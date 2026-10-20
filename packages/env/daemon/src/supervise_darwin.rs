//! Best-effort macOS owner; see env/docs/semantics.md for snapshot limits.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::os::unix::io::FromRawFd;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static SIGNALS: AtomicU32 = AtomicU32::new(0);
const FORWARDED: [i32; 4] = [libc::SIGHUP, libc::SIGINT, libc::SIGQUIT, libc::SIGTERM];

extern "C" fn receive(signal: i32, info: *mut libc::siginfo_t, _: *mut libc::c_void) {
    // Terminal SIGINT already reaches the shared foreground workload. Darwin
    // kernel-originated signals have no sender PID; explicit kill(2) still forwards.
    if signal == libc::SIGINT
        && SHARED_FOREGROUND.load(Ordering::Relaxed)
        && !info.is_null()
        && unsafe { (*info).si_pid() } == 0
    {
        return;
    }
    SIGNALS.fetch_or(1u32 << signal, Ordering::Relaxed);
}

fn prepare_signals() -> io::Result<()> {
    // SAFETY: this mode starts on the sole thread, before any fork or command.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = receive as *const () as usize;
        action.sa_flags = libc::SA_SIGINFO | libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        for signal in FORWARDED {
            if libc::sigaction(signal, &action, std::ptr::null_mut()) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        // Auto-reaping would allow a PID to change identity before cleanup signals it.
        action.sa_sigaction = libc::SIG_DFL;
        action.sa_flags = 0;
        if libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut mask: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut mask);
        libc::sigaddset(&mut mask, libc::SIGCHLD);
        for signal in FORWARDED {
            libc::sigaddset(&mut mask, signal);
        }
        if libc::sigprocmask(libc::SIG_UNBLOCK, &mask, std::ptr::null_mut()) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

static SHARED_FOREGROUND: AtomicBool = AtomicBool::new(false);

#[path = "darwin_inventory.rs"]
mod inventory;
use inventory::Inventory;

/// One private duplex stream between caller and supervise. `K` requests an
/// immediate kill of the primary and its whole owned tree; the outer stays
/// alive until cleanup completes. Lease EOF cancels the same way. The only
/// records are newline-delimited: `S{"pid":N}` (spawned),
/// `X{"code":N|null,"signal":N|null}` (primary exit), `E<errno> <message>`,
/// or `C` (best-effort Darwin sweep completed, not proof of containment). Callers require C, helper close and control
/// drain together; neither primary exit nor helper status alone proves cleanup.
struct Control {
    file: std::fs::File,
    buffer: [u8; 16],
    offset: usize,
}

impl Control {
    fn open(descriptor: i32) -> io::Result<Control> {
        // SAFETY: read-only metadata check; parse() already proved descriptor
        // is an inherited stream before anything starts.
        let mut status: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(descriptor, &mut status) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if status.st_mode & libc::S_IFMT != libc::S_IFSOCK {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("control fd {descriptor} is not a socket"),
            ));
        }
        // SAFETY: parse() validated this inherited descriptor and set CLOEXEC.
        // Take it directly: dup() would clear CLOEXEC and leak a lease into exec.
        let file = unsafe { std::fs::File::from_raw_fd(descriptor) };
        Ok(Control {
            file,
            buffer: [0; 16],
            offset: 0,
        })
    }

    /// Peek one byte without blocking: `Some(byte)` consumed, `None` still open.
    fn peek(&mut self) -> io::Result<Option<u8>> {
        if self.offset == 0 {
            match self.file.read(&mut self.buffer) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "control lease closed",
                    ));
                }
                Ok(read) => self.offset = read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => return Ok(None),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
                Err(error) => return Err(error),
            }
        }
        self.offset -= 1;
        Ok(Some(self.buffer[self.offset]))
    }

    fn report(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.file.write_all(bytes)
    }
}

// SAFETY: descriptor must be an inherited stream. Marks it CLOEXEC so the
// program and its descendants cannot retain it, then makes it O_NONBLOCK.
fn control_fd(descriptor: i32) -> io::Result<i32> {
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } < 0
        || unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(descriptor)
}

fn finish(result: io::Result<i32>, clean: io::Result<()>, control: Option<&mut Control>) -> i32 {
    if clean.is_ok()
        && result.is_ok()
        && let Some(control) = control
    {
        // A disconnected caller cannot receive C; preserve primary status, but no caller
        // may infer successful cleanup from that status without a complete C record.
        let _ = control.report(b"C\n");
    }
    match (result, clean) {
        (Ok(code), Ok(())) => code,
        (Err(error), _) | (_, Err(error)) => {
            eprintln!("pi-env supervise: {error}");
            125
        }
    }
}

