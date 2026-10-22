#![cfg(any(target_os = "linux", target_os = "freebsd", target_os = "macos"))]

use std::fs;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static EXIT: AtomicBool = AtomicBool::new(false);
extern "C" fn terminate(_: i32) {
    EXIT.store(true, Ordering::Relaxed);
}

#[test]
fn heartbeat_fixture() {
    let Some(root) = std::env::var_os("PI_SUSPEND_HEARTBEAT") else {
        return;
    };
    assert!(unsafe { libc::setsid() } > 0);
    let root = PathBuf::from(root);
    fs::write(root.join("heartbeat-pid"), std::process::id().to_string()).unwrap();
    for tick in 0_u64.. {
        fs::write(root.join("tick"), tick.to_string()).unwrap();
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn primary_fixture() {
    let Some(root) = std::env::var_os("PI_SUSPEND_PRIMARY") else {
        return;
    };
    let root = PathBuf::from(root);
    unsafe {
        libc::signal(libc::SIGTERM, terminate as *const () as usize);
        libc::signal(libc::SIGHUP, terminate as *const () as usize);
    }
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "heartbeat_fixture"])
        .env("PI_SUSPEND_HEARTBEAT", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    if std::env::var("PI_SUSPEND_CREATE_ORPHAN").as_deref() == Ok("1") {
        assert!(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "adopted_fixture"])
                .env("PI_SUSPEND_ORPHAN", &root)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
    }
    fs::write(root.join("primary-pid"), std::process::id().to_string()).unwrap();
    while !EXIT.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(5));
    }
    fs::write(root.join("term"), "restored").unwrap();
    // Give teardown time to expose any healthy-work resume before leaf termination.
    thread::sleep(Duration::from_millis(400));
    let _ = child.kill();
    let _ = child.wait();
}

