//! Best-effort macOS owner; see env/docs/semantics.md for snapshot limits.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static SIGNALS: AtomicU32 = AtomicU32::new(0);
const FORWARDED: [i32; 4] = [libc::SIGHUP, libc::SIGINT, libc::SIGQUIT, libc::SIGTERM];

extern "C" fn receive(signal: i32, info: *mut libc::siginfo_t, _: *mut libc::c_void) {
    if matches!(signal, libc::SIGTERM | libc::SIGHUP) {
        crate::job_control::begin_cleanup(receive);
    }
    if crate::job_control::receive(signal) {
        return;
    }
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

fn prepare_signals() -> io::Result<crate::job_control::SignalMask> {
    let job_mask = crate::job_control::initialize()?;
    // SAFETY: this mode starts on the sole thread, before any fork or command.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = receive as *const () as usize;
        action.sa_flags = libc::SA_SIGINFO | libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        for signal in crate::job_control::signals() {
            libc::sigaddset(&mut action.sa_mask, signal);
        }
        for signal in FORWARDED.into_iter().chain(crate::job_control::signals()) {
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
    Ok(job_mask)
}

static SHARED_FOREGROUND: AtomicBool = AtomicBool::new(false);

#[path = "darwin_inventory.rs"]
mod inventory;
use inventory::{Identity, Inventory};
#[path = "darwin_wake.rs"]
mod wake;
pub(super) fn startup_identity() -> io::Result<[u8; 24]> {
    Identity::current(unsafe { libc::getpid() }).map(Identity::encode)
}

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

    fn cancelled(&self) -> io::Result<bool> {
        let mut byte = 0u8;
        let got = unsafe {
            libc::recv(
                self.file.as_raw_fd(),
                (&mut byte as *mut u8).cast(),
                1,
                libc::MSG_PEEK | libc::MSG_DONTWAIT,
            )
        };
        if got >= 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if matches!(
            error.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ) {
            Ok(false)
        } else {
            Err(error)
        }
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
    startup: (
        Option<crate::job_control::Startup>,
        Option<&wake::Guardian>,
        Option<&crate::tty_handoff::Backup>,
    ),
) -> io::Result<i32> {
    let (mut gate, watch, backup) = startup;
    use std::os::unix::process::CommandExt;
    let mut command = Command::new(&args[0]);
    command
        .args(&args[1..])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if private_group || crate::tty_handoff::isolated() {
        command.process_group(0);
    }
    if !private_group {
        command
            .env_remove("PI_PROCESS_OWNER_PENDING")
            .env("PI_PROCESS_OWNER_PID", std::process::id().to_string());
    }
    let mut cancelled = || {
        if let Some(watch) = &watch {
            watch.check()?;
        }
        let requested = SIGNALS.load(Ordering::Relaxed)
            & ((1 << libc::SIGTERM)
                | (1 << libc::SIGHUP)
                | (1 << libc::SIGINT)
                | (1 << libc::SIGQUIT))
            != 0;
        let cancelled = control
            .as_mut()
            .is_some_and(|control| !matches!(control.peek(), Ok(None)));
        let mut completed = false;
        if requested || cancelled || !alive(&mut lease.read, &mut completed)? {
            return Err(io::Error::from_raw_os_error(libc::ECANCELED));
        }
        Ok(())
    };
    if let Some(gate) = &mut gate {
        if let Some(watch) = &watch {
            gate.guardian_lifetime(watch.stream.as_raw_fd());
        }
        gate.wait_active(&mut cancelled)?;
    }
    crate::tty_handoff::wait_initial_grant(cancelled)?;
    let spawned = crate::job_control::Primary::spawn(command, gate);
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
    crate::tty_handoff::drain_on_shutdown()?;
    let mut started = false;
    let mut terminating = None;
    let mut unused = false;
    let mut suspend = crate::job_control::State::default();
    let mut observer_failed = false;
    loop {
        // Snapshot before the sole primary waiter can consume a terminal status.
        inventory.snapshot()?;
        inventory.snapshot()?;
        child.reconcile_pause()?;
        if !started {
            match child.poll_exec() {
                Ok(true) => {
                    if let Some(control) = control {
                        control.report(format!("S{{\"pid\":{}}}\n", child.id()).as_bytes())?;
                    }
                    started = true;
                }
                Ok(false) => {}
                Err(error) => {
                    if let Some(control) = control {
                        control.report(&spawn_error(&error))?;
                        return Ok(125);
                    }
                    return Err(error);
                }
            }
        }
        if let Some(status) = child.try_wait()? {
            if let Some(control) = control {
                use std::os::unix::process::ExitStatusExt;
                let record = serde_json::json!({"code":status.code(), "signal":status.signal()});
                let _ = control.report(format!("X{record}\n").as_bytes());
            }
            return if observer_failed {
                Err(io::Error::other("session wake observer lost"))
            } else {
                Ok(crate::sys::exit_code(status) as i32)
            };
        }
        if let Some(backup) = backup
            && !backup.alive()?
        {
            crate::tty_handoff::fatal();
            crate::job_control::receive(libc::SIGTERM);
            SIGNALS.fetch_or(1 << libc::SIGTERM, Ordering::Relaxed);
        }
        if terminating.is_none() && !observer_failed {
            match crate::tty_handoff::grant_primary(&mut child) {
                Ok(Some(true)) => {
                    crate::job_control::receive(libc::SIGCONT);
                }
                Ok(Some(false) | None) => {}
                Err(_) => {
                    crate::tty_handoff::fatal();
                    crate::job_control::begin_cleanup(receive);
                    crate::job_control::receive(libc::SIGTERM);
                    SIGNALS.fetch_or(1 << libc::SIGTERM, Ordering::Relaxed);
                }
            }
        }
        if !observer_failed
            && let Some(watch) = &watch
            && watch.check().is_err()
        {
            observer_failed = true;
            crate::job_control::receive(libc::SIGTERM);
            SIGNALS.fetch_or(1 << libc::SIGTERM, Ordering::Relaxed);
        }
        if started
            && terminating.is_none()
            && !observer_failed
            && SIGNALS.load(Ordering::Relaxed) & ((1 << libc::SIGTERM) | (1 << libc::SIGHUP)) == 0
        {
            suspend.update(|paused| {
                inventory.snapshot()?;
                inventory.signal_other_groups(
                    if paused { libc::SIGSTOP } else { libc::SIGCONT },
                    &mut child,
                )
            })?;
        }
        child.reconcile_pause()?;
        if child.try_wait()?.is_none() && crate::tty_handoff::take_resume() {
            inventory.snapshot()?;
            inventory.signal(child.id() as i32, libc::SIGCONT)?;
        }
        let signals = SIGNALS.swap(0, Ordering::Relaxed);
        let requested = signals & ((1 << libc::SIGTERM) | (1 << libc::SIGHUP)) != 0;
        let cancelled = control
            .as_mut()
            .is_some_and(|control| !matches!(control.peek(), Ok(None)));
        if terminating.is_none()
            && (requested || cancelled || !alive(&mut lease.read, &mut unused)?)
        {
            crate::job_control::begin_cleanup(receive);
            // This tick's final snapshot precedes every parent termination signal.
            // The outer may die while stopped; wake the payload before its TERM handler.
            if !started {
                inventory.signal(child.id() as libc::pid_t, libc::SIGTERM)?;
            }
            inventory.signal_all(libc::SIGTERM)?;
            inventory.signal_all(libc::SIGCONT)?;
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
    let setup = prepare_signals().and_then(|mask| {
        Ok((
            mask,
            pipe()?,
            pipe()?,
            crate::job_control::startup()?,
            if private_group {
                None
            } else {
                Some((
                    wake::Sockets::new()?,
                    Identity::current(unsafe { libc::getpid() })?,
                ))
            },
        ))
    });
    let (
        job_mask,
        (outer_read, guardian_write),
        (guardian_read, outer_write),
        (mut startup_owner, startup_child),
        wake_setup,
    ) = match setup {
        Ok(value) => value,
        Err(error) => {
            eprintln!("pi-env supervise: {error}");
            return 125;
        }
    };
    // Standalone supervise runs on its sole thread, before daemon workers. No shared FD table.
    let guardian = unsafe { libc::fork() };
    if guardian < 0 {
        eprintln!("pi-env supervise: {}", io::Error::last_os_error());
        return 125;
    }
    if guardian == 0 {
        let mut backup = match crate::tty_handoff::private_session() {
            Ok(backup) => backup,
            Err(error) => {
                eprintln!("pi-env private tty: {error}");
                return 125;
            }
        };
        let watch = wake_setup.map(|(sockets, outer)| {
            drop(sockets.outer);
            drop(sockets.observer);
            drop(sockets.observer_guardian);
            wake::Guardian {
                stream: sockets.guardian,
                outer,
            }
        });
        drop(startup_owner);
        drop(outer_read);
        drop(outer_write);
        if let Err(error) = job_mask.activate(true) {
            eprintln!("pi-env supervise: {error}");
            return 125;
        }
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
            (startup_child, watch.as_ref(), backup.as_ref()),
        );
        if result.is_err() {
            crate::tty_handoff::fatal();
        }
        crate::job_control::begin_cleanup(receive);
        let clean = inventory
            .cleanup()
            .and(crate::job_control::cleanup_tty_result());
        let clean = backup
            .as_mut()
            .map_or(Ok(()), |backup| backup.finish())
            .and(clean);
        if clean.is_ok() && result.is_ok() {
            let _ = lease.write.write_all(b"C");
        }
        if let Some(watch) = &watch {
            let fatal = crate::tty_handoff::is_fatal() || clean.is_err() || result.is_err();
            let _ = (&watch.stream).write_all(crate::darwin_completion::Completion::record(fatal));
        }
        crate::tty_handoff::exit(finish(result, clean, None));
    }
    let mut watch = if let Some((sockets, outer_id)) = wake_setup {
        drop(sockets.guardian);
        let observer = unsafe { libc::fork() };
        if observer < 0 {
            let error = io::Error::last_os_error();
            drop(sockets.outer);
            drop(sockets.observer);
            drop(sockets.observer_guardian);
            drop(startup_owner);
            drop(startup_child);
            crate::job_control::begin_cleanup(receive);
            let _ = Inventory::new(false).cleanup();
            eprintln!("pi-env supervise: {error}");
            return 125;
        }
        if observer == 0 {
            drop(sockets.outer);
            drop(control);
            drop(ipc);
            drop(startup_owner);
            drop(startup_child);
            drop(outer_read);
            drop(guardian_write);
            drop(guardian_read);
            drop(outer_write);
            if let Err(error) = crate::tty_handoff::detach_observer() {
                eprintln!("pi-env observer tty: {error}");
                std::process::exit(125);
            }
            if unsafe { libc::setsid() } < 0 {
                eprintln!("pi-env wake observer: {}", io::Error::last_os_error());
                std::process::exit(125);
            }
            if let Err(error) = job_mask.activate(true) {
                eprintln!("pi-env wake observer: {error}");
                std::process::exit(125);
            }
            SIGNALS.store(0, Ordering::Relaxed);
            crate::tty_handoff::exit(wake::observe(
                sockets.observer,
                sockets.observer_guardian,
                outer_id,
            ));
        }
        drop(sockets.observer);
        drop(sockets.observer_guardian);
        let mut watch = wake::Outer::new(sockets.outer, observer);
        if let Err(error) = watch.reply(b'R') {
            crate::job_control::begin_cleanup(receive);
            let deadline = Instant::now() + Duration::from_secs(5);
            let _ = watch.finish(deadline);
            let _ = Inventory::new(false).cleanup_until(deadline);
            eprintln!("pi-env supervise: {error}");
            return 125;
        }
        Some(watch)
    } else {
        None
    };
    // Observer has established its independent lifetime watch before pending outer TSTP acts.
    let activation = crate::tty_handoff::physical_policy().and_then(|()| job_mask.activate(false));
    drop(startup_child);
    drop(guardian_read);
    drop(guardian_write);
    drop(ipc);
    let activation = activation.and_then(|()| {
        if let Some(owner) = &mut startup_owner {
            owner.activate()?;
        }
        Ok(())
    });
    let mut lease = Liveness {
        read: outer_read,
        write: outer_write,
    };
    let mut inventory = Inventory::new(private_group);
    let mut completed = false;
    let result = activation.and_then(|()| {
        let mut terminating = None;
        loop {
            inventory.snapshot()?;
            alive(&mut lease.read, &mut completed)?;
            let mut status = 0;
            let got = unsafe { libc::waitpid(guardian, &mut status, libc::WNOHANG) };
            if got == guardian {
                // Preserve fatal provenance before converting the held raw wait status.
                if crate::darwin_completion::fatal_status(status) {
                    crate::tty_handoff::fatal();
                }
                use std::os::unix::process::ExitStatusExt;
                alive(&mut lease.read, &mut completed)?;
                return if completed {
                    Ok(crate::sys::exit_code(ExitStatus::from_raw(status)) as i32)
                } else {
                    Err(io::Error::other("Darwin guardian cleanup unconfirmed"))
                };
            }
            if got < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return Err(io::Error::last_os_error());
            }
            if let Some(watch) = &mut watch
                && watch.exited()?
            {
                // A normal guardian exit closes its lifetime FD only after writing C.
                alive(&mut lease.read, &mut completed)?;
                if !completed {
                    return Err(io::Error::other("session wake observer lost"));
                }
            }
            if let Some(owner) = &mut startup_owner {
                owner.poll(|bytes| {
                    let held = Identity::decode(bytes)?;
                    held.child(guardian)?;
                    inventory.seed(held)?;
                    watch
                        .as_mut()
                        .ok_or_else(|| io::Error::other("session wake observer missing"))?
                        .publish(held)
                })?;
            }
            let cancelled = control
                .as_ref()
                .is_some_and(|control| !matches!(control.cancelled(), Ok(false)));
            if cancelled && terminating.is_none() {
                crate::job_control::begin_cleanup(receive);
                inventory.signal(guardian, libc::SIGTERM)?;
                inventory.signal(guardian, libc::SIGCONT)?;
                terminating = Some(Instant::now());
            }
            let signals = SIGNALS.swap(0, Ordering::Relaxed);
            for signal in FORWARDED {
                if signals & (1 << signal) != 0 {
                    inventory.signal(guardian, signal)?;
                    if matches!(signal, libc::SIGTERM | libc::SIGHUP) {
                        inventory.signal(guardian, libc::SIGCONT)?;
                    }
                    if matches!(signal, libc::SIGTERM | libc::SIGHUP) && terminating.is_none() {
                        terminating = Some(Instant::now());
                    }
                }
            }
            if terminating.is_some_and(|start| start.elapsed() >= Duration::from_secs(12)) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Darwin guardian did not exit",
                ));
            }
            thread::sleep(Duration::from_millis(25));
        }
    });
    if result.is_err() {
        crate::tty_handoff::fatal();
    }
    crate::job_control::begin_cleanup(receive);
    // Reap the extra direct child before the existing inventory can reap it. Both share
    // the original five-second cleanup budget, not sequential new timeout windows.
    let deadline = Instant::now()
        + if completed {
            Duration::from_secs(5)
        } else {
            Duration::from_millis(7500)
        };
    let watch_clean = watch
        .as_mut()
        .map_or(Ok(()), |watch| watch.finish(deadline));
    let mut clean = inventory
        .cleanup_until(deadline)
        .and(watch_clean)
        .and(crate::job_control::cleanup_tty_result());
    if !completed && clean.is_ok() {
        clean = Err(io::Error::other(
            "Darwin guardian did not confirm its sweep",
        ));
    }
    drop(lease);
    finish(
        result,
        crate::tty_handoff::restore_guardian().and(clean),
        control.as_mut(),
    )
}
