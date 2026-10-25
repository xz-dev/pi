#![cfg(any(target_os = "linux", target_os = "freebsd"))]

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static HUP: AtomicBool = AtomicBool::new(false);
extern "C" fn hup(_: i32) {
    HUP.store(true, Ordering::Relaxed);
}

#[test]
fn hup_only_primary_fixture() {
    let Some(root) = std::env::var_os("PI_HUP_ONLY_FIXTURE") else {
        return;
    };
    let root = PathBuf::from(root);
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_DFL);
        libc::signal(libc::SIGHUP, hup as *const () as usize);
    }
    fs::write(
        root.join("guardian"),
        unsafe { libc::getppid() }.to_string(),
    )
    .unwrap();
    while !HUP.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(5));
    }
    // A cohort TERM must not interrupt this HUP-only cleanup.
    thread::sleep(Duration::from_millis(150));
    fs::write(root.join("hup-complete"), "complete").unwrap();
    std::process::exit(23);
}

struct Fixture {
    child: Child,
    root: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            unsafe {
                libc::kill(self.child.id() as i32, libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_secs(6);
            while Instant::now() < deadline && self.child.try_wait().unwrap().is_none() {
                thread::sleep(Duration::from_millis(10));
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn assert_hup_only_completion() {
    let root = std::env::temp_dir().join(format!(
        "pi-hup-only-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_pi-env"))
        .args(["supervise", "--"])
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", "hup_only_primary_fixture"])
        .env_remove("PI_PROCESS_OWNER_PENDING")
        .env("PI_HUP_ONLY_FIXTURE", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut fixture = Fixture { child, root };
    let deadline = Instant::now() + Duration::from_secs(8);
    let guardian = loop {
        if let Ok(text) = fs::read_to_string(fixture.root.join("guardian"))
            && let Ok(pid) = text.parse::<i32>()
        {
            break pid;
        }
        assert!(Instant::now() < deadline, "HUP fixture not ready");
        thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(unsafe { libc::kill(guardian, libc::SIGHUP) }, 0);
    let status = loop {
        if let Some(status) = fixture.child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "HUP fixture did not exit");
        thread::sleep(Duration::from_millis(10));
    };
    assert!(
        fixture.root.join("hup-complete").exists(),
        "extra TERM interrupted HUP cleanup"
    );
    assert_eq!(
        status.code(),
        Some(23),
        "primary HUP status was not preserved"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn non_session_hup_preserves_handler_completion_and_status() {
    assert_hup_only_completion();
}

#[cfg(target_os = "freebsd")]
#[test]
fn freebsd_non_session_hup_never_injects_domain_term() {
    assert_hup_only_completion();
}
