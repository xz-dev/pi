// SPDX-License-Identifier: BSD-3-Clause
#![cfg(unix)]
use rustix::{
    fd::{AsRawFd, BorrowedFd},
    fs::{self, OFlags},
    io::{self as rio, Errno, FdFlags},
    process::{self, Pid, Signal},
};
use std::{
    fs as stdfs,
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

// BSD openpty sets CLOEXEC non-atomically; keep fixture process creation isolated.
static SPAWN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Terminal {
    dir: PathBuf,
    host: Child,
    master: rustix::fd::OwnedFd,
    output: String,
    sequence: usize,
}
impl Terminal {
    fn new(label: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("procward-terminal-{}-{label}", std::process::id()));
        stdfs::create_dir(&dir).unwrap();
        if ["redirect", "never-raw"].contains(&label) {
            stdfs::write(dir.join(label), label).unwrap();
        }
        let pty = rustix_openpty::openpty(None, None).unwrap();
        if label == "blocked" {
            let mut state = rustix::termios::tcgetattr(&pty.user).unwrap();
            state.local_modes |= rustix::termios::LocalModes::TOSTOP;
            rustix::termios::tcsetattr(&pty.user, rustix::termios::OptionalActions::Now, &state)
                .unwrap();
        }
        fs::fcntl_setfl(&pty.controller, OFlags::NONBLOCK).unwrap();
        let raw = pty.user.as_raw_fd();
        let fixture = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("examples/fixture");
        let mut host = Command::new(fixture);
        host.arg("terminal-host")
            .arg(raw.to_string())
            .arg(env!("CARGO_BIN_EXE_procward"))
            .arg(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        unsafe {
            host.pre_exec(move || {
                rio::fcntl_setfd(BorrowedFd::borrow_raw(raw), FdFlags::empty())?;
                Ok(())
            });
        }
        let host = host.spawn().unwrap();
        drop(pty.user);
        Self {
            dir,
            host,
            master: pty.controller,
            output: String::new(),
            sequence: 0,
        }
    }
    fn observe(&mut self) {
        loop {
            let mut bytes = [0; 8192];
            match rio::read(&self.master, &mut bytes) {
                Ok(0) | Err(Errno::AGAIN | Errno::IO) => return,
                Ok(count) => self
                    .output
                    .push_str(&String::from_utf8_lossy(&bytes[..count])),
                Err(Errno::INTR) => {}
                Err(error) => panic!("terminal read: {error}"),
            }
        }
    }
    fn until(&mut self, description: &str, check: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            self.observe();
            if check(self) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "{description}: deadline; result={:?}; tail_written={}; physical_queue={:?}; bytes={}; transcript_tail={:?}",
                stdfs::read_to_string(self.dir.join("result")),
                self.dir.join("tail-written").exists(),
                rio::ioctl_fionread(&self.master),
                self.output.len(),
                String::from_utf8_lossy(
                    &self.output.as_bytes()[self.output.len().saturating_sub(4096)..]
                )
            );
            let mut readiness = [rustix::event::PollFd::new(
                &self.master,
                rustix::event::PollFlags::IN,
            )];
            match rustix::event::poll(
                &mut readiness,
                Some(&rustix::event::Timespec {
                    tv_sec: 0,
                    tv_nsec: 2_000_000,
                }),
            ) {
                Ok(_) | Err(Errno::INTR) => {}
                Err(error) => panic!("terminal readiness query failed: {error}"),
            }
        }
    }
    fn input(&mut self, bytes: &[u8]) {
        rio::write(&self.master, bytes).unwrap();
    }
    fn action(&mut self, text: &str) {
        let n = self.sequence;
        let record = self.dir.join("action.tmp");
        stdfs::write(&record, text).unwrap();
        stdfs::rename(record, self.dir.join(format!("action-{n}"))).unwrap();
        self.until("shell action acknowledgement", |t| {
            t.dir.join(format!("acted-{n}")).exists()
        });
        self.sequence += 1;
    }
    fn finish_host(&mut self) -> std::process::ExitStatus {
        stdfs::write(self.dir.join("finish"), b"observations complete").unwrap();
        self.host.wait().unwrap()
    }
    fn file(&self, name: &str) -> String {
        stdfs::read_to_string(self.dir.join(name)).unwrap()
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        if self.host.try_wait().ok().flatten().is_none() {
            eprintln!("HARNESS RESCUE: terminal host/owned identities; not product cleanup");
            for name in ["primary", "owner"] {
                if let Ok(text) = stdfs::read_to_string(self.dir.join(name)) {
                    if let Some(pid) = text.parse().ok().and_then(Pid::from_raw) {
                        let _ = process::kill_process(pid, Signal::KILL);
                    }
                }
            }
            let _ = self.host.kill();
            let _ = self.host.wait();
        }
        let _ = stdfs::remove_dir_all(&self.dir);
    }
}

