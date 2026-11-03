//! Windows invocation ownership. Only trusted bootstrap runs before Job assignment.
//! IPC callers use explicit attach mode; their pre-ack module startup is not contained.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
};
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Console::{
    CTRL_BREAK_EVENT, CTRL_C_EVENT, GetConsoleProcessList, SetConsoleCtrlHandler,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Pipes::*;
use windows_sys::Win32::System::Threading::*;

const LIMIT: Duration = Duration::from_secs(5);
const TICK: Duration = Duration::from_millis(10);

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn checked(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn wide(text: &OsStr) -> io::Result<Vec<u16>> {
    let mut out: Vec<_> = text.encode_wide().collect();
    if out.contains(&0) {
        return Err(invalid("embedded NUL"));
    }
    out.push(0);
    Ok(out)
}

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful Win32 creation transfers one owned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

#[derive(Default)]
struct Faults {
    fail: Option<String>,
    phase: Option<OsString>,
}

impl Faults {
    fn check(&self, step: &str) -> io::Result<()> {
        if self.fail.as_deref() == Some(step) {
            Err(io::Error::other(format!("injected {step} failure")))
        } else {
            Ok(())
        }
    }

    fn phase(&self, phase: &str, peer: u32) -> io::Result<()> {
        let Some(name) = &self.phase else {
            return Ok(());
        };
        let mut pipe = open_pipe(name)?;
        pipe.report(&format!("{phase} {} {peer}\n", std::process::id()))?;
        if pipe.line(Instant::now() + LIMIT)? != "L" {
            return Err(io::Error::other("test phase denied"));
        }
        Ok(())
    }

    fn bootstrap_args(&self, command: &mut Command) {
        if let Some(fail) = &self.fail {
            command.arg("--test-fail").arg(fail);
        }
        if let Some(phase) = &self.phase {
            command.arg("--test-phase-pipe").arg(phase);
        }
    }
}

struct Job(OwnedHandle);
impl Job {
    fn new() -> io::Result<Self> {
        // SAFETY: unnamed, non-inheritable Job; all configuration failures close it.
        let job = Self(owned(unsafe {
            CreateJobObjectW(std::ptr::null(), std::ptr::null())
        })?);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        checked(unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        })?;
        Ok(job)
    }

    fn cleanup(&self, faults: &Faults) -> io::Result<()> {
        faults.phase("cleanup", std::process::id())?;
        // SAFETY: Job handle remains owned until after empty acknowledgment.
        checked(unsafe { TerminateJobObject(self.0.as_raw_handle(), 137) })?;
        let deadline = Instant::now() + LIMIT;
        loop {
            faults.check("query")?;
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            checked(unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            })?;
            if info.ActiveProcesses == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "owned descendants remain",
                ));
            }
            thread::sleep(TICK);
        }
    }
}

