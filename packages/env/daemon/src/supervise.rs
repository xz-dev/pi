//! One invocation owns a reaper subtree. A second reaper survives either owner's death.
//! Never signal a cached PID after reaping it: only fresh, unreaped children are targets.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static SIGNALS: AtomicU32 = AtomicU32::new(0);
#[cfg(target_os = "freebsd")]
#[path = "freebsd_exit_wake.rs"]
mod exit_wake;
const FORWARDED: [i32; 4] = [libc::SIGHUP, libc::SIGINT, libc::SIGQUIT, libc::SIGTERM];
#[cfg(target_os = "linux")]
const WAIT_ALL: i32 = libc::__WALL;
#[cfg(target_os = "freebsd")]
const WAIT_ALL: i32 = 0;

fn fork_guardian() -> libc::pid_t {
    #[cfg(target_os = "linux")]
    if crate::job_control::enabled() {
        // Sole-thread supervise mode, before workers: fork-like clone with copied stack,
        // address space and FD table; only the parent-directed exit signal differs.
        // All optional clone arguments are null (no VM/files/TLS sharing flags).
        #[cfg(target_arch = "s390x")]
        return unsafe { libc::syscall(libc::SYS_clone, 0, libc::SIGCONT, 0, 0, 0) as libc::pid_t };
        #[cfg(not(target_arch = "s390x"))]
        return unsafe { libc::syscall(libc::SYS_clone, libc::SIGCONT, 0, 0, 0, 0) as libc::pid_t };
    }
    unsafe { libc::fork() }
}
#[cfg(target_os = "linux")]
const KERNEL_SIGNAL_CODE: i32 = libc::SI_KERNEL;
// FreeBSD sys/signal.h defines SI_KERNEL; libc 0.2.190 does not export it.
#[cfg(target_os = "freebsd")]
const KERNEL_SIGNAL_CODE: i32 = 0x10006;

extern "C" fn receive(signal: i32, info: *mut libc::siginfo_t, _: *mut libc::c_void) {
    if crate::job_control::receive(signal) {
        return;
    }
    // A terminal already delivered Ctrl-C to the inherited foreground group.
    if signal == libc::SIGINT && !info.is_null() {
        // SAFETY: SA_SIGINFO supplies this pointer for the duration of the handler.
        if unsafe { (*info).si_code } == KERNEL_SIGNAL_CODE {
            return;
        }
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

#[cfg(target_os = "linux")]
fn children() -> io::Result<Vec<libc::pid_t>> {
    let text = std::fs::read_to_string(format!("/proc/self/task/{}/children", std::process::id()))?;
    text.split_whitespace()
        .map(|word| {
            word.parse::<libc::pid_t>()
                .ok()
                .filter(|pid| *pid > 0)
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid owned child PID")
                })
        })
        .collect()
}

fn acquire() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: this prctl operation takes no pointers.
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        children()?;
    }
    #[cfg(target_os = "freebsd")]
    {
        // SAFETY: the operation acquires this process's own reaper domain.
        if unsafe {
            libc::procctl(
                libc::P_PID,
                std::process::id() as libc::id_t,
                libc::PROC_REAP_ACQUIRE,
                std::ptr::null_mut(),
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn parent_death(parent: libc::pid_t) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    // SAFETY: this prctl operation takes no pointers.
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    #[cfg(target_os = "freebsd")]
    {
        let mut signal = libc::SIGTERM;
        // SAFETY: signal points to a valid integer for this process's operation.
        if unsafe {
            libc::procctl(
                libc::P_PID,
                std::process::id() as libc::id_t,
                libc::PROC_PDEATHSIG_CTL,
                (&mut signal as *mut i32).cast(),
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    // SAFETY: getppid has no arguments. Check the race before starting the command.
    if unsafe { libc::getppid() } != parent {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "owner exited during setup",
        ));
    }
    Ok(())
}

fn send(pid: libc::pid_t, signal: i32) -> io::Result<()> {
    // SAFETY: caller holds an unreaped direct child, with SIGCHLD auto-reaping disabled.
    if unsafe { libc::kill(pid, signal) } != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(target_os = "freebsd")]
fn signal_owned(signal: i32) -> io::Result<()> {
    #[repr(C)]
    struct ReaperKill {
        signal: i32,
        flags: u32,
        subtree: libc::pid_t,
        killed: u32,
        failed_pid: libc::pid_t,
        reserved: [u32; 15],
    }
    let mut request = ReaperKill {
        signal,
        flags: 0,
        subtree: 0,
        killed: 0,
        failed_pid: 0,
        reserved: [0; 15],
    };
    // SAFETY: procctl_reaper_kill layout; kernel limits targets to this reaper's descendants.
    if unsafe {
        libc::procctl(
            libc::P_PID,
            std::process::id() as libc::id_t,
            libc::PROC_REAP_KILL,
            (&mut request as *mut ReaperKill).cast(),
        )
    } != 0
    {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn signal_owned(signal: i32) -> io::Result<()> {
    // No reaping between enumeration and signals. These PIDs cannot be reused in that interval.
    for pid in children()? {
        send(pid, signal)?;
    }
    Ok(())
}

/// One private duplex stream between caller and supervise. `K` requests an
/// immediate kill of the primary and its whole owned tree; the outer stays
/// alive until cleanup completes. Lease EOF cancels the same way. The only
/// records are newline-delimited: `S{"pid":N}` (spawned),
/// `X{"code":N|null,"signal":N|null}` (primary exit), `E<errno> <message>`,
/// or `C` (outer cleanup completed). Callers require C, helper close and control
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

fn cleanup() -> io::Result<()> {
    let start = Instant::now();
    let deadline = start + Duration::from_secs(5);
    signal_owned(libc::SIGTERM)?;
    signal_owned(libc::SIGCONT)?;
    loop {
        if start.elapsed() >= Duration::from_millis(250) {
            signal_owned(libc::SIGKILL)?;
        }
        loop {
            let mut status = 0;
            // SAFETY: valid output word; only our own children are waitable.
            let got = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG | WAIT_ALL) };
            if got > 0 {
                continue;
            }
            if got < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ECHILD) {
                    return Ok(());
                }
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            break;
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "owned descendants remain",
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn reap_non_primary(primary: libc::pid_t) -> io::Result<()> {
    loop {
        // WNOWAIT preserves the primary's exit status for Child::try_wait().
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_ALL,
                0,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT | WAIT_ALL,
            )
        } != 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ECHILD) {
                return Ok(());
            }
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let pid = unsafe { info.si_pid() };
        if pid == 0 || pid == primary {
            return Ok(());
        }
        let got = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG | WAIT_ALL) };
        if got < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

fn pending(
    pid: libc::pid_t,
    deadline: &mut Option<Instant>,
    grace: Duration,
    mut before_continue: impl FnMut() -> io::Result<()>,
) -> io::Result<()> {
    let signals = SIGNALS.swap(0, Ordering::Relaxed);
    for signal in FORWARDED {
        if signals & (1u32 << signal) != 0 {
            let terminating = matches!(signal, libc::SIGTERM | libc::SIGHUP);
            let session = crate::job_control::enabled();
            // Preserve legacy CONT-then-original-signal forwarding outside a session.
            if terminating && !session {
                send(pid, libc::SIGCONT)?;
            }
            send(
                pid,
                if terminating && session {
                    libc::SIGTERM
                } else {
                    signal
                },
            )?;
            if terminating && session {
                before_continue()?;
                send(pid, libc::SIGCONT)?;
            }
            if matches!(signal, libc::SIGTERM | libc::SIGHUP) && deadline.is_none() {
                *deadline = Some(Instant::now() + grace);
            }
        }
    }
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        send(pid, libc::SIGKILL)?;
    }
    Ok(())
}

/// Only the guardian reads control. Any byte or EOF forces owned cleanup;
/// the caller requires outer C, helper close and control drain as cleanup acknowledgment.
fn control_pending(control: &mut Option<Control>) -> io::Result<()> {
    let Some(control) = control else {
        return Ok(());
    };
    if control.peek()?.is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "control kill or malformed byte",
        ));
    }
    Ok(())
}

