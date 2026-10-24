//! Native physical-terminal carrier. The VM only ever sees the private slave.
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use crate::pty::unix;

struct Private {
    master: File,
    grants: UnixStream,
    slave: File,
    redirect_stderr: bool,
}
static PRIVATE: OnceLock<Private> = OnceLock::new();
struct Physical {
    tty: File,
    saved: libc::termios,
}
static PHYSICAL: OnceLock<Physical> = OnceLock::new();
static PHYSICAL_OPEN: AtomicBool = AtomicBool::new(false);
static UPDATES: OnceLock<UnixStream> = OnceLock::new();
static BACKUP_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static BACKUP_STATUS: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);
static FATAL: AtomicBool = AtomicBool::new(false);
static RESUME_PENDING: AtomicBool = AtomicBool::new(false);
static SIGNALS: AtomicU32 = AtomicU32::new(0);
static CARRIER_CHILD: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static CHILD_STATUS: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static CHILD_REAPED: AtomicBool = AtomicBool::new(false);
static RESTORE_ERROR: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
#[cfg(target_os = "freebsd")]
static LIFETIME_CLOSED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "freebsd")]
#[path = "freebsd_exit_wake.rs"]
mod exit_wake;
#[cfg(target_os = "freebsd")]
static CARRIER_LIFETIME: OnceLock<std::os::unix::net::UnixStream> = OnceLock::new();
#[cfg(target_os = "macos")]
static CARRIER_IDENTITY: OnceLock<[u8; 24]> = OnceLock::new();

/// Only the inner shell-facing owner retains its lifetime writer.
pub(super) fn descendant() {
    #[cfg(target_os = "freebsd")]
    if !LIFETIME_CLOSED.swap(true, Ordering::SeqCst)
        && let Some(stream) = CARRIER_LIFETIME.get()
    {
        unsafe {
            libc::close(stream.as_raw_fd());
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn carrier_identity() -> Option<[u8; 24]> {
    CARRIER_IDENTITY.get().copied()
}

extern "C" fn receive(signal: i32, _: *mut libc::siginfo_t, _: *mut libc::c_void) {
    SIGNALS.fetch_or(1 << signal, Ordering::SeqCst);
}

/// Native physical roles only. Never inherited as a primary's tty policy.
pub(super) fn physical_policy() -> io::Result<()> {
    if physical_role() {
        tty_policy()
    } else {
        Ok(())
    }
}

fn tty_policy() -> io::Result<()> {
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = receive as *const () as usize;
    action.sa_flags = libc::SA_SIGINFO;
    let mut unblocked = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigemptyset(&mut unblocked);
    }
    for signal in [libc::SIGTTIN, libc::SIGTTOU] {
        check(unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) })?;
        unsafe {
            libc::sigaddset(&mut unblocked, signal);
        }
    }
    check(unsafe { libc::sigprocmask(libc::SIG_UNBLOCK, &unblocked, std::ptr::null_mut()) })?;
    Ok(())
}

pub(super) fn physical_role() -> bool {
    PHYSICAL_OPEN.load(Ordering::SeqCst)
}

pub(super) fn isolated() -> bool {
    PRIVATE.get().is_some()
}

pub(super) fn restore_guardian() -> io::Result<()> {
    if FATAL.load(Ordering::SeqCst) {
        restore_physical()
    } else {
        Ok(())
    }
}

fn restore_physical() -> io::Result<()> {
    if !physical_role() {
        return Ok(());
    }
    let physical = PHYSICAL
        .get()
        .ok_or_else(|| io::Error::other("missing physical tty"))?;
    // The modifying syscall itself checks caller-SID foreground authority. A background
    // EINTR/EIO is denial, never permission to mask TTIO or retry a stale grant.
    if unsafe { libc::tcsetattr(physical.tty.as_raw_fd(), libc::TCSANOW, &physical.saved) } < 0 {
        let error = io::Error::last_os_error();
        if !matches!(
            error.raw_os_error(),
            Some(libc::EINTR | libc::EIO | libc::ENOTTY)
        ) {
            return Err(error);
        }
    }
    Ok(())
}

pub(super) fn pause_physical_job() -> io::Result<()> {
    if physical_role()
        && !FATAL.load(Ordering::SeqCst)
        && let Some(private) = PRIVATE.get()
    {
        let mut updates = &private.grants;
        updates.write_all(b"P")?;
    }
    Ok(())
}

pub(super) fn retain_updates(stream: &UnixStream) -> io::Result<()> {
    if isolated() {
        UPDATES
            .set(stream.try_clone()?)
            .map_err(|_| io::Error::other("duplicate tty updates"))?;
    }
    Ok(())
}