struct Pipe(File, OwnedHandle);
impl Pipe {
    fn new(handle: OwnedHandle) -> io::Result<Self> {
        let event = owned(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })?;
        Ok(Self(File::from(handle), event))
    }

    // Bun creates extra stdio with UV_OVERLAPPED_PIPE; Node's ordinary pipes
    // are synchronous. Explicit OVERLAPPED supports both without CRT fd tricks.
    fn transfer(&self, bytes: *mut u8, length: u32, write: bool) -> io::Result<u32> {
        let mut operation: OVERLAPPED = unsafe { std::mem::zeroed() };
        operation.hEvent = self.1.as_raw_handle();
        let mut count = 0;
        let ok = unsafe {
            if write {
                WriteFile(
                    self.0.as_raw_handle(),
                    bytes,
                    length,
                    &mut count,
                    &mut operation,
                )
            } else {
                ReadFile(
                    self.0.as_raw_handle(),
                    bytes,
                    length,
                    &mut count,
                    &mut operation,
                )
            }
        };
        if ok != 0 {
            return Ok(count);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
            return Err(error);
        }
        let state =
            unsafe { WaitForSingleObject(self.1.as_raw_handle(), LIMIT.as_millis() as u32) };
        if state != WAIT_OBJECT_0 {
            // Stack OVERLAPPED and buffer must outlive cancellation completion.
            unsafe {
                CancelIoEx(self.0.as_raw_handle(), &operation);
                GetOverlappedResult(self.0.as_raw_handle(), &operation, &mut count, 1);
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "control I/O deadline",
            ));
        }
        checked(unsafe { GetOverlappedResult(self.0.as_raw_handle(), &operation, &mut count, 0) })?;
        Ok(count)
    }

    fn peek(&mut self) -> io::Result<Option<u8>> {
        let mut available = 0;
        // SAFETY: valid pipe and output count; no blocking read until data exists.
        checked(unsafe {
            PeekNamedPipe(
                self.0.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        })?;
        if available == 0 {
            return Ok(None);
        }
        let mut byte = [0];
        if self.transfer(byte.as_mut_ptr(), 1, false)? != 1 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "pipe EOF"));
        }
        Ok(Some(byte[0]))
    }

    fn line(&mut self, deadline: Instant) -> io::Result<String> {
        let mut bytes = Vec::new();
        loop {
            match self.peek()? {
                Some(b'\n') => {
                    return String::from_utf8(bytes)
                        .map_err(|_| invalid("invalid bootstrap record"));
                }
                Some(byte) if bytes.len() < 4096 => bytes.push(byte),
                Some(_) => return Err(invalid("oversized bootstrap record")),
                None if Instant::now() < deadline => thread::sleep(TICK),
                None => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "bootstrap deadline",
                    ));
                }
            }
        }
    }

    fn report(&mut self, text: &str) -> io::Result<()> {
        let mut bytes = text.as_bytes();
        while !bytes.is_empty() {
            let count =
                self.transfer(bytes.as_ptr().cast_mut(), bytes.len() as u32, true)? as usize;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "pipe write returned zero",
                ));
            }
            bytes = &bytes[count..];
        }
        Ok(())
    }
}

// libuv process-stdio.c: int count, byte flags[count], unaligned HANDLE[count].
// These are HANDLEs, not Rust/CRT fds. Never pass this table through to payload.
fn control(fd: usize) -> io::Result<Pipe> {
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    unsafe { GetStartupInfoW(&mut startup) };
    if startup.lpReserved2.is_null() || startup.cbReserved2 < 4 {
        return Err(invalid("missing inherited control table"));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(startup.lpReserved2, startup.cbReserved2 as usize) };
    let raw =
        crate::windows_owner_protocol::control_handle(bytes, fd, std::mem::size_of::<HANDLE>())?
            as HANDLE;
    if unsafe { GetFileType(raw) } != FILE_TYPE_PIPE {
        return Err(invalid("control is not a named pipe"));
    }
    checked(unsafe { SetHandleInformation(raw, HANDLE_FLAG_INHERIT, 0) })?;
    Pipe::new(owned(raw)?)
}

fn live(control: &mut Option<Pipe>) -> io::Result<()> {
    if let Some(pipe) = control {
        match pipe.peek() {
            Ok(None) => {}
            Ok(Some(b'K')) => {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "control cancellation",
                ));
            }
            Ok(Some(_)) => return Err(invalid("invalid control request")),
            Err(error) if matches!(error.raw_os_error(), Some(109 | 232 | 233)) => {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "control lease lost",
                ));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

// LocalFree allocations from the security conversion APIs.
struct Local(*mut std::ffi::c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn private_pipe(name: &OsStr) -> io::Result<Pipe> {
    let name = wide(name)?;
    let mut token = std::ptr::null_mut();
    checked(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
    let token = owned(token)?;
    let mut size = 0;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut size,
        )
    };
    if size == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut info = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    checked(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            info.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    })?;
    let user = unsafe { &*info.as_ptr().cast::<TOKEN_USER>() };
    let mut sid = std::ptr::null_mut();
    checked(unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) })?;
    let sid = Local(sid.cast());
    let mut length = 0;
    while unsafe { *sid.0.cast::<u16>().add(length) } != 0 {
        length += 1;
    }
    let sid_text =
        String::from_utf16(unsafe { std::slice::from_raw_parts(sid.0.cast::<u16>(), length) })
            .map_err(|_| invalid("invalid user SID"))?;
    let sddl = wide(OsStr::new(&format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid_text})")))?;
    let mut descriptor = std::ptr::null_mut();
    checked(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    })?;
    let descriptor = Local(descriptor);
    let security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            4096,
            4096,
            0,
            &security,
        )
    };
    Pipe::new(owned(handle)?)
}