fn spawn_error(error: &io::Error) -> Vec<u8> {
    let mut bytes = b"E".to_vec();
    bytes.extend(error.raw_os_error().unwrap_or(0).to_string().into_bytes());
    bytes.push(b' ');
    bytes.extend(error.to_string().into_bytes());
    bytes.push(b'\n');
    bytes
}

// Private opt-in producer. No daemon capability or consumer selects it yet.
#[cfg(target_os = "linux")]
mod exec_spec {
    use super::*;
    #[cfg(target_env = "gnu")]
    use std::ffi::CStr;
    use std::io::{Seek, SeekFrom};
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::process::CommandExt;

    const HEADER: usize = 64;
    const STRINGS: u64 = 6_291_456;
    const COUNT: u64 = 1_572_864;
    const CWD: u64 = 16_777_216;
    const SERIALIZED: u64 = 29_360_192;
    const RESTORED: [i32; 5] = [
        libc::SIGHUP,
        libc::SIGINT,
        libc::SIGQUIT,
        libc::SIGTERM,
        libc::SIGCHLD,
    ];

    unsafe extern "C" {
        static mut environ: *mut *const libc::c_char;
    }

    fn invalid() -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, "invalid sealed exec spec")
    }

    #[cfg(test)]
    std::thread_local! {
        static RESERVED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    fn reserve<T>(vec: &mut Vec<T>, count: usize) -> io::Result<()> {
        #[cfg(test)]
        RESERVED.with(|total| total.set(total.get() + count * std::mem::size_of::<T>()));
        vec.try_reserve_exact(count).map_err(io::Error::other)
    }

    struct Header {
        length: u64,
        argc: u32,
        envc: u32,
        charge: u64,
        cwd: u32,
        setup: u8,
        ignored: u8,
        blocked: u8,
    }

    impl Header {
        fn read(bytes: &[u8; HEADER], size: u64) -> io::Result<Self> {
            let u32_at = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
            let u64_at = |at| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
            let h = Self {
                length: u64_at(16),
                argc: u32_at(24),
                envc: u32_at(28),
                charge: u64_at(32),
                cwd: u32_at(40),
                setup: bytes[44],
                ignored: bytes[45],
                blocked: bytes[46],
            };
            let count = u64::from(h.argc) + u64::from(h.envc);
            if &bytes[..8] != b"PIEXSPEC"
                || u32_at(8) != 1
                || u32_at(12) != 64
                || !(64..=SERIALIZED).contains(&size)
                || h.length != size
                || h.argc == 0
                || count > COUNT
                || h.charge > STRINGS
                || h.charge < count
                || u64::from(h.cwd) > CWD
                || 64 + u64::from(h.cwd) + 4 * count > size
                || bytes[48..].iter().any(|&b| b != 0)
                || match h.setup {
                    0 => h.ignored != 0 || h.blocked != 0 || bytes[47] != 0,
                    1 => {
                        h.cwd != 0
                            || h.argc != 2
                            || (h.ignored | h.blocked) & !31 != 0
                            || bytes[47] != 3
                    }
                    _ => true,
                }
            {
                return Err(invalid());
            }
            if h.setup == 1 {
                #[cfg(target_env = "gnu")]
                // SAFETY: GNU returns a static NUL-terminated version string.
                let qualified =
                    unsafe { CStr::from_ptr(libc::gnu_get_libc_version()) }.to_bytes() == b"2.44";
                #[cfg(not(target_env = "gnu"))]
                let qualified = false;
                if !qualified {
                    return Err(invalid());
                }
            }
            Ok(h)
        }
    }

    // Immutable coupled ownership, not borrowed spec pointers. Empty entries have
    // real arena addresses; only the last pointer is NULL. No mutation API escapes.
    struct RawEnv {
        arena: Vec<u8>,
        pointers: Vec<*const libc::c_char>,
    }
    // SAFETY: both allocations stay owned together and never grow after pointers
    // are made. Foreign exec only reads them. Moving owner cannot move its heaps.
    unsafe impl Send for RawEnv {}
    // SAFETY: shared access cannot mutate/detach either allocation or its records.
    unsafe impl Sync for RawEnv {}

    impl RawEnv {
        fn new(records: &[u8], count: u32, charge: usize) -> io::Result<Self> {
            let mut arena = Vec::new();
            let mut pointers = Vec::new();
            reserve(&mut arena, charge)?;
            reserve(&mut pointers, count as usize + 1)?;
            let mut rest = records;
            for _ in 0..count {
                let record = take_record(&mut rest);
                arena.extend_from_slice(record);
                arena.push(0);
            }
            let mut offset = 0;
            for _ in 0..count {
                // SAFETY: validated records and final allocation, including empty records.
                pointers.push(unsafe { arena.as_ptr().add(offset).cast() });
                offset += arena[offset..].iter().position(|&b| b == 0).unwrap() + 1;
            }
            pointers.push(std::ptr::null());
            Ok(Self { arena, pointers })
        }

        unsafe fn install(&self) {
            // SAFETY: called only in forked payload; Command has NO env mutators,
            // hence std's maybe_envp=None does not overwrite this after callbacks.
            // Whole-owner method forces closure to retain arena AND pointer table.
            unsafe {
                environ = self.pointers.as_ptr().cast_mut();
            }
        }

        fn path(&self) -> Option<(usize, usize)> {
            let mut offset = 0;
            while offset < self.arena.len() {
                let end = offset + self.arena[offset..].iter().position(|&b| b == 0).unwrap();
                if self.arena[offset..end].starts_with(b"PATH=") {
                    return Some((offset + 5, end));
                }
                offset = end + 1;
            }
            None
        }
    }

    // Called only on the fully validated arena, never on untrusted lengths.
    fn take_record<'a>(rest: &mut &'a [u8]) -> &'a [u8] {
        let length = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
        let record = &rest[4..4 + length];
        *rest = &rest[4 + length..];
        record
    }

    struct Discovery {
        range: Option<(usize, usize)>,
        default: Vec<u8>,
        scratch: [u8; 4103],
    }

    // glibc's overlong nonfinal component leaves cursor ON its colon: next
    // iteration attempts cwd. split(':') would silently change this behavior.
    fn next_component<'a>(
        path: &'a [u8],
        cursor: &mut Option<usize>,
        limit: usize,
    ) -> Option<&'a [u8]> {
        while let Some(start) = *cursor {
            let tail = path.get(start..)?;
            let length = tail.iter().position(|&b| b == b':').unwrap_or(tail.len());
            let end = start + length;
            if length >= limit {
                *cursor = if end == path.len() { None } else { Some(end) };
                continue;
            }
            *cursor = if end == path.len() {
                None
            } else {
                Some(end + 1)
            };
            return tail.get(..length);
        }
        None
    }

    impl Discovery {
        fn new(env: &RawEnv) -> io::Result<Self> {
            let range = env.path();
            let mut default = Vec::new();
            if range.is_none() {
                // Qualified libc default, not a guessed universal PATH.
                let length = unsafe { libc::confstr(libc::_CS_PATH, std::ptr::null_mut(), 0) };
                if length == 0 || length > 4096 {
                    return Err(invalid());
                }
                reserve(&mut default, length)?;
                default.resize(length, 0);
                if unsafe { libc::confstr(libc::_CS_PATH, default.as_mut_ptr().cast(), length) }
                    != length
                    || default.last() != Some(&0)
                    || default[..length - 1].contains(&0)
                {
                    return Err(invalid());
                }
                default.pop();
            }
            Ok(Self {
                range,
                default,
                scratch: [0; 4103],
            })
        }

        fn path<'a>(&'a self, env: &'a RawEnv) -> &'a [u8] {
            match self.range {
                Some((start, end)) => &env.arena[start..end],
                None => &self.default,
            }
        }

        fn no_attempt(&self, env: &RawEnv) -> bool {
            let path = self.path(env);
            next_component(path, &mut Some(0), path.len().min(4095) + 1).is_none()
        }

        unsafe fn execute(&mut self, env: &RawEnv) -> io::Result<()> {
            let path = match self.range {
                Some((start, end)) => &env.arena[start..end],
                None => &self.default,
            };
            let mut cursor = Some(0);
            let limit = path.len().min(4095) + 1;
            let argv = [c"which".as_ptr(), c"bash".as_ptr(), std::ptr::null()];
            let mut denied = false;
            // no_attempt was handled BEFORE spawn. Every remaining return is Err,
            // so std never reaches its execvp (and cannot run headerless scripts).
            let mut errno = libc::ENOENT;
            while let Some(component) = next_component(path, &mut cursor, limit) {
                let length = component.len();
                // SAFETY: eligible length<=4095; scratch has 4103 bytes. No heap,
                // env query, locks, formatting, destructors or syscall prechecks.
                unsafe {
                    let out = self.scratch.as_mut_ptr();
                    std::ptr::copy_nonoverlapping(component.as_ptr(), out, length);
                    let suffix = if length == 0 {
                        0
                    } else {
                        out.add(length).write(b'/');
                        length + 1
                    };
                    std::ptr::copy_nonoverlapping(
                        c"which".as_ptr().cast::<u8>(),
                        out.add(suffix),
                        6,
                    );
                    libc::execve(out.cast(), argv.as_ptr(), env.pointers.as_ptr());
                    errno = *libc::__errno_location();
                }
                match errno {
                    libc::EACCES => denied = true,
                    libc::ENOENT
                    | libc::ESTALE
                    | libc::ENOTDIR
                    | libc::ENODEV
                    | libc::ETIMEDOUT
                    | libc::ENAMETOOLONG => {}
                    _ => return Err(io::Error::from_raw_os_error(errno)),
                }
            }
            Err(io::Error::from_raw_os_error(if denied {
                libc::EACCES
            } else {
                errno
            }))
        }
    }

    pub(super) struct Prepared {
        pub(super) command: Command,
        pub(super) no_attempt: bool,
    }

    pub(super) fn read(descriptor: i32) -> io::Result<Prepared> {
        // Sole-thread helper: validity check and ownership transfer cannot race close.
        if unsafe { libc::fcntl(descriptor, libc::F_GETFD) } < 0 {
            return Err(io::Error::last_os_error());
        }
        // Own original N; it is closed before acquire/guardian fork on every path.
        let mut file = unsafe { std::fs::File::from_raw_fd(descriptor) };
        let fd = file.as_raw_fd();
        let metadata = file.metadata()?;
        let seals = unsafe { libc::fcntl(fd, libc::F_GET_SEALS) };
        let required =
            libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
        if !metadata.is_file()
            || !(64..=SERIALIZED).contains(&metadata.len())
            || seals < 0
            || seals & required != required
        {
            return Err(invalid());
        }
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = [0; HEADER];
        file.read_exact(&mut bytes)?;
        let header = Header::read(&bytes, metadata.len())?;
        // First pass: bounded stack only; no count-driven allocation or Command.
        let mut remaining = header.length - 64;
        let mut scratch = [0; 4096];
        let mut consume = |file: &mut std::fs::File,
                           remaining: &mut u64,
                           length: u64,
                           expected: Option<&[u8]>|
         -> io::Result<()> {
            if length > *remaining || expected.is_some_and(|bytes| bytes.len() as u64 != length) {
                return Err(invalid());
            }
            let mut left = length;
            while left != 0 {
                let count = left.min(scratch.len() as u64) as usize;
                file.read_exact(&mut scratch[..count])?;
                if scratch[..count].contains(&0)
                    || expected.is_some_and(|bytes| bytes != &scratch[..count])
                {
                    return Err(invalid());
                }
                left -= count as u64;
            }
            *remaining -= length;
            Ok(())
        };
        consume(&mut file, &mut remaining, u64::from(header.cwd), None)?;
        let mut charge = 0u64;
        let mut env_charge = 0u64;
        for index in 0..u64::from(header.argc) + u64::from(header.envc) {
            remaining = remaining.checked_sub(4).ok_or_else(invalid)?;
            let mut word = [0; 4];
            file.read_exact(&mut word)?;
            let length = u64::from(u32::from_le_bytes(word));
            let expected = if header.setup == 1 && index < 2 {
                Some(if index == 0 {
                    b"which".as_slice()
                } else {
                    b"bash".as_slice()
                })
            } else {
                None
            };
            consume(&mut file, &mut remaining, length, expected)?;
            charge = charge.checked_add(length + 1).ok_or_else(invalid)?;
            if charge > STRINGS {
                return Err(invalid());
            }
            if index >= u64::from(header.argc) {
                env_charge += length + 1;
            }
        }
        if remaining != 0 || charge != header.charge {
            return Err(invalid());
        }
        let mut end = [0];
        if file.read(&mut end)? != 0 {
            return Err(invalid());
        }
        let length = usize::try_from(header.length).map_err(|_| invalid())?;
        let mut arena = Vec::new();
        reserve(&mut arena, length)?;
        arena.resize(length, 0);
        file.seek(SeekFrom::Start(0))?;
        file.read_exact(&mut arena)?;
        drop(file);
        let cwd_end = 64 + header.cwd as usize;
        let mut rest = &arena[cwd_end..];
        let program = take_record(&mut rest);
        if header.setup == 1 && (header.argc != 2 || program != b"which") {
            return Err(invalid());
        }
        let mut command = Command::new(OsString::from_vec(program.to_vec()));
        for _ in 1..header.argc {
            let arg = take_record(&mut rest);
            if header.setup == 1 && arg != b"bash" {
                return Err(invalid());
            }
            command.arg(OsString::from_vec(arg.to_vec()));
        }
        if header.setup == 0 {
            command.current_dir(OsString::from_vec(arena[64..cwd_end].to_vec()));
        }
        command.stdin(Stdio::null()).stdout(Stdio::inherit());
        if header.setup == 1 {
            command.stderr(Stdio::null());
        } else {
            command.stderr(Stdio::inherit());
        }
        let env = RawEnv::new(rest, header.envc, env_charge as usize)?;
        let mut discovery = if header.setup == 1 {
            Some(Discovery::new(&env)?)
        } else {
            None
        };
        let no_attempt = discovery
            .as_ref()
            .is_some_and(|lookup| lookup.no_attempt(&env));
        // Build masks before fork. Only these five bits were changed by supervisor.
        let mut block: libc::sigset_t = unsafe { std::mem::zeroed() };
        let mut unblock: libc::sigset_t = unsafe { std::mem::zeroed() };
        unsafe {
            libc::sigemptyset(&mut block);
            libc::sigemptyset(&mut unblock);
            for (bit, signal) in RESTORED.into_iter().enumerate() {
                libc::sigaddset(
                    if header.blocked & (1 << bit) != 0 {
                        &mut block
                    } else {
                        &mut unblock
                    },
                    signal,
                );
            }
            command.pre_exec(move || {
                if header.setup == 0 {
                    if libc::setsid() < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    for signal in 1..32 {
                        if signal != libc::SIGKILL
                            && signal != libc::SIGSTOP
                            && libc::signal(signal, libc::SIG_DFL) == libc::SIG_ERR
                        {
                            return Err(io::Error::last_os_error());
                        }
                    }
                    let mut empty: libc::sigset_t = std::mem::zeroed();
                    libc::sigemptyset(&mut empty);
                    if libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut()) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                } else {
                    for (bit, signal) in RESTORED.into_iter().enumerate() {
                        if libc::signal(
                            signal,
                            if header.ignored & (1 << bit) != 0 {
                                libc::SIG_IGN
                            } else {
                                libc::SIG_DFL
                            },
                        ) == libc::SIG_ERR
                        {
                            return Err(io::Error::last_os_error());
                        }
                    }
                    if libc::sigprocmask(libc::SIG_BLOCK, &block, std::ptr::null_mut()) != 0
                        || libc::sigprocmask(libc::SIG_UNBLOCK, &unblock, std::ptr::null_mut()) != 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                }
                env.install();
                if let Some(lookup) = &mut discovery {
                    return lookup.execute(&env);
                }
                Ok(())
            });
        }
        Ok(Prepared {
            command,
            no_attempt,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::ffi::CStr;
        use std::os::fd::IntoRawFd;

        fn bytes(argv: &[&[u8]], env: &[&[u8]], discovery: bool) -> Vec<u8> {
            let cwd = if discovery {
                b"".as_slice()
            } else {
                b"/".as_slice()
            };
            let mut out = vec![0; 64];
            out[..8].copy_from_slice(b"PIEXSPEC");
            out[8..12].copy_from_slice(&1u32.to_le_bytes());
            out[12..16].copy_from_slice(&64u32.to_le_bytes());
            out[24..28].copy_from_slice(&(argv.len() as u32).to_le_bytes());
            out[28..32].copy_from_slice(&(env.len() as u32).to_le_bytes());
            let charge: u64 = argv.iter().chain(env).map(|b| b.len() as u64 + 1).sum();
            out[32..40].copy_from_slice(&charge.to_le_bytes());
            out[40..44].copy_from_slice(&(cwd.len() as u32).to_le_bytes());
            out[44] = u8::from(discovery);
            out[47] = if discovery { 3 } else { 0 };
            out.extend_from_slice(cwd);
            for record in argv.iter().chain(env) {
                out.extend_from_slice(&(record.len() as u32).to_le_bytes());
                out.extend_from_slice(record);
            }
            let length = out.len() as u64;
            out[16..24].copy_from_slice(&length.to_le_bytes());
            out
        }

        fn sealed(bytes: &[u8], seal: bool) -> i32 {
            let fd = unsafe {
                libc::memfd_create(
                    c"a0-test".as_ptr(),
                    libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
                )
            };
            assert!(fd >= 0);
            let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
            file.write_all(bytes).unwrap();
            if seal {
                assert_eq!(
                    unsafe {
                        libc::fcntl(
                            fd,
                            libc::F_ADD_SEALS,
                            libc::F_SEAL_WRITE
                                | libc::F_SEAL_GROW
                                | libc::F_SEAL_SHRINK
                                | libc::F_SEAL_SEAL,
                        )
                    },
                    0
                );
            }
            file.into_raw_fd()
        }

        #[test]
        fn raw_owner_keeps_duplicates_empty_opaque_and_non_utf8() {
            let records: &[&[u8]] = &[
                b"X=first",
                b"X=last",
                b"OPAQUE",
                b"",
                b"\xff=\xfe",
                b"PATH=first",
                b"PATH=last",
            ];
            let encoded = bytes(&[b"/bin/true"], records, false);
            let h = Header::read(encoded[..64].try_into().unwrap(), encoded.len() as u64).unwrap();
            let mut rest = &encoded[65..];
            take_record(&mut rest);
            let owner =
                RawEnv::new(rest, h.envc, records.iter().map(|b| b.len() + 1).sum()).unwrap();
            fn send_sync<T: Send + Sync>(_: &T) {}
            send_sync(&owner);
            for (index, record) in records.iter().enumerate() {
                assert!(!owner.pointers[index].is_null());
                assert_eq!(
                    unsafe { CStr::from_ptr(owner.pointers[index]) }.to_bytes(),
                    *record
                );
            }
            assert!(owner.pointers[records.len()].is_null());
            let (start, end) = owner.path().unwrap();
            assert_eq!(&owner.arena[start..end], b"first");
            let empty = RawEnv::new(&[], 0, 0).unwrap();
            assert_eq!(empty.pointers, [std::ptr::null()]);
            RESERVED.with(|total| total.set(0));
            assert!(read(sealed(&encoded, true)).is_ok());
            let charged = records.iter().map(|b| b.len() + 1).sum::<usize>();
            assert_eq!(
                RESERVED.with(|total| total.get()),
                encoded.len()
                    + charged
                    + (records.len() + 1) * std::mem::size_of::<*const libc::c_char>()
            );
        }

        #[test]
        fn bounded_decoder_refuses_invalid_metadata_and_encoding() {
            let good = bytes(&[b"/bin/true"], &[], false);
            assert!(read(sealed(&good, false)).is_err());
            for at in [0, 8, 12, 16, 24, 28, 32, 40, 44, 45, 46, 47, 48, 63, 65] {
                let mut bad = good.clone();
                bad[at] ^= 0xff;
                RESERVED.with(|total| total.set(0));
                assert!(read(sealed(&bad, true)).is_err(), "accepted byte {at}");
                assert_eq!(
                    RESERVED.with(|total| total.get()),
                    0,
                    "allocated for invalid byte {at}"
                );
            }
            for bad in [
                bytes(&[b"x\0y"], &[], false),
                bytes(&[b"which", b"not-bash"], &[], true),
            ] {
                assert!(read(sealed(&bad, true)).is_err());
            }
            let mut trailing = good.clone();
            trailing.push(0);
            trailing[16..24].copy_from_slice(&(good.len() as u64 + 1).to_le_bytes());
            assert!(read(sealed(&trailing, true)).is_err());
            let fd = sealed(&good, false);
            assert_eq!(unsafe { libc::ftruncate(fd, 1i64 << 40) }, 0);
            assert_eq!(unsafe { libc::fcntl(fd, libc::F_ADD_SEALS, 15) }, 0);
            assert!(read(fd).is_err());
        }

        #[test]
        fn discovery_profile_and_argv_are_exact() {
            let good = bytes(&[b"which", b"bash"], &[b"PATH="], true);
            for profile in [0, 1, 2, 4, 255] {
                let mut bad = good.clone();
                bad[47] = profile;
                assert!(read(sealed(&bad, true)).is_err());
            }
            #[cfg(target_env = "gnu")]
            if unsafe { CStr::from_ptr(libc::gnu_get_libc_version()) }.to_bytes() == b"2.44" {
                assert!(read(sealed(&good, true)).is_ok());
                let overlong = vec![b'x'; 4096];
                let mut path = b"PATH=".to_vec();
                path.extend(&overlong);
                assert!(
                    read(sealed(&bytes(&[b"which", b"bash"], &[&path], true), true))
                        .unwrap()
                        .no_attempt
                );
            }
        }

        #[test]
        fn inclusive_header_budgets_and_invalid_descriptor() {
            let mut good = bytes(&[b"x"], &[], false);
            good[16..24].copy_from_slice(&SERIALIZED.to_le_bytes());
            good[28..32].copy_from_slice(&((COUNT - 1) as u32).to_le_bytes());
            good[32..40].copy_from_slice(&STRINGS.to_le_bytes());
            good[40..44].copy_from_slice(&(CWD as u32).to_le_bytes());
            assert!(Header::read(good[..64].try_into().unwrap(), SERIALIZED).is_ok());
            for (at, value) in [(28, COUNT as u32), (40, CWD as u32 + 1)] {
                let mut bad = good.clone();
                bad[at..at + 4].copy_from_slice(&value.to_le_bytes());
                assert!(Header::read(bad[..64].try_into().unwrap(), SERIALIZED).is_err());
            }
            good[32..40].copy_from_slice(&(STRINGS + 1).to_le_bytes());
            assert!(Header::read(good[..64].try_into().unwrap(), SERIALIZED).is_err());
            assert!(Header::read(good[..64].try_into().unwrap(), SERIALIZED + 1).is_err());
            assert!(read(i32::MAX).is_err());
        }

        #[test]
        fn gnu_cursor_keeps_colon_after_skipped_component() {
            let mut path = vec![b'x'; 4096];
            path.extend_from_slice(b":later:");
            let mut cursor = Some(0);
            assert_eq!(
                next_component(&path, &mut cursor, 4096),
                Some(b"".as_slice())
            );
            assert_eq!(
                next_component(&path, &mut cursor, 4096),
                Some(b"later".as_slice())
            );
            assert_eq!(
                next_component(&path, &mut cursor, 4096),
                Some(b"".as_slice())
            );
            assert_eq!(next_component(&path, &mut cursor, 4096), None);
            assert_eq!(next_component(&vec![b'x'; 4096], &mut Some(0), 4096), None);
        }

        #[test]
        fn unexpected_non_os_spawn_error_cannot_emit_e0() {
            let (stream, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
            let fd = control_fd(stream.into_raw_fd()).unwrap();
            let mut control = Some(Control::open(fd).unwrap());
            let command = Command::new(OsString::from_vec(b"bad\0program".to_vec()));
            assert!(observe(command, &mut control, None, true, false).is_err());
            drop(control);
            let mut report = Vec::new();
            peer.read_to_end(&mut report).unwrap();
            assert!(report.is_empty());
        }
    }
}

fn command(
    args: &[OsString],
    control: &mut Option<Control>,
    ipc: Option<std::fs::File>,
    gate: Option<crate::job_control::Startup>,
) -> io::Result<i32> {
    let mut command = Command::new(&args[0]);
    command
        .args(&args[1..])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if std::env::var_os("PI_PROCESS_OWNER_PENDING").is_some() {
        command
            .env_remove("PI_PROCESS_OWNER_PENDING")
            .env("PI_PROCESS_OWNER_PID", std::process::id().to_string());
    }
    if let Some(mut gate) = gate {
        gate.wait_active(|| {
            control_pending(control)?;
            if SIGNALS.load(Ordering::Relaxed)
                & ((1 << libc::SIGTERM)
                    | (1 << libc::SIGHUP)
                    | (1 << libc::SIGINT)
                    | (1 << libc::SIGQUIT))
                != 0
            {
                return Err(io::Error::from_raw_os_error(libc::ECANCELED));
            }
            Ok(())
        })?;
        let spawned = crate::job_control::Primary::spawn(command, Some(gate));
        return observe_primary(spawned, control, ipc, false, false);
    }
    observe(command, control, ipc, false, false)
}

fn observe(
    mut command: Command,
    control: &mut Option<Control>,
    ipc: Option<std::fs::File>,
    spec_mode: bool,
    no_attempt: bool,
) -> io::Result<i32> {
    let spawned = if no_attempt {
        // Only this typed, fully validated prefork branch may emit spec-mode E0.
        Err(io::Error::from(io::ErrorKind::NotFound))
    } else {
        command.spawn().map(crate::job_control::Primary::Standard)
    };
    observe_primary(spawned, control, ipc, spec_mode, no_attempt)
}

fn observe_primary(
    spawned: io::Result<crate::job_control::Primary>,
    control: &mut Option<Control>,
    ipc: Option<std::fs::File>,
    spec_mode: bool,
    no_attempt: bool,
) -> io::Result<i32> {
    // Only the exec child may retain IPC; a guardian copy would suppress disconnect EOF.
    drop(ipc);
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            if spec_mode && !no_attempt && error.raw_os_error().is_none() {
                return Err(error);
            }
            if let Some(control) = control
                && control.report(&spawn_error(&error)).is_ok()
            {
                // E already carries the spawn error; keep inherited stderr for the program.
                return Ok(125);
            }
            return Err(error);
        }
    };
    let mut started = false;
    let mut deadline = None;
    let mut forced = false;
    let mut suspend = crate::job_control::State::default();
    let mut targets = crate::job_control::Targets::default();
    loop {
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
                    if let Some(control) = control
                        && control.report(&spawn_error(&error)).is_ok()
                    {
                        return Ok(125);
                    }
                    return Err(error);
                }
            }
        }
        // The held native stub has no payload/tool tree and deliberately remains runnable.
        if started && deadline.is_none() && !crate::job_control::terminating() {
            suspend.update(|paused| targets.apply(paused))?;
        }
        if let Some(status) = child.try_wait()? {
            if let Some(control) = control {
                use std::os::unix::process::ExitStatusExt;
                let record =
                    serde_json::json!({ "code": status.code(), "signal": status.signal() });
                // A caller that dropped its lease must not prevent owned cleanup.
                let _ = control.report(format!("X{record}\n").as_bytes());
            }
            return Ok(crate::sys::exit_code(status) as i32);
        }
        reap_non_primary(child.id() as libc::pid_t)?;
        if !forced && control_pending(control).is_err() {
            send(child.id() as libc::pid_t, libc::SIGKILL)?;
            forced = true;
        }
        if !started {
            // A pre-exec child has default termination handlers. Queue termination before
            // CONT so cancellation cannot let it execute behind a still-stopped outer.
            let signals = SIGNALS.load(Ordering::Relaxed);
            for signal in [libc::SIGTERM, libc::SIGHUP] {
                if signals & (1 << signal) != 0 {
                    send(child.id() as libc::pid_t, signal)?;
                }
            }
        }
        pending(
            child.id() as libc::pid_t,
            &mut deadline,
            Duration::from_secs(5),
            || targets.teardown(child.id() as libc::pid_t),
        )?;
        thread::sleep(Duration::from_millis(10));
    }
}

