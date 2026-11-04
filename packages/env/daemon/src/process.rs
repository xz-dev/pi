//! `process`: a long-lived program with plain pipes, for programs that speak a protocol on stdin and stdout (an MCP
//! server). Unlike `exec`, the program reads input (`processWrite`, `processCloseStdin`, addressed by the `process`
//! request's id) and output is raw bytes per stream; unlike `pty`, nothing is echoed, translated or merged.

use crate::errors::Failure;
use crate::exec::{
    Control, Groups, Launch, Message, kill_group, running, spawn, spawn_reader, start_waiter,
};
use crate::frame::{EVENT, Frame};
use crate::output::Output;
use crate::sys;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// After the program exits, output still arriving is collected until this much silence, as for `exec`.
const EXIT_STDIO_GRACE: Duration = Duration::from_millis(100);

/// Input for a program's stdin, in arrival order.
enum Input {
    Data(Vec<u8>),
    Close,
}

/// What `processWrite` and `processCloseStdin` reach: the stdin of one running `process` request.
pub struct Process {
    input: Sender<Input>,
}

/// Running programs by the id of their `process` request.
pub type Processes = Arc<Mutex<HashMap<u32, Arc<Process>>>>;

pub struct ProcessRequest {
    argv: Vec<String>,
    cwd: String,
    env: Map<String, Value>,
    inherit_env: bool,
}

