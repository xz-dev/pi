//! `exec`: Durable's `NodeExecutionEnv.exec` semantics (docs/semantics.md), output streamed as `output` events.

use crate::decode::StreamDecoder;
use crate::errors::Failure;
use crate::frame::{EVENT, Frame};
use crate::output::Output;
use crate::sys;
use crate::window::{Pending, Window};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const EXIT_STDIO_GRACE: Duration = Duration::from_millis(100);
/// How often a delivery waiting for the link to drain looks again.
const UNSENT_POLL: Duration = Duration::from_millis(20);

/// Commands this daemon started and has not reaped; killed when the connection ends.
pub type Groups = Arc<Mutex<HashSet<u32>>>;

pub enum Message {
    Data(usize, Vec<u8>),
    Eof(usize),
    Exit(ExitStatus),
    WaitFailed(String),
    /// Abort: the command settles as `aborted`.
    Cancel,
    /// Kill without aborting, as `cleanup()` does: the command settles with the killed process's status.
    Kill,
}

/// Cancellation of one request, registered before the request runs so a cancel that arrives first is not lost.
#[derive(Default)]
pub struct Control {
    pub aborted: AtomicBool,
    pub killed: AtomicBool,
    sender: Mutex<Option<Sender<Message>>>,
    owner: Mutex<OwnerState>,
}

#[derive(Default)]
struct OwnerState {
    intent: bool,
    valid: bool,
    stopping: bool,
    #[cfg(target_os = "linux")]
    generation: u64,
    launching: bool,
    started: usize,
    completed: usize,
    uncertain: Option<String>,
    #[cfg(target_os = "linux")]
    lease: Option<(u64, std::os::unix::net::UnixStream)>,
}

impl Control {
    pub fn admitted(json: &Value) -> Self {
        let mut control = Self::default();
        let owner = control.owner.get_mut().unwrap();
        owner.intent = json["op"] == "exec" && json.get("owner").is_some();
        owner.valid = json["owner"].as_object().is_some_and(|owner| {
            owner.len() == 1 && owner.get("v").and_then(Value::as_u64) == Some(1)
        });
        control
    }

    pub fn owned(&self) -> bool {
        self.owner.lock().unwrap().intent
    }

    pub fn validate_owner(&self) -> Result<(), Failure> {
        let owner = self.owner.lock().unwrap();
        if owner.intent && !owner.valid {
            return Err(Failure::new("EINVAL", "invalid exec owner intent"));
        }
        Ok(())
    }

    /// Every owned terminal, including admission/thread errors, passes here.
    pub fn terminal(&self, mut frame: Frame) -> Frame {
        let mut owner = self.owner.lock().unwrap();
        if !owner.intent {
            return frame;
        }
        let active_lease = {
            #[cfg(target_os = "linux")]
            {
                owner.lease.is_some()
            }
            #[cfg(not(target_os = "linux"))]
            {
                false
            }
        };
        if owner.launching || owner.completed != owner.started || active_lease {
            owner
                .uncertain
                .get_or_insert_with(|| "owned scope has not completed all fences".into());
        }
        let state = if let Some(message) = &owner.uncertain {
            frame.kind = crate::frame::ERROR;
            frame.json["code"] = json!("unknown");
            frame.json["ownerError"] =
                json!({"code":"ERR_PROCESS_OWNER_CLEANUP","message":message});
            frame.json["message"] = json!(message);
            "unconfirmed"
        } else if owner.started == 0 {
            "not-started"
        } else {
            "complete"
        };
        if state == "not-started" && frame.kind == crate::frame::RESULT {
            frame.kind = crate::frame::ERROR;
            frame.json["code"] = json!("unknown");
            frame.json["message"] = json!("owned exec returned without a scope");
        }
        frame.json["owner"] = json!({"v":1,"state":state});
        frame
    }

    pub fn cancel(&self, kill: bool) {
        {
            let mut owner = self.owner.lock().unwrap();
            if kill {
                self.killed.store(true, Ordering::SeqCst);
            } else {
                self.aborted.store(true, Ordering::SeqCst);
            }
            owner.stopping = true;
            #[cfg(target_os = "linux")]
            if let Some((_, lease)) = &owner.lease {
                let _ = lease.shutdown(std::net::Shutdown::Write);
            }
        }
        let sender = self.sender.lock().unwrap();
        if let Some(sender) = sender.as_ref() {
            let _ = sender.send(if kill { Message::Kill } else { Message::Cancel });
        }
    }

    pub fn attach(&self, sender: Sender<Message>) {
        *self.sender.lock().unwrap() = Some(sender);
    }
}

pub struct ExecRequest {
    pub command: Option<String>,
    pub argv: Option<Vec<String>>,
    pub cwd: String,
    pub env: Map<String, Value>,
    pub inherit_env: bool,
    pub shell_path: Option<String>,
    pub timeout: Option<Duration>,
    pub spill: Option<(u64, u64)>,
    pub window: Option<Window>,
}