fn guardian(
    args: &[OsString],
    parent: libc::pid_t,
    control: &mut Option<Control>,
    ipc: Option<std::fs::File>,
    gate: Option<crate::job_control::Startup>,
    #[cfg(target_os = "freebsd")] _exit_lease: Option<std::os::unix::net::UnixStream>,
    #[cfg(target_os = "linux")] spec: Option<exec_spec::Prepared>,
) -> i32 {
    SIGNALS.store(0, Ordering::Relaxed);
    #[cfg(target_os = "freebsd")]
    let gate = gate.map(|mut gate| {
        if let Some(lease) = &_exit_lease {
            gate.guardian_lifetime(lease.as_raw_fd());
        }
        gate
    });
    let result = acquire()
        .and_then(|()| parent_death(parent))
        .and_then(|()| {
            #[cfg(target_os = "linux")]
            if let Some(spec) = spec {
                return observe(spec.command, control, ipc, true, spec.no_attempt);
            }
            command(args, control, ipc, gate)
        });
    finish(result, cleanup(), None)
}

fn finish(result: io::Result<i32>, clean: io::Result<()>, control: Option<&mut Control>) -> i32 {
    if clean.is_ok()
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
type Parsed<'a> = (Option<i32>, Option<i32>, Option<i32>, &'a [OsString]);