impl ProcessRequest {
    pub fn from_json(json: &Value) -> Result<ProcessRequest, Failure> {
        Ok(ProcessRequest {
            argv: crate::exec::argv(json)?
                .ok_or_else(|| Failure::new("EINVAL", "process needs argv"))?,
            cwd: json["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "process needs cwd"))?
                .to_string(),
            env: json["env"].as_object().cloned().unwrap_or_default(),
            inherit_env: json["inheritEnv"].as_bool().unwrap_or(true),
        })
    }
}

/// Queue input for the program's stdin; it is written in the order it arrives, without holding up other requests.
pub fn write(processes: &Processes, json: &Value, payload: Vec<u8>) -> Result<Value, Failure> {
    running(processes, json, "process")?
        .input
        .send(Input::Data(payload))
        .map_err(|_| Failure::new("EBADF", "the program's stdin is closed"))?;
    Ok(json!({}))
}

/// Close the program's stdin once the input queued before has been written.
pub fn close_stdin(processes: &Processes, json: &Value) -> Result<Value, Failure> {
    running(processes, json, "process")?
        .input
        .send(Input::Close)
        .map_err(|_| Failure::new("EBADF", "the program's stdin is closed"))?;
    Ok(json!({}))
}

/// Run the program, sending a `started` event and then its output, until it exits.
pub fn run(
    id: u32,
    request: ProcessRequest,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
    processes: &Processes,
) -> Result<Value, Failure> {
    let (sender, receiver) = mpsc::channel();
    control.attach(sender.clone());
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    let program = sys::resolve_program(&request.argv[0], &request.cwd, &request.env)?;
    if !Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!("Working directory does not exist: {}", request.cwd),
        ));
    }
    let launch = Launch {
        cwd: &request.cwd,
        env: &request.env,
        inherit_env: request.inherit_env,
    };
    let mut child = spawn(&program, &request.argv[1..], &launch, Stdio::piped())
        .map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    let pid = child.id();
    groups.lock().unwrap().insert(pid);
    let stop = Arc::new(AtomicBool::new(false));
    let exited = Arc::new(AtomicBool::new(false));
    // A thread that cannot start (a task limit) fails the request; the started program is killed and reaped. Threads
    // already running see `stop` within 100 ms.
    let abandon = |mut child: Child, error: std::io::Error| {
        stop.store(true, Ordering::SeqCst);
        kill_group(pid);
        // On Windows the group kill spawns taskkill, which can fail under the same limit; kill the child directly.
        let _ = child.kill();
        let _ = child.wait();
        groups.lock().unwrap().remove(&pid);
        Failure::new("spawn_error", error.to_string())
    };
    // Like a full pipe: a program that writes faster than the link waits.
    let stdout = child.stdout.take().unwrap();
    if let Err(error) = spawn_reader(
        0,
        stdout,
        sender.clone(),
        stop.clone(),
        Some(output.clone()),
        exited.clone(),
    ) {
        return Err(abandon(child, error));
    }
    let stderr = child.stderr.take().unwrap();
    if let Err(error) = spawn_reader(
        1,
        stderr,
        sender.clone(),
        stop.clone(),
        Some(output.clone()),
        exited.clone(),
    ) {
        return Err(abandon(child, error));
    }
    let (input, inputs) = mpsc::channel::<Input>();
    let mut stdin = child.stdin.take().unwrap();
    let started = {
        let stop = stop.clone();
        thread::Builder::new().spawn(move || {
            for input in inputs {
                match input {
                    Input::Data(bytes) => {
                        if !sys::write_pipe(&mut stdin, &bytes, &stop) {
                            return;
                        }
                    }
                    // Returning drops stdin, which closes it; later input fails with `EBADF`.
                    Input::Close => return,
                }
            }
        })
    };
    if let Err(error) = started {
        return Err(abandon(child, error));
    }
    if let Err((child, error)) = start_waiter(child, sender.clone()) {
        return Err(abandon(child, error));
    }
    drop(sender);
    // Registered before `started` goes out, so input sent after it always finds the program.
    processes
        .lock()
        .unwrap()
        .insert(id, Arc::new(Process { input }));
    output.control(Frame::new(
        EVENT,
        id,
        json!({ "kind": "started", "pid": pid }),
    ));

    let names = ["stdout", "stderr"];
    let mut ended = [false, false];
    let mut status: Option<Result<ExitStatus, String>> = None;
    let mut idle_until: Option<Instant> = None;
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
        if status.is_some() && ended[0] && ended[1] {
            break;
        }
        match receive(&receiver, idle_until) {
            Ok(Message::Data(stream, bytes)) => {
                output.bulk(
                    Frame::with_payload(
                        EVENT,
                        id,
                        json!({ "kind": "output", "stream": names[stream] }),
                        bytes,
                    ),
                    None,
                );
                if status.is_some() {
                    idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
                }
            }
            Ok(Message::Eof(stream)) => ended[stream] = true,
            Ok(Message::Exit(exit)) => {
                status = Some(Ok(exit));
                idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
                exited.store(true, Ordering::SeqCst);
                output.wake();
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
            // A descendant may hold silent pipes open after the program exited.
            Err(RecvTimeoutError::Timeout) if idle_until.is_some() => break,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // Readers and the writer stop within 100 ms, also when a descendant still holds a pipe; removing the program
    // drops its input channel, which ends a writer waiting for input.
    stop.store(true, Ordering::SeqCst);
    processes.lock().unwrap().remove(&id);
    groups.lock().unwrap().remove(&pid);
    if aborted {
        return Err(Failure::new("aborted", "aborted"));
    }
    match status {
        Some(Ok(status)) => Ok(json!({ "exitCode": sys::exit_code(status) })),
        Some(Err(error)) => Err(Failure::new("spawn_error", error)),
        None => Err(Failure::new(
            "spawn_error",
            "process did not report its exit",
        )),
    }
}

/// Receive output until the post-exit silence deadline; a live descendant may keep a pipe open.
fn receive(
    receiver: &Receiver<Message>,
    idle_until: Option<Instant>,
) -> Result<Message, RecvTimeoutError> {
    let wait = match idle_until {
        // An expired deadline is not silence while reader messages are already queued.
        Some(idle) => idle.saturating_duration_since(Instant::now()),
        None => Duration::from_secs(3600),
    };
    receiver.recv_timeout(wait)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drains_queued_tail_and_eof_after_exit_deadline() {
        let (sender, receiver) = mpsc::channel();
        // The runner can resume after its deadline with the final reader chunk already queued.
        sender.send(Message::Data(0, vec![120; 64 * 1024])).unwrap();
        sender.send(Message::Eof(0)).unwrap();
        sender.send(Message::Eof(1)).unwrap();
        let expired = Some(Instant::now() - EXIT_STDIO_GRACE);
        let Ok(Message::Data(stream, bytes)) = receive(&receiver, expired) else {
            panic!("queued final 64 KiB was discarded as silence");
        };
        assert_eq!(stream, 0);
        assert_eq!(bytes, vec![120; 64 * 1024]);
        assert!(matches!(receive(&receiver, expired), Ok(Message::Eof(0))));
        assert!(matches!(receive(&receiver, expired), Ok(Message::Eof(1))));
        assert!(matches!(
            receive(&receiver, expired),
            Err(RecvTimeoutError::Timeout)
        ));
    }

    /// A link that accepts nothing until `open_at`, like a client that stops reading; it keeps what it was sent.
    #[cfg(target_os = "linux")]
    struct Link {
        open_at: Instant,
        sent: Arc<Mutex<Vec<u8>>>,
    }

    #[cfg(target_os = "linux")]
    impl std::io::Write for Link {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            thread::sleep(self.open_at.saturating_duration_since(Instant::now()));
            self.sent.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Run `script` through `run` with output going to a link closed for `closed_for`, behind more unsent output than
    /// the limit, so reading waits for the link after the first chunk. Returns how long `run` took, the output, and
    /// what reached the link.
    #[cfg(target_os = "linux")]
    fn run_behind_closed_link(
        script: &str,
        closed_for: Duration,
    ) -> (Duration, Arc<Output>, Arc<Mutex<Vec<u8>>>) {
        let output = Arc::new(Output::default());
        let sent = Arc::new(Mutex::new(Vec::new()));
        let mut link = Link {
            open_at: Instant::now() + closed_for,
            sent: sent.clone(),
        };
        // The writer takes the first and waits on the closed link; the second stays unsent.
        for _ in 0..2 {
            output.bulk(
                Frame::with_payload(EVENT, 99, json!({}), vec![0; 4 * 1024 * 1024 + 1]),
                None,
            );
        }
        let writer = output.clone();
        thread::spawn(move || writer.run(&mut link));
        let request = ProcessRequest::from_json(&json!({
            "argv": ["sh", "-c", script],
            "cwd": std::env::temp_dir().to_str().unwrap(),
        }))
        .unwrap();
        let started = Instant::now();
        let reply = run(
            1,
            request,
            &output,
            &Control::default(),
            &Groups::default(),
            &Processes::default(),
        );
        assert_eq!(reply.unwrap()["exitCode"], 0);
        (started.elapsed(), output, sent)
    }

    #[cfg(target_os = "linux")]
    fn stdout_bytes(sent: &[u8]) -> usize {
        let mut input = std::io::Cursor::new(sent);
        let mut total = 0;
        while let Some(frame) = crate::frame::read_frame(&mut input).unwrap() {
            if frame.kind == EVENT
                && frame.json["kind"] == "output"
                && frame.json["stream"] == "stdout"
            {
                total += frame.payload.len();
            }
        }
        total
    }

    /// One byte more than a Linux pipe holds: the program exits with its last bytes in the pipe while the reader waits.
    #[cfg(target_os = "linux")]
    const PAST_PIPE: usize = 64 * 1024 + 1;

    #[cfg(target_os = "linux")]
    #[test]
    fn delivers_output_left_in_the_pipe_when_the_link_is_slower_than_the_exit_grace() {
        let closed_for = Duration::from_millis(500);
        let (_, output, sent) =
            run_behind_closed_link(&format!("head -c {PAST_PIPE} /dev/zero"), closed_for);
        output.close();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Arc::strong_count(&output) > 1 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(stdout_bytes(&sent.lock().unwrap()), PAST_PIPE);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ends_and_stops_reading_when_the_link_never_drains() {
        let (took, output, _) = run_behind_closed_link(
            &format!("head -c {PAST_PIPE} /dev/zero"),
            Duration::from_secs(30),
        );
        assert!(took < Duration::from_secs(2), "run took {took:?}");
        // The readers end and release the output: only this test and the stuck writer hold it.
        let deadline = Instant::now() + Duration::from_secs(1);
        while Arc::strong_count(&output) > 2 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(Arc::strong_count(&output), 2);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ends_after_the_silence_while_a_descendant_holds_the_pipe() {
        let (took, output, sent) = run_behind_closed_link(
            &format!("sleep 5 & head -c {PAST_PIPE} /dev/zero"),
            Duration::from_millis(500),
        );
        assert!(took < Duration::from_secs(2), "run took {took:?}");
        output.close();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Arc::strong_count(&output) > 1 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(stdout_bytes(&sent.lock().unwrap()), PAST_PIPE);
    }

    #[test]
    fn receives_cancel_after_exit_deadline() {
        let (sender, receiver) = mpsc::channel();
        sender.send(Message::Cancel).unwrap();
        assert!(matches!(
            receive(&receiver, Some(Instant::now() - EXIT_STDIO_GRACE)),
            Ok(Message::Cancel)
        ));
    }
}