fn descriptor(text: &OsString, name: &str) -> io::Result<i32> {
    use std::os::unix::ffi::OsStrExt;
    let Ok(text) = std::str::from_utf8(text.as_bytes()) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{name} is not a number"),
        ));
    };
    match text.parse::<i32>() {
        Ok(value) if value >= 3 => Ok(value),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{name} must be a descriptor >= 3"),
        )),
    }
}

/// `--control-fd N` and `--ipc-fd N` before `--`. Both opt in to the private
/// control stream; ipc-fd also keeps descriptor N alive through exec so a
/// Node/Bun fork channel reaches the program unchanged. Control fd N must be
/// an inherited duplex socket. The caller keeps its peer lease endpoint and
/// closes any local copy of the passed endpoint after spawn; both ends share
/// nonblocking state with their duplicates. Only the guardian reads the lease.
type Parsed<'a> = (Option<i32>, Option<i32>, &'a [OsString]);

fn parse(args: &[OsString]) -> io::Result<Parsed<'_>> {
    let mut control = None;
    let mut ipc = None;
    let mut index = 0;
    while index < args.len() && args[index] != "--" {
        let flag = match args[index].to_str() {
            Some("--control-fd") => &mut control,
            Some("--ipc-fd") => &mut ipc,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unknown option {:?}", args[index]),
                ));
            }
        };
        let name = if args[index] == "--control-fd" {
            "control fd"
        } else {
            "ipc fd"
        };
        let value = args
            .get(index + 1)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing descriptor"))?;
        *flag = Some(descriptor(value, name)?);
        index += 2;
    }
    if index >= args.len() || args.len() - index < 2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "missing command after --",
        ));
    }
    if control.is_some() && control == ipc {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "control and ipc descriptors must differ",
        ));
    }
    if ipc.is_some() && control.is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "--ipc-fd requires --control-fd",
        ));
    }
    if let Some(descriptor) = ipc {
        // SAFETY: read-only validity check; must already be an inherited fd.
        if unsafe { libc::fcntl(descriptor, libc::F_GETFD) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    if let Some(descriptor) = control {
        control_fd(descriptor)?;
    }
    Ok((control, ipc, &args[index + 1..]))
}

/// Each observer alone owns one CLOEXEC writer; exec descendants retain neither.
struct Liveness {
    read: std::fs::File,
    write: std::fs::File,
}

fn pipe() -> io::Result<(std::fs::File, std::fs::File)> {
    let mut fds = [-1; 2];
    // SAFETY: writable descriptor pair, before fork on the only thread.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe { std::fs::File::from_raw_fd(fds[0]) };
    let write = unsafe { std::fs::File::from_raw_fd(fds[1]) };
    control_fd(fds[0])?;
    control_fd(fds[1])?;
    Ok((read, write))
}

fn alive(read: &mut std::fs::File, completed: &mut bool) -> io::Result<bool> {
    let mut byte = [0];
    loop {
        match read.read(&mut byte) {
            Ok(0) => return Ok(false),
            Ok(_) if byte[0] == b'C' => *completed = true,
            Ok(_) => return Err(io::Error::other("invalid observer liveness record")),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(true),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

fn command(
    args: &[OsString],
    control: &mut Option<Control>,
    ipc: Option<std::fs::File>,
    lease: &mut Liveness,
    inventory: &mut Inventory,
    private_group: bool,
) -> io::Result<i32> {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new(&args[0]);
    command
        .args(&args[1..])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if private_group {
        command.process_group(0);
    } else {
        command
            .env_remove("PI_PROCESS_OWNER_PENDING")
            .env("PI_PROCESS_OWNER_PID", std::process::id().to_string());
    }
    let spawned = command.spawn();
    // Only the exec child retains IPC. The observer must not hide disconnect EOF.
    drop(ipc);
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            if let Some(control) = control {
                control.report(&spawn_error(&error))?;
                return Ok(125);
            }
            return Err(error);
        }
    };
    if let Some(control) = control {
        control.report(format!("S{{\"pid\":{}}}\n", child.id()).as_bytes())?;
    }
    let mut terminating = None;
    let mut unused = false;
    loop {
        // Two passes also discover private-group orphans before reaping a fast leader.
        inventory.snapshot()?;
        inventory.snapshot()?;
        if let Some(status) = child.try_wait()? {
            if let Some(control) = control {
                use std::os::unix::process::ExitStatusExt;
                let record = serde_json::json!({"code":status.code(), "signal":status.signal()});
                let _ = control.report(format!("X{record}\n").as_bytes());
            }
            return Ok(crate::sys::exit_code(status) as i32);
        }
        let signals = SIGNALS.swap(0, Ordering::Relaxed);
        let requested = signals & ((1 << libc::SIGTERM) | (1 << libc::SIGHUP)) != 0;
        let cancelled = control
            .as_mut()
            .is_some_and(|control| !matches!(control.peek(), Ok(None)));
        if terminating.is_none()
            && (requested || cancelled || !alive(&mut lease.read, &mut unused)?)
        {
            // This tick's final snapshot precedes every parent termination signal.
            inventory.signal_all(libc::SIGTERM)?;
            terminating = Some(Instant::now());
        }
        for signal in [libc::SIGINT, libc::SIGQUIT] {
            if signals & (1 << signal) != 0 {
                inventory.signal(child.id() as libc::pid_t, signal)?;
            }
        }
        if terminating.is_some_and(|start| start.elapsed() >= Duration::from_millis(250)) {
            inventory.signal_all(libc::SIGKILL)?;
        }
        if terminating.is_some_and(|start| start.elapsed() >= Duration::from_secs(5)) {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Darwin primary did not exit",
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn spawn_error(error: &io::Error) -> Vec<u8> {
    format!("E{} {error}\n", error.raw_os_error().unwrap_or(0)).into_bytes()
}

pub fn run(args: &[OsString]) -> i32 {
    let (control_fd, ipc_fd, args) = match parse(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("pi-env supervise: {error}");
            return 2;
        }
    };
    let mut control = match control_fd.map(Control::open).transpose() {
        Ok(control) => control,
        Err(error) => {
            eprintln!("pi-env supervise: {error}");
            return 125;
        }
    };
    let ipc = ipc_fd.map(|fd| unsafe { std::fs::File::from_raw_fd(fd) });
    let private_group = std::env::var_os("PI_PROCESS_OWNER_PENDING").is_none();
    SHARED_FOREGROUND.store(!private_group, Ordering::Relaxed);
    let setup = prepare_signals().and_then(|()| Ok((pipe()?, pipe()?)));
    let ((outer_read, guardian_write), (guardian_read, outer_write)) = match setup {
        Ok(pipes) => pipes,
        Err(error) => {
            eprintln!("pi-env supervise: {error}");
            return 125;
        }
    };
    // SAFETY: standalone supervisor has only one thread and no shared running locks.
    let guardian = unsafe { libc::fork() };
    if guardian < 0 {
        eprintln!("pi-env supervise: {}", io::Error::last_os_error());
        return 125;
    }
    if guardian == 0 {
        drop(outer_read);
        drop(outer_write);
        SIGNALS.store(0, Ordering::Relaxed);
        let mut lease = Liveness {
            read: guardian_read,
            write: guardian_write,
        };
        let mut inventory = Inventory::new(private_group);
        let result = command(
            args,
            &mut control,
            ipc,
            &mut lease,
            &mut inventory,
            private_group,
        );
        let clean = inventory.cleanup();
        if clean.is_ok() && result.is_ok() {
            let _ = lease.write.write_all(b"C");
        }
        std::process::exit(finish(result, clean, None));
    }
    drop(guardian_read);
    drop(guardian_write);
    drop(ipc);
    let mut lease = Liveness {
        read: outer_read,
        write: outer_write,
    };
    let mut inventory = Inventory::new(private_group);
    let mut completed = false;
    let result = (|| {
        let mut terminating = None;
        loop {
            inventory.snapshot()?;
            alive(&mut lease.read, &mut completed)?;
            let mut status = 0;
            let got = unsafe { libc::waitpid(guardian, &mut status, libc::WNOHANG) };
            if got == guardian {
                use std::os::unix::process::ExitStatusExt;
                alive(&mut lease.read, &mut completed)?;
                return if completed {
                    Ok(crate::sys::exit_code(ExitStatus::from_raw(status)) as i32)
                } else {
                    Err(io::Error::other("Darwin observer cleanup unconfirmed"))
                };
            }
            if got < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return Err(io::Error::last_os_error());
            }
            let signals = SIGNALS.swap(0, Ordering::Relaxed);
            for signal in FORWARDED {
                if signals & (1 << signal) != 0 {
                    inventory.signal(guardian, signal)?;
                    if matches!(signal, libc::SIGTERM | libc::SIGHUP) && terminating.is_none() {
                        terminating = Some(Instant::now());
                    }
                }
            }
            if terminating.is_some_and(|start| start.elapsed() >= Duration::from_secs(12)) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Darwin observer did not exit",
                ));
            }
            thread::sleep(Duration::from_millis(25));
        }
    })();
    // Keep our writer until cleanup has taken its final snapshot. Its EOF lets
    // a surviving guardian sweep independently if the outer exits or is killed.
    let mut clean = inventory.cleanup();
    if !completed && clean.is_ok() {
        clean = Err(io::Error::other(
            "Darwin observer did not confirm its sweep",
        ));
    }
    drop(lease);
    finish(result, clean, control.as_mut())
}