#[test]
fn interactive_primary_has_private_foreground_terminal_and_preserves_tail_and_status() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut terminal = Terminal::new("isolation");
    terminal.until("primary terminal readiness", |t| {
        t.dir.join("terminal").exists()
    });
    let facts: Vec<i32> = terminal
        .file("terminal")
        .split_whitespace()
        .map(|v| v.parse().unwrap())
        .collect();
    let primary: i32 = terminal.file("primary").parse().unwrap();
    assert_eq!(facts[0], primary, "primary must lead its foreground group");
    assert_eq!(
        facts[1], primary,
        "primary must own private foreground, not shell foreground"
    );
    let keeper: i32 = terminal.file("keeper").parse().unwrap();
    assert_eq!(facts[2], keeper, "live native keeper owns private session");
    assert_ne!(
        facts[2].to_string(),
        terminal.file("shell-session"),
        "private session must differ from physical shell"
    );
    process::test_kill_process(Pid::from_raw(keeper).unwrap()).unwrap();
    terminal.until("ready output", |t| t.output.contains("TTY-READY"));
    terminal.input(b"q");
    terminal.until("task result and final output", |t| {
        t.dir.join("result").exists() && t.output.contains("FINAL-TAIL")
    });
    assert_eq!(terminal.file("result"), "23");
    terminal.until("host exit", |t| t.dir.join("restored").exists());
    assert_eq!(
        terminal.file("restored"),
        "true",
        "saved={} actual={}",
        terminal.file("saved-state"),
        terminal.file("returned-state")
    );
    assert!(terminal.finish_host().success());
}

#[test]
fn shell_reclaim_does_not_block_fatal_cleanup_or_kill_shell() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut terminal = Terminal::new("reclaim");
    terminal.until("ready output", |t| t.output.contains("TTY-READY"));
    terminal.action("reclaim");
    let fault = Instant::now();
    terminal.action("term");
    terminal.until("cleanup after shell reclaim", |t| {
        t.dir.join("restored").exists()
    });
    assert!(
        fault.elapsed() < Duration::from_secs(2),
        "configured deadline must bound reclaimed-terminal cleanup"
    );
    assert!(
        terminal.finish_host().success(),
        "unrelated shell must survive"
    );
}

fn stopped(pid: &str) -> bool {
    #[cfg(target_os = "linux")]
    return stdfs::read_to_string(format!("/proc/{pid}/stat"))
        .unwrap()
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .next()
        == Some("T");
    #[cfg(not(target_os = "linux"))]
    {
        let state = Command::new("ps")
            .args(["-o", "state=", "-p", pid])
            .output()
            .unwrap();
        assert!(
            state.status.success(),
            "process state query failed: {state:?}"
        );
        String::from_utf8(state.stdout)
            .unwrap()
            .trim()
            .starts_with('T')
    }
}

