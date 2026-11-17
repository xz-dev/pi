// SPDX-License-Identifier: BSD-3-Clause
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[path = "fixtures/pipes.rs"]
mod pipes;

const DEADLINE: Duration = Duration::from_millis(2500);
static SCENARIOS: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn poll(deadline: Instant, mut condition: impl FnMut() -> bool) {
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "nested ownership observation deadline expired"
        );
        thread::sleep(Duration::from_millis(2));
    }
}
fn fixture() -> PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(format!("examples/fixture{}", std::env::consts::EXE_SUFFIX))
}
struct Identity {
    pid: u32,
    #[cfg(target_os = "linux")]
    fd: rustix::fd::OwnedFd,
    #[cfg(target_os = "macos")]
    birth: libproc::bsd_info::BSDInfo,
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
}
impl Identity {
    fn open(pid: u32) -> Self {
        Self {
            pid,
            #[cfg(target_os = "linux")]
            fd: rustix::process::pidfd_open(
                rustix::process::Pid::from_raw(pid as i32).unwrap(),
                rustix::process::PidfdFlags::empty(),
            )
            .unwrap(),
            #[cfg(target_os = "macos")]
            birth: libproc::proc_pid::pidinfo(pid as i32, 0).unwrap(),
            #[cfg(windows)]
            handle: {
                use std::os::windows::io::FromRawHandle;
                use windows_sys::Win32::System::Threading::*;
                let handle = unsafe {
                    OpenProcess(
                        PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                        0,
                        pid,
                    )
                };
                assert!(
                    !handle.is_null(),
                    "OpenProcess({pid}): {}",
                    std::io::Error::last_os_error()
                );
                unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) }
            },
        }
    }
    fn gone(&self) -> bool {
        #[cfg(unix)]
        {
            use rustix::{
                io::Errno,
                process::{self, Pid, WaitOptions},
            };
            match process::waitpid(
                Some(Pid::from_raw(self.pid as i32).unwrap()),
                WaitOptions::NOHANG,
            ) {
                Ok(Some(_)) | Err(Errno::CHILD | Errno::INTR) | Ok(None) => {}
                Err(error) => panic!("nested owned wait: {error}"),
            }
        }
        #[cfg(target_os = "linux")]
        return match fs::metadata(format!("/proc/{}", self.pid)) {
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => panic!("nested completion query: {error}"),
        };
        #[cfg(target_os = "freebsd")]
        return match rustix::process::test_kill_process(
            rustix::process::Pid::from_raw(self.pid as i32).unwrap(),
        ) {
            Ok(()) => false,
            Err(rustix::io::Errno::SRCH) => true,
            Err(error) => panic!("nested completion query: {error}"),
        };
        #[cfg(target_os = "macos")]
        return match libproc::proc_pid::pidinfo::<libproc::bsd_info::BSDInfo>(self.pid as i32, 0) {
            Ok(now) => !self.same(&now),
            Err(error) => match rustix::process::test_kill_process(
                rustix::process::Pid::from_raw(self.pid as i32).unwrap(),
            ) {
                Err(rustix::io::Errno::SRCH) => true,
                Ok(()) => false, // Existing PID with unavailable birth facts remains unknown.
                Err(query) => panic!("nested identity query: {error}; {query}"),
            },
        };
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{
                Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::WaitForSingleObject,
            };
            match unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 0) } {
                WAIT_OBJECT_0 => true,
                WAIT_TIMEOUT => false,
                result => panic!(
                    "nested process wait: {result}, {}",
                    std::io::Error::last_os_error()
                ),
            }
        }
    }
    #[cfg(target_os = "macos")]
    fn same(&self, now: &libproc::bsd_info::BSDInfo) -> bool {
        let old = &self.birth;
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
    }
    fn kill(&self) -> Instant {
        #[cfg(target_os = "freebsd")]
        {
            use rustix::process::{self, IdType, PidInfoFlags};
            let mut reapers = vec![process::getpid()];
            let mut owned = Vec::new();
            while let Some(reaper) = reapers.pop() {
                // GETPIDS omits descendants below subordinate reapers; traverse each domain.
                for info in process::get_reaper_pids(Some((IdType::Pid, reaper))).unwrap() {
                    if info.flags.contains(PidInfoFlags::REAPER) {
                        reapers.push(info.pid);
                    }
                    owned.push(info.pid);
                }
            }
            assert!(
                owned
                    .iter()
                    .any(|pid| pid.as_raw_nonzero().get() as u32 == self.pid),
                "target left test's nested reaper subtree"
            );
        }
        #[cfg(target_os = "macos")]
        {
            let now = libproc::proc_pid::pidinfo(self.pid as i32, 0).unwrap();
            assert!(self.same(&now), "nested identity changed before signal");
        }
        // Identity checks precede injection; the unchanged bound starts at the actual kill.
        let fault = Instant::now();
        #[cfg(target_os = "linux")]
        rustix::process::pidfd_send_signal(&self.fd, rustix::process::Signal::KILL).unwrap();
        #[cfg(any(target_os = "freebsd", target_os = "macos"))]
        {
            rustix::process::kill_process(
                rustix::process::Pid::from_raw(self.pid as i32).unwrap(),
                rustix::process::Signal::KILL,
            )
            .unwrap();
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            assert_ne!(
                unsafe {
                    windows_sys::Win32::System::Threading::TerminateProcess(
                        self.handle.as_raw_handle(),
                        71,
                    )
                },
                0
            );
        }
        fault
    }
}
struct Run {
    child: Child,
    dir: PathBuf,
    targets: Vec<Identity>,
    done: bool,
}
impl Run {
    fn start(label: &str, mode: &str, intermediary: Option<&str>) -> Self {
        static CALLER_HYGIENE: std::sync::Once = std::sync::Once::new();
        CALLER_HYGIENE.call_once(|| {
            // CI runners leave unrelated pipes inheritable; launch with only stdio, not runner internals.
            for raw in pipes::open(true).unwrap() {
                #[cfg(unix)]
                rustix::io::fcntl_setfd(
                    unsafe { rustix::fd::BorrowedFd::borrow_raw(raw as i32) },
                    rustix::io::FdFlags::CLOEXEC,
                )
                .unwrap();
                #[cfg(windows)]
                assert_ne!(
                    unsafe {
                        windows_sys::Win32::Foundation::SetHandleInformation(
                            raw as _,
                            windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT,
                            0,
                        )
                    },
                    0
                );
            }
        });
        #[cfg(target_os = "linux")]
        rustix::process::set_child_subreaper(Some(rustix::process::Pid::INIT)).unwrap();
        #[cfg(target_os = "freebsd")]
        {
            static REAPER: std::sync::Once = std::sync::Once::new();
            REAPER.call_once(|| rustix::process::set_reaper_status(true).unwrap());
        }
        let dir =
            std::env::temp_dir().join(format!("procward-nesting-{}-{label}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_procward"));
        command.args([
            "run",
            "--grace",
            "2s",
            "--fatal-grace",
            "1s",
            "--cleanup-deadline",
            "2500ms",
            "--",
        ]);
        match intermediary {
            Some("python") => {
                let python = ["python3", "python3.11", "python"]
                    .into_iter()
                    .find(|name| {
                        Command::new(name)
                            .arg("--version")
                            .output()
                            .is_ok_and(|out| out.status.success())
                    })
                    .expect("Python is required for the ordinary-intermediary regression");
                command.arg(python).args([
                    "-c",
                    "import subprocess,sys; sys.exit(subprocess.run(sys.argv[1:]).returncode)",
                ]);
            }
            Some("sh") => {
                #[cfg(unix)]
                let shell = PathBuf::from("/bin/sh");
                #[cfg(windows)]
                let shell =
                    PathBuf::from(std::env::var_os("ProgramFiles").unwrap()).join("Git/bin/sh.exe");
                command.arg(shell).args(["-c", "exec \"$@\"", "sh"]);
            }
            None => {}
            Some(other) => panic!("unknown intermediary {other}"),
        }
        let child = command
            .arg(env!("CARGO_BIN_EXE_procward"))
            .args(["run", "--"])
            .arg(fixture())
            .arg(mode)
            .arg(&dir)
            .stdin(Stdio::piped())
            .stdout(fs::File::create(dir.join("stdout.log")).unwrap())
            .stderr(fs::File::create(dir.join("stderr.log")).unwrap())
            .spawn()
            .unwrap();
        Self {
            child,
            dir,
            targets: Vec::new(),
            done: false,
        }
    }
    fn pid(&self, file: &str) -> u32 {
        fs::read_to_string(self.dir.join(file))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }
    fn ready(&mut self) -> u32 {
        poll(Instant::now() + Duration::from_secs(30), || {
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "nested startup failed: {:?}",
                fs::read_to_string(self.dir.join("stderr.log"))
            );
            self.dir.join("ready").exists()
        });
        let anchor = self.pid("inner-anchor");
        #[cfg(windows)]
        let inner = anchor;
        #[cfg(unix)]
        let inner = {
            fn parent(pid: u32) -> u32 {
                #[cfg(target_os = "linux")]
                {
                    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
                    stat.rsplit_once(')')
                        .unwrap()
                        .1
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .parse()
                        .unwrap()
                }
                #[cfg(not(target_os = "linux"))]
                {
                    let out = Command::new("ps")
                        .args(["-o", "ppid=", "-p", &pid.to_string()])
                        .output()
                        .unwrap();
                    assert!(out.status.success(), "parent query: {out:?}");
                    String::from_utf8(out.stdout)
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap()
                }
            }
            self.targets.push(Identity::open(anchor));
            let inner = parent(anchor);
            let mut ancestor = parent(inner);
            let mut depth = 0;
            while ancestor != self.child.id() {
                assert!(
                    ancestor > 1 && depth < 8,
                    "nested ownership ancestry escaped outer owner"
                );
                self.targets.push(Identity::open(ancestor));
                ancestor = parent(ancestor);
                depth += 1;
            }
            inner
        };
        assert_ne!(inner, self.child.id(), "inner layer must exist");
        for pid in [
            inner,
            self.pid("primary.pid"),
            self.pid("nested-branch.pid"),
            self.pid("nested-worker.pid"),
        ] {
            self.targets.push(Identity::open(pid));
        }
        assert!(
            self.targets.iter().all(|p| !p.gone()),
            "gated nested tree must remain alive"
        );
        #[cfg(any(target_os = "linux", target_os = "freebsd"))]
        poll(Instant::now() + Duration::from_secs(10), || {
            #[cfg(target_os = "linux")]
            {
                let stat =
                    fs::read_to_string(format!("/proc/{}/stat", self.pid("nested-worker.pid")))
                        .unwrap();
                stat.rsplit_once(')')
                    .unwrap()
                    .1
                    .split_whitespace()
                    .next()
                    .unwrap()
                    == "T"
            }
            #[cfg(target_os = "freebsd")]
            {
                let out = Command::new("ps")
                    .args([
                        "-o",
                        "state=",
                        "-p",
                        &self.pid("nested-worker.pid").to_string(),
                    ])
                    .output()
                    .unwrap();
                assert!(out.status.success(), "stopped worker query: {out:?}");
                String::from_utf8(out.stdout).unwrap().contains('T')
            }
        });
        inner
    }
    fn finish(&mut self, deadline: Instant) -> std::process::ExitStatus {
        poll(deadline, || self.child.try_wait().unwrap().is_some());
        self.child.wait().unwrap()
    }
    fn clean(&mut self, deadline: Instant) {
        poll(deadline, || self.targets.iter().all(Identity::gone));
        assert!(
            Instant::now() <= deadline,
            "nested tree completion observed after configured deadline"
        );
        self.done = true;
    }
}
impl Drop for Run {
    fn drop(&mut self) {
        if !self.done {
            eprintln!(
                "HARNESS RESCUE: failed nested ownership case; not product cleanup. stderr={:?}",
                fs::read_to_string(self.dir.join("stderr.log"))
            );
            let _ = self.child.kill();
            #[cfg(target_os = "freebsd")]
            let _ = rustix::process::reaper_kill(None, rustix::process::Signal::KILL, false, None);
            #[cfg(not(target_os = "freebsd"))]
            for process in &self.targets {
                if !process.gone() {
                    process.kill();
                }
            }
            let _ = self.child.wait();
            let deadline = Instant::now() + Duration::from_secs(3);
            while !self.targets.iter().all(Identity::gone) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(2));
            }
        }
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn nested_layers_preserve_status_and_clean_on_each_owner_loss() {
    let _guard = SCENARIOS.lock().unwrap();
    for mode in ["exit", "outer-loss", "inner-loss"] {
        let mut run = Run::start(mode, "nested-tree", None);
        let inner = run.ready();
        let (fault, expected) = match mode {
            "exit" => {
                let fault = Instant::now();
                run.child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
                (fault, 23)
            }
            "outer-loss" => {
                let fault = Instant::now();
                run.child.kill().unwrap();
                (fault, 1)
            }
            "inner-loss" => {
                let fault = run.targets.iter().find(|p| p.pid == inner).unwrap().kill();
                (fault, if cfg!(windows) { 71 } else { 137 })
            }
            _ => unreachable!(),
        };
        let deadline = fault
            + if mode == "exit" {
                Duration::from_secs(8)
            } else {
                DEADLINE
            };
        let status = run.finish(deadline);
        if mode == "outer-loss" {
            assert!(!status.success(), "killed outer owner cannot succeed");
        } else {
            assert_eq!(
                status.code(),
                Some(expected),
                "{mode}: {:?}",
                fs::read_to_string(run.dir.join("stderr.log"))
            );
        }
        run.clean(deadline);
        println!(
            "NESTING PASS: {mode}; native result={status}; tree gone in {:?} (fault deadline {DEADLINE:?}; exit includes inner cleanup)",
            fault.elapsed()
        );
    }
}

