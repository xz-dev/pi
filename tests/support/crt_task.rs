// SPDX-License-Identifier: BSD-3-Clause
use super::{SPAWN_LOCK, completion, pair, read_available};
use std::{
    ffi::OsStr,
    fs, io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle},
    },
    panic::{AssertUnwindSafe, catch_unwind},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{GetExitCodeProcess, GetProcessId, TerminateProcess, WaitForSingleObject},
};

unsafe extern "C" {
    fn _open_osfhandle(handle: isize, flags: i32) -> i32;
    fn _close(fd: i32) -> i32;
    fn _wspawnv(mode: i32, path: *const u16, args: *const *const u16) -> isize;
}

#[test]
fn crt_inherited_descriptor_runs_the_real_cli_without_leaking_control_or_truncating_status() {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("procward-task-crt-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let fixture = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/fixture.exe");
    for (mode, argument, expected) in [
        ("exit", OsStr::new("23"), 23),
        ("exit", OsStr::new("4275878552"), 0xfedcba98),
        ("task-probe", dir.as_os_str(), 23),
    ] {
        let (mut endpoint, child, _, raw) = pair();
        if mode == "task-probe" {
            fs::write(
                dir.join("control-identity"),
                format!("{raw} {}", std::process::id()),
            )
            .unwrap();
        }
        let fd = unsafe { _open_osfhandle(child.into_raw_handle() as isize, 0x8000) };
        assert!(fd > 2);
        let mut command = Command::new(env!("CARGO_BIN_EXE_procward"));
        command
            .args([
                "run",
                "--grace",
                "500ms",
                "--fatal-grace",
                "250ms",
                "--cleanup-deadline",
                "1500ms",
                "--control-fd",
                &fd.to_string(),
                "--",
            ])
            .arg(&fixture)
            .arg(mode)
            .arg(argument);
        let program: Vec<u16> = command.get_program().encode_wide().chain([0]).collect();
        // CRT spawn publishes its descriptor table through STARTUPINFO. All
        // arguments here have no embedded quotes or trailing backslashes.
        let args: Vec<Vec<u16>> = std::iter::once(command.get_program())
            .chain(command.get_args())
            .map(|arg| {
                std::iter::once(b'"' as u16)
                    .chain(arg.encode_wide())
                    .chain([b'"' as u16, 0])
                    .collect()
            })
            .collect();
        let pointers: Vec<*const u16> = args
            .iter()
            .map(|arg| arg.as_ptr())
            .chain([std::ptr::null()])
            .collect();
        let process = unsafe { _wspawnv(1, program.as_ptr(), pointers.as_ptr()) };
        let closed = unsafe { _close(fd) };
        assert_ne!(process, -1, "CRT process launch failed");
        let process = unsafe { OwnedHandle::from_raw_handle(process as _) };
        let result = catch_unwind(AssertUnwindSafe(|| {
            assert_eq!(closed, 0);
            let pid = unsafe { GetProcessId(process.as_raw_handle()) };
            assert_ne!(pid, 0);
            let limit = Instant::now() + Duration::from_secs(8);
            let mut transcript = String::new();
            loop {
                let mut bytes = [0; 1024];
                match read_available(&mut endpoint, &mut bytes) {
                    Ok(0) => break,
                    Ok(count) => transcript.push_str(std::str::from_utf8(&bytes[..count]).unwrap()),
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                        ) => {}
                    Err(error) => panic!("CRT task transport failed: {error}"),
                }
                assert!(
                    Instant::now() < limit,
                    "original task deadline: {transcript}"
                );
                thread::sleep(Duration::from_millis(2));
            }
            assert!(
                transcript.starts_with(&format!("PROCWARD/1 S {pid} kernel\n")),
                "{transcript}"
            );
            assert_eq!(completion(&transcript, true), Ok(expected), "{transcript}");
            let remaining = limit.saturating_duration_since(Instant::now()).as_millis() as u32;
            assert_eq!(
                unsafe { WaitForSingleObject(process.as_raw_handle(), remaining) },
                WAIT_OBJECT_0,
                "C and EOF do not replace actual child exit"
            );
            let mut status = 0;
            assert_ne!(
                unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut status) },
                0
            );
            assert_eq!(status, expected);
            if mode == "task-probe" {
                assert!(dir.join("accepted").exists());
            }
        }));
        let alive = unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } == WAIT_TIMEOUT;
        if alive {
            eprintln!("HARNESS RESCUE: CRT task owner; not product cleanup");
            unsafe {
                TerminateProcess(process.as_raw_handle(), 125);
                WaitForSingleObject(process.as_raw_handle(), 8000);
            }
        }
        assert!(!alive, "CRT task required harness rescue");
        result.unwrap();
    }
    fs::remove_dir_all(dir).unwrap();
}