#[test]
fn repeated_stop_background_foreground_freezes_detached_work_and_reconciles_cont_race() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut terminal = Terminal::new("job-control");
    terminal.until("primary and detached worker readiness", |t| {
        t.output.contains("TTY-READY") && t.dir.join("worker").exists()
    });
    for cycle in 0..3 {
        let _ = stdfs::remove_file(terminal.dir.join("stopped"));
        terminal.input(&[26]);
        terminal.until("shell sees stopped job", |t| t.dir.join("stopped").exists());
        assert_eq!(
            terminal.file("stopped"),
            "true",
            "pause must restore saved cooked settings; saved={} actual={}",
            terminal.file("saved-state"),
            terminal.file("paused-state")
        );
        terminal.until("primary and detached worker stopped", |t| {
            stopped(&t.file("primary")) && stopped(&t.file("worker")) && stopped(&t.file("keeper"))
        });
        terminal.action("race");
        terminal.until("freeze wins detached CONT race without extra Ctrl-Z", |t| {
            stopped(&t.file("worker"))
        });
        terminal.action("bg");
        terminal.until("private work resumed in background", |t| {
            !stopped(&t.file("worker")) && !stopped(&t.file("primary"))
        });
        terminal.input(b"p");
        stdfs::write(terminal.dir.join(format!("ping-{cycle}")), b"ping").unwrap();
        terminal.until("background worker response", |t| {
            t.dir.join(format!("pong-{cycle}")).exists()
        });
        let previous = terminal.output.matches("REPLY").count();
        assert_eq!(
            previous, cycle,
            "background job must not steal physical input/output"
        );
        terminal.action("fg");
        terminal.until("foreground input/output restored", |t| {
            t.output.matches("REPLY").count() == cycle + 1
        });
    }
    terminal.input(b"q");
    terminal.until("result and tail", |t| {
        t.dir.join("result").exists() && t.output.contains("FINAL-TAIL")
    });
    assert_eq!(terminal.file("result"), "23");
    assert!(terminal.finish_host().success());
}

// Drops only procward's one visible weaker-backend startup diagnostic from a transcript.
fn payload_output(output: &str) -> String {
    output
        .split_inclusive('\n')
        .filter(|line| {
            !(cfg!(target_os = "linux")
                && line.starts_with("procward: Linux cgroup v2 workload group unavailable (")
                && line
                    .trim_end()
                    .ends_with("); cleanup falls back to subreaper and pidfd termination"))
        })
        .collect()
}

#[test]
fn interactive_stderr_keeps_its_redirected_destination() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut terminal = Terminal::new("redirect");
    terminal.until("ready output", |t| t.output.contains("TTY-READY"));
    terminal.input(b"q");
    terminal.until("redirected result and output", |t| {
        t.dir.join("result").exists() && t.output.contains("FINAL-TAIL")
    });
    assert_eq!(terminal.file("result"), "23");
    // Only procward's one visible weaker-backend startup diagnostic may precede payload bytes.
    let stderr = terminal.file("stderr");
    let payload = match stderr.split_once('\n') {
        Some((first, rest))
            if cfg!(target_os = "linux")
                && first.starts_with("procward: Linux cgroup v2 workload group unavailable (")
                && first.ends_with("); cleanup falls back to subreaper and pidfd termination") =>
        {
            rest
        }
        _ => stderr.as_str(),
    };
    assert_eq!(payload, "REDIRECTED-TAIL\n");
    assert!(!terminal.output.contains("REDIRECTED-TAIL"));
    assert!(terminal.finish_host().success());
}

#[test]
fn interrupt_is_single_and_normal_final_tail_is_not_discarded() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut terminal = Terminal::new("tail");
    terminal.until("ready output", |t| t.output.contains("TTY-READY"));
    terminal.input(&[3]);
    terminal.input(b"p");
    terminal.until("single interrupt acknowledgement", |t| {
        t.output.contains("REPLY 1")
    });
    terminal.input(b"q");
    terminal.until("complete final tail and result", |t| {
        t.dir.join("returned-state").exists() && t.output.contains("FINAL-TAIL")
    });
    assert_eq!(
        payload_output(&terminal.output)
            .bytes()
            .filter(|b| *b == b'x')
            .count(),
        262144
    );
    assert_eq!(terminal.file("result"), "23");
    assert_eq!(
        terminal.file("restored"),
        "true",
        "saved={} actual={}",
        terminal.file("saved-state"),
        terminal.file("returned-state")
    );
    assert!(terminal.finish_host().success());
}