struct Fixture {
    child: Child,
    root: PathBuf,
    lease: Option<UnixStream>,
    peer: Child,
}
impl Fixture {
    fn start() -> Self {
        Self::start_inner(false)
    }
    fn start_inner(with_lease: bool) -> Self {
        Self::start_config(with_lease, false)
    }
    fn start_config(with_lease: bool, orphan: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "pi-suspend-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let streams = with_lease.then(|| UnixStream::pair().unwrap());
        let mut command = Command::new(env!("CARGO_BIN_EXE_pi-env"));
        command.arg("supervise");
        if let Some((_, passed)) = &streams {
            let fd = passed.as_raw_fd();
            command.args(["--control-fd", &fd.to_string()]);
            unsafe {
                command.pre_exec(move || {
                    let flags = libc::fcntl(fd, libc::F_GETFD);
                    if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let child = command
            .arg("--")
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", "primary_fixture"])
            .env("PI_PROCESS_OWNER_PENDING", "1")
            .env("PI_SUSPEND_PRIMARY", &root)
            .env("PI_SUSPEND_CREATE_ORPHAN", if orphan { "1" } else { "0" })
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let lease = streams.map(|(lease, passed)| {
            drop(passed);
            lease
        });
        let peer = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let fixture = Self {
            child,
            root,
            lease,
            peer,
        };
        wait_for(|| {
            fixture.root.join("primary-pid").exists()
                && fixture.root.join("heartbeat-pid").exists()
                && fixture.tick().is_some()
        });
        fixture
    }
    fn pid(&self, name: &str) -> i32 {
        fs::read_to_string(self.root.join(name))
            .unwrap()
            .parse()
            .unwrap()
    }
    fn tick(&self) -> Option<u64> {
        fs::read_to_string(self.root.join("tick"))
            .ok()?
            .parse()
            .ok()
    }
    fn group_signal(&self, signal: i32) {
        assert_eq!(unsafe { libc::kill(-(self.child.id() as i32), signal) }, 0);
    }
    fn pause(&self) {
        self.group_signal(libc::SIGTSTP);
        wait_for(|| state(self.pid("heartbeat-pid")).starts_with('T'));
    }
    fn resume(&self) {
        self.group_signal(libc::SIGCONT);
        let tick = self.tick();
        wait_for(|| self.tick().is_some() && self.tick() != tick);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            // The unreaped outer anchors its process-group identity until these signals finish.
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGCONT);
                libc::kill(self.child.id() as i32, libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_secs(7);
            while Instant::now() < deadline && self.child.try_wait().unwrap().is_none() {
                thread::sleep(Duration::from_millis(10));
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = self.peer.kill();
        let _ = self.peer.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn state(pid: i32) -> String {
    String::from_utf8_lossy(
        &Command::new("ps")
            .args(["-o", "state=", "-p", &pid.to_string()])
            .output()
            .unwrap()
            .stdout,
    )
    .trim()
    .to_owned()
}
fn wait_for(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "suspend fixture condition timed out"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn repeated_suspend_resume_freezes_setsid_grandchild() {
    let fixture = Fixture::start();
    let primary = fixture.pid("primary-pid");
    let guardian = String::from_utf8(
        Command::new("ps")
            .args(["-o", "ppid=", "-p", &primary.to_string()])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .parse::<i32>()
    .unwrap();
    let processes = [
        fixture.child.id() as i32,
        guardian,
        primary,
        fixture.pid("heartbeat-pid"),
    ];
    for _ in 0..5 {
        fixture.pause();
        wait_for(|| state(fixture.child.id() as i32).starts_with('T'));
        assert!(!state(guardian).starts_with('T'));
        assert!(!state(fixture.peer.id() as i32).starts_with('T'));
        let stopped = fixture.tick();
        thread::sleep(Duration::from_millis(70));
        assert_eq!(fixture.tick(), stopped);
        fixture.resume();
    }
    // The final CONT in these pairs is the only resume in the asserted path.
    // A repair CONT here would hide a stranded outer even if the heartbeat runs.
    for _ in 0..100 {
        fixture.group_signal(libc::SIGTSTP);
        fixture.group_signal(libc::SIGCONT);
    }
    let tick = fixture.tick();
    wait_for(|| fixture.tick().is_some() && fixture.tick() != tick);
    wait_for(|| {
        processes.iter().all(|pid| {
            let value = state(*pid);
            !value.is_empty() && !value.starts_with(['T', 't', 'Z', 'X'])
        })
    });
    assert!(!state(fixture.peer.id() as i32).starts_with('T'));
}

#[test]
fn paused_guardian_termination_does_not_resume_work_during_primary_cleanup() {
    for signal in [libc::SIGTERM, libc::SIGHUP] {
        let mut fixture = Fixture::start();
        let primary = fixture.pid("primary-pid");
        let guardian: i32 = String::from_utf8(
            Command::new("ps")
                .args(["-o", "ppid=", "-p", &primary.to_string()])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .parse()
        .unwrap();
        fixture.pause();
        wait_for(|| {
            state(fixture.child.id() as i32).starts_with('T') && state(primary).starts_with('T')
        });
        let tick = fixture.tick();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(fixture.tick(), tick);
        let start = Instant::now();
        assert_eq!(unsafe { libc::kill(guardian, signal) }, 0);
        while fixture.child.try_wait().unwrap().is_none() {
            assert!(
                start.elapsed() < Duration::from_secs(8),
                "paused termination exceeded eight seconds without rescue CONT"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert!(start.elapsed() < Duration::from_secs(8));
        assert!(
            fixture.root.join("term").exists(),
            "primary must receive graceful termination"
        );
        assert_eq!(
            fixture.tick(),
            tick,
            "paused leaf ran during delayed primary cleanup (signal {signal})"
        );
        wait_for(|| {
            let state = state(fixture.pid("heartbeat-pid"));
            state.is_empty() || state.starts_with('Z')
        });
    }
}

#[test]
fn session_guardian_exit_wakes_only_its_outer_not_unowned_job_peer() {
    let mut fixture = Fixture::start();
    let _ = fixture.peer.kill();
    let _ = fixture.peer.wait();
    fixture.peer = Command::new("/bin/sleep")
        .arg("60")
        .process_group(fixture.child.id() as i32)
        .spawn()
        .unwrap();
    let primary = fixture.pid("primary-pid");
    let guardian: i32 = String::from_utf8(
        Command::new("ps")
            .args(["-o", "ppid=", "-p", &primary.to_string()])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .parse()
    .unwrap();
    fixture.pause();
    wait_for(|| state(fixture.peer.id() as i32).starts_with('T'));
    assert_eq!(unsafe { libc::kill(guardian, libc::SIGKILL) }, 0);
    wait_for(|| fixture.child.try_wait().unwrap().is_some());
    wait_for(|| {
        let value = state(fixture.pid("heartbeat-pid"));
        value.is_empty() || value.starts_with('Z')
    });
    assert!(
        state(fixture.peer.id() as i32).starts_with('T'),
        "unowned same-job peer was resumed"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn session_wake_observer_is_runnable_sibling_and_failure_is_fatal() {
    let mut fixture = Fixture::start();
    let primary = fixture.pid("primary-pid");
    let guardian: i32 = String::from_utf8(
        Command::new("ps")
            .args(["-o", "ppid=", "-p", &primary.to_string()])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .parse()
    .unwrap();
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
        .unwrap();
    let direct: Vec<i32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() == 2 && fields[1].parse::<u32>().ok() == Some(fixture.child.id()) {
                fields[0].parse().ok()
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        direct.len(),
        2,
        "session must have guardian and exactly one wake observer"
    );
    let observer = *direct.iter().find(|pid| **pid != guardian).unwrap();
    let group: i32 = String::from_utf8(
        Command::new("ps")
            .args(["-o", "pgid=", "-p", &observer.to_string()])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .parse()
    .unwrap();
    assert_ne!(group, fixture.child.id() as i32);
    fixture.pause();
    assert!(!state(observer).starts_with('T'));
    let tick = fixture.tick();
    assert_eq!(unsafe { libc::kill(observer, libc::SIGKILL) }, 0);
    wait_for(|| fixture.child.try_wait().unwrap().is_some());
    wait_for(|| {
        let value = state(fixture.pid("heartbeat-pid"));
        value.is_empty() || value.starts_with('Z')
    });
    assert_eq!(
        fixture.tick(),
        tick,
        "observer failure must not resume healthy work"
    );
    assert!(
        state(observer).is_empty(),
        "outer must reap failed observer"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn outer_cancellation_and_forwarded_termination_never_thaw_paused_work() {
    use std::io::Write;
    // Wake only the held outer controller, as caller cancellation does, never the payload group.
    for signal in [None, Some(libc::SIGTERM), Some(libc::SIGHUP)] {
        let mut fixture = Fixture::start_inner(signal.is_none());
        let primary = fixture.pid("primary-pid");
        let guardian: i32 = String::from_utf8(
            Command::new("ps")
                .args(["-o", "ppid=", "-p", &primary.to_string()])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .parse()
        .unwrap();
        fixture.pause();
        wait_for(|| {
            state(fixture.child.id() as i32).starts_with('T') && state(primary).starts_with('T')
        });
        let tick = fixture.tick();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(fixture.tick(), tick);
        // Keep guardian from consuming K before the outer's cancellation forwarding path.
        assert_eq!(unsafe { libc::kill(guardian, libc::SIGSTOP) }, 0);
        wait_for(|| state(guardian).starts_with('T'));
        if let Some(signal) = signal {
            assert_eq!(unsafe { libc::kill(fixture.child.id() as i32, signal) }, 0);
        } else {
            fixture.lease.as_mut().unwrap().write_all(b"K").unwrap();
        }
        let start = Instant::now();
        assert_eq!(
            unsafe { libc::kill(fixture.child.id() as i32, libc::SIGCONT) },
            0
        );
        while fixture.child.try_wait().unwrap().is_none() {
            assert!(
                start.elapsed() < Duration::from_secs(8),
                "outer cancellation did not finish"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            fixture.tick(),
            tick,
            "outer teardown thawed paused heartbeat (signal {signal:?})"
        );
        wait_for(|| {
            let state = state(fixture.pid("heartbeat-pid"));
            state.is_empty() || state.starts_with('Z')
        });
    }
}

#[cfg(target_os = "macos")]
#[test]
fn normal_session_completion_reaps_wake_observer() {
    let mut fixture = Fixture::start();
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
        .unwrap();
    let children: Vec<i32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() == 2 && fields[1].parse::<u32>().ok() == Some(fixture.child.id()) {
                fields[0].parse().ok()
            } else {
                None
            }
        })
        .collect();
    assert_eq!(children.len(), 2);
    assert_eq!(
        unsafe { libc::kill(fixture.pid("primary-pid"), libc::SIGTERM) },
        0
    );
    wait_for(|| fixture.child.try_wait().unwrap().is_some());
    assert_eq!(fixture.child.try_wait().unwrap().unwrap().code(), Some(0));
    for pid in children {
        assert!(
            state(pid).is_empty(),
            "session left an unreaped native child"
        );
    }
}

#[test]
fn lease_eof_while_paused_automatically_cleans_whole_session() {
    let mut fixture = Fixture::start_inner(true);
    fixture.pause();
    let tick = fixture.tick();
    drop(fixture.lease.take());
    wait_for(|| {
        let state = state(fixture.pid("heartbeat-pid"));
        state.is_empty() || state.starts_with('Z')
    });
    wait_for(|| fixture.child.try_wait().unwrap().is_some());
    assert_eq!(fixture.tick(), tick, "lease EOF resumed paused work");
}

#[test]
fn owner_death_while_paused_resumes_primary_for_graceful_teardown() {
    let mut fixture = Fixture::start();
    fixture.pause();
    assert_eq!(
        unsafe { libc::kill(fixture.child.id() as i32, libc::SIGKILL) },
        0
    );
    let _ = fixture.child.wait();
    wait_for(|| fixture.root.join("term").exists());
    wait_for(|| {
        let state = state(fixture.pid("heartbeat-pid"));
        state.is_empty() || state.starts_with('Z')
    });
}

#[cfg(any(target_os = "linux", target_os = "freebsd"))]
fn parent_pid(pid: i32) -> i32 {
    String::from_utf8(
        Command::new("ps")
            .args(["-o", "ppid=", "-p", &pid.to_string()])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .parse()
    .unwrap()
}

#[cfg(any(target_os = "linux", target_os = "freebsd"))]
#[test]
fn ancestor_anchor_stays_runnable_and_its_death_fails_closed() {
    for paused in [false, true] {
        let mut fixture = Fixture::start();
        let primary = fixture.pid("primary-pid");
        let guardian = parent_pid(primary);
        let anchor = parent_pid(guardian);
        assert_eq!(parent_pid(anchor), fixture.child.id() as i32);
        if paused {
            fixture.pause();
        }
        assert!(!state(anchor).starts_with('T'));
        let start = Instant::now();
        assert_eq!(unsafe { libc::kill(anchor, libc::SIGKILL) }, 0);
        while fixture.child.try_wait().unwrap().is_none() {
            assert!(start.elapsed() < Duration::from_secs(8));
            thread::sleep(Duration::from_millis(10));
        }
        for pid in [anchor, guardian, primary, fixture.pid("heartbeat-pid")] {
            wait_for(|| state(pid).is_empty());
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "freebsd"))]
#[test]
fn normal_session_reaps_ancestor_anchor_and_preserves_primary_status() {
    let mut fixture = Fixture::start();
    let primary = fixture.pid("primary-pid");
    let guardian = parent_pid(primary);
    let anchor = parent_pid(guardian);
    assert_eq!(unsafe { libc::kill(primary, libc::SIGTERM) }, 0);
    wait_for(|| fixture.child.try_wait().unwrap().is_some());
    assert_eq!(fixture.child.try_wait().unwrap().unwrap().code(), Some(0));
    for pid in [anchor, guardian, primary, fixture.pid("heartbeat-pid")] {
        assert!(state(pid).is_empty(), "native session role not reaped");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn anchor_channel_allocation_failure_refuses_grant_without_half_state() {
    let root = std::env::temp_dir().join(format!("pi-anchor-failure-{}", std::process::id()));
    let _ = fs::remove_file(&root);
    let mut command = Command::new(env!("CARGO_BIN_EXE_pi-env"));
    command
        .args([
            "supervise",
            "--",
            "/bin/sh",
            "-c",
            "printf executed > \"$1\"",
            "sh",
        ])
        .arg(&root)
        .env("PI_PROCESS_OWNER_PENDING", "1");
    unsafe {
        command.pre_exec(|| {
            let limit = libc::rlimit {
                rlim_cur: 6,
                rlim_max: 6,
            };
            if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = command.output().unwrap();
    assert_eq!(output.status.code(), Some(125));
    assert!(!root.exists());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--no-process-ownership"));
}

// Same async-signal-safe fork fixture pattern as supervise_darwin.rs.
#[test]
fn adopted_fixture() {
    let Some(root) = std::env::var_os("PI_SUSPEND_ORPHAN") else {
        return;
    };
    let file = fs::File::create(PathBuf::from(root).join("adopted-pid")).unwrap();
    unsafe {
        let child = libc::fork();
        assert!(child >= 0);
        if child > 0 {
            // Darwin inventory must have an observation window before reparenting.
            libc::usleep(400_000);
            libc::_exit(0);
        }
        if libc::setsid() < 0 {
            libc::_exit(121);
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
            libc::_exit(122);
        }
        loop {
            libc::pause();
        }
    }
}

#[test]
fn observed_adopted_setsid_grandchild_dies_with_both_owners() {
    for paused in [false, true] {
        let mut fixture = Fixture::start_config(false, true);
        wait_for(|| {
            fs::read_to_string(fixture.root.join("adopted-pid"))
                .ok()
                .and_then(|x| x.parse::<i32>().ok())
                .is_some()
        });
        let orphan = fixture.pid("adopted-pid");
        let primary = fixture.pid("primary-pid");
        let parent = |pid: i32| -> i32 {
            String::from_utf8(
                Command::new("ps")
                    .args(["-o", "ppid=", "-p", &pid.to_string()])
                    .output()
                    .unwrap()
                    .stdout,
            )
            .unwrap()
            .trim()
            .parse()
            .unwrap()
        };
        let guardian = parent(primary);
        #[cfg(any(target_os = "linux", target_os = "freebsd"))]
        {
            assert_eq!(parent(orphan), guardian, "already orphaned before fault");
        }
        if paused {
            fixture.pause();
            wait_for(|| state(orphan).starts_with('T'));
        }
        let start = Instant::now();
        assert_eq!(unsafe { libc::kill(guardian, libc::SIGKILL) }, 0);
        fixture.child.kill().unwrap();
        fixture.child.wait().unwrap();
        while !state(orphan).is_empty() {
            assert!(
                start.elapsed() < Duration::from_secs(8),
                "observed orphan survived both owners"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
