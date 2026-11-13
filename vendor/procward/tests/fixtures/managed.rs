// SPDX-License-Identifier: BSD-3-Clause
//! Test-only reference consumer. Applications implement this documented wire contract themselves.
use std::{
    env, fs,
    io::{self, Read},
    path::Path,
    process::{self, Command},
    thread,
    time::{Duration, Instant},
};
const ENV: [&str; 6] = [
    "PROCWARD_PROTOCOL",
    "PROCWARD_OWNER_PID",
    "PROCWARD_LIFECYCLE_FD",
    "PROCWARD_LIFECYCLE_HANDLE",
    "PROCWARD_CONTRACT_ID",
    "PROCWARD_PRIMARY_PID",
];
struct Transport {
    file: fs::File,
    buffered: Vec<u8>,
}
impl Transport {
    fn open() -> io::Result<(Self, String)> {
        #[cfg(unix)]
        let (file, raw) = {
            use std::os::fd::FromRawFd;
            let raw = env::var("PROCWARD_LIFECYCLE_FD")
                .map_err(io::Error::other)?
                .parse::<i32>()
                .map_err(io::Error::other)?;
            if raw <= 2 {
                return Err(io::Error::other("invalid lifecycle fd"));
            }
            rustix::io::fcntl_getfd(unsafe { std::os::fd::BorrowedFd::borrow_raw(raw) })?;
            let file = unsafe { fs::File::from_raw_fd(raw) };
            if rustix::fs::FileType::from_raw_mode(rustix::fs::fstat(&file)?.st_mode)
                != rustix::fs::FileType::Fifo
            {
                return Err(io::Error::other("lifecycle fd is not a pipe"));
            }
            rustix::io::fcntl_setfd(&file, rustix::io::FdFlags::CLOEXEC)?;
            rustix::fs::fcntl_setfl(&file, rustix::fs::OFlags::NONBLOCK)?;
            (file, raw.to_string())
        };
        #[cfg(windows)]
        let (file, raw) = {
            use std::os::windows::io::FromRawHandle;
            use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};
            let raw = env::var("PROCWARD_LIFECYCLE_HANDLE")
                .map_err(io::Error::other)?
                .parse::<usize>()
                .map_err(io::Error::other)?;
            if raw == 0 || unsafe { SetHandleInformation(raw as _, HANDLE_FLAG_INHERIT, 0) } == 0 {
                return Err(io::Error::last_os_error());
            }
            (
                unsafe { fs::File::from_raw_handle(raw as _) },
                raw.to_string(),
            )
        };
        Ok((
            Self {
                file,
                buffered: Vec::new(),
            },
            raw,
        ))
    }
    fn line(&mut self, deadline: Instant) -> io::Result<Option<String>> {
        loop {
            if let Some(end) = self.buffered.iter().position(|b| *b == b'\n') {
                if end + 1 > 256 {
                    return Err(io::Error::other("oversized lifecycle record"));
                }
                let record: Vec<_> = self.buffered.drain(..=end).collect();
                return String::from_utf8(record)
                    .map(Some)
                    .map_err(io::Error::other);
            }
            if self.buffered.len() >= 256 {
                return Err(io::Error::other("oversized lifecycle record"));
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "lifecycle response deadline",
                ));
            }
            let mut bytes = [0; 257];
            match self.read(&mut bytes) {
                Ok(0) if self.buffered.is_empty() => return Ok(None),
                Ok(0) => return Err(io::Error::other("truncated lifecycle record")),
                Ok(count) => self.buffered.extend_from_slice(&bytes[..count]),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    thread::sleep(Duration::from_millis(2))
                }
                Err(error) => return Err(error),
            }
        }
    }
    #[cfg(unix)]
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.file.read(bytes)
    }
    #[cfg(windows)]
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::ERROR_BROKEN_PIPE, System::Pipes::PeekNamedPipe};
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                self.file.as_raw_handle(),
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
        let size = bytes.len().min(available as usize);
        self.file.read(&mut bytes[..size])
    }
}

#[cfg(unix)]
fn parent_matches(owner: u32, identity: &str) -> io::Result<bool> {
    Ok(identity == "parent"
        && rustix::process::getppid().is_some_and(|pid| pid.as_raw_nonzero().get() as u32 == owner))
}
#[cfg(windows)]
fn parent_matches(owner: u32, identity: &str) -> io::Result<bool> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{FILETIME, INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
                PROCESS_SYNCHRONIZE, WaitForSingleObject,
            },
        },
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    if unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } == 0 {
        return Err(io::Error::last_os_error());
    }
    loop {
        if entry.th32ProcessID == process::id() {
            break;
        }
        if unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    if entry.th32ParentProcessID != owner {
        return Ok(false);
    }
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            owner,
        )
    };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut times: [FILETIME; 4] = unsafe { std::mem::zeroed() };
    if unsafe {
        GetProcessTimes(
            handle.as_raw_handle(),
            &mut times[0],
            &mut times[1],
            &mut times[2],
            &mut times[3],
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let birth = (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime);
    Ok(format!("{birth:016x}") == identity
        && unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } == WAIT_TIMEOUT)
}

