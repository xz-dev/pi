// SPDX-License-Identifier: BSD-3-Clause
use std::{
    fs,
    io::{self, Read, Write},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
static SPAWN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(unix)]
fn pair() -> (fs::File, fs::File, &'static str, String) {
    use std::os::{
        fd::{AsRawFd, OwnedFd},
        unix::net::UnixStream,
    };
    let (parent, child) = UnixStream::pair().unwrap();
    parent.set_nonblocking(true).unwrap();
    rustix::io::fcntl_setfd(&child, rustix::io::FdFlags::empty()).unwrap();
    let raw = child.as_raw_fd().to_string();
    (
        fs::File::from(OwnedFd::from(parent)),
        fs::File::from(OwnedFd::from(child)),
        "--control-fd",
        raw,
    )
}
#[cfg(windows)]
fn pair() -> (fs::File, fs::File, &'static str, String) {
    use std::{
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        sync::atomic::{AtomicU32, Ordering},
    };
    use windows_sys::Win32::{
        Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
        },
        System::Pipes::{CreateNamedPipeW, PIPE_NOWAIT, PIPE_TYPE_BYTE},
    };
    static SERIAL: AtomicU32 = AtomicU32::new(0);
    let name: Vec<u16> = format!(
        "\\\\.\\pipe\\procward-task-{}-{}\0",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::SeqCst)
    )
    .encode_utf16()
    .collect();
    let server = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_NOWAIT,
            1,
            4096,
            4096,
            0,
            std::ptr::null(),
        )
    };
    assert_ne!(server, INVALID_HANDLE_VALUE);
    let server = unsafe { OwnedHandle::from_raw_handle(server) };
    let security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let client = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            &security,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(client, INVALID_HANDLE_VALUE);
    let client = unsafe { OwnedHandle::from_raw_handle(client) };
    let raw = (client.as_raw_handle() as usize).to_string();
    (server.into(), client.into(), "--control-handle", raw)
}
fn read_available(file: &mut fs::File, bytes: &mut [u8]) -> io::Result<usize> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::ERROR_BROKEN_PIPE, System::Pipes::PeekNamedPipe};
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                file.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                Ok(0)
            } else {
                Err(error)
            };
        }
        if available == 0 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let count = bytes.len().min(available as usize);
        file.read(&mut bytes[..count])
    }
    #[cfg(unix)]
    file.read(bytes)
}
struct Task {
    child: Child,
    endpoint: fs::File,
    transcript: String,
    eof: bool,
}
impl Task {
    fn start(mode: &str, argument: &str) -> Self {
        let (parent, child, option, raw) = pair();
        if mode == "task-probe" {
            #[cfg(unix)]
            {
                let stat = rustix::fs::fstat(&child).unwrap();
                fs::write(
                    std::path::Path::new(argument).join("control-identity"),
                    format!("{} {}", stat.st_dev, stat.st_ino),
                )
                .unwrap();
            }
            #[cfg(windows)]
            fs::write(
                std::path::Path::new(argument).join("control-identity"),
                format!("{raw} {}", std::process::id()),
            )
            .unwrap();
        }

        let fixture = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(format!("examples/fixture{}", std::env::consts::EXE_SUFFIX));
        let (grace, fatal, deadline) = if mode == "task-tree" {
            ("2s", "1s", "2500ms")
        } else {
            ("500ms", "250ms", "1500ms")
        };
        let process = Command::new(env!("CARGO_BIN_EXE_procward"))
            .args([
                "run",
                "--grace",
                grace,
                "--fatal-grace",
                fatal,
                "--cleanup-deadline",
                deadline,
                option,
                &raw,
                "--",
            ])
            .arg(fixture)
            .args([mode, argument])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        drop(child);
        Self {
            child: process,
            endpoint: parent,
            transcript: String::new(),
            eof: false,
        }
    }
    fn observe(&mut self) {
        let mut bytes = [0; 1024];
        loop {
            match read_available(&mut self.endpoint, &mut bytes) {
                Ok(0) => {
                    self.eof = true;
                    break;
                }
                Ok(count) => self
                    .transcript
                    .push_str(std::str::from_utf8(&bytes[..count]).unwrap()),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    break;
                }
                Err(error) => panic!("task observation failed: {error}"),
            }
        }
    }
    fn until(&mut self, predicate: impl Fn(&Self) -> bool) {
        let limit = Instant::now() + Duration::from_secs(8);
        loop {
            self.observe();
            if predicate(self) {
                return;
            }
            assert!(
                Instant::now() < limit,
                "task deadline: {:?}",
                self.transcript
            );
            thread::sleep(Duration::from_millis(2));
        }
    }
}
impl Drop for Task {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            eprintln!("HARNESS RESCUE: task owner; not product cleanup");
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
fn completion(transcript: &str, eof: bool) -> Result<u32, &'static str> {
    let lines: Vec<_> = transcript
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>())
        .collect();
    if !eof || lines.len() != 3 {
        return Err("missing completion or transport drain");
    }
    if lines[0].len() != 4
        || lines[0][..2] != ["PROCWARD/1", "S"]
        || lines[1].len() != 3
        || lines[1][..2] != ["PROCWARD/1", "X"]
        || lines[2].len() != 3
        || lines[2][..2] != ["PROCWARD/1", "C"]
    {
        return Err("invalid task sequence");
    }
    let scope = if cfg!(target_os = "macos") {
        "best-effort"
    } else {
        "kernel"
    };
    if lines[0][3] != scope || lines[2][2] != scope {
        return Err("wrong cleanup guarantee");
    }
    lines[1][2].parse().map_err(|_| "invalid native result")
}
#[test]
fn task_completion_requires_native_result_cleanup_acknowledgement_and_transport_eof() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut task = Task::start("exit", "23");
    task.until(|t| t.eof);
    assert_eq!(completion(&task.transcript, task.eof), Ok(23));
    assert_eq!(task.child.wait().unwrap().code(), Some(23));
    let incomplete = task
        .transcript
        .lines()
        .take(2)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        completion(&incomplete, true).is_err(),
        "primary exit is not tree completion"
    );
    assert!(
        completion(&task.transcript, false).is_err(),
        "C alone is not transport drain"
    );
    #[cfg(windows)]
    {
        let mut task = Task::start("exit", "4275878552");
        task.until(|t| t.eof);
        assert_eq!(completion(&task.transcript, true), Ok(0xfedcba98));
        assert_eq!(
            task.child.wait().unwrap().code().unwrap() as u32,
            0xfedcba98
        );
    }
}
#[test]
fn task_cancellation_is_bounded_and_invalid_control_never_acknowledges_success() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("procward-task-cancel-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    for malformed in [false, true] {
        let mut task = Task::start("waiting", dir.to_str().unwrap());
        task.until(|t| t.transcript.contains("PROCWARD/1 S ") && dir.join("waiting.pid").exists());
        let fault = Instant::now();
        task.endpoint
            .write_all(if malformed {
                b"PROCWARD/1 INVALID\n"
            } else {
                b"PROCWARD/1 CANCEL\n"
            })
            .unwrap();
        task.until(|t| t.eof);
        assert!(fault.elapsed() < Duration::from_secs(2));
        let status = task.child.wait().unwrap();
        if malformed {
            assert!(task.transcript.contains("PROCWARD/1 E 125\n"));
            assert!(!task.transcript.contains("PROCWARD/1 C "));
            assert_eq!(status.code(), Some(125));
        } else {
            let result = completion(&task.transcript, true).unwrap();
            assert_ne!(result, 23);
            assert_eq!(status.code().unwrap() as u32, result);
        }
        let _ = fs::remove_file(dir.join("waiting.pid"));
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn task_is_non_session_and_does_not_leak_its_controller_endpoint() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("procward-task-mode-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let mut task = Task::start("task-probe", dir.to_str().unwrap());
    task.until(|t| t.eof);
    assert_eq!(
        completion(&task.transcript, true),
        Ok(23),
        "{}",
        task.transcript
    );
    assert_eq!(task.child.wait().unwrap().code(), Some(23));
    assert!(dir.join("accepted").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn invalid_control_options_and_endpoints_refuse_payload_side_effects() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let marker =
        std::env::temp_dir().join(format!("procward-invalid-control-{}", std::process::id()));
    let fixture = std::env::current_exe()
        .unwrap()
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
    for (value, expected) in [("nan", 2), ("0", 2), ("999999999", 125)] {
        let output = Command::new(env!("CARGO_BIN_EXE_procward"))
            .args(["run", option, value, "--"])
            .arg(&fixture)
            .arg("touch")
            .arg(&marker)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(expected), "{value}: {output:?}");
        assert!(!marker.exists());
    }
}

#[cfg(any(target_os = "linux", target_os = "freebsd"))]
#[test]
fn primary_result_precedes_tree_completion_and_controller_loss_cannot_acknowledge_it() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    use rustix::{
        io::Errno,
        process::{self, Pid, Signal},
    };
    for lose_controller in [false, true] {
        let dir = std::env::temp_dir().join(format!(
            "procward-task-tree-{}-{lose_controller}",
            std::process::id()
        ));
        fs::create_dir(&dir).unwrap();
        let mut task = Task::start("task-tree", dir.to_str().unwrap());
        task.until(|_| {
            dir.join("task-worker-ready").exists()
                && fs::read_to_string(dir.join("task-anchor"))
                    .ok()
                    .is_some_and(|v| v.parse::<i32>().is_ok())
        });
        let worker = Pid::from_raw(
            fs::read_to_string(dir.join("task-worker.pid"))
                .unwrap()
                .parse()
                .unwrap(),
        )
        .unwrap();
        let fault = Instant::now();
        task.child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
        task.until(|t| t.transcript.contains("PROCWARD/1 X 23\n"));
        assert!(
            !task.transcript.contains("PROCWARD/1 C "),
            "primary result must precede live-tree cleanup"
        );
        assert!(
            process::test_kill_process(worker).is_ok(),
            "ignoring worker must still be alive during grace"
        );
        if lose_controller {
            let anchor = Pid::from_raw(
                fs::read_to_string(dir.join("task-anchor"))
                    .unwrap()
                    .parse()
                    .unwrap(),
            )
            .unwrap();
            process::kill_process(anchor, Signal::KILL).unwrap();
        }
        task.until(|t| t.eof);
        assert!(
            fault.elapsed() < Duration::from_secs(3),
            "original configured tree deadline"
        );
        assert_eq!(
            process::test_kill_process(worker),
            Err(Errno::SRCH),
            "C/error transport close must not leave known worker"
        );
        if lose_controller {
            assert!(
                task.transcript.contains("PROCWARD/1 E 125\n"),
                "{}",
                task.transcript
            );
            assert!(
                !task.transcript.contains("PROCWARD/1 C "),
                "controller failure after X must not claim success"
            );
            assert_eq!(task.child.wait().unwrap().code(), Some(125));
        } else {
            assert_eq!(completion(&task.transcript, true), Ok(23));
            assert_eq!(task.child.wait().unwrap().code(), Some(23));
        }
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn malformed_task_control_cannot_block_final_error_on_full_stderr() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("procward-task-stderr-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let mut task = Task::start("blocked-stderr", dir.to_str().unwrap());
    task.until(|t| {
        let stderr = t.child.stderr.as_ref().unwrap();
        #[cfg(unix)]
        {
            rustix::io::ioctl_fionread(stderr).unwrap() > 0
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let mut available = 0;
            assert_ne!(
                unsafe {
                    windows_sys::Win32::System::Pipes::PeekNamedPipe(
                        stderr.as_raw_handle(),
                        std::ptr::null_mut(),
                        0,
                        std::ptr::null_mut(),
                        &mut available,
                        std::ptr::null_mut(),
                    )
                },
                0
            );
            available > 0
        }
    });
    let fault = Instant::now();
    task.endpoint.write_all(b"PROCWARD/1 INVALID\n").unwrap();
    task.until(|t| t.eof);
    let status = loop {
        if let Some(status) = task.child.try_wait().unwrap() {
            break status;
        }
        assert!(
            fault.elapsed() < Duration::from_secs(2),
            "final error reporting blocked on payload-filled stderr"
        );
        thread::sleep(Duration::from_millis(2));
    };
    assert_eq!(status.code(), Some(125));
    assert!(!task.transcript.contains("PROCWARD/1 C "));
    fs::remove_dir_all(dir).unwrap();
}
