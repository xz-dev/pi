// SPDX-License-Identifier: BSD-3-Clause
#![cfg(windows)]
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        TerminateProcess, WaitForSingleObject,
    },
};

fn poll(deadline: Instant, mut predicate: impl FnMut() -> bool) {
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "observable-state deadline expired"
        );
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
        .join("examples/fixture.exe")
}
struct Handle(HANDLE);
impl Handle {
    fn open(pid: u32) -> Self {
        let raw = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                0,
                pid,
            )
        };
        assert!(
            !raw.is_null(),
            "OpenProcess failed: {}",
            std::io::Error::last_os_error()
        );
        Self(raw)
    }
    fn exited(&self) -> bool {
        match unsafe { WaitForSingleObject(self.0, 0) } {
            WAIT_OBJECT_0 => true,
            WAIT_TIMEOUT => false,
            result => panic!(
                "process wait query failed: {result}, {}",
                std::io::Error::last_os_error()
            ),
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        assert_ne!(unsafe { CloseHandle(self.0) }, 0);
    }
}
struct Run {
    child: Child,
    dir: PathBuf,
    handles: Vec<Handle>,
}
impl Run {
    fn new(serial: usize) -> Self {
        let dir =
            std::env::temp_dir().join(format!("procward-windows-{}-{serial}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_procward"))
            .args(["run", "--"])
            .arg(fixture())
            .arg("tree")
            .arg(&dir)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let mut run = Self {
            child,
            dir,
            handles: Vec::new(),
        };
        for mode in ["tree", "branch", "worker"] {
            let path = run.dir.join(format!("{mode}.pid"));
            poll(Instant::now() + Duration::from_secs(20), || {
                path.try_exists().unwrap()
                    && fs::read_to_string(&path).unwrap().parse::<u32>().is_ok()
            });
            let pid = fs::read_to_string(path).unwrap().parse().unwrap();
            run.handles.push(Handle::open(pid));
        }
        run
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
        for handle in &self.handles {
            if !handle.exited() {
                unsafe {
                    TerminateProcess(handle.0, 99);
                }
                rescued = true;
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if rescued {
            eprintln!("HARNESS RESCUE: killed Job survivors; not product cleanup");
        }
        fs::remove_dir_all(&self.dir).unwrap();
        assert!(
            !rescued || thread::panicking(),
            "Job cleanup required rescue"
        );
    }
}

#[test]
fn job_is_assigned_before_payload_work() {
    let status = Command::new(env!("CARGO_BIN_EXE_procward"))
        .args(["run", "--"])
        .arg(fixture())
        .arg("job-member")
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(23));
}

#[test]
fn primary_exit_terminates_descendants_and_confirms_job_completion() {
    let mut run = Run::new(0);
    assert!(run.handles.iter().all(|h| !h.exited()));
    run.child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
    assert_eq!(run.finish().code(), Some(23));
    assert!(run.handles.iter().all(Handle::exited));
}

#[test]
fn owner_termination_closes_last_job_handle_without_destructors() {
    let mut run = Run::new(1);
    let fault = Instant::now();
    run.child.kill().unwrap();
    assert!(!run.finish().success());
    poll(fault + Duration::from_secs(8), || {
        run.handles.iter().all(Handle::exited)
    });
}

#[test]
fn native_32_bit_primary_results_are_not_truncated() {
    for code in [0, 1, 23, 259, 0x81234567_u32, u32::MAX] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_procward"))
            .args(["run", "--"])
            .arg(fixture())
            .arg("exit")
            .arg(code.to_string())
            .spawn()
            .unwrap();
        poll(Instant::now() + Duration::from_secs(10), || {
            child.try_wait().unwrap().is_some()
        });
        assert_eq!(child.wait().unwrap().code().unwrap() as u32, code);
    }
}

#[test]
fn launch_restrictions_refuse_payload_side_effects() {
    let marker = std::env::temp_dir().join(format!("procward-denied-{}", std::process::id()));
    assert!(!marker.try_exists().unwrap());
    let status = Command::new(fixture())
        .arg("limited-launch")
        .arg(env!("CARGO_BIN_EXE_procward"))
        .arg(&marker)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(23));
    assert!(!marker.try_exists().unwrap());
}

mod windows_conpty;

#[test]
fn console_handles_one_ctrl_c_and_break_then_response_driven_quit() {
    let dir = std::env::temp_dir().join(format!("procward-console-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let mut child = Command::new(fixture())
        .arg("console-host")
        .arg(env!("CARGO_BIN_EXE_procward"))
        .arg(&dir)
        .spawn()
        .unwrap();
    poll(Instant::now() + Duration::from_secs(40), || {
        child.try_wait().unwrap().is_some()
    });
    let status = child.wait().unwrap();
    let transcript = fs::read_to_string(dir.join("console.log"));
    fs::remove_dir_all(dir).unwrap();
    assert_eq!(status.code(), Some(23), "{transcript:?}");
}

#[test]
fn job_wait_does_not_complete_while_gated_descendants_are_alive() {
    use process_wrap::tokio::{CommandWrap, JobObject, KillOnDrop};
    use std::task::{Context, Poll, Waker};
    let dir = std::env::temp_dir().join(format!("procward-job-wait-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut command = tokio::process::Command::new(fixture());
        command.arg("job-wait").arg(&dir);
        let mut job = CommandWrap::from(command)
            .wrap(KillOnDrop)
            .wrap(JobObject)
            .spawn()
            .unwrap();
        let mut descendants = Vec::new();
        for mode in ["branch", "worker"] {
            let path = dir.join(format!("{mode}.pid"));
            poll(Instant::now() + Duration::from_secs(20), || {
                path.try_exists().unwrap()
                    && fs::read_to_string(&path).unwrap().parse::<u32>().is_ok()
            });
            descendants.push(Handle::open(
                fs::read_to_string(path).unwrap().parse().unwrap(),
            ));
        }
        fs::write(dir.join("release"), b"exit primary").unwrap();
        poll(Instant::now() + Duration::from_secs(5), || {
            job.inner_mut().try_wait().unwrap().is_some()
        });
        assert!(descendants.iter().all(|handle| !handle.exited()));
        let mut completion = job.wait();
        let mut context = Context::from_waker(Waker::noop());
        assert!(
            matches!(completion.as_mut().poll(&mut context), Poll::Pending),
            "Job wait completed while gated descendant process handles are still live"
        );
        for handle in &descendants {
            assert_ne!(unsafe { TerminateProcess(handle.0, 0) }, 0);
        }
        let result = tokio::time::timeout(Duration::from_millis(7500), completion)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.code(), Some(23));
        assert!(descendants.iter().all(Handle::exited));
    });
    runtime.shutdown_timeout(Duration::from_millis(50));
    fs::remove_dir_all(dir).unwrap();
}
