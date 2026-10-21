//! Session job control. The guardian stays runnable; only the shell-facing outer stops.

use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};

static SESSION: AtomicBool = AtomicBool::new(false);
static PAUSE: AtomicBool = AtomicBool::new(false);

/// Keep job signals blocked across fork until each process installs its role's dispositions.
pub(super) struct SignalMask {
    previous: Option<libc::sigset_t>,
}
impl SignalMask {
    pub(super) fn activate(mut self, guardian: bool) -> io::Result<()> {
        if self.previous.is_some() && !guardian {
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = libc::SIG_DFL;
            unsafe {
                libc::sigemptyset(&mut action.sa_mask);
            }
            for signal in signals() {
                if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
        }
        self.restore()
    }
    fn restore(&mut self) -> io::Result<()> {
        if let Some(previous) = &self.previous {
            let mut unblock: libc::sigset_t = unsafe { std::mem::zeroed() };
            unsafe {
                libc::sigemptyset(&mut unblock);
            }
            for signal in signals() {
                if unsafe { libc::sigismember(previous, signal) } == 0 {
                    unsafe {
                        libc::sigaddset(&mut unblock, signal);
                    }
                }
            }
            if unsafe { libc::sigprocmask(libc::SIG_UNBLOCK, &unblock, std::ptr::null_mut()) } != 0
            {
                return Err(io::Error::last_os_error());
            }
            self.previous = None;
        }
        Ok(())
    }
}
impl Drop for SignalMask {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

pub(super) fn initialize() -> io::Result<SignalMask> {
    SESSION.store(
        std::env::var_os("PI_PROCESS_OWNER_PENDING").is_some(),
        Ordering::Relaxed,
    );
    block()
}

fn block() -> io::Result<SignalMask> {
    let mut mask = SignalMask { previous: None };
    if enabled() {
        let mut block: libc::sigset_t = unsafe { std::mem::zeroed() };
        let mut previous: libc::sigset_t = unsafe { std::mem::zeroed() };
        unsafe {
            libc::sigemptyset(&mut block);
        }
        for signal in [libc::SIGTSTP, libc::SIGCONT] {
            unsafe {
                libc::sigaddset(&mut block, signal);
            }
        }
        if unsafe { libc::sigprocmask(libc::SIG_BLOCK, &block, &mut previous) } != 0 {
            return Err(io::Error::last_os_error());
        }
        mask.previous = Some(previous);
    }
    Ok(mask)
}

pub(super) fn enabled() -> bool {
    SESSION.load(Ordering::Relaxed)
}

pub(super) fn signals() -> impl Iterator<Item = i32> {
    [libc::SIGTSTP, libc::SIGCONT]
        .into_iter()
        .filter(|_| enabled())
}

/// Guardian only: record requests without generating a new stop signal.
/// Outer uses kernel-default TSTP so a later CONT cancels an earlier stop.
pub(super) fn receive(signal: i32) -> bool {
    if !enabled() {
        return false;
    }
    if matches!(signal, libc::SIGTERM | libc::SIGHUP) {
        PAUSE.store(false, Ordering::SeqCst);
        return false;
    }
    match signal {
        libc::SIGTSTP => PAUSE.store(true, Ordering::SeqCst),
        libc::SIGCONT => PAUSE.store(false, Ordering::SeqCst),
        _ => return false,
    }
    true
}

/// Two barriers: outer activation before primary fork, then exec permission after child exists.
/// A pre-child TSTP parks outer before permission; a later TSTP reaches the child itself.
pub(super) struct OuterStartup {
    stream: UnixStream,
    #[cfg(target_os = "macos")]
    record: [u8; 25],
    #[cfg(target_os = "macos")]
    length: usize,
}
pub(super) struct Startup(UnixStream, Option<i32>);
pub(super) fn startup() -> io::Result<(Option<OuterStartup>, Option<Startup>)> {
    if !enabled() {
        return Ok((None, None));
    }
    let (outer, guardian) = UnixStream::pair()?;
    outer.set_nonblocking(true)?;
    Ok((
        Some(OuterStartup {
            stream: outer,
            #[cfg(target_os = "macos")]
            record: [0; 25],
            #[cfg(target_os = "macos")]
            length: 0,
        }),
        Some(Startup(guardian, None)),
    ))
}
impl OuterStartup {
    pub(super) fn activate(&mut self) -> io::Result<()> {
        self.stream.write_all(b"A")
    }
    pub(super) fn poll(
        &mut self,
        #[cfg(target_os = "macos")] mut publish: impl FnMut([u8; 24]) -> io::Result<()>,
    ) -> io::Result<()> {
        #[cfg(target_os = "macos")]
        {
            while self.length < self.record.len() {
                match self.stream.read(&mut self.record[self.length..]) {
                    Ok(0) if self.length == 0 => return Ok(()),
                    Ok(0) => return Err(io::Error::other("incomplete session identity")),
                    Ok(n) => self.length += n,
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                        ) =>
                    {
                        return Ok(());
                    }
                    Err(error) => return Err(error),
                }
            }
            if self.record[0] != b'R' {
                return Err(io::Error::other("invalid session identity"));
            }
            publish(self.record[1..].try_into().unwrap())?;
            self.stream.write_all(b"G")?;
            self.length = 0;
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let mut byte = [0];
            match self.stream.read(&mut byte) {
                Ok(0) => Ok(()),
                Ok(_) if byte == *b"R" => self.stream.write_all(b"G"),
                Ok(_) => Err(io::Error::other("invalid session startup request")),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    Ok(())
                }
                Err(error) => Err(error),
            }
        }
    }
}
impl Startup {
    #[cfg(any(target_os = "freebsd", target_os = "macos"))]
    pub(super) fn guardian_lifetime(&mut self, fd: i32) {
        self.1 = Some(fd);
    }
    pub(super) fn wait_active(
        &mut self,
        mut cancelled: impl FnMut() -> io::Result<()>,
    ) -> io::Result<()> {
        loop {
            cancelled()?;
            let mut byte = [0u8];
            let got = unsafe {
                libc::recv(
                    self.0.as_raw_fd(),
                    byte.as_mut_ptr().cast(),
                    1,
                    libc::MSG_DONTWAIT,
                )
            };
            if got == 1 && byte == *b"A" {
                return Ok(());
            }
            if got >= 0 {
                return Err(io::Error::other("session owner lost before startup"));
            }
            let error = io::Error::last_os_error();
            if !matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) {
                return Err(error);
            }
            let mut fd = libc::pollfd {
                fd: self.0.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // Bounded event wait keeps cancellation/owner-death processing live without a payload.
            if unsafe { libc::poll(&mut fd, 1, 10) } < 0
                && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
            {
                return Err(io::Error::last_os_error());
            }
        }
    }
}