#[test]
fn fatal_cleanup_discards_blocked_output_and_respects_unrelated_terminal_authority() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut terminal = Terminal::new("blocked");
    terminal.until("ready output", |t| {
        t.output.contains("TTY-READY") && t.dir.join("worker").exists()
    });
    terminal.input(b"f");
    terminal.until("writer starts output", |t| {
        t.output.contains("FLOOD-BEGIN") && t.dir.join("flood-count").exists()
    });
    terminal.action("takeover");
    assert!(
        !terminal.dir.join("flood-done").exists(),
        "writer must still have pending output"
    );
    let fault = Instant::now();
    terminal.action("term");
    terminal.until("fatal cleanup despite blocked physical output", |t| {
        t.dir.join("restored").exists()
    });
    assert!(
        fault.elapsed() < Duration::from_secs(2),
        "configured teardown deadline"
    );
    assert!(terminal.finish_host().success());
    assert_eq!(
        terminal.file("takeover-final"),
        terminal.file("takeover"),
        "denied restoration must not overwrite unrelated foreground state"
    );
}

fn absent(pid: &str) -> bool {
    let target = Pid::from_raw(pid.parse().unwrap()).unwrap();
    match process::waitpid(Some(target), process::WaitOptions::NOHANG) {
        Ok(Some((_, status))) => {
            assert!(status.exit_status().is_some() || status.terminating_signal().is_some())
        }
        Ok(None) | Err(Errno::CHILD | Errno::INTR) => {}
        Err(error) => panic!("owned-child wait failed: {error}"),
    }
    match process::test_kill_process(target) {
        Err(Errno::SRCH) => true,
        Ok(()) => false,
        Err(error) => panic!("liveness query failed: {error}"),
    }
}

#[test]
fn owner_loss_while_paused_cleans_work_without_foreground_rescue() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut terminal = Terminal::new("paused-loss");
    terminal.until("primary and worker ready", |t| {
        t.output.contains("TTY-READY") && t.dir.join("worker").exists()
    });
    terminal.input(&[26]);
    terminal.until("job stopped", |t| {
        t.dir.join("stopped").exists() && stopped(&t.file("worker"))
    });
    terminal.action("takeover");
    let fault = Instant::now();
    terminal.action("kill");
    terminal.until("tree and independent cleanup role gone", |t| {
        ["primary", "worker", "keeper", "anchor"]
            .iter()
            .all(|name| absent(&t.file(name)))
    });
    assert!(
        fault.elapsed() < Duration::from_secs(2),
        "configured teardown deadline"
    );
    stdfs::write(terminal.dir.join("finish"), b"complete").unwrap();
    assert!(terminal.finish_host().success());
    assert_eq!(terminal.file("takeover-final"), terminal.file("takeover"));
}

#[test]
fn repeated_blocked_terminal_cleanup_survives_foreground_reclaim() {
    let iterations = std::env::var("PROCWARD_TERMINAL_STRESS")
        .map(|value| value.parse::<usize>().unwrap())
        .unwrap_or(8);
    assert!(iterations >= 8);
    for iteration in 1..=iterations {
        eprintln!("blocked terminal iteration {iteration}/{iterations}");
        fatal_cleanup_discards_blocked_output_and_respects_unrelated_terminal_authority();
    }
}

