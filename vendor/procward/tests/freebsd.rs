// SPDX-License-Identifier: BSD-3-Clause
#![cfg(target_os = "freebsd")]
use rustix::{
    io::Errno,
    process::{self, Pid, Signal, WaitOptions},
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn poll(deadline: Instant, mut condition: impl FnMut() -> bool) {
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "observable-state deadline expired"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn present(pid: u32) -> bool {
    let out = Command::new("ps")
        .args(["-o", "state=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    match out.status.code() {
        Some(0) => {
            assert!(!out.stdout.is_empty());
            true
        }
        Some(1) if out.stdout.is_empty() && out.stderr.is_empty() => false,
        _ => panic!("process query failed: {out:?}"),
    }
}

struct Run {
    child: Child,
    dir: PathBuf,
}
impl Run {
    fn new(mode: &str, serial: usize) -> Self {
        let dir =
            std::env::temp_dir().join(format!("procward-freebsd-{}-{serial}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let fixture = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("examples/fixture");
        let child = Command::new(env!("CARGO_BIN_EXE_procward"))
            .args(["run", "--"])
            .arg(fixture)
            .arg(mode)
            .arg(&dir)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        Self { child, dir }
    }
    fn pid(&self, mode: &str) -> u32 {
        let path = self.dir.join(format!("{mode}.pid"));
        poll(Instant::now() + Duration::from_secs(20), || {
            path.try_exists().unwrap() && fs::read_to_string(&path).unwrap().parse::<u32>().is_ok()
        });
        fs::read_to_string(path).unwrap().parse().unwrap()
    }
    fn release(&mut self) {
        self.child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
    }
    fn finish(&mut self) -> std::process::ExitStatus {
        poll(Instant::now() + Duration::from_secs(8), || {
            self.child.try_wait().unwrap().is_some()
        });
        self.child.wait().unwrap()
    }
}
impl Drop for Run {
    fn drop(&mut self) {
        let mut rescued = false;
        while let Ok(Some(_)) = process::wait(WaitOptions::NOHANG) {}
        if process::get_reaper_status(None).unwrap().descendants != 0 {
            eprintln!("HARNESS RESCUE: FreeBSD descendants remain, not product cleanup");
            process::reaper_kill(None, Signal::KILL, false, None).unwrap();
            rescued = true;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match process::wait(WaitOptions::NOHANG) {
                Err(Errno::CHILD) => break,
                Ok(Some(_)) | Err(Errno::INTR) => {}
                other => {
                    assert!(Instant::now() < deadline, "rescue reaping: {other:?}");
                    thread::sleep(Duration::from_millis(5));
                }
            }
        }
        fs::remove_dir_all(&self.dir).unwrap();
        assert!(!rescued || thread::panicking(), "fixture needed rescue");
    }
}

fn wait_file(path: &Path) {
    poll(Instant::now() + Duration::from_secs(20), || {
        path.try_exists().unwrap()
    });
}

fn successful_reaper_kill_has_no_failed_pid() {
    struct DirectFixture {
        child: Child,
        dir: PathBuf,
    }
    impl Drop for DirectFixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    let dir = std::env::temp_dir().join(format!("procward-reaper-kill-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let fixture = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/fixture");
    let child = Command::new(fixture)
        .arg("waiting")
        .arg(&dir)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let mut fixture = DirectFixture { child, dir };
    wait_file(&fixture.dir.join("waiting.pid"));
    assert!(
        fixture.child.try_wait().unwrap().is_none(),
        "gated fixture exited before reaper signal"
    );
    let inventory = process::get_reaper_pids(None).unwrap();
    assert!(
        inventory
            .iter()
            .any(|info| info.pid.as_raw_nonzero().get() as u32 == fixture.child.id())
    );
    let result = process::reaper_kill(None, Signal::TERM, false, None).unwrap();
    assert!(
        result.first_failed.is_none(),
        "successful reaper kill reported a failed PID: {result:?}"
    );
    assert_eq!(result.killed, 1);
    poll(Instant::now() + Duration::from_secs(8), || {
        fixture.child.try_wait().unwrap().is_some()
    });
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(
        fixture.child.wait().unwrap().signal(),
        Some(signal_hook::consts::SIGTERM)
    );
}

#[test]
fn freebsd_reaper_lifecycle_and_targeted_parent_death_wake() {
    process::set_reaper_status(true).unwrap();
    successful_reaper_kill_has_no_failed_pid();
    // One sequential scenario group: this process's rescue reaper owns no other test's work.
    {
        let mut run = Run::new("detached-tree", 0);
        let primary = run.pid("detached-tree");
        let branch = run.pid("detached-branch");
        let worker = run.pid("stopped-worker");
        poll(Instant::now() + Duration::from_secs(20), || {
            let out = Command::new("ps")
                .args(["-o", "state=", "-p", &worker.to_string()])
                .output()
                .unwrap();
            out.status.success() && String::from_utf8(out.stdout).unwrap().contains('T')
        });
        assert!(present(worker), "stopped is alive");
        let nested = process::get_reaper_status(Some((
            process::IdType::Pid,
            Pid::from_raw(branch as i32).unwrap(),
        )))
        .unwrap();
        assert!(nested.flags.contains(process::ReaperStatusFlags::OWNED));
        run.release();
        assert_eq!(run.finish().code(), Some(23));
        for pid in [primary, branch, worker] {
            assert!(!present(pid), "owned survivor {pid}");
        }
    }
    {
        let mut run = Run::new("orphan", 1);
        let primary = run.pid("orphan");
        let orphan = run.pid("orphan-child");
        wait_file(&run.dir.join("ready"));
        fs::write(run.dir.join("release"), b"exit").unwrap();
        poll(Instant::now() + Duration::from_secs(3), || !present(orphan));
        assert!(present(primary));
        assert!(run.child.try_wait().unwrap().is_none());
        run.release();
        assert_eq!(run.finish().code(), Some(23));
    }
    {
        let mut run = Run::new("detached-tree", 2);
        let primary = run.pid("detached-tree");
        let branch = run.pid("detached-branch");
        let worker = run.pid("stopped-worker");
        let out = Command::new("ps")
            .args(["-o", "ppid=", "-p", &primary.to_string()])
            .output()
            .unwrap();
        assert!(out.status.success());
        let anchor = Pid::from_raw(
            String::from_utf8(out.stdout)
                .unwrap()
                .trim()
                .parse()
                .unwrap(),
        )
        .unwrap();
        // The test reaper owns the live descendant chain; no stale numeric observations survive a reap.
        process::kill_process(anchor, Signal::STOP).unwrap();
        poll(Instant::now() + Duration::from_secs(20), || {
            let out = Command::new("ps")
                .args(["-o", "state=", "-p", &anchor.to_string()])
                .output()
                .unwrap();
            out.status.success() && String::from_utf8(out.stdout).unwrap().contains('T')
        });
        let fault = Instant::now();
        run.child.kill().unwrap();
        assert!(!run.finish().success());
        let deadline = fault + Duration::from_secs(8);
        poll(deadline, || {
            [primary, branch, worker]
                .into_iter()
                .all(|pid| !present(pid))
        });
        poll(deadline, || {
            match process::waitpid(Some(anchor), WaitOptions::NOHANG) {
                Ok(Some(_)) => true,
                Ok(None) | Err(Errno::INTR) => false,
                other => panic!("anchor wait: {other:?}"),
            }
        });
    }
    for failover in [false, true] {
        let mut run = Run::new("cleanup-order", 3 + usize::from(failover));
        let primary = run.pid("cleanup-order");
        let out = Command::new("ps")
            .args(["-o", "ppid=", "-p", &primary.to_string()])
            .output()
            .unwrap();
        assert!(out.status.success());
        let anchor = Pid::from_raw(
            String::from_utf8(out.stdout)
                .unwrap()
                .trim()
                .parse()
                .unwrap(),
        )
        .unwrap();
        let worker = run.pid("order-worker");
        wait_file(&run.dir.join("order-ready"));
        poll(Instant::now() + Duration::from_secs(20), || {
            let out = Command::new("ps")
                .args(["-o", "state=", "-p", &worker.to_string()])
                .output()
                .unwrap();
            out.status.success() && String::from_utf8(out.stdout).unwrap().contains('T')
        });
        let start = Instant::now();
        run.release();
        if failover {
            poll(Instant::now() + Duration::from_secs(2), || {
                fs::read_to_string(run.dir.join("order-observed"))
                    .is_ok_and(|text| text == "true 1")
            });
            process::kill_process(anchor, Signal::KILL).unwrap();
        }
        assert_eq!(run.finish().code(), Some(if failover { 125 } else { 23 }));
        assert_eq!(
            fs::read_to_string(run.dir.join("order-observed")).unwrap(),
            "true 1"
        );
        assert!(!present(worker));
        assert!(start.elapsed() >= Duration::from_secs(6));
        assert!(start.elapsed() <= Duration::from_secs(8));
    }
    assert!(
        process::get_reaper_status(Some((
            process::IdType::Pid,
            Pid::from_raw(i32::MAX).unwrap()
        )))
        .is_err(),
        "failed kernel query is not absence"
    );
}
