//! Deterministic Linux syscall timing: ptrace selects a window, then detaches before assertions.
#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

#[cfg(target_env = "musl")]
use libc::c_int as PtraceRequest;
#[cfg(not(target_env = "musl"))]
use libc::c_uint as PtraceRequest;
use std::fs;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug)]
enum Window {
    OuterAcquire,
    GuardianBorn,
    GuardianAcquire,
    PrimaryFork,
    PrimaryBorn,
    PrimaryGate,
    PostGrantUnmask,
    PrimaryExec,
}
static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

struct Fixture {
    child: Child,
    traced: Option<i32>,
    root: PathBuf,
    guardian: i32,
    primary: i32,
    lease: Option<UnixStream>,
    reaped: bool,
    primary_pin: Option<OwnedFd>,
    gate_fd: Option<u64>,
}
impl Fixture {
    fn start(window: Window) -> Self {
        Self::start_inner(window, false)
    }
    fn start_inner(window: Window, control: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "pi-startup-{}-{}-{window:?}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let (lease, inherited) = if control {
            let (lease, inherited) = UnixStream::pair().unwrap();
            (Some(lease), Some(inherited))
        } else {
            (None, None)
        };
        let fd = inherited.as_ref().map(AsRawFd::as_raw_fd);
        let mut command = Command::new(env!("CARGO_BIN_EXE_pi-env"));
        command.arg("supervise");
        if let Some(fd) = fd {
            command.args(["--control-fd", &fd.to_string()]);
        }
        command
            .args([
                "--",
                "/bin/sh",
                "-c",
                "printf started > \"$1/started\"; exec /bin/sleep 60",
                "sh",
            ])
            .arg(&root)
            .env("PI_PROCESS_OWNER_PENDING", "1")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(fs::File::create(root.join("stderr")).unwrap()));
        unsafe {
            command.pre_exec(move || {
                if let Some(fd) = fd
                    && libc::fcntl(fd, libc::F_SETFD, 0) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ptrace(libc::PTRACE_TRACEME, 0, 0, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command
            .spawn()
            .expect("unprivileged child PTRACE_TRACEME required");
        drop(inherited);
        let pid = child.id() as i32;
        let fixture = Self {
            child,
            traced: Some(pid),
            root,
            guardian: 0,
            primary: 0,
            lease,
            reaped: false,
            primary_pin: None,
            gate_fd: None,
        };
        let status = wait_trace(pid);
        assert!(libc::WIFSTOPPED(status));
        ptrace(
            libc::PTRACE_SETOPTIONS,
            pid,
            (libc::PTRACE_O_TRACESYSGOOD
                | libc::PTRACE_O_TRACEFORK
                | libc::PTRACE_O_TRACEVFORK
                | libc::PTRACE_O_TRACECLONE
                | libc::PTRACE_O_TRACEEXEC) as usize,
        );
        fixture
    }
    fn inject(&mut self, window: Window) {
        let mut pid = self.traced.unwrap();
        let mut gate_fd = None;
        let mut exec_seen = false;
        let mut grant_received = false;
        for _ in 0..10000 {
            ptrace(libc::PTRACE_SYSCALL, pid, 0);
            let status = wait_trace(pid);
            assert!(
                libc::WIFSTOPPED(status),
                "tracee exited before {window:?}: {status}"
            );
            let event = status >> 16;
            if event == libc::PTRACE_EVENT_FORK
                || event == libc::PTRACE_EVENT_VFORK
                || event == libc::PTRACE_EVENT_CLONE
            {
                let mut child = 0usize;
                ptrace(
                    libc::PTRACE_GETEVENTMSG,
                    pid,
                    (&mut child as *mut usize) as usize,
                );
                ptrace(libc::PTRACE_DETACH, pid, 0);
                pid = child as i32;
                self.traced = Some(pid);
                gate_fd = None;
                exec_seen = false;
                grant_received = false;
                if self.guardian == 0 {
                    self.guardian = pid;
                } else {
                    self.primary = pid;
                }
                assert!(libc::WIFSTOPPED(wait_trace(pid)));
                if (matches!(window, Window::GuardianBorn) && self.primary == 0)
                    || (matches!(window, Window::PrimaryBorn) && self.primary != 0)
                {
                    self.pause_at(pid, window);
                    return;
                }
                continue;
            }
            if event == libc::PTRACE_EVENT_EXEC {
                exec_seen = true;
                assert!(
                    !matches!(window, Window::PrimaryGate),
                    "exec occurred before calibrated gate receive"
                );
                continue;
            }
            let stop = libc::WSTOPSIG(status);
            if stop != (libc::SIGTRAP | 0x80) {
                assert_eq!(stop, libc::SIGTRAP);
                continue;
            }
            let mut regs: libc::user_regs_struct = unsafe { std::mem::zeroed() };
            ptrace(
                libc::PTRACE_GETREGS,
                pid,
                (&mut regs as *mut libc::user_regs_struct) as usize,
            );
            // x86-64 marks syscall entry with -ENOSYS; fork-child stops break parity counting.
            let entry = regs.rax == (-i64::from(libc::ENOSYS)) as u64;
            if entry
                && pid == self.primary
                && regs.orig_rax == libc::SYS_sendto as u64
                && regs.rdx == 1
            {
                unsafe {
                    *libc::__errno_location() = 0;
                }
                let word =
                    unsafe { libc::ptrace(libc::PTRACE_PEEKDATA, pid, regs.rsi as usize, 0) };
                assert_eq!(
                    unsafe { *libc::__errno_location() },
                    0,
                    "read gate request byte"
                );
                if word as u8 == b'R' {
                    gate_fd = Some(regs.rdi);
                }
            }
            if !entry
                && pid == self.primary
                && regs.orig_rax == libc::SYS_recvfrom as u64
                && gate_fd == Some(regs.rdi)
                && regs.rax == 1
            {
                grant_received = true;
            }
            let acquire = regs.orig_rax == libc::SYS_prctl as u64
                && regs.rdi == libc::PR_SET_CHILD_SUBREAPER as u64;
            let selected = entry
                && match window {
                    Window::GuardianBorn | Window::PrimaryBorn => false,
                    Window::OuterAcquire => pid == self.child.id() as i32 && acquire,
                    Window::GuardianAcquire => pid == self.guardian && acquire,
                    Window::PrimaryFork => {
                        pid == self.guardian
                            && [libc::SYS_clone, libc::SYS_clone3, libc::SYS_vfork]
                                .contains(&(regs.orig_rax as i64))
                    }
                    Window::PrimaryGate => {
                        pid == self.primary
                            && regs.orig_rax == libc::SYS_sendto as u64
                            && gate_fd == Some(regs.rdi)
                            && regs.rdx == 1
                    }
                    Window::PostGrantUnmask => {
                        pid == self.primary
                            && grant_received
                            && regs.orig_rax == libc::SYS_rt_sigprocmask as u64
                            && regs.rdi == libc::SIG_UNBLOCK as u64
                    }
                    Window::PrimaryExec => {
                        pid == self.primary && regs.orig_rax == libc::SYS_execve as u64
                    }
                };
            if selected {
                if matches!(window, Window::PrimaryGate | Window::PostGrantUnmask) {
                    assert!(!exec_seen);
                    let exe = fs::read_link(format!("/proc/{pid}/exe")).unwrap();
                    assert_eq!(exe, fs::canonicalize(env!("CARGO_BIN_EXE_pi-env")).unwrap());
                    let fd = gate_fd.unwrap();
                    if matches!(window, Window::PrimaryGate) {
                        let link = fs::read_link(format!("/proc/{pid}/fd/{fd}")).unwrap();
                        assert!(link.to_string_lossy().starts_with("socket:["));
                        println!(
                            "PrimaryGate calibrated: before publishing R, sendto fd={fd} link={} exe={} exec_seen={exec_seen}",
                            link.display(),
                            exe.display()
                        );
                    } else {
                        println!(
                            "PostGrantUnmask calibrated: G received, rt_sigprocmask(SIG_UNBLOCK), exe={} exec_seen={exec_seen}",
                            exe.display()
                        );
                    }
                    self.gate_fd = gate_fd;
                }
                self.pause_at(pid, window);
                return;
            }
        }
        panic!("startup trace window not reached: {window:?}");
    }
    fn pause_at(&mut self, pid: i32, window: Window) {
        assert_eq!(
            unsafe { libc::kill(-(self.child.id() as i32), libc::SIGTSTP) },
            0
        );
        ptrace(libc::PTRACE_DETACH, pid, 0);
        self.traced = None;
        thread::sleep(Duration::from_millis(150));
        if matches!(window, Window::PrimaryGate) {
            thread::sleep(Duration::from_millis(150));
            let syscall = fs::read_to_string(format!("/proc/{pid}/syscall")).unwrap();
            let fields: Vec<_> = syscall.split_whitespace().collect();
            assert_eq!(fields[0].parse::<i64>().unwrap(), libc::SYS_recvfrom);
            assert_eq!(
                u64::from_str_radix(fields[1].trim_start_matches("0x"), 16).unwrap(),
                self.gate_fd.unwrap()
            );
            assert!(matches!(state(pid), 'S' | 'R' | 'D'));
            assert_eq!(
                fs::read_link(format!("/proc/{pid}/exe")).unwrap(),
                fs::canonicalize(env!("CARGO_BIN_EXE_pi-env")).unwrap()
            );
            assert!(
                !fs::read_to_string(self.root.join("stderr"))
                    .unwrap()
                    .contains("freezing unavailable")
            );
            println!(
                "Held native stub: actual syscall={syscall}; remains runnable without disabling payload freezing"
            );
        }
        if matches!(window, Window::PostGrantUnmask) {
            assert_eq!(state(pid), 'T');
            assert_eq!(
                fs::read_link(format!("/proc/{pid}/exe")).unwrap(),
                fs::canonicalize(env!("CARGO_BIN_EXE_pi-env")).unwrap()
            );
        }
        assert_eq!(
            state(self.child.id() as i32),
            'T',
            "outer must really stop: {window:?}"
        );
        assert!(
            !self.root.join("started").exists(),
            "payload executed behind stopped outer: {window:?}"
        );
        if matches!(window, Window::OuterAcquire) {
            for guardian in children(self.child.id() as i32) {
                assert!(
                    children(guardian).is_empty(),
                    "pre-fork stop must precede primary creation"
                );
            }
        }
        for guardian in children(self.child.id() as i32) {
            assert!(
                matches!(state(guardian), 'R' | 'S' | 'D' | 'I'),
                "guardian must remain runnable"
            );
        }
    }
    fn resume_once(&mut self) {
        assert_eq!(
            unsafe { libc::kill(-(self.child.id() as i32), libc::SIGCONT) },
            0
        );
        wait_for(|| self.root.join("started").exists());
        wait_for(|| {
            let guardians = children(self.child.id() as i32);
            let primaries: Vec<_> = guardians.iter().flat_map(|pid| children(*pid)).collect();
            !primaries.is_empty()
                && [self.child.id() as i32]
                    .into_iter()
                    .chain(guardians)
                    .chain(primaries)
                    .all(|pid| matches!(state(pid), 'R' | 'S' | 'D' | 'I'))
        });
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(pid) = self.traced {
            unsafe {
                libc::ptrace(libc::PTRACE_DETACH, pid, 0, 0);
            }
        }
        if !self.reaped {
            // Unreaped outer anchors this fixture group. Cleanup CONT follows assertions only.
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGCONT);
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            let _ = self.child.wait();
        }
        if let Some(fd) = &self.primary_pin {
            // A reaped outer no longer anchors any numeric group/PID. Held pidfd only.
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn ptrace(request: PtraceRequest, pid: i32, data: usize) {
    assert!(
        unsafe { libc::ptrace(request, pid, 0, data) } >= 0,
        "ptrace failed: {}",
        std::io::Error::last_os_error()
    );
}
fn wait_trace(pid: i32) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut status = 0;
        let got = unsafe { libc::waitpid(pid, &mut status, libc::__WALL | libc::WNOHANG) };
        if got == pid {
            return status;
        }
        assert_eq!(
            got,
            0,
            "trace wait failed: {}",
            std::io::Error::last_os_error()
        );
        assert!(Instant::now() < deadline, "trace stop timed out");
        thread::sleep(Duration::from_millis(1));
    }
}
fn children(pid: i32) -> Vec<i32> {
    fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
        .unwrap_or_default()
        .split_whitespace()
        .map(|pid| pid.parse().unwrap())
        .collect()
}
fn state(pid: i32) -> char {
    fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| {
            stat.rsplit_once(") ")
                .and_then(|(_, tail)| tail.chars().next())
        })
        .unwrap_or('X')
}
fn wait_for(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "startup condition timed out");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn pending_startup_pause_prevents_payload_side_effect_until_one_cont() {
    for window in [
        Window::OuterAcquire,
        Window::GuardianBorn,
        Window::GuardianAcquire,
        Window::PrimaryFork,
        Window::PrimaryBorn,
        Window::PrimaryGate,
        Window::PostGrantUnmask,
        Window::PrimaryExec,
    ] {
        let mut fixture = Fixture::start(window);
        fixture.inject(window);
        fixture.resume_once();
        println!("{window:?}: outer stopped, no payload side effect; one CONT resumed session");
    }
}

#[test]
fn paused_preexec_child_terminates_without_exec_when_guardian_is_terminated() {
    let mut fixture = Fixture::start(Window::PrimaryGate);
    fixture.inject(Window::PrimaryGate);
    assert_eq!(unsafe { libc::kill(fixture.guardian, libc::SIGTERM) }, 0);
    wait_for(|| matches!(state(fixture.primary), 'X' | 'Z'));
    assert!(
        !fixture.root.join("started").exists(),
        "teardown must not run payload"
    );
}

#[test]
fn paused_preexec_lease_eof_cleans_child_without_exec_or_fg() {
    let mut fixture = Fixture::start_inner(Window::PrimaryGate, true);
    fixture.inject(Window::PrimaryGate);
    drop(fixture.lease.take());
    wait_for(|| matches!(state(fixture.primary), 'X' | 'Z'));
    assert!(!fixture.root.join("started").exists());
}

#[test]
fn paused_preexec_double_owner_loss_does_not_run_payload() {
    double_owner_loss(Window::PrimaryGate);
}
#[test]
fn postgrant_preexec_double_owner_loss_does_not_run_payload() {
    double_owner_loss(Window::PostGrantUnmask);
}
fn double_owner_loss(window: Window) {
    let mut fixture = Fixture::start(window);
    fixture.inject(window);
    let mut subreaper = 0;
    assert_eq!(
        unsafe { libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &mut subreaper, 0, 0, 0) },
        0
    );
    println!("startup test harness subreaper={subreaper}");
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, fixture.primary, 0) };
    assert!(
        fd >= 0,
        "pin pre-exec child identity: {}",
        std::io::Error::last_os_error()
    );
    fixture.primary_pin = Some(unsafe { OwnedFd::from_raw_fd(fd as i32) });
    assert_eq!(unsafe { libc::kill(fixture.guardian, libc::SIGKILL) }, 0);
    assert_eq!(
        unsafe { libc::kill(fixture.child.id() as i32, libc::SIGKILL) },
        0
    );
    fixture.child.wait().unwrap();
    fixture.reaped = true;
    let stat = fs::read_to_string(format!("/proc/{}/stat", fixture.primary)).unwrap_or_default();
    let parent = stat
        .rsplit_once(") ")
        .and_then(|(_, tail)| tail.split_whitespace().nth(1))
        .unwrap_or("0");
    println!(
        "after outer reap: child={stat}; adopted parent={}",
        fs::read_to_string(format!("/proc/{parent}/stat")).unwrap_or_default()
    );
    wait_for(|| {
        let mut fd = libc::pollfd {
            fd: fixture.primary_pin.as_ref().unwrap().as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        (unsafe { libc::poll(&mut fd, 1, 0) }) == 1 && fd.revents & libc::POLLIN != 0
    });
    assert!(!fixture.root.join("started").exists());
}