pub(super) fn wake_on_parent_death(parent: i32) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGCONT, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    #[cfg(target_os = "freebsd")]
    {
        let mut signal = libc::SIGCONT;
        if unsafe {
            libc::procctl(
                libc::P_PID,
                libc::getpid() as libc::id_t,
                libc::PROC_PDEATHSIG_CTL,
                (&mut signal as *mut i32).cast(),
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    // Fork clears the setting; normal non-privileged exec retains it on Linux/FreeBSD.
    // Check after arming: a parent already dead would not produce a death signal.
    if unsafe { libc::getppid() } != parent {
        return Err(io::Error::from_raw_os_error(libc::ECANCELED));
    }
    Ok(())
}

/// Session-only asynchronous exec handshake; non-session launch stays std::Command::spawn.
/// Supervise mode is single-threaded: build Command before fork; child only sets dispositions,
/// exchanges fixed gate bytes, and calls CommandExt::exec (no extra process/helper generation).
pub(super) enum Primary {
    Standard(std::process::Child),
    Session {
        pid: i32,
        error: UnixStream,
        bytes: [u8; 4],
        length: usize,
        started: bool,
        status: Option<ExitStatus>,
    },
}
impl Primary {
    pub(super) fn spawn(mut command: Command, gate: Option<Startup>) -> io::Result<Self> {
        let Some(mut gate) = gate else {
            return command.spawn().map(Self::Standard);
        };
        let (read, mut write) = UnixStream::pair()?;
        read.set_nonblocking(true)?;
        let parent = unsafe { libc::getpid() };
        let mask = block()?;
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return Err(io::Error::last_os_error());
        }
        if pid == 0 {
            drop(read);
            if let Some(fd) = gate.1 {
                unsafe {
                    libc::close(fd);
                }
            }
            let result: io::Result<()> = (|| {
                let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
                action.sa_sigaction = libc::SIG_DFL;
                unsafe {
                    libc::sigemptyset(&mut action.sa_mask);
                }
                for signal in [libc::SIGHUP, libc::SIGINT, libc::SIGQUIT, libc::SIGTERM] {
                    if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                wake_on_parent_death(parent)?;
                #[cfg(not(target_os = "macos"))]
                gate.0.write_all(b"R")?;
                #[cfg(target_os = "macos")]
                {
                    let identity = crate::supervise::startup_identity()?;
                    let mut record = [0; 25];
                    record[0] = b'R';
                    record[1..].copy_from_slice(&identity);
                    gate.0.write_all(&record)?;
                }
                let mut byte = [0];
                gate.0.read_exact(&mut byte)?;
                if byte != *b"G" || unsafe { libc::getppid() } != parent {
                    return Err(io::Error::from_raw_os_error(libc::ECANCELED));
                }
                loop {
                    let alive = unsafe {
                        libc::recv(
                            gate.0.as_raw_fd(),
                            byte.as_mut_ptr().cast(),
                            1,
                            libc::MSG_PEEK | libc::MSG_DONTWAIT,
                        )
                    };
                    if alive == 0 {
                        return Err(io::Error::from_raw_os_error(libc::ECANCELED));
                    }
                    if alive > 0 {
                        return Err(io::Error::other("invalid session startup permission"));
                    }
                    let error = io::Error::last_os_error();
                    match error.kind() {
                        io::ErrorKind::WouldBlock => break,
                        io::ErrorKind::Interrupted => continue,
                        _ => return Err(error),
                    }
                }
                drop(gate);
                mask.activate(false)?;
                if unsafe { libc::getppid() } != parent {
                    return Err(io::Error::from_raw_os_error(libc::ECANCELED));
                }
                Err(command.exec())
            })();
            let error: io::Error = result.unwrap_err();
            let bytes = error
                .raw_os_error()
                .unwrap_or(libc::ECANCELED)
                .to_ne_bytes();
            // Fixed error record only; parent formats existing spawn error/status protocol.
            let _ = write.write_all(&bytes);
            unsafe {
                libc::_exit(127);
            }
        }
        drop(write);
        drop(gate);
        mask.activate(true)?;
        Ok(Self::Session {
            pid,
            error: read,
            bytes: [0; 4],
            length: 0,
            started: false,
            status: None,
        })
    }
    pub(super) fn id(&self) -> u32 {
        match self {
            Self::Standard(child) => child.id(),
            Self::Session { pid, .. } => *pid as u32,
        }
    }
    pub(super) fn poll_exec(&mut self) -> io::Result<bool> {
        let Self::Session {
            error,
            bytes,
            length,
            started,
            ..
        } = self
        else {
            return Ok(true);
        };
        if *started {
            return Ok(true);
        }
        loop {
            match error.read(&mut bytes[*length..]) {
                Ok(0) if *length == 0 => {
                    *started = true;
                    return Ok(true);
                }
                Ok(0) => return Err(io::Error::other("incomplete session exec error")),
                Ok(n) => {
                    *length += n;
                    if *length == bytes.len() {
                        return Err(io::Error::from_raw_os_error(i32::from_ne_bytes(*bytes)));
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
    }
    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match self {
            Self::Standard(child) => child.try_wait(),
            Self::Session { pid, status, .. } => {
                if status.is_some() {
                    return Ok(*status);
                }
                let mut raw = 0;
                let got = unsafe { libc::waitpid(*pid, &mut raw, libc::WNOHANG) };
                if got == *pid {
                    *status = Some(ExitStatus::from_raw(raw));
                } else if got < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(*status)
            }
        }
    }
}

#[derive(Default)]
pub(super) struct State {
    paused: bool,
    disabled: bool,
    warned: bool,
}
impl State {
    /// Reconcile again after each operation: CONT arriving during STOP must win.
    fn settle(
        &mut self,
        wanted: &AtomicBool,
        mut apply: impl FnMut(bool) -> io::Result<()>,
    ) -> io::Result<()> {
        loop {
            let target = wanted.load(Ordering::SeqCst);
            if self.paused == target {
                return Ok(());
            }
            apply(target)?;
            self.paused = target;
        }
    }
    pub(super) fn update(&mut self, apply: impl FnMut(bool) -> io::Result<()>) -> io::Result<()> {
        if !enabled() {
            return Ok(());
        }
        self.update_requested(&PAUSE, apply)
    }
    fn update_requested(
        &mut self,
        wanted: &AtomicBool,
        mut apply: impl FnMut(bool) -> io::Result<()>,
    ) -> io::Result<()> {
        if !wanted.load(Ordering::SeqCst) {
            self.disabled = false;
        }
        if self.disabled {
            return Ok(());
        }
        if let Err(error) = self.settle(wanted, &mut apply) {
            // A failed freeze may have stopped some processes. Always undo it first.
            apply(false)?;
            self.paused = false;
            self.disabled = true;
            if !self.warned {
                eprintln!(
                    "pi-env: owned tool processes keep running while suspended (freezing unavailable: {error})"
                );
                self.warned = true;
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    #[derive(Clone, Copy, PartialEq, Eq, Hash)]
    struct Identity {
        pid: i32,
        start: u64,
    }
    struct Record {
        identity: Identity,
        parent: i32,
        group: i32,
    }
    fn record(pid: i32) -> io::Result<Record> {
        let text = fs::read_to_string(format!("/proc/{pid}/stat"))?;
        let (_, fields) = text
            .rsplit_once(") ")
            .ok_or_else(|| io::Error::other("invalid proc stat"))?;
        let fields: Vec<_> = fields.split_whitespace().collect();
        let invalid = || io::Error::other("invalid proc stat fields");
        Ok(Record {
            identity: Identity {
                pid,
                start: fields
                    .get(19)
                    .ok_or_else(invalid)?
                    .parse()
                    .map_err(|_| invalid())?,
            },
            parent: fields
                .get(1)
                .ok_or_else(invalid)?
                .parse()
                .map_err(|_| invalid())?,
            group: fields
                .get(2)
                .ok_or_else(invalid)?
                .parse()
                .map_err(|_| invalid())?,
        })
    }
    fn gone(error: &io::Error) -> bool {
        matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH))
    }
    fn open(pid: i32) -> io::Result<OwnedFd> {
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
    fn signal(fd: &OwnedFd, signal: i32) -> io::Result<()> {
        if unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        } < 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
    fn owned(mut pid: i32, root: i32) -> io::Result<bool> {
        let mut visited = HashSet::new();
        while pid != root && pid > 1 && visited.insert(pid) {
            match record(pid) {
                Ok(p) => pid = p.parent,
                Err(e) if gone(&e) => return Ok(false),
                Err(e) => return Err(e),
            }
        }
        Ok(pid == root)
    }
    fn stopped(pid: i32) -> io::Result<bool> {
        for task in fs::read_dir(format!("/proc/{pid}/task"))? {
            let text = match fs::read_to_string(task?.path().join("stat")) {
                Ok(text) => text,
                Err(e) if gone(&e) => continue,
                Err(e) => return Err(e),
            };
            let (_, fields) = text
                .rsplit_once(") ")
                .ok_or_else(|| io::Error::other("invalid task stat"))?;
            if !matches!(fields.as_bytes().first(), Some(b'T' | b't' | b'Z')) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn children(pid: i32) -> io::Result<Vec<i32>> {
        let mut result = Vec::new();
        for task in fs::read_dir(format!("/proc/{pid}/task"))? {
            let task = task?;
            match fs::read_to_string(task.path().join("children")) {
                Ok(text) => {
                    for child in text.split_whitespace() {
                        result.push(
                            child
                                .parse()
                                .map_err(|_| io::Error::other("invalid child PID"))?,
                        );
                    }
                }
                Err(e) if gone(&e) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(result)
    }
    #[derive(Default)]
    pub(crate) struct Targets {
        stopped: Vec<(Identity, OwnedFd)>,
    }
    impl Targets {
        pub(crate) fn apply(&mut self, paused: bool) -> io::Result<()> {
            if !paused {
                return self.resume();
            }
            let root = unsafe { libc::getpid() };
            let group = unsafe { libc::getpgrp() };
            // Probe both syscalls before stopping anything (older kernels / seccomp).
            signal(&open(root)?, 0)?;
            let mut visited = HashSet::new();
            let mut queue: Vec<(i32, Option<Identity>)> = vec![(root, None)];
            while let Some((pid, parent)) = queue.pop() {
                if !PAUSE.load(Ordering::SeqCst) {
                    break;
                }
                if !visited.insert(pid) {
                    continue;
                }
                let p = match record(pid) {
                    Ok(p) => p,
                    Err(e) if gone(&e) => continue,
                    Err(e) => return Err(e),
                };
                if let Some(parent) = parent {
                    let held = match record(parent.pid) {
                        Ok(held) => held.identity == parent,
                        Err(e) if gone(&e) => false,
                        Err(e) => return Err(e),
                    };
                    if !held || p.parent != parent.pid {
                        continue;
                    }
                }
                if pid != root && p.group != group {
                    let fd = match open(pid) {
                        Ok(fd) => fd,
                        Err(e) if gone(&e) => continue,
                        Err(e) => return Err(e),
                    };
                    // Opening a pidfd alone does not prove ancestry or snapshot identity.
                    let current = match record(pid) {
                        Ok(p) => p,
                        Err(e) if gone(&e) => continue,
                        Err(e) => return Err(e),
                    };
                    if current.identity != p.identity
                        || current.parent != p.parent
                        || !owned(pid, root)?
                    {
                        continue;
                    }
                    signal(&fd, libc::SIGSTOP)?;
                    self.stopped.push((p.identity, fd));
                }
                if pid != root {
                    // Stop parents before enumerating their children. This also waits for Pi's
                    // foreground-group TSTP, so it cannot fork a new task after we scan it.
                    let deadline =
                        std::time::Instant::now() + std::time::Duration::from_millis(250);
                    while PAUSE.load(Ordering::SeqCst) {
                        match stopped(pid) {
                            Ok(true) => break,
                            Err(e) if gone(&e) => break,
                            Err(e) => return Err(e),
                            _ => {}
                        }
                        if std::time::Instant::now() >= deadline {
                            return Err(io::Error::other("descendant did not stop"));
                        }
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                }
                match children(pid) {
                    Ok(pids) => {
                        queue.extend(pids.into_iter().map(|child| (child, Some(p.identity))))
                    }
                    Err(e) if gone(&e) => {}
                    Err(e) => return Err(e),
                }
            }
            Ok(())
        }
        fn resume(&mut self) -> io::Result<()> {
            for (_, fd) in &self.stopped {
                signal(fd, libc::SIGCONT)?;
            }
            self.stopped.clear();
            Ok(())
        }
    }
    impl Drop for Targets {
        fn drop(&mut self) {
            if let Err(error) = self.resume() {
                eprintln!("pi-env: failed to resume owned processes: {error}");
            }
        }
    }
}

#[cfg(target_os = "freebsd")]
mod platform {
    use super::*;
    #[derive(Default)]
    pub(crate) struct Targets {}
    impl Targets {
        pub(crate) fn apply(&mut self, paused: bool) -> io::Result<()> {
            #[repr(C)]
            struct ReaperKill {
                signal: i32,
                flags: u32,
                subtree: i32,
                killed: u32,
                failed_pid: i32,
                reserved: [u32; 15],
            }
            let mut request = ReaperKill {
                signal: if paused { libc::SIGSTOP } else { libc::SIGCONT },
                flags: 0,
                subtree: 0,
                killed: 0,
                failed_pid: 0,
                reserved: [0; 15],
            };
            // flags=0 includes nested reapers, excluding this reaper itself:
            // freebsd-src/sys/kern/kern_procctl.c, reap_kill_subtree_once().
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
    }
    impl Drop for Targets {
        fn drop(&mut self) {
            let _ = self.apply(false);
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "freebsd"))]
pub(super) use platform::Targets;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    #[test]
    fn unavailable_freeze_rolls_back_partial_work_once_per_pause() {
        let wanted = AtomicBool::new(true);
        let mut state = State::default();
        let mut operations = Vec::new();
        state
            .update_requested(&wanted, |paused| {
                operations.push(paused);
                if paused {
                    Err(io::Error::from_raw_os_error(libc::ENOSYS))
                } else {
                    Ok(())
                }
            })
            .unwrap();
        assert_eq!(operations, [true, false]);
        assert!(!state.paused);
        assert!(state.disabled && state.warned);
        state
            .update_requested(&wanted, |_| {
                panic!("must not retry an unsupported freeze in this pause")
            })
            .unwrap();
        wanted.store(false, Ordering::SeqCst);
        state.update_requested(&wanted, |_| Ok(())).unwrap();
        assert!(!state.disabled);
    }

    #[test]
    fn resume_received_mid_freeze_settles_to_running() {
        let wanted = Arc::new(AtomicBool::new(true));
        let barrier = Arc::new(Barrier::new(2));
        let resume = Arc::clone(&wanted);
        let other = Arc::clone(&barrier);
        let sender = std::thread::spawn(move || {
            other.wait(); // STOP pass is in progress.
            resume.store(false, Ordering::SeqCst); // SIGCONT handler's state update.
            other.wait();
        });
        let mut state = State::default();
        let mut operations = Vec::new();
        state
            .settle(&wanted, |paused| {
                operations.push(paused);
                if paused {
                    barrier.wait();
                    barrier.wait();
                }
                Ok(())
            })
            .unwrap();
        sender.join().unwrap();
        assert_eq!(operations, [true, false]);
        assert!(!state.paused);
    }
}