// A fresh test-owned child of this test's own group with cgroup.max.descendants 0 forces the
// weaker backend; None means the own group is not writable, so procward falls back anyway.
#[cfg(target_os = "linux")]
struct FallbackGroup(PathBuf);
#[cfg(target_os = "linux")]
impl FallbackGroup {
    fn new(tag: &str) -> Option<Self> {
        let membership = stdfs::read_to_string("/proc/self/cgroup").unwrap();
        let own = membership
            .lines()
            .find_map(|line| line.strip_prefix("0::"))?;
        let base = PathBuf::from("/sys/fs/cgroup").join(own.trim_start_matches('/'));
        let path = base.join(format!("procward-test-{}-{tag}", std::process::id()));
        match stdfs::create_dir(&path) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied
                        | std::io::ErrorKind::ReadOnlyFilesystem
                        | std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::WouldBlock
                ) =>
            {
                return None;
            }
            Err(error) => panic!("test fallback group: {error}"),
        }
        let group = Self(path);
        stdfs::write(group.0.join("cgroup.max.descendants"), "0").unwrap();
        Some(group)
    }
}
#[cfg(target_os = "linux")]
impl Drop for FallbackGroup {
    fn drop(&mut self) {
        let events = stdfs::read_to_string(self.0.join("cgroup.events")).unwrap();
        if events.contains("populated 1") {
            stdfs::write(self.0.join("cgroup.kill"), "1").unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while stdfs::read_to_string(self.0.join("cgroup.events"))
                .unwrap()
                .contains("populated 1")
            {
                assert!(Instant::now() < deadline, "test fallback group kill");
                std::thread::sleep(Duration::from_millis(5));
            }
            eprintln!("HARNESS RESCUE: test fallback group still populated; NOT product cleanup");
        }
        stdfs::remove_dir(&self.0).unwrap();
        assert!(
            !events.contains("populated 1") || std::thread::panicking(),
            "test fallback group needed rescue"
        );
    }
}

// Runs procward as a background job of a TOSTOP terminal; returns (transcript, result dir).
#[cfg(target_os = "linux")]
fn background_tostop(label: &str, mode: &str, redirect: bool) -> (String, PathBuf) {
    let dir = std::env::temp_dir().join(format!("procward-tostop-{}-{label}", std::process::id()));
    let _ = stdfs::remove_dir_all(&dir);
    stdfs::create_dir(&dir).unwrap();
    if redirect {
        stdfs::write(dir.join("redirect"), "redirect").unwrap();
    }
    let forced = FallbackGroup::new(label);
    let pty = rustix_openpty::openpty(None, None).unwrap();
    fs::fcntl_setfl(&pty.controller, OFlags::NONBLOCK).unwrap();
    let raw = pty.user.as_raw_fd();
    let fixture = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/fixture");
    let mut host = Command::new(fixture);
    host.arg("tostop-host")
        .arg(raw.to_string())
        .arg(env!("CARGO_BIN_EXE_procward"))
        .arg(&dir)
        .arg(mode)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Some(group) = &forced {
        host.env("PROCWARD_TEST_FALLBACK_GROUP", &group.0);
    }
    unsafe {
        host.pre_exec(move || {
            rio::fcntl_setfd(BorrowedFd::borrow_raw(raw), FdFlags::empty())?;
            Ok(())
        });
    }
    let mut host = host.spawn().unwrap();
    drop(pty.user);
    let mut output = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let mut bytes = [0; 4096];
        match rio::read(&pty.controller, &mut bytes) {
            Ok(0) | Err(Errno::AGAIN | Errno::IO) => {}
            Ok(count) => output.extend_from_slice(&bytes[..count]),
            Err(Errno::INTR) => {}
            Err(error) => panic!("terminal read: {error}"),
        }
        if let Some(status) = host.try_wait().unwrap() {
            assert!(
                status.success(),
                "tostop host failed: {status}: {:?}",
                String::from_utf8_lossy(&output)
            );
            break;
        }
        if Instant::now() >= deadline {
            eprintln!("HARNESS RESCUE: tostop host deadline; NOT product behaviour");
            let _ = host.kill();
            let _ = host.wait();
            panic!("tostop host deadline");
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    while let Ok(count @ 1..) = rio::read(&pty.controller, &mut [0; 4096][..]) {
        let _ = count;
    }
    drop(forced);
    (String::from_utf8_lossy(&output).into_owned(), dir)
}

#[cfg(target_os = "linux")]
#[test]
fn background_tostop_diagnostic_is_denied_without_leak_or_signal_storm() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let read = |dir: &PathBuf, name: &str| stdfs::read_to_string(dir.join(name)).unwrap();
    // Control: with stderr redirected, the same background run does attempt the diagnostic.
    let (_, control) = background_tostop("control", "plain", true);
    assert_eq!(read(&control, "result"), "7");
    assert!(
        read(&control, "stderr").contains("cgroup v2 workload group unavailable"),
        "control run did not attempt the fallback diagnostic: {:?}",
        read(&control, "stderr")
    );
    stdfs::remove_dir_all(&control).unwrap();
    {
        let mode = "plain";
        let (transcript, dir) = background_tostop(mode, mode, false);
        let (result, ttou, stops, cpu, elapsed) = (
            read(&dir, "result"),
            read(&dir, "ttou-count"),
            read(&dir, "stops"),
            read(&dir, "cpu-ms"),
            read(&dir, "elapsed-ms"),
        );
        stdfs::remove_dir_all(&dir).unwrap();
        eprintln!(
            "TOSTOP {mode}: result {result} SIGTTOU {ttou} stops {stops} cpu {cpu}ms elapsed {elapsed}ms"
        );
        assert_eq!(result, "7", "{mode}: payload status");
        assert!(
            !transcript.contains("procward:"),
            "{mode}: kernel-denied diagnostic reached the TOSTOP terminal: {transcript:?}"
        );
        let ttou: usize = ttou.parse().unwrap();
        // Absolute caps are native-speed calibrations; on emulated CI vCPUs normal
        // runs reach hundreds of ms of CPU and dozens of allowed per-operation
        // SIGTTOU deliveries. A real storm burns a whole core for the whole run,
        // so bound CPU by elapsed wall time; keep the signal count only as a
        // generous runaway backstop.
        let (cpu, elapsed): (u64, u64) = (cpu.parse().unwrap(), elapsed.parse().unwrap());
        assert!(ttou <= 64, "{mode}: SIGTTOU storm: {ttou} signals");
        assert!(
            elapsed > 0 && cpu < elapsed,
            "{mode}: retry storm burned {cpu} ms CPU in {elapsed} ms"
        );
    }
}