#[test]
fn nested_payload_has_only_inner_contract_metadata_and_transport() {
    let _guard = SCENARIOS.lock().unwrap();
    let mut run = Run::start("isolation", "nested-probe", None);
    let status = run.finish(Instant::now() + Duration::from_secs(30));
    assert_eq!(
        status.code(),
        Some(23),
        "nested contract isolation: harness={} outer={} inner={:?}; {:?}",
        std::process::id(),
        run.child.id(),
        fs::read_to_string(run.dir.join("inner-anchor")),
        fs::read_to_string(run.dir.join("stderr.log"))
    );
    assert_eq!(
        fs::read(run.dir.join("isolated")).unwrap(),
        b"only inner contract and pipe"
    );
    run.done = true;
    println!("NESTING PASS: contract isolation; only validated inner READY, environment and pipe");
}

#[test]
fn ordinary_intermediaries_keep_nesting_cleanup_and_inner_contract() {
    let _guard = SCENARIOS.lock().unwrap();
    for intermediary in ["python", "sh"] {
        let mut run = Run::start(
            &format!("{intermediary}-tree"),
            "nested-tree",
            Some(intermediary),
        );
        run.ready();
        let release = Instant::now();
        run.child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
        let deadline = release + Duration::from_secs(8);
        assert_eq!(
            run.finish(deadline).code(),
            Some(23),
            "{intermediary}: {:?}",
            fs::read_to_string(run.dir.join("stderr.log"))
        );
        run.clean(deadline);
        let mut probe = Run::start(
            &format!("{intermediary}-probe"),
            "nested-probe",
            Some(intermediary),
        );
        assert_eq!(
            probe
                .finish(Instant::now() + Duration::from_secs(30))
                .code(),
            Some(23),
            "{intermediary}: {:?}",
            fs::read_to_string(probe.dir.join("stderr.log"))
        );
        assert!(probe.dir.join("isolated").exists());
        probe.done = true;
        println!(
            "NESTING PASS: {intermediary} intermediary; inner layer, cleanup, metadata and transport isolation"
        );
    }
}