#[test]
fn session_control_exec_failure_reports_errno_without_started_record() {
    let (mut peer, inherited) = UnixStream::pair().unwrap();
    let fd = inherited.as_raw_fd();
    let mut command = Command::new(env!("CARGO_BIN_EXE_pi-env"));
    command
        .args([
            "supervise",
            "--control-fd",
            &fd.to_string(),
            "--",
            "/pi-does-not-exist-B2",
        ])
        .env("PI_PROCESS_OWNER_PENDING", "1");
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = command.output().unwrap();
    drop(inherited);
    let mut records = String::new();
    peer.read_to_string(&mut records).unwrap();
    assert_eq!(output.status.code(), Some(125));
    assert!(output.stderr.is_empty());
    assert!(records.starts_with("E2 "));
    assert!(records.ends_with("C\n"));
    assert!(!records.lines().any(|line| line.starts_with(['S', 'X'])));
}

#[test]
fn session_preserves_normal_primary_exit_status() {
    let status = Command::new(env!("CARGO_BIN_EXE_pi-env"))
        .args(["supervise", "--", "/bin/sh", "-c", "exit 7"])
        .env("PI_PROCESS_OWNER_PENDING", "1")
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(7));
}

#[test]
fn session_exec_failure_preserves_spawn_errno_and_exit_status() {
    let output = Command::new(env!("CARGO_BIN_EXE_pi-env"))
        .args(["supervise", "--", "/pi-does-not-exist-B2"])
        .env("PI_PROCESS_OWNER_PENDING", "1")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(125));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("No such file or directory (os error 2)")
    );
}
