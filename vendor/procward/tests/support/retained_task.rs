// SPDX-License-Identifier: BSD-3-Clause
use super::{SPAWN_LOCK, Task, completion};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
struct Worker(rustix::process::Pid);
#[cfg(windows)]
struct Worker(std::os::windows::io::OwnedHandle);
impl Worker {
    fn open(dir: &Path, name: &str) -> Self {
        let pid: u32 = fs::read_to_string(dir.join(name)).unwrap().parse().unwrap();
        #[cfg(unix)]
        {
            Self(rustix::process::Pid::from_raw(i32::try_from(pid).unwrap()).unwrap())
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::FromRawHandle;
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            assert!(
                !handle.is_null(),
                "worker handle: {}",
                std::io::Error::last_os_error()
            );
            Self(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) })
        }
    }
    fn running(&self) -> bool {
        #[cfg(unix)]
        {
            match rustix::process::test_kill_process(self.0) {
                Ok(()) => true,
                Err(rustix::io::Errno::SRCH) => false,
                Err(error) => panic!("worker query failed: {error}"),
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{
                Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::WaitForSingleObject,
            };
            match unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) } {
                WAIT_OBJECT_0 => false,
                WAIT_TIMEOUT => true,
                value => panic!("worker wait failed: {value}"),
            }
        }
    }
}

fn fixture(name: &str, retain: bool) -> (Task, PathBuf, Worker) {
    let dir = std::env::temp_dir().join(format!("procward-retained-{name}-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let mut task = Task::start_retained("retained-task", dir.to_str().unwrap(), retain);
    task.until(|t| t.transcript.contains("PROCWARD/1 S ") && dir.join("retained-ready").exists());
    let worker = Worker::open(&dir, "retained-worker.pid");
    assert!(worker.running());
    (task, dir, worker)
}
fn exit_primary(task: &mut Task, dir: &Path) {
    task.child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
    task.until(|t| t.transcript.contains("PROCWARD/1 X 23\n"));
    fs::write(dir.join("retained-probe"), b"prove liveness after X").unwrap();
    task.until(|t| {
        assert!(
            !t.eof && !t.transcript.contains("PROCWARD/1 C "),
            "primary exit must retain live work"
        );
        dir.join("retained-probed").exists()
    });
}

#[test]
fn retained_task_natural_completion_preserves_descendants_and_primary_result() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (mut task, dir, worker) = fixture("natural", true);
    exit_primary(&mut task, &dir);
    assert!(worker.running());
    assert!(task.child.try_wait().unwrap().is_none());
    // Healthy retained work must outlive the configured 1500 ms cleanup
    // deadline: the budget starts on cleanup, not when X is reported.
    let hold_until = Instant::now() + Duration::from_millis(1600);
    task.until(|t| {
        assert!(!t.eof && !t.transcript.contains("PROCWARD/1 C "));
        assert!(worker.running());
        Instant::now() >= hold_until
    });
    fs::write(dir.join("retained-release"), b"finish naturally").unwrap();
    task.until(|t| t.eof);
    assert_eq!(completion(&task.transcript, true), Ok(23));
    assert_eq!(task.child.wait().unwrap().code(), Some(23));
    assert!(dir.join("retained-finished").exists());
    assert!(!worker.running());
    let mut stderr = String::new();
    task.child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(
        stderr.is_empty(),
        "retained mode must preserve command stderr: {stderr}"
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn retained_task_cancel_after_primary_exit_confirms_tree_cleanup() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (mut task, dir, worker) = fixture("cancel", true);
    exit_primary(&mut task, &dir);
    task.endpoint.write_all(b"PROCWARD/1 CANCEL\n").unwrap();
    task.until(|t| t.eof);
    assert_eq!(completion(&task.transcript, true), Ok(23));
    assert_eq!(task.child.wait().unwrap().code(), Some(23));
    assert!(!worker.running());
    assert!(!dir.join("retained-finished").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn retained_task_controller_eof_after_primary_exit_cleans_descendants() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (mut task, dir, worker) = fixture("eof", true);
    exit_primary(&mut task, &dir);
    // Drop the only controller peer. Do not read the replacement as completion evidence.
    drop(std::mem::replace(
        &mut task.endpoint,
        fs::File::open(if cfg!(windows) { "NUL" } else { "/dev/null" }).unwrap(),
    ));
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = task.child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "controller EOF exceeded cleanup deadline"
        );
        thread::sleep(Duration::from_millis(2));
    };
    assert_eq!(
        status.code(),
        Some(125),
        "a disconnected controller cannot receive C"
    );
    assert!(!worker.running());
    assert!(!dir.join("retained-finished").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn retained_task_owner_loss_after_primary_exit_cleans_descendants() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (mut task, dir, worker) = fixture("owner-loss", true);
    #[cfg(target_os = "linux")]
    let anchor = Worker::open(&dir, "retained-anchor.pid");
    exit_primary(&mut task, &dir);
    task.child.kill().unwrap();
    assert!(!task.child.wait().unwrap().success());
    let deadline = Instant::now() + Duration::from_secs(2);
    while worker.running() {
        assert!(
            Instant::now() < deadline,
            "owner loss exceeded cleanup deadline"
        );
        thread::sleep(Duration::from_millis(2));
    }
    // Worker death and controller EOF do not confirm the orphan anchor has exited.
    #[cfg(target_os = "linux")]
    while anchor.running() {
        assert!(
            Instant::now() < deadline,
            "owner loss left the anchor alive past cleanup deadline"
        );
        thread::sleep(Duration::from_millis(2));
    }
    task.until(|t| t.eof);
    assert!(!task.transcript.contains("PROCWARD/1 C "));
    assert!(!dir.join("retained-finished").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn retained_task_option_does_not_change_default_primary_exit_cleanup() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (mut task, dir, worker) = fixture("default", false);
    task.child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
    task.until(|t| t.eof);
    assert_eq!(completion(&task.transcript, true), Ok(23));
    assert_eq!(task.child.wait().unwrap().code(), Some(23));
    assert!(!worker.running());
    assert!(!dir.join("retained-finished").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn retained_task_invalid_options_refuse_payload_side_effects() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let marker =
        std::env::temp_dir().join(format!("procward-invalid-retain-{}", std::process::id()));
    let executable = std::env::current_exe().unwrap();
    let fixture = executable
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(format!("examples/fixture{}", std::env::consts::EXE_SUFFIX));
    let option = if cfg!(windows) {
        "--control-handle"
    } else {
        "--control-fd"
    };
    for flags in [
        &["--retain-descendants"][..],
        &[
            "--retain-descendants",
            "--retain-descendants",
            option,
            "999999999",
        ][..],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_procward"))
            .arg("run")
            .args(flags)
            .arg("--")
            .arg(&fixture)
            .arg("touch")
            .arg(&marker)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{output:?}");
        assert!(!marker.exists());
    }
}