fn open_pipe(name: &OsStr) -> io::Result<Pipe> {
    if !name.to_string_lossy().starts_with("\\\\.\\pipe\\") {
        return Err(invalid("expected local pipe"));
    }
    let name = wide(name)?;
    Pipe::new(owned(unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    })?)
}

fn connect(name: &OsStr, parent: u32) -> io::Result<Pipe> {
    // The server exists before B starts. Open is non-inheritable.
    let pipe = open_pipe(name)?;
    let mut actual = 0;
    checked(unsafe { GetNamedPipeServerProcessId(pipe.0.as_raw_handle(), &mut actual) })?;
    if actual != parent {
        return Err(invalid("bootstrap server PID mismatch"));
    }
    Ok(pipe)
}

fn wait_connection(
    pipe: &mut Pipe,
    child: &mut Child,
    control: &mut Option<Pipe>,
) -> io::Result<()> {
    let deadline = Instant::now() + LIMIT;
    loop {
        live(control)?;
        if unsafe { ConnectNamedPipe(pipe.0.as_raw_handle(), std::ptr::null_mut()) } != 0 {
            break;
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error().map(|n| n as u32) {
            Some(ERROR_PIPE_CONNECTED) => break,
            Some(ERROR_PIPE_LISTENING)
                if Instant::now() < deadline && child.try_wait()?.is_none() =>
            {
                thread::sleep(TICK)
            }
            _ => return Err(error),
        }
    }
    let mut actual = 0;
    checked(unsafe { GetNamedPipeClientProcessId(pipe.0.as_raw_handle(), &mut actual) })?;
    if actual != child.id() {
        return Err(invalid("bootstrap client PID mismatch"));
    }
    // Return to blocking writes, with PeekNamedPipe controlling every read.
    let mode = PIPE_READMODE_BYTE | PIPE_WAIT;
    checked(unsafe {
        SetNamedPipeHandleState(
            pipe.0.as_raw_handle(),
            &mode,
            std::ptr::null(),
            std::ptr::null(),
        )
    })
}

fn attached_console() -> io::Result<bool> {
    let mut pid = 0;
    if unsafe { GetConsoleProcessList(&mut pid, 1) } != 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_INVALID_HANDLE as i32) {
        Ok(false)
    } else {
        Err(error)
    }
}

fn inherit_console(command: &mut Command) -> io::Result<()> {
    // Hidden/headless callers must not gain a console window at either native hop.
    if !attached_console()? {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(())
}

fn bootstrap(args: &[OsString], faults: &Faults) -> io::Result<u32> {
    if args.len() < 5 || args[3] != "--" {
        return Err(invalid("invalid bootstrap command"));
    }
    let parent = args[2]
        .to_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| invalid("invalid guardian PID"))?;
    let mut pipe = connect(&args[1], parent)?;
    let deadline = Instant::now() + LIMIT;
    let raw: usize = pipe
        .line(deadline)?
        .parse()
        .map_err(|_| invalid("invalid Job handle"))?;
    let job = owned(raw as HANDLE)?;
    faults.phase("received", parent)?;
    faults.check("assign")?;
    // Sole temporary Job handle is NEVER inherited by P. Close before ready/launch.
    checked(unsafe { AssignProcessToJobObject(job.as_raw_handle(), GetCurrentProcess()) })?;
    checked(unsafe { CloseHandle(job.into_raw_handle()) })?;
    faults.phase("assigned", parent)?;
    pipe.report("R\n")?;
    if pipe.line(deadline)? != "L" {
        return Err(invalid("launch not authorized"));
    }
    faults.phase("launch", parent)?;
    let mut command = Command::new(&args[4]);
    command
        .args(&args[5..])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    inherit_console(&mut command)?;
    if std::env::var_os("PI_PROCESS_OWNER_PENDING").is_some() {
        command
            .env_remove("PI_PROCESS_OWNER_PENDING")
            .env("PI_PROCESS_OWNER_PID", std::process::id().to_string());
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            pipe.report(&format!(
                "E{} {}\n",
                spawn_errno(&error),
                error.to_string().replace(['\r', '\n'], " ")
            ))?;
            return Ok(125);
        }
    };
    pipe.report(&format!("S{{\"pid\":{}}}\n", child.id()))?;
    let status = child.wait()?;
    let code = crate::sys::exit_code(status) as u32;
    pipe.report(&format!("X{{\"code\":{code},\"signal\":null}}\n"))?;
    Ok(code)
}

