#![cfg(target_os = "macos")]

use std::fs;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

// Invoked as a subprocess by the runtime tests, never ignored/skipped on Darwin.
#[test]
fn darwin_fixture() {
    let Ok(mode) = std::env::var("PI_DARWIN_FIXTURE") else {
        return;
    };
    let file = fs::File::create(std::env::var_os("PI_DARWIN_PID_FILE").unwrap()).unwrap();
    let detached = mode.contains("setsid");
    let resistant = mode == "resistant";
    // SAFETY: child uses only async-signal-safe syscalls until _exit.
    unsafe {
        let first = libc::fork();
        assert!(first >= 0);
        if first == 0 {
            if detached && libc::setsid() < 0 {
                libc::_exit(121);
            }
            let second = libc::fork();
            if second < 0 {
                libc::_exit(122);
            }
            if second > 0 {
                if mode == "observed-setsid" {
                    libc::usleep(400_000);
                }
                libc::_exit(0);
            }
            if resistant {
                libc::signal(libc::SIGTERM, libc::SIG_IGN);
            }
            let mut pid = libc::getpid() as u32;
            let mut bytes = [0u8; 16];
            let mut at = bytes.len();
            while pid > 0 {
                at -= 1;
                bytes[at] = b'0' + (pid % 10) as u8;
                pid /= 10;
            }
            if libc::write(
                file.as_raw_fd(),
                bytes[at..].as_ptr().cast(),
                bytes.len() - at,
            ) < 0
            {
                libc::_exit(123);
            }
            loop {
                libc::pause();
            }
        }
        assert_eq!(libc::waitpid(first, std::ptr::null_mut(), 0), first);
    }
    if mode.ends_with("-death") {
        loop {
            unsafe {
                libc::pause();
            }
        }
    }
    if mode != "fast-setsid" {
        std::thread::sleep(Duration::from_millis(400));
    }
}

struct Invocation {
    child: Child,
    control: UnixStream,
    directory: PathBuf,
    descendant: Option<(i32, u64, u64)>,
}

fn record(pid: i32) -> Option<libc::proc_bsdinfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let got = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (got == size && info.pbi_status != libc::SZOMB).then_some(info)
}

impl Invocation {
    fn start(mode: &str) -> Self {
        let directory =
            std::env::temp_dir().join(format!("pi-darwin-{}-{}", std::process::id(), mode));
        fs::create_dir(&directory).unwrap();
        let (control, passed) = UnixStream::pair().unwrap();
        control
            .set_read_timeout(Some(Duration::from_secs(12)))
            .unwrap();
        let fd = passed.as_raw_fd();
        let binary = std::env::var_os("PI_ENV_DAEMON")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_pi-env")));
        let mut command = Command::new(binary);
        command
            .args(["supervise", "--control-fd", "3", "--"])
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "darwin_fixture",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("PI_DARWIN_FIXTURE", mode)
            .env("PI_DARWIN_PID_FILE", directory.join("pid"))
            .env_remove("PI_PROCESS_OWNER_PENDING")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        drop(passed);
        let mut run = Self {
            child,
            control,
            directory,
            descendant: None,
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(text) = fs::read_to_string(run.directory.join("pid"))
                && let Ok(pid) = text.parse::<i32>()
            {
                if let Some(info) = record(pid) {
                    run.descendant = Some((pid, info.pbi_start_tvsec, info.pbi_start_tvusec));
                }
                // A fast escape may already be dead before its first observation.
                return run;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("fixture did not report descendant PID");
    }

    fn finish(&mut self) -> String {
        let mut protocol = String::new();
        self.control.read_to_string(&mut protocol).unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "{status}: {protocol}");
                break;
            }
            assert!(Instant::now() < deadline, "owner did not close");
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(protocol.starts_with("S{\"pid\":"), "{protocol}");
        assert!(protocol.contains("\nX{"), "{protocol}");
        assert!(protocol.ends_with("\nC\n"), "{protocol}");
        protocol
    }

    fn survivor(&self) -> bool {
        self.descendant.is_some_and(|(pid, seconds, micros)| {
            record(pid).is_some_and(|info| {
                info.pbi_start_tvsec == seconds && info.pbi_start_tvusec == micros
            })
        })
    }
}