pub(super) fn publish_pause() -> io::Result<()> {
    if let Some(mut stream) = UPDATES.get() {
        stream.write_all(b"P")?;
    }
    Ok(())
}

pub(super) fn backup_pid() -> i32 {
    if BACKUP_STATUS.load(Ordering::SeqCst) == -1 {
        BACKUP_PID.load(Ordering::SeqCst)
    } else {
        0
    }
}
pub(super) fn forget_backup() {
    BACKUP_PID.store(0, Ordering::SeqCst);
}

pub(super) fn backup_reaped(pid: i32, status: i32) {
    if pid == BACKUP_PID.load(Ordering::SeqCst) && pid > 0 {
        BACKUP_STATUS.store(status, Ordering::SeqCst);
    }
}

/// Anchor holds this direct child until its private cleanup has completed.
pub(super) struct Backup {
    lease: UnixStream,
    pid: i32,
}
impl Backup {
    pub(super) fn alive(&self) -> io::Result<bool> {
        if BACKUP_STATUS.load(Ordering::SeqCst) != -1 {
            return Ok(false);
        }
        let mut status = 0;
        let got = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
        if got == self.pid {
            backup_reaped(self.pid, status);
            return Ok(false);
        }
        if got < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(io::Error::last_os_error());
        }
        Ok(true)
    }
    pub(super) fn finish(&mut self) -> io::Result<()> {
        if self.alive()? {
            self.lease.write_all(b"D")?;
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(250);
        while self.alive()? {
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "tty backup did not exit",
                ));
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        BACKUP_PID.store(0, Ordering::SeqCst);
        if BACKUP_STATUS.load(Ordering::SeqCst) == 0 {
            Ok(())
        } else {
            Err(io::Error::other("tty backup failed"))
        }
    }
}

/// Before anchor setsid, before any per-role thread. The sole added role keeps
/// caller SID/job PG; its private parent owns its exact wait/reap lifetime.
pub(super) fn private_session() -> io::Result<Option<Backup>> {
    let Some(private) = PRIVATE.get() else {
        return Ok(None);
    };
    let (mut parent, mut child) = UnixStream::pair()?;
    let owner = unsafe { libc::getpid() };
    let pid = check(unsafe { libc::fork() })?;
    if pid == 0 {
        drop(parent);
        let result = (|| {
            // No startup/control/private-PTY copies can keep other lifetimes open.
            let keep = [
                child.as_raw_fd(),
                PHYSICAL.get().unwrap().tty.as_raw_fd(),
                private.grants.as_raw_fd(),
            ];
            let descriptors: Vec<_> = std::fs::read_dir("/dev/fd")?
                .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<i32>().ok())
                .filter(|fd| *fd > 2 && !keep.contains(fd))
                .collect();
            for fd in descriptors {
                unsafe {
                    libc::close(fd);
                }
            }
            physical_policy()?;
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = receive as *const () as usize;
            action.sa_flags = libc::SA_SIGINFO;
            unsafe {
                libc::sigemptyset(&mut action.sa_mask);
            }
            let mut mask = unsafe { std::mem::zeroed() };
            unsafe {
                libc::sigemptyset(&mut mask);
            }
            for signal in [
                libc::SIGTSTP,
                libc::SIGCONT,
                libc::SIGTERM,
                libc::SIGHUP,
                libc::SIGINT,
                libc::SIGQUIT,
            ] {
                check(unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) })?;
                unsafe {
                    libc::sigaddset(&mut mask, signal);
                }
            }
            check(unsafe { libc::sigprocmask(libc::SIG_UNBLOCK, &mask, std::ptr::null_mut()) })?;
            crate::job_control::parent_death_signal(owner, libc::SIGTERM)?;
            child.set_nonblocking(true)?;
            child.write_all(b"R")?;
            let mut lost = false;
            loop {
                let signals = SIGNALS.swap(0, Ordering::SeqCst);
                if signals & ((1 << libc::SIGTERM) | (1 << libc::SIGHUP)) != 0
                    || unsafe { libc::getppid() } != owner
                {
                    restore_physical()?;
                    return Ok(());
                }
                let mut byte = [0];
                match child.read(&mut byte) {
                    Ok(1) if byte == *b"D" => return Ok(()),
                    Ok(0) => {
                        restore_physical()?;
                        return Ok(());
                    }
                    Ok(_) => return Err(io::Error::other("invalid tty backup lease")),
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                        ) => {}
                    Err(error) => return Err(error),
                }
                // Carrier death closes its unique grant writer even when both other
                // physical roles were killed. Poll only: backup never consumes grants.
                let mut fd = libc::pollfd {
                    fd: private.grants.as_raw_fd(),
                    events: 0,
                    revents: 0,
                };
                check(unsafe { libc::poll(&mut fd, 1, 0) })?;
                if !lost && fd.revents & libc::POLLHUP != 0 {
                    lost = true;
                    restore_physical()?;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        })();
        unsafe {
            libc::_exit(if result.is_ok() { 0 } else { 125 });
        }
    }
    drop(child);
    BACKUP_PID.store(pid, Ordering::SeqCst);
    parent.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut ready = [0];
    parent.read_exact(&mut ready)?;
    if ready != *b"R" {
        return Err(io::Error::other("tty backup not ready"));
    }
    parent.set_read_timeout(None)?;
    parent.set_nonblocking(true)?;
    check(unsafe { libc::setsid() })?;
    check(unsafe { libc::ioctl(private.slave.as_raw_fd(), libc::TIOCSCTTY as _, 0) })?;
    for fd in 0..if private.redirect_stderr { 3 } else { 2 } {
        check(unsafe { libc::dup2(private.slave.as_raw_fd(), fd) })?;
    }
    close_physical();
    Ok(Some(Backup { lease: parent, pid }))
}