fn spawn_errno(error: &io::Error) -> u32 {
    // Public E record uses portable errno numbers, never Win32 error numbers.
    match crate::sys::os_error_name(error) {
        "ENOENT" => 2,
        "EPERM" => 1,
        "EACCES" => 13,
        "EMFILE" => 24,
        "ENOMEM" => 12,
        "ENOTDIR" => 20,
        "ENAMETOOLONG" => 36,
        _ if error.raw_os_error() == Some(193) => 8,
        _ => 22,
    }
}

fn relay(
    job: &Job,
    args: &[OsString],
    control: &mut Option<Pipe>,
    started: &mut bool,
    faults: &Faults,
) -> io::Result<u32> {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let nonce = RandomState::new().build_hasher().finish();
    let name = OsString::from(format!(
        "\\\\.\\pipe\\pi-owner-{}-{nonce:016x}",
        std::process::id()
    ));
    let mut pipe = private_pipe(&name)?;
    let mut command = Command::new(std::env::current_exe()?);
    command.arg("supervise");
    faults.bootstrap_args(&mut command);
    inherit_console(&mut command)?;
    let mut child = command
        .arg("--bootstrap")
        .arg(&name)
        .arg(std::process::id().to_string())
        .arg("--")
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    let result = (|| {
        faults.phase("spawned", child.id())?;
        wait_connection(&mut pipe, &mut child, control)?;
        live(control)?;
        let mut remote = std::ptr::null_mut();
        checked(unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                job.0.as_raw_handle(),
                child.as_raw_handle(),
                &mut remote,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        })?;
        faults.phase("transferred", child.id())?;
        faults.check("transport")?;
        pipe.report(&format!("{}\n", remote as usize))?;
        if pipe.line(Instant::now() + LIMIT)? != "R" {
            return Err(invalid("bootstrap not ready"));
        }
        faults.phase("ready", child.id())?;
        live(control)?;
        pipe.report("L\n")?;
        loop {
            if let Some(byte) = pipe.peek()? {
                let mut line = String::from(byte as char);
                line.push_str(&pipe.line(Instant::now() + LIMIT)?);
                if !matches!(byte, b'S' | b'X' | b'E') {
                    return Err(invalid("invalid bootstrap response"));
                }
                if byte == b'S' {
                    *started = true;
                }
                if let Some(control) = control {
                    control.report(&format!("{line}\n"))?;
                }
                if byte == b'X' || byte == b'E' {
                    return Ok(if byte == b'E' {
                        125
                    } else {
                        serde_json::from_str::<serde_json::Value>(&line[1..])
                            .ok()
                            .and_then(|v| v["code"].as_u64())
                            .and_then(|n| u32::try_from(n).ok())
                            .ok_or_else(|| invalid("invalid primary status"))?
                    });
                }
                continue;
            }
            live(control)?;
            // B may have exited with X still buffered after S. Pipe EOF, not
            // Child::try_wait, establishes that no further record can arrive.
            thread::sleep(TICK);
        }
    })();
    // Before assignment B is trusted but not Job-owned. Terminate via held Child handle,
    // never a cached PID. Closing rendezvous also revokes launch authorization.
    drop(pipe);
    if result.is_err()
        && let Err(error) = child.kill()
        && child.try_wait()?.is_none()
    {
        return Err(error);
    }
    // Job cleanup runs before waiting B: it can still have living descendants.
    result
}

fn process_parent(pid: u32) -> io::Result<u32> {
    let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })?;
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    checked(unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) })?;
    loop {
        if entry.th32ProcessID == pid {
            return Ok(entry.th32ParentProcessID);
        }
        checked(unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) })?;
    }
}

