// SPDX-License-Identifier: BSD-3-Clause
use std::{
    ffi::OsStr,
    fs,
    io::{self, BufRead, Write},
    path::Path,
    process::{self, Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::System::Console::*;
static C: AtomicUsize = AtomicUsize::new(0);
static B: AtomicUsize = AtomicUsize::new(0);
unsafe extern "system" fn control(event: u32) -> i32 {
    match event {
        CTRL_C_EVENT => {
            C.fetch_add(1, Ordering::SeqCst);
            1
        }
        CTRL_BREAK_EVENT => {
            B.fetch_add(1, Ordering::SeqCst);
            1
        }
        _ => 0,
    }
}
unsafe extern "system" fn ignore(_: u32) -> i32 {
    1
}

pub fn conpty_bootstrap(procward: &OsStr) {
    assert_ne!(unsafe { SetConsoleCtrlHandler(Some(ignore), 1) }, 0);
    // Native CreateProcess from a redirected test host retains that host's std handles.
    let input = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("CONIN$")
        .unwrap();
    let output = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("CONOUT$")
        .unwrap();
    let status = Command::new(procward)
        .args(["run", "--"])
        .arg(std::env::current_exe().unwrap())
        .arg("console")
        .stdin(input)
        .stdout(output.try_clone().unwrap())
        .stderr(output)
        .status()
        .unwrap();
    process::exit(status.code().unwrap());
}

pub fn interactive() {
    assert_ne!(unsafe { SetConsoleCtrlHandler(Some(control), 1) }, 0);
    println!("READY");
    io::stdout().flush().unwrap();
    let mut may_quit = false;
    for line in io::stdin().lock().lines() {
        match line.unwrap().trim() {
            "status" => {
                let c = C.load(Ordering::SeqCst);
                let b = B.load(Ordering::SeqCst);
                if c + b == 0 {
                    println!("NOT_READY");
                } else {
                    may_quit = true;
                    println!("SEEN {c} {b}");
                }
            }
            "quit" if may_quit => {
                println!("BYE");
                io::stdout().flush().unwrap();
                process::exit(23);
            }
            _ => println!("NOT_READY"),
        }
        io::stdout().flush().unwrap();
    }
    panic!("console transport ended before quit");
}

fn response(path: &Path, from: usize, deadline: Instant) -> String {
    loop {
        let text = fs::read_to_string(path).unwrap();
        let tail = &text[from..];
        if tail.ends_with('\n') && !tail.is_empty() {
            return tail.to_string();
        }
        assert!(Instant::now() < deadline, "console silence: {text:?}");
        thread::sleep(Duration::from_millis(5));
    }
}

pub fn console_host(procward: &OsStr, dir: &Path) {
    unsafe {
        FreeConsole();
    }
    assert_ne!(
        unsafe { AllocConsole() },
        0,
        "AllocConsole: {}",
        io::Error::last_os_error()
    );
    assert_ne!(unsafe { SetConsoleCtrlHandler(Some(ignore), 1) }, 0);
    let path = dir.join("console.log");
    let out = fs::File::create(&path).unwrap();
    let mut child = Command::new(procward)
        .args(["run", "--"])
        .arg(std::env::current_exe().unwrap())
        .arg("console")
        .stdin(Stdio::piped())
        .stdout(out.try_clone().unwrap())
        .stderr(out)
        .spawn()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let ready = response(&path, 0, Instant::now() + Duration::from_secs(20));
        assert!(ready.contains("READY"), "{ready:?}");
        let mut cursor = fs::metadata(&path).unwrap().len() as usize;
        child.stdin.as_mut().unwrap().write_all(b"quit\n").unwrap();
        let not_ready = response(&path, cursor, Instant::now() + Duration::from_secs(3));
        assert!(not_ready.contains("NOT_READY"), "{not_ready:?}");
        for (event, expected) in [(CTRL_C_EVENT, "SEEN 1 0"), (CTRL_BREAK_EVENT, "SEEN 1 1")] {
            assert_ne!(unsafe { GenerateConsoleCtrlEvent(event, 0) }, 0);
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                cursor = fs::metadata(&path).unwrap().len() as usize;
                child
                    .stdin
                    .as_mut()
                    .unwrap()
                    .write_all(b"status\n")
                    .unwrap();
                let reply = response(&path, cursor, deadline);
                if reply.contains(expected) {
                    break;
                }
                assert!(
                    reply.contains("NOT_READY") || reply.contains("SEEN 1 0"),
                    "{reply:?}"
                );
                assert!(Instant::now() < deadline, "endless hints: {reply:?}");
            }
        }
        cursor = fs::metadata(&path).unwrap().len() as usize;
        child.stdin.as_mut().unwrap().write_all(b"quit\n").unwrap();
        assert!(response(&path, cursor, Instant::now() + Duration::from_secs(3)).contains("BYE"));
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert_eq!(status.code(), Some(23));
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
    }));
    if result.is_err() {
        eprintln!(
            "HARNESS RESCUE: terminating console owner after failed interaction; transcript: {:?}",
            fs::read_to_string(&path)
        );
        let _ = child.kill();
        let _ = child.wait();
        std::panic::resume_unwind(result.unwrap_err());
    }
    process::exit(23);
}