#[test]
fn anchor_loss_restores_raw_terminal_only_with_foreground_authority() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    for takeover in [false, true] {
        let mut terminal = Terminal::new("anchor-loss");
        terminal.until("raw payload ready", |t| {
            t.output.contains("TTY-READY") && t.dir.join("worker").exists()
        });
        if takeover {
            terminal.action("takeover");
        }
        let fault = Instant::now();
        terminal.action("kill-anchor");
        terminal.until("surviving owner restores after anchor loss", |t| {
            t.dir.join("returned-state").exists()
        });
        assert_eq!(terminal.file("result"), "125");
        assert!(
            fault.elapsed() < Duration::from_secs(2),
            "configured teardown deadline"
        );
        if terminal.output.contains(
            "procward: macOS best-effort observer lost; pre-observation descendants may escape after reparenting",
        ) {
            eprintln!(
                "HARNESS CLEANUP: Darwin pre-observation observer-loss window; known terminal fixtures cleaned by test, NOT product cleanup"
            );
            for name in ["primary", "worker", "keeper", "anchor"] {
                let pid = terminal.file(name);
                if !absent(&pid) {
                    match process::kill_process(
                        Pid::from_raw(pid.parse().unwrap()).unwrap(),
                        Signal::KILL,
                    ) {
                        Ok(()) | Err(Errno::SRCH) => {}
                        Err(error) => panic!("known terminal fixture cleanup failed: {error}"),
                    }
                }
            }
        }
        terminal.until("owned identities gone", |t| {
            ["primary", "worker", "keeper", "anchor"]
                .iter()
                .all(|name| absent(&t.file(name)))
        });
        assert!(terminal.finish_host().success());
        if takeover {
            assert_eq!(
                terminal.file("takeover-final"),
                terminal.file("takeover"),
                "failover restoration must not overwrite unrelated foreground state"
            );
        } else {
            assert_eq!(
                terminal.file("restored"),
                "true",
                "saved={} actual={}",
                terminal.file("saved-state"),
                terminal.file("returned-state")
            );
        }
    }
}