fn parse(args: &[OsString]) -> io::Result<Parsed<'_>> {
    let mut control = None;
    let mut ipc = None;
    let mut spec = None;
    let mut index = 0;
    while index < args.len() && args[index] != "--" {
        let flag = match args[index].to_str() {
            Some("--control-fd") => &mut control,
            Some("--ipc-fd") => &mut ipc,
            #[cfg(target_os = "linux")]
            Some("--exec-spec-fd") => &mut spec,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unknown option {:?}", args[index]),
                ));
            }
        };
        // Reject duplicate flags only in new spec mode; legacy parse stays unchanged.
        if args
            .iter()
            .take_while(|arg| *arg != "--")
            .any(|arg| arg == "--exec-spec-fd")
            && flag.is_some()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "duplicate descriptor flag",
            ));
        }
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
    if index >= args.len() || (spec.is_none() && args.len() - index < 2) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "missing command after --",
        ));
    }
    if let Some(spec) = spec
        && (control.is_none() || ipc.is_some() || control == Some(spec) || args.len() != index + 1)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec spec requires distinct control fd, no IPC or command",
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
    Ok((control, ipc, spec, &args[index + 1..]))
}

pub fn run(args: &[OsString]) -> i32 {
    let (control_fd, ipc_fd, spec_fd, command_args) = match parse(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("usage: pi-env supervise [--control-fd N --ipc-fd N] -- <program> [args]");
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
    #[cfg(target_os = "linux")]
    let spec = match spec_fd.map(exec_spec::read).transpose() {
        Ok(spec) => spec,
        Err(error) => {
            eprintln!("pi-env supervise: {error}");
            return 125;
        }
    };
    #[cfg(not(target_os = "linux"))]
    let _ = spec_fd;
    // SAFETY: parse() validated this inherited descriptor; each fork owns its copy.
    let ipc = ipc_fd.map(|fd| unsafe { std::fs::File::from_raw_fd(fd) });
    let caller = unsafe { libc::getppid() };
    let job_mask = match prepare_signals().and_then(|mask| acquire().map(|()| mask)) {
        Ok(mask) => mask,
        Err(error) => {
            eprintln!("pi-env supervise: {error}");
            return 125;
        }
    };
    if let Err(error) = crate::job_control::wake_on_parent_death(caller) {
        eprintln!("pi-env supervise: {error}");
        if crate::job_control::enabled() {
            eprintln!(
                "pi-env: parent-death wake unavailable; use --no-process-ownership to opt out"
            );
        }
        return 125;
    }
    #[cfg(target_os = "linux")]
    let startup = if spec.is_some() {
        Ok((None, None))
    } else {
        crate::job_control::startup()
    };
    #[cfg(not(target_os = "linux"))]
    let startup = crate::job_control::startup();
    let (mut startup_owner, startup_child) = match startup {
        Ok(pair) => pair,
        Err(error) => {
            eprintln!("pi-env supervise: {error}");
            return 125;
        }
    };
    #[cfg(target_os = "freebsd")]
    let (mut exit_wake, exit_lease) = if crate::job_control::enabled() {
        match exit_wake::ExitWake::pair() {
            Ok((wake, lease)) => (Some(wake), Some(lease)),
            Err(error) => {
                eprintln!("pi-env supervise: {error}");
                return 125;
            }
        }
    } else {
        (None, None)
    };
    let parent = std::process::id() as libc::pid_t;
    // SAFETY: this standalone mode has one thread. Neither branch shares running locks.
    let guardian = fork_guardian();
    if guardian < 0 {
        eprintln!("pi-env supervise: {}", io::Error::last_os_error());
        return 125;
    }
    if guardian == 0 {
        if let Err(error) = job_mask.activate(true) {
            eprintln!("pi-env supervise: {error}");
            return 125;
        }
        #[cfg(target_os = "freebsd")]
        drop(exit_wake);
        drop(startup_owner);
        std::process::exit(self::guardian(
            command_args,
            parent,
            &mut control,
            ipc,
            startup_child,
            #[cfg(target_os = "freebsd")]
            exit_lease,
            #[cfg(target_os = "linux")]
            spec,
        ));
    }
    #[cfg(target_os = "freebsd")]
    {
        drop(exit_lease);
        if let Some(wake) = &mut exit_wake
            && let Err(error) = wake.arm()
        {
            eprintln!("pi-env supervise: {error}");
            return 125;
        }
    }
    if let Err(error) = job_mask.activate(false) {
        eprintln!("pi-env supervise: {error}");
        return 125;
    }
    drop(startup_child);
    if let Some(owner) = &mut startup_owner
        && let Err(error) = owner.activate()
    {
        eprintln!("pi-env supervise: {error}");
        return 125;
    }
    // Only guardian consumes control; outer also peeks for cancellation to wake a stopped guardian.
    // Retaining IPC would hide the child's disconnect.
    drop(ipc);
    let mut deadline = None;
    let mut cancelling = false;
    let result = loop {
        #[cfg(target_os = "freebsd")]
        if let Some(wake) = &mut exit_wake
            && let Err(error) = wake.check()
        {
            break Err(error);
        }
        if let Some(owner) = &mut startup_owner
            && let Err(error) = owner.poll()
        {
            break Err(error);
        }
        let mut status = 0;
        // SAFETY: guardian is our unreaped child; status is a valid output word.
        let got = unsafe { libc::waitpid(guardian, &mut status, libc::WNOHANG | WAIT_ALL) };
        if got == guardian {
            use std::os::unix::process::ExitStatusExt;
            break Ok(crate::sys::exit_code(ExitStatus::from_raw(status)) as i32);
        }
        if got < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                break Err(error);
            }
        }
        if !cancelling
            && (unsafe { libc::getppid() } != caller
                || control
                    .as_ref()
                    .is_some_and(|control| !matches!(control.cancelled(), Ok(false))))
        {
            // Held unreaped direct child only; no ancestor or cached process-group signal.
            if let Err(error) =
                send(guardian, libc::SIGTERM).and_then(|()| send(guardian, libc::SIGCONT))
            {
                break Err(error);
            }
            deadline = Some(Instant::now() + Duration::from_secs(12));
            cancelling = true;
        }
        // Guardian has five seconds for command shutdown and five for owned cleanup.
        if let Err(error) = pending(guardian, &mut deadline, Duration::from_secs(12), || Ok(())) {
            break Err(error);
        }
        thread::sleep(Duration::from_millis(10));
    };
    let clean = cleanup();
    #[cfg(target_os = "freebsd")]
    let clean = if let Some(wake) = &mut exit_wake {
        wake.finish().and(clean)
    } else {
        clean
    };
    finish(result, clean, control.as_mut())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{AsRawFd, IntoRawFd};

    #[test]
    fn non_session_hup_does_not_invoke_cohort_teardown() {
        const FIXTURE: &str = "PI_TEST_NON_SESSION_HUP";
        if std::env::var_os(FIXTURE).is_none() {
            let status = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "supervise::tests::non_session_hup_does_not_invoke_cohort_teardown",
                ])
                .env(FIXTURE, "1")
                .env_remove("PI_PROCESS_OWNER_PENDING")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        // Isolate SIGNALS from parallel unit tests. A real HUP-only child preserves its status.
        assert!(!crate::job_control::enabled());
        let mut child = Command::new("/bin/sh")
            .args(["-c", "trap 'sleep 0.1; printf hup; exit 23' HUP; printf ready; while :; do sleep 0.02; done"])
            .stdin(Stdio::null()).stdout(Stdio::piped()).spawn().unwrap();
        let mut output = child.stdout.take().unwrap();
        let mut ready = [0; 5];
        output.read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"ready");
        SIGNALS.store(1 << libc::SIGHUP, Ordering::Relaxed);
        let mut cohort_called = false;
        pending(child.id() as i32, &mut None, Duration::from_secs(5), || {
            cohort_called = true;
            Ok(())
        })
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                panic!("HUP handler did not exit");
            }
            thread::sleep(Duration::from_millis(10));
        };
        let mut completed = String::new();
        output.read_to_string(&mut completed).unwrap();
        assert_eq!(completed, "hup");
        assert_eq!(status.code(), Some(23));
        assert!(
            !cohort_called,
            "non-session HUP invoked session cohort teardown"
        );
    }

    #[test]
    fn outer_cancel_peek_does_not_consume_guardian_kill_record() {
        let (stream, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let fd = control_fd(stream.into_raw_fd()).unwrap();
        let mut control = Control::open(fd).unwrap();
        peer.write_all(b"K").unwrap();
        assert!(control.cancelled().unwrap());
        assert!(control.cancelled().unwrap());
        assert_eq!(control.peek().unwrap(), Some(b'K'));
    }

    #[test]
    fn completion_record_depends_on_cleanup_not_primary_status() {
        for code in [0, 7, 125, 137] {
            for cleaned in [false, true] {
                let (stream, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
                let fd = control_fd(stream.into_raw_fd()).unwrap();
                let mut control = Control::open(fd).unwrap();
                // Injected cleanup results test record selection, not kernel containment.
                let clean = if cleaned {
                    Ok(())
                } else {
                    Err(io::Error::other("synthetic cleanup failure"))
                };
                assert_eq!(
                    finish(Ok(code), clean, Some(&mut control)),
                    if cleaned { code } else { 125 }
                );
                drop(control);
                let mut report = Vec::new();
                peer.read_to_end(&mut report).unwrap();
                assert_eq!(report, if cleaned { b"C\n".as_slice() } else { b"" });
            }
        }
    }

    #[test]
    fn command_failure_can_acknowledge_successful_cleanup() {
        let (stream, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let fd = control_fd(stream.into_raw_fd()).unwrap();
        let mut control = Control::open(fd).unwrap();
        assert_eq!(
            finish(
                Err(io::Error::other("synthetic command failure")),
                Ok(()),
                Some(&mut control)
            ),
            125
        );
        drop(control);
        let mut report = Vec::new();
        peer.read_to_end(&mut report).unwrap();
        assert_eq!(report, b"C\n");
    }

    #[test]
    fn disconnected_completion_preserves_primary_status() {
        let (stream, peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let fd = control_fd(stream.into_raw_fd()).unwrap();
        let mut control = Control::open(fd).unwrap();
        drop(peer);
        assert_eq!(finish(Ok(137), Ok(()), Some(&mut control)), 137);
        assert_eq!(finish(Ok(125), Ok(()), None), 125);
    }

    #[test]
    fn spawn_error_is_quiet_only_after_successful_report() {
        let args = [OsString::from("/dev/null/pi-supervise-missing")];
        let (stream, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let fd = control_fd(stream.into_raw_fd()).unwrap();
        let mut control = Some(Control::open(fd).unwrap());
        assert_eq!(command(&args, &mut control, None, None).unwrap(), 125);
        let mut report = [0; 256];
        let count = peer.read(&mut report).unwrap();
        assert_eq!(
            &report[..count],
            spawn_error(&io::Error::from_raw_os_error(libc::ENOTDIR))
        );

        // Keep a duplicate alive: a concurrent fork may retain the
        // peer until exec, so dropping the parent copy is not enough.
        let _inherited_peer = peer.try_clone().unwrap();
        peer.shutdown(std::net::Shutdown::Both).unwrap();
        drop(peer);
        assert_eq!(
            command(&args, &mut control, None, None)
                .unwrap_err()
                .raw_os_error(),
            Some(libc::ENOTDIR)
        );
        assert_eq!(
            command(&args, &mut None, None, None)
                .unwrap_err()
                .raw_os_error(),
            Some(libc::ENOTDIR)
        );
    }

    #[test]
    fn spawn_observation_does_not_attest_exec() {
        use std::os::unix::process::CommandExt;
        let (stream, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let fd = control_fd(stream.into_raw_fd()).unwrap();
        let mut control = Some(Control::open(fd).unwrap());
        let mut command = Command::new("/dev/null/cannot-exec");
        // Real kernel death in std's callback, before its execvp. No user code.
        unsafe {
            command.pre_exec(|| {
                libc::raise(libc::SIGKILL);
                Ok(())
            });
        }
        assert_eq!(
            observe(command, &mut control, None, true, false).unwrap(),
            137
        );
        drop(control);
        let mut report = String::new();
        peer.read_to_string(&mut report).unwrap();
        let lines: Vec<_> = report.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("S{\"pid\":"));
        let status: serde_json::Value = serde_json::from_str(&lines[1][1..]).unwrap();
        assert_eq!(status, serde_json::json!({"code": null, "signal": 9}));
    }

    #[test]
    fn control_descriptor_stays_cloexec() {
        let (stream, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let descriptor = stream.into_raw_fd();
        control_fd(descriptor).unwrap();
        let control = Control::open(descriptor).unwrap();
        // SAFETY: the Control owns this live descriptor.
        let flags = unsafe { libc::fcntl(control.file.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0);
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
    }
}