pub fn boundary_tree(dir: &Path) {
    let _helper = Command::new(std::env::current_exe().unwrap())
        .arg("boundary-deny")
        .arg(dir)
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    super::wait_for(&dir.join("go"));
    process::exit(23);
}

// Replace this process object's DACL so Everyone, including the controller, is denied.
pub fn deny_self(dir: &Path) {
    use windows_sys::Win32::{
        Security::{
            ACL, ACL_REVISION, AddAccessDeniedAce, CreateWellKnownSid, DACL_SECURITY_INFORMATION,
            InitializeAcl, InitializeSecurityDescriptor, SECURITY_DESCRIPTOR,
            SECURITY_MAX_SID_SIZE, SetKernelObjectSecurity, SetSecurityDescriptorDacl, WinWorldSid,
        },
        System::Threading::{GetCurrentProcess, PROCESS_ALL_ACCESS},
    };
    let record = dir.join("deny.tmp");
    fs::write(&record, process::id().to_string()).unwrap();
    fs::rename(record, dir.join("deny.pid")).unwrap();
    super::wait_for(&dir.join("apply"));
    let mut sid = [0u8; SECURITY_MAX_SID_SIZE as usize];
    let mut sid_size = sid.len() as u32;
    let mut acl = [0u64; 32];
    let mut descriptor: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let descriptor_ptr = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
    unsafe {
        assert_ne!(
            CreateWellKnownSid(
                WinWorldSid,
                std::ptr::null_mut(),
                sid.as_mut_ptr().cast(),
                &mut sid_size
            ),
            0
        );
        let acl_ptr = acl.as_mut_ptr().cast::<ACL>();
        assert_ne!(InitializeAcl(acl_ptr, 256, ACL_REVISION), 0);
        assert_ne!(
            AddAccessDeniedAce(
                acl_ptr,
                ACL_REVISION,
                PROCESS_ALL_ACCESS,
                sid.as_mut_ptr().cast()
            ),
            0
        );
        // SECURITY_DESCRIPTOR_REVISION is 1.
        assert_ne!(InitializeSecurityDescriptor(descriptor_ptr, 1), 0);
        assert_ne!(SetSecurityDescriptorDacl(descriptor_ptr, 1, acl_ptr, 0), 0);
        assert_ne!(
            SetKernelObjectSecurity(
                GetCurrentProcess(),
                DACL_SECURITY_INFORMATION,
                descriptor_ptr
            ),
            0
        );
    }
    fs::write(dir.join("denied"), b"denied").unwrap();
    loop {
        thread::park();
    }
}