impl ExecRequest {
    pub fn from_json(json: &Value) -> Result<ExecRequest, Failure> {
        // Reject numeric values that would panic the shared window/timer code.
        if let Some(window) = json["window"].as_object() {
            for key in ["maxBytes", "maxLines"] {
                if window
                    .get(key)
                    .and_then(Value::as_u64)
                    .is_some_and(|value| value > (usize::MAX / 4 - 1) as u64)
                {
                    return Err(Failure::new("EINVAL", "exec window out of range"));
                }
            }
            if let Some(ms) = window.get("minIntervalMs").and_then(Value::as_f64) {
                let duration = Duration::try_from_secs_f64(ms.max(0.0) / 1000.0)
                    .map_err(|_| Failure::new("EINVAL", "exec window interval out of range"))?;
                if Instant::now().checked_add(duration).is_none() {
                    return Err(Failure::new("EINVAL", "exec window interval out of range"));
                }
            }
        }
        let strings = |value: &Value| -> Option<Vec<String>> {
            value
                .as_array()?
                .iter()
                .map(|item| item.as_str().map(str::to_string))
                .collect()
        };
        Ok(ExecRequest {
            command: json["command"].as_str().map(str::to_string),
            argv: strings(&json["argv"]),
            cwd: json["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "exec needs cwd"))?
                .to_string(),
            env: json["env"].as_object().cloned().unwrap_or_default(),
            inherit_env: json["inheritEnv"].as_bool().unwrap_or(true),
            shell_path: json["shellPath"].as_str().map(str::to_string),
            timeout: json["timeoutMs"]
                .as_f64()
                .map(|ms| {
                    Duration::try_from_secs_f64(ms / 1000.0)
                        .map_err(|_| Failure::new("EINVAL", "invalid exec timeout"))
                })
                .transpose()?,
            spill: json["spill"].as_object().and_then(|spill| {
                Some((
                    spill.get("afterBytes")?.as_u64()?,
                    spill.get("afterLines")?.as_u64()?,
                ))
            }),
            window: Window::from_json(&json["window"]),
        })
    }
}

pub fn kill_group(pid: u32) {
    sys::kill_tree(pid);
}

fn random_uuid() -> String {
    let mut bytes = sys::random_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Spill of the complete raw output, started once it crosses either threshold, like Node's.
struct Spill {
    after_bytes: u64,
    after_lines: u64,
    seen_bytes: u64,
    seen_newlines: u64,
    prefix: Vec<Vec<u8>>,
    file: Option<File>,
    path: Option<String>,
    failed: Option<String>,
}

impl Spill {
    fn push(&mut self, chunk: &[u8], tmpdir: &str) {
        if self.failed.is_some() || chunk.is_empty() {
            return;
        }
        if self.file.is_none() {
            self.seen_bytes += chunk.len() as u64;
            self.seen_newlines += chunk.iter().filter(|byte| **byte == b'\n').count() as u64;
            let lines = self.seen_newlines + u64::from(chunk.last() != Some(&b'\n'));
            if self.seen_bytes <= self.after_bytes && lines <= self.after_lines {
                self.prefix.push(chunk.to_vec());
                return;
            }
            if let Err(error) = self.start(tmpdir) {
                self.failed = Some(error);
                return;
            }
        }
        if let Some(file) = &mut self.file
            && let Err(error) = file.write_all(chunk)
        {
            self.failed = Some(error.to_string());
        }
    }

    /// `createTempFile({ prefix: "pi-output-", suffix: ".log" })`: a fresh `tmp-` directory holding the file.
    fn start(&mut self, tmpdir: &str) -> Result<(), String> {
        let prefix = Path::new(tmpdir)
            .join("tmp-")
            .to_string_lossy()
            .into_owned();
        let directory = sys::mkdtemp(&prefix).map_err(|error| error.to_string())?;
        let path = Path::new(&directory)
            .join(format!("pi-output-{}.log", random_uuid()))
            .to_string_lossy()
            .into_owned();
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        for chunk in self.prefix.drain(..) {
            file.write_all(&chunk).map_err(|error| error.to_string())?;
        }
        self.file = Some(file);
        self.path = Some(path);
        Ok(())
    }
}

fn spawn(
    request: &ExecRequest,
    program: &str,
    args: &[String],
    piped_stdin: bool,
) -> std::io::Result<Child> {
    let mut command = Command::new(program);
    command
        .current_dir(&request.cwd)
        .stdin(if piped_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sys::configure(&mut command, args, &request.env, request.inherit_env);
    let child = command.spawn()?;
    sys::after_spawn(&child);
    Ok(child)
}

/// Read one pipe on its own thread. Without an output window, reading waits while too much output is unsent.
fn spawn_reader(
    stream: usize,
    pipe: impl sys::Pipe + Send + 'static,
    sender: Sender<Message>,
    stop: Arc<AtomicBool>,
    output: Option<Arc<Output>>,
) -> std::io::Result<JoinHandle<()>> {
    thread::Builder::new().spawn(move || {
        sys::read_pipe(pipe, &stop, |bytes| {
            let delivered = sender.send(Message::Data(stream, bytes.to_vec())).is_ok();
            if let Some(output) = &output {
                output.wait_for_room(&stop);
            }
            delivered
        });
        let _ = sender.send(Message::Eof(stream));
    })
}

fn output_frame(id: u32, stream: &str, text: String, skipped: Option<Value>) -> Frame {
    let mut json = json!({ "kind": "output", "stream": stream });
    if let Some(skipped) = skipped {
        json["skipped"] = skipped;
    }
    Frame::with_payload(EVENT, id, json, text.into_bytes())
}

/// Run one command, sending output events for request `id`, until it settles.
pub fn run(
    id: u32,
    request: ExecRequest,
    tmpdir: &str,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
) -> Result<Value, Failure> {
    let (sender, receiver) = mpsc::channel();
    control.attach(sender.clone());
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    // A string runs through the shell (as its last argument, or on stdin for legacy WSL bash); argv runs directly.
    let (program, args, stdin_command) = match (&request.command, &request.argv) {
        (Some(command), _) => {
            let shell = sys::shell_config(request.shell_path.as_deref())?;
            let mut args = shell.args;
            if shell.command_on_stdin {
                (shell.program, args, Some(command.clone()))
            } else {
                args.push(command.clone());
                (shell.program, args, None)
            }
        }
        (None, Some(argv)) => match argv.split_first() {
            Some((first, rest)) => (
                sys::resolve_program(first, &request.cwd, &request.env)?,
                rest.to_vec(),
                None,
            ),
            None => return Err(Failure::new("spawn_error", "Empty argv: no program to run")),
        },
        (None, None) => return Err(Failure::new("EINVAL", "exec needs command or argv")),
    };
    if !Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!(
                "Working directory does not exist: {}\nCannot execute bash commands.",
                request.cwd
            ),
        ));
    }
    let mut child = spawn(&request, &program, &args, stdin_command.is_some())
        .map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    if let (Some(command), Some(mut stdin)) = (stdin_command, child.stdin.take()) {
        let _ = stdin.write_all(command.as_bytes());
    }
    let pid = child.id();
    groups.lock().unwrap().insert(pid);
    let deadline = request.timeout.map(|timeout| Instant::now() + timeout);
    let stop = Arc::new(AtomicBool::new(false));
    // Without a window, output is not coalesced; reading then waits for the link.
    let gate = if request.window.is_none() {
        Some(output.clone())
    } else {
        None
    };
    // A thread that cannot start (a task limit) fails the command; the started child is killed and reaped.
    let abandon = |mut child: Child, readers: &[JoinHandle<()>], error: std::io::Error| {
        stop.store(true, Ordering::SeqCst);
        for reader in readers {
            sys::interrupt_reader(reader);
        }
        kill_group(pid);
        // On Windows the group kill spawns taskkill, which can fail under the same limit; kill the child directly.
        let _ = child.kill();
        let _ = child.wait();
        groups.lock().unwrap().remove(&pid);
        Failure::new("spawn_error", error.to_string())
    };
    let mut readers = Vec::with_capacity(2);
    let stdout = child.stdout.take().unwrap();
    match spawn_reader(0, stdout, sender.clone(), stop.clone(), gate.clone()) {
        Ok(reader) => readers.push(reader),
        Err(error) => return Err(abandon(child, &readers, error)),
    }
    let stderr = child.stderr.take().unwrap();
    match spawn_reader(1, stderr, sender.clone(), stop.clone(), gate) {
        Ok(reader) => readers.push(reader),
        Err(error) => return Err(abandon(child, &readers, error)),
    }
    // The waiter receives the child once it runs, so a waiter that cannot start leaves the child here to reap.
    let (give, take) = mpsc::channel::<Child>();
    let waiter = sender.clone();
    let started = thread::Builder::new().spawn(move || {
        let Ok(mut child) = take.recv() else {
            return;
        };
        let _ = waiter.send(match child.wait() {
            Ok(status) => Message::Exit(status),
            Err(error) => Message::WaitFailed(error.to_string()),
        });
    });
    if let Err(error) = started {
        return Err(abandon(child, &readers, error));
    }
    let _ = give.send(child);
    drop(sender);

