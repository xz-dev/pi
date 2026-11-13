// SPDX-License-Identifier: BSD-3-Clause
// Real rolling/deep/wide reproducer. Only ci/vm-test.py --hazard runs this ignored test.
// The whole VM has an independent host deadline; a guest cgroup also bounds the workload.
#![cfg(target_os = "linux")]

use std::{
    fs, io,
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Scope(PathBuf);
impl Scope {
    fn populated(&self) -> bool {
        fs::read_to_string(self.0.join("cgroup.events"))
            .unwrap()
            .contains("populated 1")
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        if self.populated() {
            eprintln!("HARNESS RESCUE: hazardous workload survived; NOT product cleanup");
            fs::write(self.0.join("cgroup.kill"), "1").unwrap();
            let until = Instant::now() + Duration::from_secs(1);
            while self.populated() && Instant::now() < until {
                thread::sleep(Duration::from_millis(5));
            }
        }
        let _ = fs::remove_dir(&self.0);
    }
}

fn poll(until: Instant, mut ready: impl FnMut() -> bool) {
    while !ready() {
        assert!(Instant::now() < until, "hazardous test deadline expired");
        thread::sleep(Duration::from_millis(5));
    }
}

fn fixture() -> PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/fixture")
}

#[test]
#[ignore = "requires ci/vm-test.py --hazard and an independent VM watchdog"]
fn rolling_deep_wide_without_cgroup_survives_no_descriptor_shortcut() {
    let host = std::env::var("PROCWARD_VM_HOST_BOOT_ID")
        .expect("HAZARD-REFUSED: launch through the disposable full-system VM runner");
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap();
    assert_ne!(host.trim(), boot.trim(), "HAZARD-REFUSED: host kernel");
    assert_eq!(unsafe { libc::geteuid() }, 0, "guest root required");

    // This group is fresh and outside the test/controller's own group. No unrelated task
    // is moved. The independent host VM watchdog remains authoritative if this test dies.
    let name = format!("procward-hazard-{}", std::process::id());
    let path = PathBuf::from("/sys/fs/cgroup").join(&name);
    fs::create_dir(&path).unwrap();
    let group = Scope(path);
    for (file, value) in [
        ("pids.max", "768"),
        ("memory.max", "536870912"),
        ("cgroup.max.descendants", "0"),
    ] {
        fs::write(group.0.join(file), value).unwrap();
        assert_eq!(
            fs::read_to_string(group.0.join(file)).unwrap().trim(),
            value
        );
    }
    for (file, value) in [
        ("memory.swap.max", "0"),
        ("memory.oom.group", "1"),
        ("cpu.max", "100000 100000"),
    ] {
        if group.0.join(file).exists() {
            fs::write(group.0.join(file), value).unwrap();
        }
    }
    fs::write(group.0.join("cgroup.kill"), "1").unwrap();
    assert!(
        !group.populated(),
        "outer group was not empty before launch"
    );

    let scratch = std::env::temp_dir().join(&name);
    fs::create_dir(&scratch).unwrap();
    let stdout = scratch.join("stdout");
    let stderr = scratch.join("stderr");
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(r#"echo $$ > "$1/cgroup.procs" && shift && exec "$@""#)
        .arg("sh")
        .arg(&group.0)
        .arg(env!("CARGO_BIN_EXE_procward"))
        .args([
            "run",
            "--grace",
            "300ms",
            "--fatal-grace",
            "150ms",
            "--cleanup-deadline",
            "2s",
            "--",
        ])
        .arg(fixture())
        .args(["pwbomb", "400"])
        .env("PROCWARD_HAZARD_GROUP", format!("/{name}"))
        .stdin(Stdio::null())
        .stdout(fs::File::create(&stdout).unwrap())
        .stderr(fs::File::create(&stderr).unwrap());
    unsafe {
        command.pre_exec(|| {
            let limit = libc::rlimit {
                rlim_cur: 32,
                rlim_max: 32,
            };
            if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut unrelated = Command::new("sleep").arg("30").spawn().unwrap();
    let mut child: Child = command.spawn().unwrap();
    let ready = Instant::now() + Duration::from_secs(2);
    poll(ready, || {
        let text = fs::read_to_string(&stdout).unwrap();
        let peak = fs::read_to_string(group.0.join("pids.peak"))
            .unwrap()
            .trim()
            .parse::<u64>()
            .unwrap();
        ["ready\n", "rolling-started", "deep-started", "wide-started"]
            .iter()
            .all(|marker| text.contains(marker))
            && peak >= 400
    });
    let output = fs::read_to_string(&stdout).unwrap();
    for marker in ["rolling-started", "deep-started", "wide-started"] {
        assert!(
            output.contains(marker),
            "missing actual adversarial branch: {output}"
        );
    }
    let peak: u64 = fs::read_to_string(group.0.join("pids.peak"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(
        peak > 32,
        "workload never exceeded the controller's fd limit: {peak}"
    );

    let fault = Instant::now();
    unsafe { assert_eq!(libc::kill(child.id() as i32, libc::SIGTERM), 0) };
    poll(fault + Duration::from_millis(2500), || {
        child.try_wait().unwrap().is_some()
    });
    let code = child.wait().unwrap().code();
    let remaining = group.populated();
    let memory = fs::read_to_string(group.0.join("memory.events")).unwrap();
    let oom_kills = memory
        .lines()
        .find_map(|line| line.strip_prefix("oom_kill "))
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let diagnostic = fs::read_to_string(&stderr).unwrap();
    let unrelated_alive = unrelated.try_wait().unwrap().is_none();
    if unrelated_alive {
        unrelated.kill().unwrap();
    }
    unrelated.wait().unwrap();
    eprintln!(
        "HAZARD-REAL: uncapped rolling/deep/wide, nofile=32 pids_peak={peak} code={code:?} populated={remaining} oom_kills={oom_kills} elapsed={:?}; stderr={diagnostic:?}",
        fault.elapsed()
    );
    assert_eq!(
        oom_kills, 0,
        "OOM containment must not be credited as product cleanup"
    );
    assert!(diagnostic.contains("falls back to subreaper and pidfd termination"));
    assert!(!diagnostic.contains("Too many open files"), "{diagnostic}");
    assert!(
        !remaining,
        "signalable rolling/deep/wide workload survived product cleanup"
    );
    assert_eq!(code, Some(137), "{diagnostic}");
    assert!(unrelated_alive, "unrelated process was hit");
    fs::remove_dir_all(scratch).unwrap();
}
