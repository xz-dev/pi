//! Session job control. The guardian stays runnable; only the shell-facing outer stops.

use std::io;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

static OUTER: AtomicI32 = AtomicI32::new(0);
static PAUSE: AtomicBool = AtomicBool::new(false);

pub(super) fn initialize() {
    if std::env::var_os("PI_PROCESS_OWNER_PENDING").is_some() {
        OUTER.store(unsafe { libc::getpid() }, Ordering::Relaxed);
    }
}

pub(super) fn enabled() -> bool {
    OUTER.load(Ordering::Relaxed) != 0
}

pub(super) fn signals() -> impl Iterator<Item = i32> {
    [libc::SIGTSTP, libc::SIGCONT]
        .into_iter()
        .filter(|_| enabled())
}

/// Called from sigaction: atomics and async-signal-safe libc calls only.
/// OUTER is set before fork, so even a signal immediately after fork cannot stop the guardian.
pub(super) fn receive(signal: i32) -> bool {
    if !enabled() {
        return false;
    }
    if matches!(signal, libc::SIGTERM | libc::SIGHUP) {
        PAUSE.store(false, Ordering::SeqCst);
        return false;
    }
    match signal {
        libc::SIGTSTP => {
            PAUSE.store(true, Ordering::SeqCst);
            if unsafe { libc::getpid() } == OUTER.load(Ordering::Relaxed) {
                unsafe {
                    libc::raise(libc::SIGSTOP);
                }
            }
        }
        libc::SIGCONT => PAUSE.store(false, Ordering::SeqCst),
        _ => return false,
    }
    true
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
    pub(super) fn update(
        &mut self,
        mut apply: impl FnMut(bool) -> io::Result<()>,
    ) -> io::Result<()> {
        if !enabled() {
            return Ok(());
        }
        if !PAUSE.load(Ordering::SeqCst) {
            self.disabled = false;
        }
        if self.disabled {
            return Ok(());
        }
        if let Err(error) = self.settle(&PAUSE, &mut apply) {
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
        state: u8,
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
            state: *fields
                .first()
                .and_then(|s| s.as_bytes().first())
                .ok_or_else(invalid)?,
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
            let mut queue = vec![root];
            while let Some(pid) = queue.pop() {
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
                    if current.identity != p.identity || !owned(pid, root)? {
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
                        match record(pid) {
                            Ok(p) if matches!(p.state, b'T' | b't' | b'Z') => break,
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
                    Ok(pids) => queue.extend(pids),
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
    pub(crate) struct Targets;
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
