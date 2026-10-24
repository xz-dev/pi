#![cfg(target_os = "linux")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct Fixture {
    child: Child,
    root: PathBuf,
}
impl Fixture {
    fn start(script: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "pi-owner-death-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_pi-env"))
            .args(["supervise", "--", "/bin/sh", "-c", script])
            .env("FIXTURE", &root)
            .env("OWNER", env!("CARGO_BIN_EXE_pi-env"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self { child, root }
    }
    fn pid(&self, name: &str) -> i32 {
        let file = self.root.join(name);
        wait_for(|| {
            fs::read_to_string(&file)
                .ok()
                .and_then(|s| s.trim().parse::<i32>().ok())
                .is_some()
        });
        fs::read_to_string(file).unwrap().trim().parse().unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
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
fn wait_for(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(Instant::now() < deadline, "fixture condition timed out");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn guardian_death_gives_primary_a_term_grace_period() {
    let mut fixture = Fixture::start(
        "trap 'echo restored > \"$FIXTURE/term\"; exit 0' TERM; echo $PPID > \"$FIXTURE/guardian\"; while :; do sleep 0.02; done",
    );
    let guardian = fixture.pid("guardian");
    assert_eq!(unsafe { libc::kill(guardian, libc::SIGKILL) }, 0);
    wait_for(|| fixture.root.join("term").exists());
    wait_for(|| fixture.child.try_wait().unwrap().is_some());
    assert_eq!(
        fs::read_to_string(fixture.root.join("term")).unwrap(),
        "restored\n"
    );
}

#[test]
fn adopted_guardian_is_reaped_while_primary_is_running() {
    let mut fixture = Fixture::start(
        "\"$OWNER\" supervise -- /bin/sh -c 'echo $PPID > \"$FIXTURE/nested-guardian\"; sleep 60' & echo $! > \"$FIXTURE/nested-outer\"; echo $$ > \"$FIXTURE/primary\"; while :; do sleep 0.05; done",
    );
    let outer = fixture.pid("nested-outer");
    let guardian = fixture.pid("nested-guardian");
    let primary = fixture.pid("primary");
    assert_eq!(unsafe { libc::kill(outer, libc::SIGKILL) }, 0);
    wait_for(|| !Path::new(&format!("/proc/{guardian}")).exists());
    assert!(Path::new(&format!("/proc/{primary}")).exists());
    assert!(fixture.child.try_wait().unwrap().is_none());
}