fn accept() -> io::Result<(Transport, u32, String, String)> {
    if env::var("PROCWARD_PROTOCOL").ok().as_deref() != Some("1") {
        return Err(io::Error::other("unsupported or absent managed protocol"));
    }
    let owner = env::var("PROCWARD_OWNER_PID")
        .map_err(io::Error::other)?
        .parse::<u32>()
        .map_err(io::Error::other)?;
    let id = env::var("PROCWARD_CONTRACT_ID").map_err(io::Error::other)?;
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(io::Error::other("invalid managed launch id"));
    }
    let (mut transport, raw) = Transport::open()?;
    let record = transport
        .line(Instant::now() + Duration::from_secs(2))?
        .ok_or_else(|| io::Error::other("EOF before readiness"))?;
    let fields: Vec<_> = record.split_whitespace().collect();
    if fields.len() != 6
        || fields[0..2] != ["PROCWARD/1", "READY"]
        || fields[2] != owner.to_string()
        || fields[3] != process::id().to_string()
        || fields[5] != id
        || !parent_matches(owner, fields[4])?
    {
        return Err(io::Error::other("stale or mismatched managed readiness"));
    }
    // Same unset-and-close-on-exec discipline as socket activation: consume before spawning.
    for name in ENV {
        unsafe {
            env::remove_var(name);
        }
    }
    Ok((transport, owner, id, raw))
}

#[allow(
    clippy::zombie_processes,
    reason = "fixture deliberately leaves descendants for procward cleanup"
)]
pub fn nested(dir: &Path, probe: bool) -> io::Result<()> {
    let expected = [
        "PROCWARD_PROTOCOL",
        "PROCWARD_OWNER_PID",
        "PROCWARD_CONTRACT_ID",
        if cfg!(unix) {
            "PROCWARD_LIFECYCLE_FD"
        } else {
            "PROCWARD_LIFECYCLE_HANDLE"
        },
    ];
    assert_eq!(
        env::vars_os()
            .filter(|(name, _)| ENV.iter().any(|key| name == key))
            .count(),
        expected.len(),
        "only the inner contract environment may reach the payload"
    );
    assert!(expected.iter().all(|name| env::var_os(name).is_some()));
    let (_transport, owner, id, raw) = accept()?;
    fs::write(dir.join("inner-anchor"), owner.to_string())?;
    fs::write(dir.join("primary.pid"), process::id().to_string())?;
    fs::write(dir.join("inner-contract"), id)?;
    if probe {
        only_inner_pipe(&raw)?;
        fs::write(dir.join("isolated"), b"only inner contract and pipe")?;
    } else {
        let _branch = super::spawn("nested-branch", dir);
        super::wait_for(&dir.join("nested-worker-ready"));
        fs::write(dir.join("ready"), b"nested tree ready")?;
        super::wait_for_input();
    }
    Ok(())
}

fn only_inner_pipe(raw: &str) -> io::Result<()> {
    let inner = raw.parse::<usize>().map_err(io::Error::other)?;
    let pipes = super::pipes::open(false)?;
    #[cfg(windows)]
    if pipes != [inner] {
        use windows_sys::Win32::{
            Foundation::GetHandleInformation,
            System::{
                Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
                Pipes::GetNamedPipeServerProcessId,
            },
        };
        eprintln!(
            "PIPE ORIGINS: payload={} inner={inner} stdio={:?}",
            process::id(),
            unsafe {
                [
                    GetStdHandle(STD_INPUT_HANDLE) as usize,
                    GetStdHandle(STD_OUTPUT_HANDLE) as usize,
                    GetStdHandle(STD_ERROR_HANDLE) as usize,
                ]
            }
        );
        for raw in &pipes {
            let (mut server, mut flags) = (0, 0);
            let server_ok = unsafe { GetNamedPipeServerProcessId(*raw as _, &mut server) };
            let flags_ok = unsafe { GetHandleInformation(*raw as _, &mut flags) };
            eprintln!(
                "PIPE {raw}: server={server} query={server_ok}, flags={flags} query={flags_ok}"
            );
        }
    }
    assert_eq!(
        pipes,
        vec![inner],
        "outer lifecycle or private pipe leaked into inner payload"
    );
    Ok(())
}

pub fn probe(dir: &Path) -> io::Result<()> {
    let (_transport, owner, id, raw) = accept()?;
    let status = Command::new(env::current_exe()?)
        .arg("managed-ordinary")
        .arg(&raw)
        .arg(process::id().to_string())
        .status()?;
    if status.code() != Some(23) {
        return Err(io::Error::other(
            "ordinary child inherited managed claim/endpoint",
        ));
    }
    fs::write(dir.join("accepted"), b"ready")?;
    println!("MANAGED {owner} {} {id}", process::id());
    Ok(())
}

