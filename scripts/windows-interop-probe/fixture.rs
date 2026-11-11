// SPDX-License-Identifier: BSD-3-Clause
// Windows File ownership and pipe inspection follow procward v0.3.1's
// tests/fixtures/managed.rs (tree 164561d170371a9c0cd2268cb46bd1d9974f8771).
// This is independent byte-I/O framing, NOT procward's native protocol.
#[cfg(not(windows))]
compile_error!("Windows-only fixture; metadata-check with a Windows target, never run on the host");

use std::{
    env,
    ffi::c_void,
    fs::File,
    io::{self, Read, Write},
    os::windows::io::{AsRawHandle, FromRawHandle},
    process,
};

type Handle = *mut c_void;
type InvalidParameterHandler =
    Option<unsafe extern "C" fn(*const u16, *const u16, *const u16, u32, usize)>;
#[link(name = "ucrt")]
unsafe extern "C" {
    fn _get_osfhandle(fd: i32) -> isize;
    fn _close(fd: i32) -> i32;
    fn _set_thread_local_invalid_parameter_handler(
        handler: InvalidParameterHandler,
    ) -> InvalidParameterHandler;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn DuplicateHandle(
        source_process: Handle,
        source: Handle,
        target_process: Handle,
        target: *mut Handle,
        access: u32,
        inherit: i32,
        options: u32,
    ) -> i32;
    fn GetHandleInformation(handle: Handle, flags: *mut u32) -> i32;
    fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
    fn GetFileType(handle: Handle) -> u32;
    fn GetNamedPipeInfo(
        handle: Handle,
        flags: *mut u32,
        output: *mut u32,
        input: *mut u32,
        instances: *mut u32,
    ) -> i32;
    fn GetNamedPipeHandleStateW(
        handle: Handle,
        state: *mut u32,
        instances: *mut u32,
        collection: *mut u32,
        timeout: *mut u32,
        username: *mut u16,
        size: u32,
    ) -> i32;
    fn CreateFileW(
        path: *const u16,
        access: u32,
        share: u32,
        security: *mut c_void,
        creation: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
}

// A missing CRT slot must return -1, not invoke the CRT's aborting default handler.
unsafe extern "C" fn ignore_invalid(_: *const u16, _: *const u16, _: *const u16, _: u32, _: usize) {
}
fn crt_handle() -> isize {
    unsafe {
        let previous = _set_thread_local_invalid_parameter_handler(Some(ignore_invalid));
        let handle = _get_osfhandle(3);
        _set_thread_local_invalid_parameter_handler(previous);
        handle
    }
}
fn checked(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn line(file: &mut File) -> io::Result<Vec<u8>> {
    let mut result = Vec::new();
    loop {
        let mut byte = [0];
        match file.read(&mut byte) {
            Ok(0) if result.is_empty() => return Ok(result),
            Ok(0) => return Err(io::Error::other("truncated frame")),
            Ok(_) => {
                result.push(byte[0]);
                if result.len() > 1024 {
                    return Err(io::Error::other("oversized frame"));
                }
                if byte[0] == b'\n' {
                    return Ok(result);
                }
            }
            Err(error) if error.raw_os_error() == Some(109) && result.is_empty() => {
                return Ok(result);
            }
            Err(error) => return Err(error),
        }
    }
}
fn run() -> io::Result<()> {
    let args: Vec<String> = env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("");
    println!("PROBE_STDOUT_BEGIN");
    eprintln!("PROBE_STDERR_MARKER");
    let (mut file, source, fd, source_closed) = match mode {
        "crt" if args.len() == 2 => {
            let raw = crt_handle();
            println!("PROBE_CRT fd=3 handle=0x{:x}", raw as usize);
            if raw == -1 || raw == -2 || raw == 0 {
                println!("PROBE_UNSUPPORTED crt-fd3-unavailable");
                process::exit(78);
            }
            let mut duplicate = std::ptr::null_mut();
            unsafe {
                let current = GetCurrentProcess();
                checked(DuplicateHandle(
                    current,
                    raw as Handle,
                    current,
                    &mut duplicate,
                    0,
                    0,
                    2,
                ))?;
            }
            // Own only the duplicate. The CRT alone closes the original descriptor/HANDLE.
            let file = unsafe { File::from_raw_handle(duplicate) };
            if unsafe { _close(3) } != 0 {
                return Err(io::Error::last_os_error());
            }
            if crt_handle() != -1 {
                return Err(io::Error::other("CRT slot still open"));
            }
            (file, raw as usize, "3", true)
        }
        "named" if args.len() == 3 => {
            let path = &args[2];
            if !path.starts_with(r"\\.\pipe\pi-interop-") || path.contains('\0') {
                return Err(io::Error::other("invalid probe pipe path"));
            }
            let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
            let raw = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    0xc0000000,
                    0,
                    std::ptr::null_mut(),
                    3,
                    128,
                    std::ptr::null_mut(),
                )
            };
            if raw as isize == -1 {
                return Err(io::Error::last_os_error());
            }
            (
                unsafe { File::from_raw_handle(raw) },
                raw as usize,
                "null",
                false,
            )
        }
        _ => return Err(io::Error::other("usage: fixture.exe crt | named PIPE_PATH")),
    };
    let raw = file.as_raw_handle();
    let (mut inherit, mut flags, mut state, mut output, mut input, mut instances) =
        (0, 0, 0, 0, 0, 0);
    unsafe {
        checked(SetHandleInformation(raw, 1, 0))?;
        checked(GetHandleInformation(raw, &mut inherit))?;
        if GetFileType(raw) != 3 {
            return Err(io::Error::other("not a pipe HANDLE"));
        }
        checked(GetNamedPipeInfo(
            raw,
            &mut flags,
            &mut output,
            &mut input,
            &mut instances,
        ))?;
        checked(GetNamedPipeHandleStateW(
            raw,
            &mut state,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        ))?;
    }
    if flags & 4 != 0 || state & 2 != 0 || inherit & 1 != 0 {
        return Err(io::Error::other("expected byte-mode, noninheritable pipe"));
    }
    let record = format!(
        concat!(
            "{{\"mode\":\"{}\",\"pid\":{},\"fd\":{},",
            "\"sourceHandle\":\"0x{:x}\",\"ownedHandle\":\"0x{:x}\",",
            "\"fileType\":3,\"pipeFlags\":{},\"pipeState\":{},\"handleFlags\":{},",
            "\"outBuffer\":{},\"inBuffer\":{},\"crtSourceClosed\":{}}}"
        ),
        mode,
        process::id(),
        fd,
        source,
        raw as usize,
        flags,
        state,
        inherit,
        output,
        input,
        source_closed
    );
    println!("PROBE_OPEN {record}");
    writeln!(file, "ready {record}")?;
    file.flush()?;
    if line(&mut file)? != b"ping\n" {
        return Err(io::Error::other("expected ping"));
    }
    file.write_all(b"pong\n")?;
    file.flush()?;
    if !line(&mut file)?.is_empty() {
        return Err(io::Error::other("expected EOF"));
    }
    println!("PROBE_CONTROL_EOF");
    drop(file);
    println!("PROBE_STDOUT_END");
    Ok(())
}
fn main() {
    match run() {
        Ok(()) => process::exit(17),
        Err(error) => {
            eprintln!("PROBE_ERROR {error}");
            process::exit(1);
        }
    }
}
