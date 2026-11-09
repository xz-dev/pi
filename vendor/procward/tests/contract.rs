// SPDX-License-Identifier: BSD-3-Clause
use std::{
    fs,
    io::{self, Write},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
fn fixture() -> std::path::PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(format!("examples/fixture{}", std::env::consts::EXE_SUFFIX))
}
fn finish(mut child: std::process::Child) -> std::process::Output {
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("contract response deadline; HARNESS RESCUE, not product cleanup");
        }
        thread::sleep(Duration::from_millis(2));
    }
    child.wait_with_output().unwrap()
}
#[cfg(unix)]
fn pipe() -> (fs::File, fs::File, &'static str, String) {
    use std::os::fd::AsRawFd;
    let (read, write) = rustix::pipe::pipe().unwrap();
    rustix::io::fcntl_setfd(&write, rustix::io::FdFlags::CLOEXEC).unwrap();
    let raw = read.as_raw_fd().to_string();
    (read.into(), write.into(), "PROCWARD_LIFECYCLE_FD", raw)
}
#[cfg(windows)]
fn pipe() -> (fs::File, fs::File, &'static str, String) {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation},
        Security::SECURITY_ATTRIBUTES,
        System::Pipes::CreatePipe,
    };
    let security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
    assert_ne!(
        unsafe { CreatePipe(&mut read, &mut write, &security, 4096) },
        0
    );
    let read = unsafe { OwnedHandle::from_raw_handle(read) };
    let write = unsafe { OwnedHandle::from_raw_handle(write) };
    assert_ne!(
        unsafe { SetHandleInformation(write.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) },
        0
    );
    let raw = (read.as_raw_handle() as usize).to_string();
    (read.into(), write.into(), "PROCWARD_LIFECYCLE_HANDLE", raw)
}
#[cfg(unix)]
fn identity() -> String {
    "parent".into()
}
#[cfg(windows)]
fn identity() -> String {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let mut times: [FILETIME; 4] = unsafe { std::mem::zeroed() };
    assert_ne!(
        unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut times[0],
                &mut times[1],
                &mut times[2],
                &mut times[3],
            )
        },
        0
    );
    format!(
        "{:016x}",
        (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime)
    )
}