pub(super) fn close_physical() {
    if PHYSICAL_OPEN.swap(false, Ordering::SeqCst)
        && let Some(physical) = PHYSICAL.get()
    {
        unsafe {
            libc::close(physical.tty.as_raw_fd());
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn detach_observer() -> io::Result<()> {
    if let Some(private) = PRIVATE.get() {
        for fd in 0..if private.redirect_stderr { 3 } else { 2 } {
            check(unsafe { libc::dup2(private.slave.as_raw_fd(), fd) })?;
        }
        close_physical();
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn primary_group(pid: i32) -> io::Result<()> {
    if isolated() {
        check(unsafe { libc::setpgid(pid, pid) })?;
        check(unsafe { libc::tcsetpgrp(0, pid) })?;
    }
    Ok(())
}

fn check(result: i32) -> io::Result<i32> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

pub(super) fn fatal() {
    FATAL.store(true, Ordering::SeqCst);
    RESUME_PENDING.store(false, Ordering::SeqCst);
}

/// Cleanup ran already; a held parent's wait status carries irreversible failure.
pub(super) fn exit(code: i32) -> ! {
    if PRIVATE.get().is_some() && FATAL.load(Ordering::SeqCst) {
        unsafe {
            libc::signal(libc::SIGTERM, libc::SIG_DFL);
            let mut mask = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigaddset(&mut mask, libc::SIGTERM);
            libc::sigprocmask(libc::SIG_UNBLOCK, &mask, std::ptr::null_mut());
            libc::raise(libc::SIGTERM);
        }
    }
    std::process::exit(code)
}

/// Called in the exec stub, before unblocking signals. These are native-only FDs.
pub(super) fn close_primary() {
    descendant();
    close_physical();
    if let Some(private) = PRIVATE.get() {
        unsafe {
            libc::close(private.master.as_raw_fd());
            libc::close(private.grants.as_raw_fd());
            libc::close(private.slave.as_raw_fd());
        }
    }
}

/// Each native role calls this only after its final fork. Fatal readers discard;
/// they never touch the physical terminal or wait for its carrier to run.
pub(super) fn drain_on_shutdown() -> io::Result<()> {
    let Some(private) = PRIVATE.get() else {
        return Ok(());
    };
    let mut master = private.master.try_clone()?;
    std::thread::Builder::new()
        .name("tty-fatal-drain".into())
        .spawn(move || {
            let mut lost = false;
            let mut buffer = [0; 65536];
            loop {
                let mut fds = [
                    libc::pollfd {
                        fd: private.grants.as_raw_fd(),
                        events: 0,
                        revents: 0,
                    },
                    libc::pollfd {
                        fd: master.as_raw_fd(),
                        events: if FATAL.load(Ordering::SeqCst) {
                            libc::POLLIN
                        } else {
                            0
                        },
                        revents: 0,
                    },
                ];
                unsafe {
                    libc::poll(fds.as_mut_ptr(), 2, 5);
                }
                if !lost && fds[0].revents & libc::POLLHUP != 0 {
                    lost = true;
                    if let Err(error) = restore_carrier_loss() {
                        RESTORE_ERROR
                            .store(error.raw_os_error().unwrap_or(libc::EIO), Ordering::SeqCst);
                    }
                    unsafe {
                        libc::kill(libc::getpid(), libc::SIGTERM);
                    }
                }
                if FATAL.load(Ordering::SeqCst) {
                    match master.read(&mut buffer) {
                        Ok(0) => return,
                        Ok(_) => {}
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                            ) => {}
                        Err(_) => return,
                    }
                }
            }
        })?;
    Ok(())
}

pub(super) fn cleanup_result() -> io::Result<()> {
    match RESTORE_ERROR.load(Ordering::SeqCst) {
        0 => Ok(()),
        error => Err(io::Error::from_raw_os_error(error)),
    }
}

/// Guardian owns this input. A grant is not permission for VM physical I/O:
/// even a stale grant can only resume a process on the isolated private tty.
#[cfg(not(target_os = "macos"))]
pub(super) fn grant() -> io::Result<Option<bool>> {
    let Some(private) = PRIVATE.get() else {
        return Ok(None);
    };
    if FATAL.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let latest = match read_grants(&private.grants) {
        Ok(latest) => latest,
        Err(error) => {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                restore_carrier_loss()?;
            }
            return Err(error);
        }
    };
    if latest.is_some() {
        RESUME_PENDING.store(true, Ordering::SeqCst);
    }
    Ok(latest)
}

#[cfg(not(target_os = "macos"))]
fn read_grants(mut reader: impl Read) -> io::Result<Option<bool>> {
    let mut latest = None;
    let mut bytes = [0; 64];
    loop {
        match reader.read(&mut bytes) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
            Ok(n) => {
                for byte in &bytes[..n] {
                    latest = Some(match byte {
                        b'G' => true,
                        b'B' => false,
                        _ => {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "invalid native tty grant",
                            ));
                        }
                    });
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(latest),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn ordered_grant(
    witness: impl FnMut() -> io::Result<ordered::Witness>,
) -> io::Result<Option<bool>> {
    let Some(private) = PRIVATE.get() else {
        return Ok(None);
    };
    if is_fatal() {
        return Ok(None);
    }
    match ORDERED
        .lock()
        .map_err(|_| io::Error::other("tty grant lock poisoned"))?
        .poll(&private.grants, witness)
    {
        Ok(Some(level)) => {
            if level.resume {
                RESUME_PENDING.store(true, Ordering::SeqCst);
            }
            Ok(Some(level.resume))
        }
        Ok(None) => Ok(None),
        Err(error) => {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                restore_carrier_loss()?;
            }
            Err(error)
        }
    }
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn grant_primary(primary: &mut crate::job_control::Primary) -> io::Result<Option<bool>> {
    ordered_grant(|| primary.witness())
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn is_fatal() -> bool {
    FATAL.load(Ordering::SeqCst)
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn cancel_resume() {
    RESUME_PENDING.store(false, Ordering::SeqCst);
}

pub(super) fn take_resume() -> bool {
    !FATAL.load(Ordering::SeqCst) && RESUME_PENDING.swap(false, Ordering::SeqCst)
}

#[cfg(target_os = "linux")]
pub(super) fn refresh() -> io::Result<()> {
    match grant() {
        Ok(Some(active)) => {
            let _ = active;
            crate::job_control::receive(libc::SIGCONT);
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(error) => {
            fatal();
            crate::job_control::receive(libc::SIGTERM);
            unsafe {
                libc::kill(libc::getpid(), libc::SIGTERM);
            }
            Err(error)
        }
    }
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn refresh_primary(primary: &mut crate::job_control::Primary) -> io::Result<()> {
    match grant_primary(primary) {
        Ok(Some(true)) => {
            crate::job_control::receive(libc::SIGCONT);
            Ok(())
        }
        Ok(_) => Ok(()),
        Err(error) => {
            fatal();
            crate::job_control::receive(libc::SIGTERM);
            unsafe {
                libc::kill(libc::getpid(), libc::SIGTERM);
            }
            Err(error)
        }
    }
}

fn nonblocking(fd: i32) -> io::Result<()> {
    let flags = check(unsafe { libc::fcntl(fd, libc::F_GETFL) })?;
    check(unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) })?;
    Ok(())
}

/// None means ordinary/non-tty/redirected operation: leave its existing path intact.
pub(super) fn enter() -> io::Result<Option<i32>> {
    if std::env::var_os("PI_PROCESS_OWNER_PENDING").is_none() {
        return Ok(None);
    }
    let mut identities = Vec::new();
    for fd in 0..2 {
        if unsafe { libc::isatty(fd) } != 1 {
            return Ok(None);
        }
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        check(unsafe { libc::fstat(fd, &mut stat) })?;
        identities.push(stat.st_rdev);
    }
    if identities.iter().any(|id| *id != identities[0]) {
        return Ok(None);
    }
    let redirect_stderr = unsafe { libc::isatty(2) } == 1;
    // A separate open-file description: never change the caller's O_NONBLOCK.
    let fd = check(unsafe {
        libc::open(
            c"/dev/tty".as_ptr(),
            libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    })?;
    let physical = unsafe { File::from_raw_fd(fd) };
    // A tty descriptor may name another session's slave. Require our controlling tty.
    check(unsafe { libc::tcgetpgrp(0) })?;
    let mut saved: libc::termios = unsafe { std::mem::zeroed() };
    check(unsafe { libc::tcgetattr(fd, &mut saved) })?;
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    check(unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) })?;
    let (master, slave) = unix::open_pty(size.ws_col, size.ws_row)?;
    unix::cloexec(master.as_raw_fd())?;
    unix::cloexec(slave.as_raw_fd())?;
    nonblocking(master.as_raw_fd())?;
    check(unsafe { libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &saved) })?;
    let (read, mut grants) = UnixStream::pair()?;
    read.set_nonblocking(true)?;
    grants.set_nonblocking(true)?;
    let carrier_group = unsafe { libc::getpgrp() };
    let mut child_action: libc::sigaction = unsafe { std::mem::zeroed() };
    child_action.sa_sigaction = libc::SIG_DFL;
    unsafe {
        libc::sigemptyset(&mut child_action.sa_mask);
    }
    check(unsafe { libc::sigaction(libc::SIGCHLD, &child_action, std::ptr::null_mut()) })?;
    #[cfg(target_os = "freebsd")]
    let (mut exit_wake, lifetime) = exit_wake::ExitWake::pair()?;
    #[cfg(target_os = "macos")]
    let carrier_identity = crate::supervise::startup_identity()?;
    #[cfg(target_os = "linux")]
    let child = unsafe {
        #[cfg(target_arch = "s390x")]
        {
            libc::syscall(libc::SYS_clone, 0, libc::SIGCONT, 0, 0, 0) as i32
        }
        #[cfg(not(target_arch = "s390x"))]
        {
            libc::syscall(libc::SYS_clone, libc::SIGCONT, 0, 0, 0, 0) as i32
        }
    };
    #[cfg(not(target_os = "linux"))]
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(io::Error::last_os_error());
    }
    if child == 0 {
        #[cfg(target_os = "freebsd")]
        {
            drop(exit_wake);
            CARRIER_LIFETIME
                .set(lifetime)
                .map_err(|_| io::Error::other("duplicate carrier lifetime"))?;
        }
        #[cfg(target_os = "macos")]
        CARRIER_IDENTITY
            .set(carrier_identity)
            .map_err(|_| io::Error::other("duplicate carrier identity"))?;
        drop(grants);
        PHYSICAL
            .set(Physical {
                tty: physical,
                saved,
            })
            .map_err(|_| io::Error::other("duplicate physical tty"))?;
        PHYSICAL_OPEN.store(true, Ordering::SeqCst);
        PRIVATE
            .set(Private {
                master: File::from(master),
                grants: read,
                slave: File::from(slave),
                redirect_stderr,
            })
            .map_err(|_| io::Error::other("native tty initialized twice"))?;
        return Ok(None);
    }
    #[cfg(target_os = "freebsd")]
    {
        drop(lifetime);
        exit_wake.arm()?;
    }
    drop(read);
    drop(slave);
    let mut master = File::from(master);
    let mut physical = physical;
    tty_policy()?;
    let result = carry(child, &mut physical, &mut master, &mut grants, saved);
    #[cfg(target_os = "freebsd")]
    let result = exit_wake.finish().and(result);
    // Default TTOU still protects restoration if the shell reclaimed this tty.
    if unsafe { libc::tcgetpgrp(fd) } == carrier_group {
        let restored = check(unsafe { libc::tcsetattr(fd, libc::TCSANOW, &saved) });
        if result.is_ok() {
            restored?;
        }
    }
    result.map(Some)
}

fn carry(
    child: i32,
    physical: &mut File,
    master: &mut File,
    grants: &mut UnixStream,
    saved: libc::termios,
) -> io::Result<i32> {
    let fd = physical.as_raw_fd();
    let group = unsafe { libc::getpgrp() };
    CARRIER_CHILD.store(child, Ordering::SeqCst);
    for signal in [libc::SIGTSTP, libc::SIGCONT] {
        if unsafe { libc::signal(signal, libc::SIG_DFL) } == libc::SIG_ERR {
            return Err(io::Error::last_os_error());
        }
    }
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = receive as *const () as usize;
    action.sa_flags = libc::SA_SIGINFO;
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
    }
    for signal in [
        libc::SIGWINCH,
        libc::SIGTERM,
        libc::SIGHUP,
        libc::SIGINT,
        libc::SIGQUIT,
    ] {
        check(unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) })?;
    }
    let mut raw = saved;
    unsafe {
        libc::cfmakeraw(&mut raw);
    }
    raw.c_lflag |= libc::TOSTOP;
    let mut active = false;
    let mut suspended = false;
    let mut fatal = false;
    let mut published = None;
    #[cfg(target_os = "macos")]
    let mut producer = ordered::Producer::default();
    let mut input = Vec::new();
    let mut output = Vec::new();
    loop {
        let signals = SIGNALS.swap(0, Ordering::SeqCst);
        for signal in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT, libc::SIGQUIT] {
            if signals & (1 << signal) != 0 {
                if matches!(signal, libc::SIGTERM | libc::SIGHUP) {
                    fatal = true;
                }
                // Direct unreaped child, never a caller/pipeline process-group broadcast.
                signal_child(signal)?;
                if fatal {
                    signal_child(libc::SIGCONT)?;
                }
            }
        }
        if let Some(status) = poll_child()? {
            if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
                if !fatal && libc::WIFEXITED(status) {
                    flush(physical, master, &mut output)?;
                }
                return Ok(if libc::WIFEXITED(status) {
                    libc::WEXITSTATUS(status)
                } else {
                    128 + libc::WTERMSIG(status)
                });
            }
            if libc::WIFSTOPPED(status) && !fatal {
                published = None;
                if active && unsafe { libc::tcsetattr(fd, libc::TCSANOW, &saved) } < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                active = false;
                suspended = true;
                check(unsafe { libc::kill(-libc::getpgrp(), libc::SIGTSTP) })?;
                continue;
            }
        }
        #[cfg(not(target_os = "macos"))]
        let mut updates = [0; 64];
        #[cfg(not(target_os = "macos"))]
        let pause = match grants.read(&mut updates) {
            Ok(0) => {
                fatal = true;
                false
            }
            Ok(n) if updates[..n].iter().all(|byte| *byte == b'P') => !fatal,
            Ok(_) => return Err(io::Error::other("invalid tty pause update")),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                false
            }
            Err(error) => return Err(error),
        };
        #[cfg(target_os = "macos")]
        let pause = match producer.poll(&mut *grants) {
            Ok(pause) => pause && !fatal,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                fatal = true;
                false
            }
            Err(error) => return Err(error),
        };
        if pause {
            if active && unsafe { libc::tcsetattr(fd, libc::TCSANOW, &saved) } < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
            active = false;
            suspended = true;
            published = None;
            check(unsafe { libc::kill(-libc::getpgrp(), libc::SIGTSTP) })?;
            continue;
        }
        let foreground = check(unsafe { libc::tcgetpgrp(fd) })? == group;
        // Reacquisition must refresh dimensions before any grant can trigger redraw.
        if foreground && !fatal && (!active || signals & (1 << libc::SIGWINCH) != 0) {
            let mut size: libc::winsize = unsafe { std::mem::zeroed() };
            check(unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) })?;
            unix::set_size(master, size.ws_col, size.ws_row)?;
        }
        #[cfg(not(target_os = "macos"))]
        if !fatal && published != Some(foreground) {
            grants.write_all(if foreground { b"G" } else { b"B" })?;
            published = Some(foreground);
        }
        #[cfg(target_os = "macos")]
        let input_ready = !fatal && producer.update(&mut *grants, &mut published, foreground)?;
        if !foreground || fatal {
            active = false;
            // Draining here also keeps an active hook runnable after TERM.
            let mut buffer = [0; 65536];
            let _ = master.read(&mut buffer);
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        if !active {
            if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            active = true;
            if suspended {
                signal_child(libc::SIGCONT)?;
                suspended = false;
            }
        }
        // At most one fixed-sized chunk per direction; no unbounded buffering.
        let mut buffer = [0; 65536];
        #[cfg(not(target_os = "macos"))]
        let input_ready = true;
        if input.is_empty() && input_ready {
            match physical.read(&mut buffer) {
                Ok(0) => {
                    signal_child(libc::SIGHUP)?;
                    fatal = true;
                }
                Ok(n) => input.extend_from_slice(&buffer[..n]),
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                    ) => {}
                Err(e) => return Err(e),
            }
        }
        if !input.is_empty() && input_ready {
            match master.write(&input) {
                Ok(n) => {
                    input.drain(..n);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                    ) => {}
                Err(e) => return Err(e),
            }
        }
        if output.is_empty() {
            match master.read(&mut buffer) {
                Ok(n) => output.extend_from_slice(&buffer[..n]),
                Err(e) if e.raw_os_error() == Some(libc::EIO) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                    ) => {}
                Err(e) => return Err(e),
            }
        }
        if !output.is_empty() {
            match physical.write(&output) {
                Ok(n) => {
                    output.drain(..n);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                    ) => {}
                Err(e) => return Err(e),
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn flush(physical: &mut File, master: &mut File, output: &mut Vec<u8>) -> io::Result<()> {
    loop {
        if SIGNALS.load(Ordering::SeqCst) & ((1 << libc::SIGTERM) | (1 << libc::SIGHUP)) != 0 {
            return Ok(());
        }
        if check(unsafe { libc::tcgetpgrp(physical.as_raw_fd()) })? != unsafe { libc::getpgrp() } {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        if output.is_empty() {
            let mut buffer = [0; 65536];
            match master.read(&mut buffer) {
                Ok(0) => return Ok(()),
                Ok(n) => output.extend_from_slice(&buffer[..n]),
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.raw_os_error() == Some(libc::EIO) =>
                {
                    return Ok(());
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        match physical.write(output) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(n) => {
                output.drain(..n);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(error) => return Err(error),
        }
    }
}

fn restore_carrier_loss() -> io::Result<()> {
    fatal();
    restore_physical()
}

fn signal_child(signal: i32) -> io::Result<()> {
    if !CHILD_REAPED.load(Ordering::SeqCst) {
        check(unsafe { libc::kill(CARRIER_CHILD.load(Ordering::SeqCst), signal) })?;
    }
    Ok(())
}

fn poll_child() -> io::Result<Option<i32>> {
    {
        if CHILD_REAPED.load(Ordering::SeqCst) {
            return Ok(Some(CHILD_STATUS.load(Ordering::SeqCst)));
        }
        let mut status = 0;
        #[cfg(target_os = "linux")]
        let flags = libc::__WALL;
        #[cfg(not(target_os = "linux"))]
        let flags = 0;
        let got = unsafe {
            libc::waitpid(
                CARRIER_CHILD.load(Ordering::SeqCst),
                &mut status,
                libc::WNOHANG | libc::WUNTRACED | flags,
            )
        };
        if got > 0 {
            if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
                CHILD_STATUS.store(status, Ordering::SeqCst);
                CHILD_REAPED.store(true, Ordering::SeqCst);
            }
            Ok(Some(status))
        } else if got == 0 || io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            Ok(None)
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

/// Consume the carrier's startup grant before a primary can generate a newer STOP.
#[cfg(any(target_os = "macos", test))]
pub(super) fn wait_initial_grant(mut cancelled: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    if !isolated() {
        return Ok(());
    }
    loop {
        cancelled()?;
        #[cfg(not(target_os = "macos"))]
        let initial = grant()?;
        #[cfg(target_os = "macos")]
        let initial = ordered_grant(|| Ok(ordered::Witness::default()))?;
        if initial.is_some() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    #[test]
    fn stop_observation_cancels_prior_resume_without_marking_fatal() {
        RESUME_PENDING.store(true, Ordering::SeqCst);
        cancel_resume();
        assert!(!take_resume());
        assert!(!is_fatal());
    }

    #[test]
    fn fatal_signal_interrupts_final_tail_before_foreground_wait() {
        for signal in [libc::SIGTERM, libc::SIGHUP] {
            let mut physical = File::open("/dev/null").unwrap();
            let mut master = File::open("/dev/null").unwrap();
            SIGNALS.store(1 << signal, Ordering::SeqCst);
            let mut tail = vec![1, 2, 3];
            flush(&mut physical, &mut master, &mut tail).unwrap();
            assert_eq!(tail, [1, 2, 3]);
        }
        SIGNALS.store(0, Ordering::SeqCst);
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn initial_unknown_is_not_background_and_ordered_grants_coalesce() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        assert_eq!(read_grants(&reader).unwrap(), None);
        writer.write_all(b"GBBG").unwrap();
        assert_eq!(read_grants(&reader).unwrap(), Some(true));
        writer.write_all(b"GGB").unwrap();
        assert_eq!(read_grants(&reader).unwrap(), Some(false));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn malformed_grant_is_not_a_positive_or_background_state() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        writer.write_all(b"GXG").unwrap();
        assert_eq!(
            read_grants(&reader).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn eof_supersedes_queued_live_grant() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        writer.write_all(b"G").unwrap();
        drop(writer);
        assert_eq!(
            read_grants(&reader).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
    #[test]
    #[cfg(not(target_os = "macos"))]
    fn initial_grant_precedes_primary_stop_and_later_grants_win() {
        const CHILD: &str = "PI_INITIAL_GRANT_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tty_handoff::tests::initial_grant_precedes_primary_stop_and_later_grants_win",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .env("PI_PROCESS_OWNER_PENDING", "1")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        use std::os::unix::process::CommandExt;
        let (reader, mut carrier) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        PRIVATE
            .set(Private {
                master: File::open("/dev/null").unwrap(),
                grants: reader,
                slave: File::open("/dev/null").unwrap(),
                redirect_stderr: false,
            })
            .ok()
            .unwrap();
        let (updates, mut physical) = UnixStream::pair().unwrap();
        physical.set_nonblocking(true).unwrap();
        UPDATES.set(updates).ok().unwrap();
        crate::job_control::initialize()
            .unwrap()
            .activate(true)
            .unwrap();
        carrier.write_all(b"G").unwrap();
        wait_initial_grant(|| Ok(())).unwrap();
        struct Held(std::process::Child, bool);
        impl Drop for Held {
            fn drop(&mut self) {
                if !self.1 {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
        }
        let mut child = Held(std::process::Command::new("/bin/sh")
            .args(["-c", "kill -TSTP $$; read -r line; kill -TSTP $$; read -r line; kill -TSTP $$; read -r line; exit 23"])
            .stdin(std::process::Stdio::piped()).process_group(0).spawn().unwrap(), false);
        let (error, _writer) = UnixStream::pair().unwrap();
        let mut primary = crate::job_control::Primary::Session {
            pid: child.0.id() as i32,
            error,
            bytes: [0; 4],
            length: 0,
            started: true,
            status: None,
            witness: ordered::Witness::default(),
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        for cycle in 0..3 {
            loop {
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                assert_eq!(
                    unsafe {
                        libc::waitid(
                            libc::P_PID,
                            child.0.id(),
                            &mut info,
                            libc::WSTOPPED | libc::WNOWAIT | libc::WNOHANG,
                        )
                    },
                    0
                );
                if unsafe { info.si_pid() } != 0 {
                    break;
                }
                assert!(std::time::Instant::now() < deadline, "primary did not stop");
                std::thread::sleep(Duration::from_millis(1));
            }
            // Cycles 1/2 queue genuinely post-STOP G/B before guardian observes STOP.
            if cycle > 0 {
                carrier
                    .write_all(if cycle == 1 { b"G" } else { b"B" })
                    .unwrap();
            }
            primary.reconcile_pause().unwrap();
            assert!(primary.try_wait().unwrap().is_none());
            refresh().unwrap(); // Same post-observation grant path as Darwin's loop.
            let mut operations = Vec::new();
            crate::job_control::State::default()
                .update(|paused| {
                    operations.push(paused);
                    // A newly arriving grant midway through freeze must undo that freeze.
                    if paused {
                        carrier.write_all(b"G").unwrap();
                        refresh().unwrap();
                    }
                    Ok(())
                })
                .unwrap();
            if cycle == 0 {
                assert_eq!(operations, [true, false]);
                let mut byte = [0];
                physical.read_exact(&mut byte).unwrap();
                assert_eq!(byte, *b"P");
            } else {
                assert!(operations.is_empty());
                assert_eq!(
                    physical.read(&mut [0]).unwrap_err().kind(),
                    io::ErrorKind::WouldBlock
                );
            }
            assert!(!crate::job_control::pause_requested());
            assert!(take_resume());
            assert_eq!(unsafe { libc::kill(primary.id() as i32, libc::SIGCONT) }, 0);
            child
                .0
                .stdin
                .as_mut()
                .unwrap()
                .write_all(b"next\n")
                .unwrap();
        }
        loop {
            primary.observe_pause().unwrap();
            if let Some(status) = primary.try_wait().unwrap() {
                child.1 = true;
                assert_eq!(status.code(), Some(23));
                assert_eq!(primary.observe_pause().unwrap(), None);
                assert_eq!(primary.try_wait().unwrap(), Some(status));
                assert!(!take_resume());
                break;
            }
            assert!(std::time::Instant::now() < deadline, "primary did not exit");
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(
            child.0.wait().unwrap_err().raw_os_error(),
            Some(libc::ECHILD)
        );
    }
}

#[cfg(any(target_os = "macos", test))]
#[path = "tty_grant.rs"]
pub(super) mod ordered;
#[cfg(any(target_os = "macos", test))]
static ORDERED: std::sync::Mutex<ordered::Consumer> =
    std::sync::Mutex::new(ordered::Consumer::new());