fn attach(
    job: &Job,
    pid: u32,
    control: &mut Option<Pipe>,
    started: &mut bool,
    faults: &Faults,
) -> io::Result<u32> {
    // Hold this process object through opened/permit/assignment. Never assign from PID alone.
    faults.check("assign")?;
    faults.phase("attach-opening", pid)?;
    let process = owned(unsafe {
        OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        )
    })?;
    let pipe = control
        .as_mut()
        .ok_or_else(|| invalid("attach requires control"))?;
    let mut caller = 0;
    checked(unsafe { GetNamedPipeServerProcessId(pipe.0.as_raw_handle(), &mut caller) })?;
    let parent = process_parent(pid)?;
    if parent != caller {
        return Err(invalid("attach parent PID mismatch"));
    }
    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    checked(unsafe {
        GetProcessTimes(
            process.as_raw_handle(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    })?;
    let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    let creation_time = ticks
        .checked_sub(116_444_736_000_000_000)
        .ok_or_else(|| invalid("invalid attach creation time"))? as f64
        / 10_000.0;
    faults.phase("attach-opened", pid)?;
    pipe.report(&format!(
        "O{{\"pid\":{pid},\"parentPid\":{parent},\"creationTime\":{creation_time}}}\n"
    ))?;
    if pipe.line(Instant::now() + LIMIT)? != "permit" {
        return Err(invalid("attach identity denied"));
    }
    live(control)?;
    checked(unsafe { AssignProcessToJobObject(job.0.as_raw_handle(), process.as_raw_handle()) })?;
    *started = true;
    if let Some(control) = control {
        control.report(&format!("S{{\"pid\":{pid}}}\n"))?;
    }
    loop {
        let state = unsafe { WaitForSingleObject(process.as_raw_handle(), 0) };
        if state == WAIT_OBJECT_0 {
            let mut code = 0;
            checked(unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) })?;
            if let Some(control) = control {
                control.report(&format!("X{{\"code\":{code},\"signal\":null}}\n"))?;
            }
            return Ok(code);
        }
        if state != WAIT_TIMEOUT {
            return Err(io::Error::last_os_error());
        }
        live(control)?;
        thread::sleep(TICK);
    }
}

fn run_inner(args: &[OsString]) -> io::Result<u32> {
    let mut faults = Faults::default();
    let mut offset = 0;
    // Private release-artifact test seam. Only introduces failure or bounded delay.
    while args
        .get(offset)
        .is_some_and(|s| s == "--test-fail" || s == "--test-phase-pipe")
    {
        if std::env::var_os("PI_ENV_SUPERVISE_TEST_FAULTS").as_deref() != Some(OsStr::new("1")) {
            return Err(invalid("test controls disabled"));
        }
        let value = args
            .get(offset + 1)
            .ok_or_else(|| invalid("missing test value"))?;
        if args[offset] == "--test-fail" {
            let text = value
                .to_str()
                .filter(|s| matches!(*s, "assign" | "query" | "transport"))
                .ok_or_else(|| invalid("unknown test failure"))?;
            faults.fail = Some(text.to_string());
        } else {
            faults.phase = Some(value.clone());
        }
        offset += 2;
    }
    let args = &args[offset..];
    if args.first().is_some_and(|s| s == "--bootstrap") {
        return bootstrap(args, &faults);
    }
    let mut control_pipe = None;
    let mut pid = None;
    let mut index = 0;
    while index < args.len() && args[index] != "--" {
        let value = args
            .get(index + 1)
            .and_then(|s| s.to_str())
            .ok_or_else(|| invalid("missing option value"))?;
        match args[index].to_str() {
            Some("--control-fd") if control_pipe.is_none() => {
                control_pipe = Some(control(
                    value.parse().map_err(|_| invalid("invalid control fd"))?,
                )?)
            }
            Some("--attach-pid") if pid.is_none() => {
                pid = Some(
                    value
                        .parse::<u32>()
                        .ok()
                        .filter(|p| *p > 0)
                        .ok_or_else(|| invalid("invalid attach PID"))?,
                )
            }
            _ => return Err(invalid("unknown/duplicate supervise option")),
        }
        index += 2;
    }
    if (pid.is_none() && (args.get(index).is_none_or(|s| s != "--") || args.len() <= index + 1))
        || (pid.is_some() && (control_pipe.is_none() || index != args.len()))
    {
        return Err(invalid("expected -- command, or attach PID with control"));
    }
    live(&mut control_pipe)?;
    let job = Job::new()?;
    let mut started = false;
    let result = match pid {
        Some(pid) => attach(&job, pid, &mut control_pipe, &mut started, &faults),
        None => relay(
            &job,
            &args[index + 1..],
            &mut control_pipe,
            &mut started,
            &faults,
        ),
    };
    let cleanup = job.cleanup(&faults);
    // Cancellation's exit record follows kernel-confirmed termination, not K receipt.
    let result = match result {
        Err(error) if started && error.kind() == io::ErrorKind::Interrupted && cleanup.is_ok() => {
            if let Some(control) = &mut control_pipe {
                control.report("X{\"code\":137,\"signal\":null}\n")?;
            }
            Ok(137)
        }
        other => other,
    };
    // C means terminate succeeded AND kernel accounting proved empty, never helper exit alone.
    if cleanup.is_ok()
        && result.is_ok()
        && let Some(control) = &mut control_pipe
    {
        control.report("C\n")?;
    }
    cleanup?;
    result
}