#[test]
fn managed_handoff_is_direct_bounded_one_shot_and_separate_from_native_ownership() {
    let dir = std::env::temp_dir().join(format!("procward-contract-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let output = finish(
        Command::new(env!("CARGO_BIN_EXE_procward"))
            .args(["run", "--"])
            .arg(fixture())
            .arg("managed-probe")
            .arg(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    assert_eq!(output.status.code(), Some(23), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("ORDINARY-CLEAN"));
    assert!(String::from_utf8_lossy(&output.stdout).contains("MANAGED "));
    assert!(dir.join("accepted").exists());
    fs::remove_file(dir.join("accepted")).unwrap();
    for case in [
        "owner",
        "primary",
        "launch",
        "identity",
        "version",
        "oversized",
        "truncated",
        "EOF",
        "unsupported-env",
    ] {
        let (read, mut write, variable, raw) = pipe();
        let owner = std::process::id() + u32::from(case == "owner");
        let id = "0123456789abcdef0123456789abcdef";
        let child = Command::new(fixture())
            .arg("managed-probe")
            .arg(&dir)
            .env(
                "PROCWARD_PROTOCOL",
                if case == "unsupported-env" { "2" } else { "1" },
            )
            .env("PROCWARD_OWNER_PID", owner.to_string())
            .env("PROCWARD_CONTRACT_ID", id)
            .env(variable, raw)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        drop(read);
        let pid = child.id() + u32::from(case == "primary");
        let mut record = format!(
            "PROCWARD/{} READY {owner} {pid} {} {}\n",
            if case == "version" { 2 } else { 1 },
            if case == "identity" {
                "stale".into()
            } else {
                identity()
            },
            if case == "launch" {
                "ffffffffffffffffffffffffffffffff"
            } else {
                id
            }
        );
        match case {
            "oversized" => record = format!("{}\n", "a".repeat(257)),
            "truncated" => record = "PROCWARD/1 READY".into(),
            "EOF" => record.clear(),
            _ => {}
        }
        if let Err(error) = write.write_all(record.as_bytes()) {
            assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
        }
        drop(write);
        let output = finish(child);
        assert_eq!(output.status.code(), Some(125), "{case}: {output:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("REJECTED"),
            "{case}: {output:?}"
        );
        assert!(
            !dir.join("accepted").exists(),
            "{case}: application side effect before validation"
        );
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn stale_application_metadata_still_starts_fresh_ownership() {
    let marker = std::env::temp_dir().join(format!("procward-nested-stale-{}", std::process::id()));
    fs::create_dir(&marker).unwrap();
    let regular = fs::File::open(std::env::current_exe().unwrap()).unwrap();
    #[cfg(unix)]
    let (variable, raw) = {
        use std::os::fd::AsRawFd;
        rustix::io::fcntl_setfd(&regular, rustix::io::FdFlags::empty()).unwrap();
        ("PROCWARD_LIFECYCLE_FD", regular.as_raw_fd().to_string())
    };
    #[cfg(windows)]
    let (variable, raw) = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};
        assert_ne!(
            unsafe {
                SetHandleInformation(
                    regular.as_raw_handle(),
                    HANDLE_FLAG_INHERIT,
                    HANDLE_FLAG_INHERIT,
                )
            },
            0
        );
        (
            "PROCWARD_LIFECYCLE_HANDLE",
            (regular.as_raw_handle() as usize).to_string(),
        )
    };
    for value in ["0", "invalid", "2147483647", &raw] {
        let output = finish(
            Command::new(env!("CARGO_BIN_EXE_procward"))
                .args(["run", "--"])
                .arg(fixture())
                .arg("managed-probe")
                .arg(&marker)
                .env("PROCWARD_PROTOCOL", "stale")
                .env("PROCWARD_OWNER_PID", "1")
                .env("PROCWARD_CONTRACT_ID", "stale")
                .env(variable, value)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        assert_eq!(output.status.code(), Some(23), "{value}: {output:?}");
        assert!(
            marker.join("accepted").exists(),
            "fresh READY was not accepted"
        );
        fs::remove_file(marker.join("accepted")).unwrap();
    }
    fs::remove_dir_all(marker).unwrap();
}

#[cfg(unix)]
#[test]
fn owner_loss_notifies_cooperative_primary_and_bounds_blocked_primary_by_configured_policy() {
    use rustix::{
        io::Errno,
        process::{self, Pid, Signal, WaitOptions},
    };
    #[cfg(target_os = "linux")]
    process::set_child_subreaper(Some(Pid::INIT)).unwrap();
    #[cfg(target_os = "freebsd")]
    process::set_reaper_status(true).unwrap();
    fn gone(raw: u32) -> bool {
        let pid = Pid::from_raw(raw as i32).unwrap();
        match process::waitpid(Some(pid), WaitOptions::NOHANG) {
            Ok(Some((_, status))) => {
                assert!(status.exit_status().is_some() || status.terminating_signal().is_some())
            }
            Ok(None) | Err(Errno::CHILD | Errno::INTR) => {}
            Err(error) => panic!("owned-child wait failed: {error}"),
        }
        match process::test_kill_process(pid) {
            Err(Errno::SRCH) => true,
            Ok(()) => false,
            Err(error) => panic!("identity query failed: {error}"),
        }
    }
    struct Case {
        owner: std::process::Child,
        dir: std::path::PathBuf,
        targets: Vec<u32>,
        done: bool,
        #[cfg(target_os = "macos")]
        identities: Vec<libproc::bsd_info::BSDInfo>,
    }
    impl Drop for Case {
        fn drop(&mut self) {
            if !self.done {
                eprintln!("HARNESS RESCUE: owner-loss fixture; not product cleanup");
                let _ = self.owner.kill();
                let _ = self.owner.wait();
                let deadline = Instant::now() + Duration::from_secs(3);
                while !self.targets.iter().copied().all(gone) && Instant::now() < deadline {
                    for raw in self.targets.iter().rev() {
                        let pid = Pid::from_raw(*raw as i32).unwrap();
                        #[cfg(not(target_os = "macos"))]
                        if matches!(process::waitpid(Some(pid), WaitOptions::NOHANG), Ok(None)) {
                            let _ = process::kill_process(pid, Signal::KILL);
                        }
                        #[cfg(target_os = "macos")]
                        if let Ok(now) =
                            libproc::proc_pid::pidinfo::<libproc::bsd_info::BSDInfo>(*raw as i32, 0)
                        {
                            if self.identities.iter().any(|old| {
                                (
                                    old.pbi_pid,
                                    old.pbi_start_tvsec,
                                    old.pbi_start_tvusec,
                                    old.pbi_uid,
                                    old.pbi_ruid,
                                    old.pbi_svuid,
                                ) == (
                                    now.pbi_pid,
                                    now.pbi_start_tvsec,
                                    now.pbi_start_tvusec,
                                    now.pbi_uid,
                                    now.pbi_ruid,
                                    now.pbi_svuid,
                                )
                            }) {
                                let _ = process::kill_process(pid, Signal::KILL);
                            }
                        }
                    }
                    thread::sleep(Duration::from_millis(2));
                }
            }
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    for mode in ["cooperative", "blocked", "EOF"] {
        let dir = std::env::temp_dir().join(format!(
            "procward-owner-contract-{}-{mode}",
            std::process::id()
        ));
        fs::create_dir(&dir).unwrap();
        let owner = Command::new(env!("CARGO_BIN_EXE_procward"))
            .args([
                "run",
                "--grace",
                "1s",
                "--fatal-grace",
                "500ms",
                "--cleanup-deadline",
                "1500ms",
                "--",
            ])
            .arg(fixture())
            .arg(if mode == "blocked" {
                "managed-blocked"
            } else {
                "managed-owner"
            })
            .arg(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(dir.join("stderr.log")).unwrap())
            .spawn()
            .unwrap();
        let mut case = Case {
            owner,
            dir,
            targets: Vec::new(),
            done: false,
            #[cfg(target_os = "macos")]
            identities: Vec::new(),
        };
        let startup = Instant::now() + Duration::from_secs(20);
        while !case.dir.join("ready").exists() {
            assert!(Instant::now() < startup, "managed startup deadline");
            thread::sleep(Duration::from_millis(2));
        }
        for name in ["primary", "anchor"] {
            let raw: u32 = fs::read_to_string(case.dir.join(name))
                .unwrap()
                .parse()
                .unwrap();
            case.targets.push(raw);
            #[cfg(target_os = "macos")]
            case.identities.push(
                libproc::proc_pid::pidinfo::<libproc::bsd_info::BSDInfo>(raw as i32, 0).unwrap(),
            );
        }
        let fault = Instant::now();
        if mode == "EOF" {
            process::kill_process(Pid::from_raw(case.targets[1] as i32).unwrap(), Signal::KILL)
                .unwrap();
        } else {
            case.owner.kill().unwrap();
        }
        let deadline = fault + Duration::from_secs(2);
        loop {
            let owner_done = case.owner.try_wait().unwrap().is_some();
            if case.targets.iter().copied().all(gone) && owner_done {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "{mode}: original configured deadline exceeded; targets={:?}; notification={:?}; stderr={:?}",
                case.targets,
                fs::read_to_string(case.dir.join("notification")),
                fs::read_to_string(case.dir.join("stderr.log"))
            );
            thread::sleep(Duration::from_millis(2));
        }
        if mode == "blocked" {
            assert!(
                fault.elapsed() >= Duration::from_secs(1),
                "configured ordinary grace must not be skipped"
            );
            assert!(
                !case.dir.join("notification").exists(),
                "blocked main loop cannot fake observing notification"
            );
        } else {
            assert_eq!(
                fs::read_to_string(case.dir.join("notification")).unwrap(),
                if mode == "EOF" { "EOF" } else { "notice" }
            );
        }
        assert!(!case.owner.wait().unwrap().success());
        case.done = true;
    }
}
