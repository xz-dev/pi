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
    fs::write(root.join("primary-pid"), std::process::id().to_string()).unwrap();
    while !EXIT.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(5));
    }
    fs::write(root.join("term"), "restored").unwrap();
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
        wait_for(|| fixture.root.join("heartbeat-pid").exists() && fixture.tick().is_some());
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
    for _ in 0..5 {
        fixture.pause();
        assert!(!state(fixture.peer.id() as i32).starts_with('T'));
        let stopped = fixture.tick();
        thread::sleep(Duration::from_millis(70));
        assert_eq!(fixture.tick(), stopped);
        fixture.resume();
    }
    // A quick fg must not leave a delayed guardian STOP after resume.
    for _ in 0..20 {
        fixture.group_signal(libc::SIGTSTP);
        fixture.group_signal(libc::SIGCONT);
    }
    fixture.resume();
    assert!(!state(fixture.pid("primary-pid")).starts_with('T'));
}

#[test]
fn lease_eof_while_paused_cleans_descendants_before_fg() {
    let mut fixture = Fixture::start_inner(true);
    fixture.pause();
    drop(fixture.lease.take());
    wait_for(|| {
        let state = state(fixture.pid("heartbeat-pid"));
        state.is_empty() || state.starts_with('Z')
    });
    fixture.group_signal(libc::SIGCONT);
    wait_for(|| fixture.child.try_wait().unwrap().is_some());
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