// Inherited console already broadcasts Ctrl-C/Break to P. Custom handlers are
// not inherited by Command children (unlike SetConsoleCtrlHandler(NULL, TRUE)).
unsafe extern "system" fn console(event: u32) -> i32 {
    i32::from(event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT)
}

pub fn run(args: &[OsString]) -> i32 {
    if args
        .iter()
        .take_while(|s| *s != "--")
        .any(|s| s == "--test-fail" || s == "--test-phase-pipe")
        && std::env::var_os("PI_ENV_SUPERVISE_TEST_FAULTS").as_deref() != Some(OsStr::new("1"))
    {
        eprintln!("pi-env supervise: test controls disabled");
        return 2;
    }
    let signals = attached_console().and_then(|attached| {
        if attached {
            checked(unsafe { SetConsoleCtrlHandler(Some(console), 1) })
        } else {
            Ok(())
        }
    });
    if let Err(error) = signals {
        eprintln!("pi-env supervise: {error}");
        return 125;
    }
    match run_inner(args) {
        Ok(code) => code as i32,
        Err(error) => {
            eprintln!("pi-env supervise: {error}");
            125
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_job_cleanup_proves_empty_and_query_fault_cannot_acknowledge() {
        let job = Job::new().unwrap();
        let child = Command::new("cmd.exe")
            .args(["/c", "pause"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        checked(unsafe { AssignProcessToJobObject(job.0.as_raw_handle(), child.as_raw_handle()) })
            .unwrap();
        let fail = Faults {
            fail: Some("query".into()),
            phase: None,
        };
        assert!(job.cleanup(&fail).is_err());
        job.cleanup(&Faults::default()).unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(child.as_raw_handle(), 1000) },
            WAIT_OBJECT_0
        );
    }

    #[test]
    fn native_assignment_and_transport_faults_do_not_execute_payload() {
        for step in ["assign", "transport"] {
            let faults = Faults {
                fail: Some(step.into()),
                phase: None,
            };
            let job = Job::new().unwrap();
            let mut control = None;
            let mut started = false;
            let result = if step == "assign" {
                // Failure precedes AssignProcessToJobObject even for a valid process handle.
                attach(
                    &job,
                    std::process::id(),
                    &mut control,
                    &mut started,
                    &faults,
                )
            } else {
                faults.check("transport").map(|()| 0)
            };
            assert_eq!(
                result.unwrap_err().to_string(),
                format!("injected {step} failure")
            );
            assert!(!started);
            job.cleanup(&Faults::default()).unwrap();
        }
    }

    #[test]
    fn native_pipe_rejects_wrong_client_and_bounds_wait_without_permit() {
        let name = OsString::from(format!(
            "\\\\.\\pipe\\pi-owner-auth-unit-{}",
            std::process::id()
        ));
        let mut server = private_pipe(&name).unwrap();
        let mut client = open_pipe(&name).unwrap();
        assert_eq!(
            client
                .line(Instant::now() + Duration::from_millis(20))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        let mut child = Command::new("cmd.exe")
            .args(["/c", "pause"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        assert!(wait_connection(&mut server, &mut child, &mut None).is_err());
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn native_pipe_authentication_rejects_wrong_server_pid() {
        let name = OsString::from(format!("\\\\.\\pipe\\pi-owner-unit-{}", std::process::id()));
        let _server = private_pipe(&name).unwrap();
        assert!(connect(&name, 0).is_err());
    }
}