pub fn ordinary(raw: &std::ffi::OsStr, parent: &std::ffi::OsStr) {
    assert!(
        ENV.iter().all(|name| env::var_os(name).is_none()),
        "reusable claim leaked"
    );
    #[cfg(unix)]
    {
        use rustix::fd::BorrowedFd;
        let _ = parent;
        let raw = raw.to_str().unwrap().parse::<i32>().unwrap();
        assert_eq!(
            rustix::io::fcntl_getfd(unsafe { BorrowedFd::borrow_raw(raw) }),
            Err(rustix::io::Errno::BADF),
            "application endpoint leaked"
        );
    }
    // A handle number names nothing across processes: this fresh child may own an unrelated
    // object at the same value. Compare object identity with the parent's endpoint instead.
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{
                CloseHandle, CompareObjectHandles, DUPLICATE_SAME_ACCESS, DuplicateHandle,
                GetHandleInformation,
            },
            System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE},
        };
        let raw = raw.to_str().unwrap().parse::<usize>().unwrap() as _;
        let parent = parent.to_str().unwrap().parse::<u32>().unwrap();
        let mut flags = 0;
        if unsafe { GetHandleInformation(raw, &mut flags) } != 0 {
            unsafe {
                let source = OpenProcess(PROCESS_DUP_HANDLE, 0, parent);
                assert!(!source.is_null(), "{}", io::Error::last_os_error());
                let mut endpoint = std::ptr::null_mut();
                assert_ne!(
                    DuplicateHandle(
                        source,
                        raw,
                        GetCurrentProcess(),
                        &mut endpoint,
                        0,
                        0,
                        DUPLICATE_SAME_ACCESS
                    ),
                    0,
                    "parent endpoint unavailable: {}",
                    io::Error::last_os_error()
                );
                let same = CompareObjectHandles(endpoint, raw) != 0;
                CloseHandle(endpoint);
                CloseHandle(source);
                assert!(!same, "application endpoint leaked");
            }
            eprintln!(
                "ENDPOINT-NUMBER-REUSED: handle {raw:?} (flags {flags}) in the ordinary child is an unrelated object, not the endpoint"
            );
        }
    }
    println!("ORDINARY-CLEAN");
    process::exit(23);
}

pub fn task_probe(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use rustix::fd::BorrowedFd;
        let parent =
            rustix::process::getppid().ok_or_else(|| io::Error::other("missing task parent"))?;
        assert_eq!(
            rustix::process::getsid(None)?,
            rustix::process::getsid(Some(parent))?,
            "task must not create a session"
        );
        let expected = fs::read_to_string(dir.join("control-identity"))?;
        for raw in 3..128 {
            let fd = unsafe { BorrowedFd::borrow_raw(raw) };
            match rustix::fs::fstat(fd) {
                Ok(stat) => assert_ne!(
                    format!("{} {}", stat.st_dev, stat.st_ino),
                    expected,
                    "native task control leaked into primary"
                ),
                Err(rustix::io::Errno::BADF) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
        let expected = fs::read_to_string(dir.join("control-identity"))?;
        let fields: Vec<_> = expected.split_whitespace().collect();
        let raw = fields[0].parse::<usize>().map_err(io::Error::other)?;
        let mut server = 0;
        if unsafe { GetNamedPipeServerProcessId(raw as _, &mut server) } != 0 {
            assert_ne!(
                server,
                fields[1].parse::<u32>().unwrap(),
                "native task control leaked into primary"
            );
        }
    }
    probe(dir)
}

#[cfg(unix)]
pub fn owner_loss(dir: &Path, blocked: bool) -> io::Result<()> {
    let (mut transport, owner, id, _raw) = accept()?;
    signal_hook::flag::register(
        signal_hook::consts::SIGTERM,
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    )?;
    for (name, value) in [("primary", process::id()), ("anchor", owner)] {
        let temporary = dir.join(format!("{name}.tmp"));
        fs::write(&temporary, value.to_string())?;
        fs::rename(temporary, dir.join(name))?;
    }
    fs::write(dir.join("ready"), b"ready")?;
    if blocked {
        loop {
            thread::park();
        }
    }
    let record = transport.line(Instant::now() + Duration::from_secs(20))?;
    let evidence = if let Some(record) = record {
        if record != format!("PROCWARD/1 OWNER-LOSS {id}\n") {
            return Err(io::Error::other("invalid owner-loss notice"));
        }
        "notice"
    } else {
        "EOF"
    };
    fs::write(dir.join("notification"), evidence)?;
    Ok(())
}

pub fn responses(mode: &std::ffi::OsStr) {
    use std::io::{BufRead, Write};
    let mode = mode.to_str().unwrap();
    println!("RESPONSE-READY {}", env::var("PROCWARD_OWNER_PID").unwrap());
    io::stdout().flush().unwrap();
    let mut attempts = 0;
    for line in io::stdin().lock().lines() {
        assert_eq!(line.unwrap(), "quit");
        attempts += 1;
        if mode == "silence" {
            continue;
        }
        if mode == "hints" || attempts <= 3 {
            println!("NOT-READY");
        } else {
            println!("BYE {attempts}");
            io::stdout().flush().unwrap();
            process::exit(23);
        }
        io::stdout().flush().unwrap();
    }
}

#[cfg(unix)]
pub fn terminal_handoff() -> io::Result<u32> {
    let (_transport, owner, _id, _raw) = accept()?;
    Ok(owner)
}