impl Drop for Invocation {
    fn drop(&mut self) {
        if self.survivor() {
            unsafe {
                libc::kill(self.descendant.unwrap().0, libc::SIGKILL);
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn double_fork_contained() {
    let mut run = Invocation::start("double-fork");
    run.finish();
    assert!(!run.survivor(), "private-PGID double-fork survived");
}

#[test]
fn observed_setsid_contained() {
    let mut run = Invocation::start("observed-setsid");
    run.finish();
    assert!(!run.survivor(), "observed setsid descendant survived");
}

#[test]
fn term_resistant_descendant_killed() {
    let mut run = Invocation::start("resistant");
    run.finish();
    assert!(
        !run.survivor(),
        "TERM-resistant descendant survived KILL escalation"
    );
}

#[test]
fn unrelated_process_survives() {
    let mut unrelated = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let mut run = Invocation::start("unrelated");
    run.finish();
    let survived = unrelated.try_wait().unwrap().is_none();
    let _ = unrelated.kill();
    let _ = unrelated.wait();
    assert!(survived, "unrelated process was signalled");
    assert!(!run.survivor());
}

#[test]
fn fast_setsid_escape_is_explicit_best_effort_limit() {
    let mut run = Invocation::start("fast-setsid");
    let protocol = run.finish();
    // C attests a sweep, NOT an empty descendant domain. Either race outcome is
    // supported; a surviving escape is explicitly measured and cleaned by Drop.
    let survived = run.survivor();
    if survived {
        let primary: serde_json::Value =
            serde_json::from_str(protocol.lines().next().unwrap().strip_prefix('S').unwrap())
                .unwrap();
        let info = record(run.descendant.unwrap().0).unwrap();
        assert_ne!(info.pbi_ppid, primary["pid"].as_u64().unwrap() as u32);
        assert_ne!(info.pbi_pgid, unsafe { libc::getpgrp() } as u32);
        assert!(
            protocol.ends_with("\nC\n"),
            "best-effort C permits unseen reparented escapees"
        );
    }
    let outcome = if survived {
        "escaped-before-snapshot"
    } else {
        "observed-and-killed"
    };
    eprintln!("Darwin fast setsid limitation: {outcome}; C is not proof of containment");
}

#[test]
fn report_runtime_privileges() {
    let output = Command::new("/usr/bin/id").output().unwrap();
    assert!(output.status.success());
    let identity = String::from_utf8(output.stdout).unwrap();
    let groups = Command::new("/usr/bin/id").arg("-Gn").output().unwrap();
    assert!(groups.status.success());
    let groups = String::from_utf8(groups.stdout).unwrap();
    eprintln!(
        "Darwin runtime identity: {}; admin-group={}",
        identity.trim(),
        groups.split_whitespace().any(|group| group == "admin")
    );
}

#[test]
fn guardian_sigkill_leaves_outer_sweeper() {
    let mut run = Invocation::start("guardian-death");
    std::thread::sleep(Duration::from_millis(100));
    let mut pids = [0i32; 16];
    let count = unsafe {
        libc::proc_listchildpids(
            run.child.id() as i32,
            pids.as_mut_ptr().cast(),
            std::mem::size_of_val(&pids) as i32,
        )
    };
    assert_eq!(count, 1, "expected one guardian");
    assert!(record(pids[0]).is_some());
    assert_eq!(unsafe { libc::kill(pids[0], libc::SIGKILL) }, 0);
    let mut protocol = String::new();
    run.control.read_to_string(&mut protocol).unwrap();
    assert!(
        !protocol.ends_with("\nC\n"),
        "dead guardian cannot confirm its sweep"
    );
    let deadline = Instant::now() + Duration::from_secs(8);
    while run.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        !run.survivor(),
        "outer failed to sweep after guardian SIGKILL"
    );
}

#[test]
fn outer_sigkill_leaves_guardian_sweeper() {
    let mut run = Invocation::start("outer-death");
    std::thread::sleep(Duration::from_millis(100));
    run.child.kill().unwrap();
    run.child.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while run.survivor() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        !run.survivor(),
        "guardian failed to sweep after outer SIGKILL"
    );
}