    let mut decoders = [StreamDecoder::new(), StreamDecoder::new()];
    let mut spill = request.spill.map(|(after_bytes, after_lines)| Spill {
        after_bytes,
        after_lines,
        seen_bytes: 0,
        seen_newlines: 0,
        prefix: Vec::new(),
        file: None,
        path: None,
        failed: None,
    });
    let mut pending = request.window.map(Pending::new);
    let unsent = Arc::new(AtomicUsize::new(0));
    let names = ["stdout", "stderr"];
    let emit = |pending: &mut Option<Pending>, stream: usize, text: String| {
        if text.is_empty() {
            return;
        }
        match pending {
            Some(pending) => pending.push(names[stream], text),
            None => output.bulk(output_frame(id, names[stream], text, None), None),
        }
    };
    let deliver = |pending: &mut Pending| {
        for event in pending.take() {
            output.bulk(
                output_frame(id, event.stream, event.text, event.skipped),
                Some(unsent.clone()),
            );
        }
    };
    let mut ended = [false, false];
    let mut status: Option<Result<ExitStatus, String>> = None;
    let mut idle_until: Option<Instant> = None;
    let mut timed_out = false;
    let mut aborted = false;
    let mut killed = false;
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            kill_group(pid);
        }
    };
    if control.killed.load(Ordering::SeqCst) {
        kill(&mut killed);
    }
    loop {
        let now = Instant::now();
        // Node's timer stays armed until the command settles, including the grace period after exit.
        if !timed_out && deadline.is_some_and(|deadline| now >= deadline) {
            timed_out = true;
            kill(&mut killed);
        }
        if status.is_some() && ended[0] && ended[1] {
            break;
        }
        if idle_until.is_some_and(|idle| now >= idle) {
            // A descendant may hold the pipes open after the process exited; stop waiting for it.
            break;
        }
        if let Some(pending) = &mut pending
            && !pending.is_empty()
            && now >= pending.next_send()
            && unsent.load(Ordering::SeqCst) == 0
        {
            deliver(pending);
        }
        let mut wait = Duration::from_secs(3600);
        if let Some(deadline) = deadline.filter(|_| !timed_out) {
            wait = wait.min(deadline.saturating_duration_since(now));
        }
        if let Some(idle) = idle_until {
            wait = wait.min(idle.saturating_duration_since(now));
        }
        if let Some(pending) = pending.as_ref().filter(|pending| !pending.is_empty()) {
            wait = wait.min(if unsent.load(Ordering::SeqCst) > 0 {
                UNSENT_POLL
            } else {
                pending.next_send().saturating_duration_since(now)
            });
        }
        match receiver.recv_timeout(wait) {
            Ok(Message::Data(stream, bytes)) => {
                emit(&mut pending, stream, decoders[stream].decode(&bytes, false));
                if let Some(spill) = &mut spill {
                    spill.push(&bytes, tmpdir);
                    if spill.failed.is_some() {
                        kill(&mut killed);
                    }
                }
                if status.is_some() {
                    idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
                }
            }
            Ok(Message::Eof(stream)) => ended[stream] = true,
            Ok(Message::Exit(exit)) => {
                status = Some(Ok(exit));
                idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
            }
            Ok(Message::WaitFailed(error)) => {
                status = Some(Err(error));
                idle_until = Some(Instant::now());
            }
            Ok(Message::Cancel) => {
                aborted = true;
                kill(&mut killed);
            }
            Ok(Message::Kill) => kill(&mut killed),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // Like Node destroying its streams: stop reading, so the pipes close even if a descendant still holds them.
    stop.store(true, Ordering::SeqCst);
    for reader in &readers {
        sys::interrupt_reader(reader);
    }
    groups.lock().unwrap().remove(&pid);
    emit(&mut pending, 0, decoders[0].decode(&[], true));
    emit(&mut pending, 1, decoders[1].decode(&[], true));
    if let Some(pending) = &mut pending
        && !pending.is_empty()
    {
        deliver(pending);
    }
    let spill_path = spill.as_ref().and_then(|spill| spill.path.clone());
    let with_spill = |failure: Failure| match &spill_path {
        Some(path) => failure.extra(json!({ "spillPath": path })),
        None => failure,
    };
    if timed_out {
        return Err(with_spill(Failure::new("timeout", "timeout")));
    }
    if aborted {
        return Err(with_spill(Failure::new("aborted", "aborted")));
    }
    if let Some(error) = spill.as_ref().and_then(|spill| spill.failed.clone()) {
        return Err(Failure::new(
            "unknown",
            format!("Failed to preserve complete shell output: {error}"),
        ));
    }
    let status = match status {
        Some(Ok(status)) => status,
        Some(Err(error)) => return Err(Failure::new("spawn_error", error)),
        None => {
            return Err(Failure::new(
                "spawn_error",
                "process did not report its exit",
            ));
        }
    };
    let mut result = json!({ "exitCode": sys::exit_code(status) });
    if let Some(path) = spill_path {
        result["spillPath"] = json!(path);
    }
    Ok(result)
}

#[cfg(target_os = "linux")]
pub mod owned {
    use super::*;
    use std::io;
    use std::net::Shutdown;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::net::UnixStream;

    const DRAIN: Duration = Duration::from_secs(2);
    enum Notice {
        Data(usize, Vec<u8>),
        End(usize, Result<(), String>),
        Report(Vec<u8>),
        ControlEnd(Result<(), String>),
    }

    #[derive(Debug, Default)]
    struct Reports {
        bytes: Vec<u8>,
        total: usize,
        pid: Option<u32>,
        exit: Option<i32>,
        error: Option<(Option<i32>, String)>,
        complete: bool,
    }

    impl Reports {
        fn push(&mut self, bytes: &[u8], zero: bool) -> Result<(), String> {
            self.total = self
                .total
                .checked_add(bytes.len())
                .ok_or("control report overflow")?;
            if self.total > 4096 {
                return Err("control report exceeds 4096 bytes".into());
            }
            for &byte in bytes {
                if self.complete {
                    return Err("bytes after C".into());
                }
                if byte != b'\n' {
                    self.bytes.push(byte);
                    continue;
                }
                let line = std::mem::take(&mut self.bytes);
                self.line(&line, zero)?;
            }
            Ok(())
        }

        fn object(line: &[u8], keys: &[&str]) -> Result<Value, String> {
            let text = std::str::from_utf8(line).map_err(|_| "invalid control UTF8")?;
            let value: Value = serde_json::from_str(text).map_err(|_| "invalid control JSON")?;
            let object = value.as_object().ok_or("control object required")?;
            if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
                return Err("unexpected control keys".into());
            }
            // Values are scalar integers/null. Counting parsed members separately
            // rejects duplicate keys, which Value alone would silently replace.
            let body = text
                .trim()
                .strip_prefix('{')
                .and_then(|s| s.strip_suffix('}'))
                .ok_or("control object required")?;
            let members: Vec<_> = body.split(',').collect();
            if members.len() != keys.len() {
                return Err("duplicate control keys".into());
            }
            let mut seen = HashSet::new();
            for member in members {
                let (key, _) = member.split_once(':').ok_or("invalid control member")?;
                let key: String =
                    serde_json::from_str(key.trim()).map_err(|_| "invalid control key")?;
                if !seen.insert(key) {
                    return Err("duplicate control key".into());
                }
            }
            Ok(value)
        }

        fn line(&mut self, line: &[u8], zero: bool) -> Result<(), String> {
            match line.first() {
                Some(b'S') if self.pid.is_none() && self.error.is_none() && self.exit.is_none() => {
                    let value = Self::object(&line[1..], &["pid"])?;
                    let pid = value["pid"]
                        .as_u64()
                        .filter(|&p| p > 0 && p <= i32::MAX as u64)
                        .ok_or("invalid S pid")?;
                    self.pid = Some(pid as u32);
                }
                Some(b'X') if self.pid.is_some() && self.exit.is_none() && self.error.is_none() => {
                    let value = Self::object(&line[1..], &["code", "signal"])?;
                    self.exit = Some(match (value["code"].as_i64(), value["signal"].as_i64()) {
                        (Some(code), None)
                            if (0..=255).contains(&code) && value["signal"].is_null() =>
                        {
                            code as i32
                        }
                        (None, Some(signal))
                            if (1..=127).contains(&signal) && value["code"].is_null() =>
                        {
                            128 + signal as i32
                        }
                        _ => return Err("invalid X status".into()),
                    });
                }
                Some(b'E') if self.pid.is_none() && self.error.is_none() && self.exit.is_none() => {
                    let text = std::str::from_utf8(&line[1..]).map_err(|_| "invalid E UTF8")?;
                    let (errno, message) = text.split_once(' ').ok_or("invalid E record")?;
                    if errno.is_empty()
                        || !errno.bytes().all(|b| b.is_ascii_digit())
                        || message.is_empty()
                    {
                        return Err("invalid E errno/message".into());
                    }
                    let errno: i32 = errno.parse().map_err(|_| "invalid E errno")?;
                    if errno == 0 && !zero {
                        return Err("unexpected E0".into());
                    }
                    self.error = Some(((errno != 0).then_some(errno), message.into()));
                }
                Some(b'C') if line == b"C" && (self.exit.is_some() || self.error.is_some()) => {
                    self.complete = true
                }
                _ => return Err("unexpected control record/order".into()),
            }
            Ok(())
        }

        fn finish(&self, status: ExitStatus) -> Result<i32, String> {
            if !self.bytes.is_empty() || !self.complete {
                return Err("missing/partial control fence".into());
            }
            let expected = self.exit.unwrap_or(125);
            // helper exits normally with 128+signal; it is not itself signal-killed.
            if status.code() != Some(expected) {
                return Err("helper wait disagrees with control status".into());
            }
            Ok(expected)
        }
    }

    impl Control {
        fn uncertain(&self, message: impl Into<String>) {
            let mut state = self.owner.lock().unwrap();
            state.uncertain.get_or_insert_with(|| message.into());
            state.stopping = true;
            if let Some((_, lease)) = &state.lease {
                let _ = lease.shutdown(Shutdown::Write);
            }
        }
        fn stopped(&self) -> bool {
            self.owner.lock().unwrap().stopping
        }
        fn stopped_failure(&self) -> Failure {
            // No main primary exists to supply a truthful killed status.
            Failure::new("aborted", "aborted")
        }
        fn publish(&self, lease: UnixStream) -> Result<u64, Failure> {
            let mut state = self.owner.lock().unwrap();
            if state.stopping {
                return Err(self.stopped_failure());
            }
            state.generation += 1;
            let generation = state.generation;
            state.launching = true;
            state.lease = Some((generation, lease));
            Ok(generation)
        }
        fn launch_allowed(&self) -> bool {
            // A cancellation after this committed boundary sees the installed
            // lease. Its half-close crosses exec even before Child is published.
            !self.owner.lock().unwrap().stopping
        }
        fn launched(&self, generation: u64, started: bool) {
            let mut state = self.owner.lock().unwrap();
            state.launching = false;
            if started {
                state.started += 1;
            } else if state.lease.as_ref().is_some_and(|(g, _)| *g == generation) {
                state.lease = None;
            }
        }
        fn fenced(&self, generation: u64, success: bool) {
            let mut state = self.owner.lock().unwrap();
            if success {
                state.completed += 1;
            }
            if state.lease.as_ref().is_some_and(|(g, _)| *g == generation) {
                state.lease = None;
            }
        }
    }

    /// Polling permits explicit failure teardown; stopping is NEVER readable EOF.
    fn pipe_reader(
        pipe: &mut (impl sys::Pipe + ?Sized),
        stop: &AtomicBool,
        mut send: impl FnMut(&[u8]) -> bool,
    ) -> io::Result<()> {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            if stop.load(Ordering::SeqCst) {
                return Err(io::Error::other("reader stopped without EOF"));
            }
            let mut poll = libc::pollfd {
                fd: pipe.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut poll, 1, 50) };
            if ready == 0 {
                continue;
            }
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            match pipe.read(&mut buffer) {
                Ok(0) => return Ok(()),
                Ok(n) if send(&buffer[..n]) => {}
                Ok(_) => return Err(io::Error::other("output receiver closed")),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    }

    struct Delivery<'a> {
        id: u32,
        output: &'a Arc<Output>,
        tmpdir: &'a str,
        decoders: [StreamDecoder; 2],
        pending: Option<Pending>,
        unsent: Arc<AtomicUsize>,
        spill: Option<Spill>,
    }
    impl<'a> Delivery<'a> {
        fn new(id: u32, request: &ExecRequest, output: &'a Arc<Output>, tmpdir: &'a str) -> Self {
            Self {
                id,
                output,
                tmpdir,
                decoders: [StreamDecoder::new(), StreamDecoder::new()],
                pending: request.window.map(Pending::new),
                unsent: Arc::new(AtomicUsize::new(0)),
                spill: request.spill.map(|(after_bytes, after_lines)| Spill {
                    after_bytes,
                    after_lines,
                    seen_bytes: 0,
                    seen_newlines: 0,
                    prefix: Vec::new(),
                    file: None,
                    path: None,
                    failed: None,
                }),
            }
        }
        fn text(&mut self, stream: usize, text: String) {
            if text.is_empty() {
                return;
            }
            let name = ["stdout", "stderr"][stream];
            if let Some(pending) = &mut self.pending {
                pending.push(name, text);
            } else {
                self.output
                    .bulk(output_frame(self.id, name, text, None), None);
            }
        }
        fn data(&mut self, stream: usize, bytes: &[u8]) -> Result<(), String> {
            let text = self.decoders[stream].decode(bytes, false);
            self.text(stream, text);
            if let Some(spill) = &mut self.spill {
                spill.push(bytes, self.tmpdir);
                if let Some(error) = &spill.failed {
                    return Err(error.clone());
                }
            }
            Ok(())
        }
        fn poll(&mut self, force: bool) {
            if let Some(pending) = &mut self.pending
                && !pending.is_empty()
                && (force
                    || (Instant::now() >= pending.next_send()
                        && self.unsent.load(Ordering::SeqCst) == 0))
            {
                for event in pending.take() {
                    self.output.bulk(
                        output_frame(self.id, event.stream, event.text, event.skipped),
                        Some(self.unsent.clone()),
                    );
                }
            }
        }
        fn finish(&mut self) -> Result<(), String> {
            for stream in 0..2 {
                let text = self.decoders[stream].decode(&[], true);
                self.text(stream, text);
            }
            self.poll(true);
            if let Some(spill) = &mut self.spill
                && let Some(mut file) = spill.file.take()
            {
                file.flush().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        fn spill_path(&self) -> Option<String> {
            self.spill.as_ref().and_then(|s| s.path.clone())
        }
    }

    struct ScopeResult {
        code: i32,
        stdout: Vec<u8>,
        error: Option<(Option<i32>, String)>,
    }

    fn scope(
        control: &Control,
        handoff: sys::owned::Handoff,
        mut delivery: Option<&mut Delivery<'_>>,
        deadline: Option<Instant>,
    ) -> Result<ScopeResult, Failure> {
        let sys::owned::Handoff {
            mut command,
            lease,
            spec,
            passed,
            zero_attempt,
        } = handoff;
        // A CLOEXEC read duplicate, never a private descriptor in stdio slots.
        let fd = unsafe { libc::fcntl(lease.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
        if fd < 0 {
            return Err(Failure::new(
                "unknown",
                io::Error::last_os_error().to_string(),
            ));
        }
        // SAFETY: successful fcntl returned a fresh descriptor owned by this scope.
        let mut readable = unsafe { UnixStream::from_raw_fd(fd) };
        let generation = control.publish(lease)?;
        if !control.launch_allowed() {
            control.launched(generation, false);
            return Err(control.stopped_failure());
        }
        let spawned = command.spawn();
        drop(spec);
        drop(passed);
        drop(command);
        control.launched(generation, spawned.is_ok());
        if spawned.is_err() && control.stopped() {
            return Err(control.stopped_failure());
        }
        let mut child = spawned.map_err(|e| {
            Failure::new("spawn_error", e.to_string())
                .path("/proc/self/exe")
                .extra(json!({"spawn":{"stage":"helper","errno":e.raw_os_error()}}))
        })?;
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();
        let mut joins = Vec::new();
        // Fallible thread launch is itself a scope failure, not a detached handle.
        for (stream, mut pipe) in [
            (
                0,
                Box::new(child.stdout.take().unwrap()) as Box<dyn sys::Pipe + Send>,
            ),
            (
                1,
                Box::new(child.stderr.take().unwrap()) as Box<dyn sys::Pipe + Send>,
            ),
        ] {
            let tx = tx.clone();
            let stop = stop.clone();
            let output = delivery
                .as_ref()
                .filter(|d| d.pending.is_none())
                .map(|d| d.output.clone());
            match thread::Builder::new().spawn(move || {
                let result = pipe_reader(&mut *pipe, &stop, |bytes| {
                    if tx.send(Notice::Data(stream, bytes.to_vec())).is_err() {
                        return false;
                    }
                    if let Some(output) = &output {
                        output.wait_for_room(&stop);
                    }
                    true
                })
                .map_err(|e| e.to_string());
                let _ = tx.send(Notice::End(stream, result));
            }) {
                Ok(join) => joins.push(join),
                Err(error) => {
                    control.uncertain(format!("output thread failed: {error}"));
                }
            }
        }
        {
            let tx = tx.clone();
            let stop = stop.clone();
            match thread::Builder::new().spawn(move || {
                let result = pipe_reader(&mut readable, &stop, |bytes| {
                    tx.send(Notice::Report(bytes.to_vec())).is_ok()
                })
                .map_err(|e| e.to_string());
                let _ = tx.send(Notice::ControlEnd(result));
            }) {
                Ok(join) => joins.push(join),
                Err(error) => {
                    control.uncertain(format!("control thread failed: {error}"));
                }
            }
        }
        // Wait stays on runner: no detached waiter and no unjoinable wait thread.
        let mut reports = Reports::default();
        let mut ended = [false; 2];
        let mut control_end = false;
        let mut wait = None;
        let mut drain = None;
        let mut captured = Vec::new();
        let mut stderr = Vec::new();
        let mut timed_out = false;
        let mut spill_failed = None;
        drop(tx);
        loop {
            let now = Instant::now();
            if !timed_out && deadline.is_some_and(|d| now >= d) {
                timed_out = true;
                control.cancel(true);
            }
            if wait.is_none() {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        // try_wait has reaped it; wait joins the owned Child's
                        // cached status without blocking output/control delivery.
                        match child.wait() {
                            Ok(status) => wait = Some(status),
                            Err(error) => control.uncertain(format!("helper wait failed: {error}")),
                        }
                        drain.get_or_insert(now + DRAIN);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        control.uncertain(format!("helper wait failed: {error}"));
                        drain.get_or_insert(now + DRAIN);
                    }
                }
            }
            if control.owner.lock().unwrap().uncertain.is_some()
                || (wait.is_some() && !control_end)
                || (reports.complete && (!control_end || wait.is_none()))
            {
                drain.get_or_insert(now + DRAIN);
            } else {
                drain = None;
            }
            if ended == [true, true] && control_end && wait.is_some() {
                break;
            }
            if drain.is_some_and(|d| now >= d) {
                control.uncertain("owned scope drain did not reach all real EOF/wait fences");
                break;
            }
            if let Some(delivery) = &mut delivery {
                delivery.poll(false);
            }
            match rx.recv_timeout(UNSENT_POLL) {
                Ok(Notice::Data(stream, bytes)) => {
                    if stream == 1 && reports.pid.is_none() {
                        stderr.push(bytes);
                    } else if let Some(delivery) = &mut delivery {
                        if let Err(error) = delivery.data(stream, &bytes) {
                            spill_failed.get_or_insert(error);
                            control.cancel(true);
                        }
                    } else if stream == 0 {
                        captured.extend_from_slice(&bytes);
                    }
                }
                Ok(Notice::Report(bytes)) => {
                    if let Err(error) = reports.push(&bytes, zero_attempt) {
                        control.uncertain(error);
                    }
                    if reports.pid.is_some() && !stderr.is_empty() {
                        for bytes in stderr.drain(..) {
                            if let Some(delivery) = &mut delivery
                                && let Err(error) = delivery.data(1, &bytes)
                            {
                                spill_failed.get_or_insert(error);
                                control.cancel(true);
                            }
                        }
                    }
                }
                Ok(Notice::End(stream, result)) => {
                    ended[stream] = true;
                    if let Err(error) = result {
                        control.uncertain(format!("output read failed: {error}"));
                    }
                }
                Ok(Notice::ControlEnd(result)) => {
                    control_end = true;
                    if let Err(error) = result {
                        control.uncertain(format!("control read failed: {error}"));
                    }
                    if !reports.complete || !reports.bytes.is_empty() {
                        control.uncertain("control EOF before valid complete record");
                    }
                }

                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) if wait.is_some() => break,
                Err(RecvTimeoutError::Disconnected) => {}
            }
        }
        stop.store(true, Ordering::SeqCst);
        for join in joins {
            if join.join().is_err() {
                control.uncertain("owned reader panicked");
            }
        }
        let status = wait.ok_or_else(|| {
            control.uncertain("missing actual helper wait");
            Failure::new("unknown", "missing actual helper wait")
        });
        let verified = status.and_then(|status| {
            reports.finish(status).map_err(|e| {
                control.uncertain(e.clone());
                Failure::new("unknown", e)
            })
        });
        let complete = verified.is_ok()
            && ended == [true, true]
            && control_end
            && control.owner.lock().unwrap().uncertain.is_none();
        control.fenced(generation, complete);
        let code = verified?;
        if !complete {
            return Err(Failure::new("unknown", "owned scope unconfirmed"));
        }
        if timed_out {
            return Err(Failure::new("timeout", "timeout"));
        }
        if control.aborted.load(Ordering::SeqCst) || (reports.error.is_some() && control.stopped())
        {
            return Err(Failure::new("aborted", "aborted"));
        }
        if let Some(error) = spill_failed {
            return Err(Failure::new(
                "unknown",
                format!("Failed to preserve complete shell output: {error}"),
            ));
        }
        Ok(ScopeResult {
            code,
            stdout: captured,
            error: reports.error,
        })
    }

    pub fn run(
        id: u32,
        request: ExecRequest,
        tmpdir: &str,
        output: &Arc<Output>,
        control: &Control,
        snapshot: &sys::owned::Snapshot,
    ) -> Result<Value, Failure> {
        if control.stopped() {
            return Err(control.stopped_failure());
        }
        let (program, args) = if let Some(command) = &request.command {
            let program = if let Some(shell) = &request.shell_path {
                if !Path::new(shell).exists() {
                    return Err(Failure::new(
                        "shell_unavailable",
                        format!("Custom shell path not found: {shell}"),
                    ));
                }
                shell.clone()
            } else if Path::new("/bin/bash").exists() {
                "/bin/bash".into()
            } else {
                let handoff = snapshot.prepare(
                    &["which".into(), "bash".into()],
                    "",
                    &Map::new(),
                    true,
                    true,
                )?;
                let lookup = scope(control, handoff, None, None)?;
                if control.stopped() {
                    return Err(control.stopped_failure());
                }
                let found = (lookup.code == 0 && lookup.error.is_none()).then(|| {
                    String::from_utf8_lossy(&lookup.stdout)
                        .trim()
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_string()
                });
                found
                    .filter(|p| !p.is_empty() && Path::new(p).exists())
                    .unwrap_or_else(|| "sh".into())
            };
            (program, vec!["-c".into(), command.clone()])
        } else if let Some(argv) = &request.argv {
            let (program, args) = argv
                .split_first()
                .ok_or_else(|| Failure::new("spawn_error", "Empty argv: no program to run"))?;
            (program.clone(), args.to_vec())
        } else {
            return Err(Failure::new("EINVAL", "exec needs command or argv"));
        };
        if control.stopped() {
            return Err(control.stopped_failure());
        }
        if !Path::new(&request.cwd).exists() {
            return Err(Failure::new(
                "spawn_error",
                format!(
                    "Working directory does not exist: {}\nCannot execute bash commands.",
                    request.cwd
                ),
            ));
        }
        let mut argv = vec![program];
        argv.extend(args);
        let handoff = snapshot.prepare(
            &argv,
            &request.cwd,
            &request.env,
            request.inherit_env,
            false,
        )?;
        let deadline = request
            .timeout
            .map(|duration| {
                Instant::now()
                    .checked_add(duration)
                    .ok_or_else(|| Failure::new("EINVAL", "exec timeout out of range"))
            })
            .transpose()?;
        let mut delivery = Delivery::new(id, &request, output, tmpdir);
        let result = scope(control, handoff, Some(&mut delivery), deadline);
        let finished = delivery.finish();
        let result = result.and_then(|result| {
            finished.map(|()| result).map_err(|error| {
                Failure::new(
                    "unknown",
                    format!("Failed to preserve complete shell output: {error}"),
                )
            })
        });
        let path = delivery.spill_path();
        let result = result.and_then(|result| {
            if let Some((errno, message)) = result.error {
                return Err(Failure::new("spawn_error", message)
                    .extra(json!({"spawn":{"stage":"target","errno":errno}})));
            }
            Ok(json!({"exitCode":result.code}))
        });
        match result {
            Ok(mut value) => {
                if let Some(path) = path {
                    value["spillPath"] = json!(path);
                }
                Ok(value)
            }
            Err(failure) => {
                // Preserve independent spawn/owner/cause fields when adding spill.
                let mut fields = failure.to_json();
                if let Some(path) = path {
                    fields["spillPath"] = json!(path);
                }
                Err(Failure::new(&failure.code, &failure.message).extra(fields))
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::Read;
        use std::os::unix::process::ExitStatusExt;

        fn control() -> Control {
            Control::admitted(&json!({"op":"exec","owner":{"v":1}}))
        }
        fn error(control: &Control, failure: Failure) -> Value {
            control
                .terminal(Frame::new(crate::frame::ERROR, 1, failure.to_json()))
                .json
        }

        #[test]
        fn confirmed_stop_before_or_between_scopes_is_aborted() {
            for kill in [false, true] {
                for prior in [false, true] {
                    let control = control();
                    if prior {
                        let (lease, _peer) = UnixStream::pair().unwrap();
                        let generation = control.publish(lease).unwrap();
                        control.launched(generation, true);
                        control.fenced(generation, true);
                    }
                    control.cancel(kill);
                    let (lease, _peer) = UnixStream::pair().unwrap();
                    assert!(control.publish(lease).is_err());
                    let value = error(&control, control.stopped_failure());
                    assert_eq!(value["code"], "aborted");
                    assert_eq!(
                        value["owner"]["state"],
                        if prior { "complete" } else { "not-started" }
                    );
                    assert!(value.get("ownerError").is_none());
                    assert_eq!(control.owner.lock().unwrap().started, usize::from(prior));
                }
            }
        }

        #[test]
        fn cancellation_crosses_published_launch_and_stays_sticky() {
            let control = control();
            let (lease, mut peer) = UnixStream::pair().unwrap();
            let generation = control.publish(lease).unwrap();
            control.cancel(true);
            let mut byte = [0];
            assert_eq!(peer.read(&mut byte).unwrap(), 0);
            assert!(!control.launch_allowed());
            control.launched(generation, true);
            let pending = error(&control, Failure::new("aborted", "aborted"));
            assert_eq!(pending["owner"]["state"], "unconfirmed");
            control.fenced(generation, true);
            assert_eq!(
                error(&control, Failure::new("aborted", "aborted"))["owner"]["state"],
                "unconfirmed"
            );
        }

        #[test]
        fn prior_discovery_survives_helper_launch_error() {
            let control = control();
            let (lease, _peer) = UnixStream::pair().unwrap();
            let generation = control.publish(lease).unwrap();
            control.launched(generation, true);
            control.fenced(generation, true);
            let (lease, _peer) = UnixStream::pair().unwrap();
            let generation = control.publish(lease).unwrap();
            control.launched(generation, false);
            let value = error(
                &control,
                Failure::new("spawn_error", "helper failure")
                    .extra(json!({"spawn":{"stage":"helper","errno":11},"spillPath":"synthetic"})),
            );
            assert_eq!(value["owner"]["state"], "complete");
            assert_eq!(value["spawn"]["errno"], 11);
            assert_eq!(value["spillPath"], "synthetic");
        }

        #[test]
        fn native_scope_faults_require_real_stream_eof_and_wait() {
            use std::os::fd::{AsRawFd, OwnedFd};
            use std::os::unix::process::CommandExt;
            for (report, status, valid) in [
                (
                    "S{\"pid\":7}\\nX{\"code\":0,\"signal\":null}\\nC\\n",
                    0,
                    true,
                ),
                ("E2 missing\\nC\\n", 125, true),
                ("C\\n", 0, false),
                (
                    "S{\"pid\":7}\\nX{\"code\":125,\"signal\":null}\\n",
                    125,
                    false,
                ),
                (
                    "S{\"pid\":7}\\nX{\"code\":0,\"signal\":null}\\nC\\n",
                    125,
                    false,
                ),
                ("E0 unexpected\\nC\\n", 125, false),
            ] {
                let control = control();
                let (lease, passed) = UnixStream::pair().unwrap();
                let passed = File::from(OwnedFd::from(passed));
                let fd = passed.as_raw_fd();
                let mut command = Command::new("/bin/sh");
                command
                    .args([
                        "-c",
                        &format!("printf '%b' '{report}' >&{fd}; exit {status}"),
                    ])
                    .env_clear()
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                unsafe {
                    command.pre_exec(move || {
                        let flags = libc::fcntl(fd, libc::F_GETFD);
                        if flags < 0
                            || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                        {
                            return Err(io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
                let handoff = sys::owned::Handoff {
                    command,
                    lease,
                    spec: File::open("/dev/null").unwrap(),
                    passed,
                    zero_attempt: false,
                };
                let result = scope(&control, handoff, None, None);
                let frame = match result {
                    Ok(r) => control.terminal(Frame::new(
                        crate::frame::RESULT,
                        1,
                        json!({"exitCode":r.code}),
                    )),
                    Err(e) => control.terminal(Frame::new(crate::frame::ERROR, 1, e.to_json())),
                };
                assert_eq!(
                    frame.json["owner"]["state"],
                    if valid { "complete" } else { "unconfirmed" },
                    "{report}: {}",
                    frame.json
                );
                if !valid {
                    assert_eq!(frame.json["code"], "unknown");
                    assert_eq!(
                        frame.json["ownerError"]["code"],
                        "ERR_PROCESS_OWNER_CLEANUP"
                    );
                }
            }
        }

        #[test]
        fn invalid_numeric_options_are_parse_errors_not_panics() {
            for fields in [
                json!({"timeoutMs":-1}),
                json!({"timeoutMs":1e30}),
                json!({"window":{"maxBytes":u64::MAX,"maxLines":1,"minIntervalMs":0,"bytesPerSecond":1}}),
                json!({"window":{"maxBytes":1,"maxLines":1,"minIntervalMs":1e30,"bytesPerSecond":1}}),
            ] {
                let mut value = json!({"argv":["/missing"],"cwd":"/"});
                value
                    .as_object_mut()
                    .unwrap()
                    .extend(fields.as_object().unwrap().clone());
                assert_eq!(ExecRequest::from_json(&value).err().unwrap().code, "EINVAL");
            }
        }

        #[test]
        fn strict_control_fences_and_errno_do_not_confuse_125() {
            for (bytes, status, zero) in [
                (
                    b"S{\"pid\":7}\nX{\"code\":125,\"signal\":null}\nC\n".as_slice(),
                    125,
                    false,
                ),
                (b"E2 missing\nC\n".as_slice(), 125, false),
                (b"E0 typed miss\nC\n".as_slice(), 125, true),
                (
                    b"S{\"pid\":7}\nX{\"code\":null,\"signal\":9}\nC\n".as_slice(),
                    137,
                    false,
                ),
            ] {
                let mut reports = Reports::default();
                for byte in bytes {
                    reports.push(&[*byte], zero).unwrap();
                }
                assert_eq!(
                    reports.finish(ExitStatus::from_raw(status << 8)).unwrap(),
                    status
                );
                assert!(reports.finish(ExitStatus::from_raw(0)).is_err());
            }
            for bytes in [
                "C\n",
                "E0 no\nC\n",
                "E-1 no\nC\n",
                "E2 no\n",
                "E2 no\nC\nextra",
                "E2 no\nC",
                "E2 no\nC\nC\n",
                "E2 no\nS{\"pid\":7}\nC\n",
                "S{\"pid\":0}\n",
                "S{\"pid\":1,\"pid\":2}\n",
                "S{\"pid\":1,\"extra\":2}\n",
                "S{\"pid\":1}\nC\n",
                "S{\"pid\":1}\nX{\"code\":256,\"signal\":null}\nC\n",
                "S{\"pid\":1}\nX{\"code\":0,\"signal\":9}\nC\n",
                "S{\"pid\":1}\nX{\"code\":null,\"signal\":0}\nC\n",
                "S{\"pid\":1}\nX{\"code\":0,\"signal\":null,\"code\":0}\nC\n",
            ] {
                let mut reports = Reports::default();
                assert!(
                    reports.push(bytes.as_bytes(), false).is_err()
                        || reports.finish(ExitStatus::from_raw(0)).is_err(),
                    "{bytes}"
                );
            }
            assert!(Reports::default().push(&[b'x'; 4097], false).is_err());
        }
    }
}