#[test]
fn never_raw_anchor_loss_preserves_newer_shell_settings() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut terminal = Terminal::new("never-raw");
    terminal.until("background private payload ready", |t| {
        t.dir.join("ready").exists() && t.dir.join("worker").exists()
    });
    terminal.action("stop-anchor");
    terminal.until("anchor stopped before foreground handoff", |t| {
        stopped(&t.file("anchor"))
    });
    assert_eq!(
        format!(
            "{:?}",
            rustix::termios::tcgetattr(&terminal.master).unwrap()
        ),
        terminal.file("saved-state"),
        "background relay must never have made physical terminal raw"
    );
    terminal.action("takeover");
    terminal.action("handoff");
    terminal.action("kill-anchor");
    terminal.until("owner completes never-raw failover", |t| {
        t.dir.join("returned-state").exists()
    });
    assert_eq!(terminal.file("result"), "125");
    assert_eq!(
        terminal.file("returned-state"),
        terminal.file("takeover"),
        "never-raw failover must not restore stale startup settings"
    );
    terminal.until("owned identities gone", |t| {
        ["primary", "worker", "keeper", "anchor"]
            .iter()
            .all(|name| absent(&t.file(name)))
    });
    assert!(terminal.finish_host().success());
}

#[test]
fn reacquired_terminal_failover_restores_latest_shell_settings() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut terminal = Terminal::new("reacquire");
    terminal.until("raw payload ready", |t| {
        t.output.contains("TTY-READY") && t.dir.join("worker").exists()
    });
    terminal.input(&[26]);
    terminal.until("pause releases physical terminal", |t| {
        t.dir.join("stopped").exists() && stopped(&t.file("worker"))
    });
    assert_eq!(terminal.file("stopped"), "true");
    terminal.action("takeover");
    terminal.action("fg");
    terminal.input(b"p");
    terminal.until("reacquired relay delivers input", |t| {
        t.output.contains("REPLY 0")
    });
    terminal.action("kill-anchor");
    terminal.until("owner completes reacquired failover", |t| {
        t.dir.join("returned-state").exists()
    });
    assert_eq!(terminal.file("result"), "125");
    assert_eq!(
        terminal.file("returned-state"),
        terminal.file("takeover"),
        "reacquisition must save current settings, not reuse startup state"
    );
    terminal.until("owned identities gone", |t| {
        ["primary", "worker", "keeper", "anchor"]
            .iter()
            .all(|name| absent(&t.file(name)))
    });
    assert!(terminal.finish_host().success());
}

#[test]
fn released_terminal_anchor_loss_preserves_newer_shell_settings() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut terminal = Terminal::new("released");
    terminal.until("raw payload ready", |t| {
        t.output.contains("TTY-READY") && t.dir.join("worker").exists()
    });
    terminal.input(&[26]);
    terminal.until("pause releases physical terminal", |t| {
        t.dir.join("stopped").exists() && stopped(&t.file("worker"))
    });
    assert_eq!(terminal.file("stopped"), "true");
    terminal.action("takeover");
    terminal.action("handoff");
    terminal.action("continue-owner");
    terminal.action("kill-anchor");
    terminal.until("owner completes released-terminal failover", |t| {
        t.dir.join("returned-state").exists()
    });
    assert_eq!(terminal.file("result"), "125");
    assert_eq!(
        terminal.file("returned-state"),
        terminal.file("takeover"),
        "released acquisition must not authorize a later stale restore"
    );
    terminal.until("owned identities gone", |t| {
        ["primary", "worker", "keeper", "anchor"]
            .iter()
            .all(|name| absent(&t.file(name)))
    });
    assert!(terminal.finish_host().success());
}
