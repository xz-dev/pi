// SPDX-License-Identifier: BSD-3-Clause
use crate::{
    config::Config,
    inventory::Inventory,
    policy::{Policy, RECORD_LEN},
};
use rustix::{
    fd::{AsRawFd, FromRawFd, OwnedFd},
    io::{self as rio, Errno, FdFlags},
    process::{self, Pid, Signal},
};
use signal_hook::{
    consts::{SIGCHLD, SIGHUP, SIGINT, SIGTERM},
    iterator::Signals,
};
use std::{
    ffi::{OsStr, OsString},
    io,
    os::unix::process::{CommandExt, ExitStatusExt},
    process::Command,
    thread,
    time::Duration,
};

pub(crate) fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    #[cfg(not(target_os = "macos"))]
    return Ok(rustix::pipe::pipe_with(
        rustix::pipe::PipeFlags::CLOEXEC | rustix::pipe::PipeFlags::NONBLOCK,
    )?);
    #[cfg(target_os = "macos")]
    {
        let pair = rustix::pipe::pipe()?;
        for fd in [&pair.0, &pair.1] {
            rio::fcntl_setfd(fd, FdFlags::CLOEXEC)?;
            rustix::fs::fcntl_setfl(fd, rustix::fs::OFlags::NONBLOCK)?;
        }
        Ok(pair)
    }
}

const NOTICE_RECORD_LEN: usize = if crate::terminal::SNAPSHOT_RECORD_LEN > RECORD_LEN {
    crate::terminal::SNAPSHOT_RECORD_LEN
} else {
    RECORD_LEN
};

struct PolicyReader {
    bytes: [u8; NOTICE_RECORD_LEN],
    filled: usize,
    terminal: Option<rustix::termios::Termios>,
    policy: Option<Policy>,
    progress: std::collections::HashSet<crate::policy::SignalIdentity>,
    pause: bool,
    resumed: bool,
    result: Option<u8>,
    result_pending: bool,
}
impl PolicyReader {
    fn new() -> Self {
        Self {
            bytes: [0; NOTICE_RECORD_LEN],
            filled: 0,
            terminal: None,
            policy: None,
            progress: std::collections::HashSet::new(),
            pause: false,
            resumed: false,
            result: None,
            result_pending: false,
        }
    }
    fn refresh(&mut self, fd: &OwnedFd, config: Config) -> io::Result<()> {
        loop {
            if self.result_pending {
                let mut byte = [0];
                match rio::read(fd, &mut byte) {
                    Ok(0) => return Err(io::Error::other("truncated native primary result")),
                    Err(Errno::AGAIN) => return Ok(()),
                    Err(Errno::INTR) => continue,
                    Err(error) => return Err(error.into()),
                    Ok(_) => {
                        self.result = Some(byte[0]);
                        self.result_pending = false;
                    }
                }
            }
            if self.filled == 0 {
                let mut byte = [0];
                match rio::read(fd, &mut byte) {
                    Ok(0) | Err(Errno::AGAIN) => return Ok(()),
                    Err(Errno::INTR) => continue,
                    Err(error) => return Err(error.into()),
                    Ok(_) if byte[0] == b'S' => {
                        self.pause = true;
                        continue;
                    }
                    Ok(_) if byte[0] == b'R' => {
                        self.pause = false;
                        self.resumed = true;
                        continue;
                    }
                    Ok(_) if byte[0] == b'D' => {
                        self.terminal = None;
                        continue;
                    }
                    Ok(_) if byte[0] == b'X' => {
                        if self.result.is_some() {
                            return Err(io::Error::other("duplicate native primary result"));
                        }
                        self.result_pending = true;
                        continue;
                    }
                    Ok(_) => {
                        self.bytes[0] = byte[0];
                        self.filled = 1;
                    }
                }
            }
            let length = if self.bytes[0] == b'A' {
                crate::terminal::SNAPSHOT_RECORD_LEN
            } else {
                RECORD_LEN
            };
            match rio::read(fd, &mut self.bytes[self.filled..length]) {
                Ok(0) => return Err(io::Error::other("truncated native cleanup policy")),
                Err(Errno::AGAIN) => return Ok(()),
                Err(Errno::INTR) => continue,
                Err(error) => return Err(error.into()),
                Ok(count) => {
                    self.filled += count;
                    if self.filled == length {
                        if self.bytes[0] == b'A' {
                            self.terminal =
                                Some(crate::terminal::saved_from_record(&self.bytes[..length])?);
                        } else if &self.bytes[..4] == b"PWT1" {
                            self.progress.insert(crate::policy::progress_record(
                                self.bytes[..length].try_into().unwrap(),
                            )?);
                        } else if self.policy.is_some() {
                            return Err(io::Error::other("duplicate native cleanup policy"));
                        } else {
                            self.policy = Some(Policy::from_record(
                                self.bytes[..length].try_into().unwrap(),
                                config,
                            )?);
                        }
                        self.filled = 0;
                    }
                }
            }
        }
    }
}

pub fn run(
    command: &OsStr,
    args: &[OsString],
    config: Config,
    retain_descendants: bool,
    quiet: bool,
    mut task: Option<&mut crate::task::Task>,
) -> io::Result<u8> {
    #[cfg(not(target_os = "linux"))]
    let _ = quiet;
    crate::reaper::acquire()?;
    let interactive = task.is_none() && crate::terminal::interactive()?;
    let mut signals = Signals::new([
        SIGCHLD,
        SIGHUP,
        SIGINT,
        SIGTERM,
        signal_hook::consts::SIGTSTP,
        signal_hook::consts::SIGCONT,
        signal_hook::consts::SIGTTIN,
        signal_hook::consts::SIGTTOU,
    ])?;
    // Linux: a TOSTOP-denied diagnostic must fail once with EINTR, not restart in a SIGTTOU loop.
    if interactive || cfg!(target_os = "linux") {
        crate::terminal::interrupt_job_control()?;
    }
    // The workload group exists before any payload; owner and anchor stay outside it.
    #[cfg(target_os = "linux")]
    let scope = match crate::cgroup::Scope::create() {
        Ok(scope) => Some(scope),
        Err(reason) => {
            // Quiet invocations and retained tasks preserve command stderr;
            // errors still use the normal diagnostic path.
            if !retain_descendants && !quiet {
                crate::diagnostic(format!(
                    "Linux cgroup v2 workload group unavailable ({reason}); cleanup falls back to subreaper and pidfd termination"
                ));
            }
            None
        }
    };
    let (read, write) = pipe()?;
    let (notice, publish) = pipe()?;
    let expected = process::getpid();
    let raw = read.as_raw_fd();
    let policy_raw = publish.as_raw_fd();
    let mut anchor = Command::new(std::env::current_exe()?);
    anchor
        .arg("__anchor")
        .arg(expected.to_string())
        .arg(raw.to_string())
        .arg(policy_raw.to_string())
        .arg(config.grace.as_millis().to_string())
        .arg(config.fatal_grace.as_millis().to_string())
        .arg(config.deadline.as_millis().to_string())
        .arg(command)
        .args(args);
    if !interactive {
        anchor.process_group(0);
    }
    // Only async-signal-safe OS calls run between fork and trusted native exec.
    unsafe {
        anchor.pre_exec(move || {
            arm_parent(expected)?;
            for fd in [raw, policy_raw] {
                rio::fcntl_setfd(rustix::fd::BorrowedFd::borrow_raw(fd), FdFlags::empty())?;
            }
            Ok(())
        });
    }
    anchor.env(
        "PROCWARD_PRIVATE_TASK",
        if task.is_some() { "1" } else { "0" },
    );
    anchor.env(
        "PROCWARD_PRIVATE_RETAIN_DESCENDANTS",
        if retain_descendants { "1" } else { "0" },
    );
    #[cfg(target_os = "linux")]
    {
        anchor.env_remove(crate::cgroup::ENV);
        if let Some(scope) = &scope {
            scope.pass_to_anchor(&mut anchor);
        }
    }
    let mut anchor = anchor.spawn()?;
    drop(read);
    drop(publish);
    rio::write(&write, b"R")?;
    let pid = Pid::from_raw(anchor.id() as i32).unwrap();
    let mut policy = PolicyReader::new();
    let mut cancelled = false;
    let mut observed = Inventory::new();
    // Group lifetime and completion authority survive anchor loss; drop removes it.
    #[cfg(target_os = "linux")]
    if let Some(scope) = scope {
        observed.own(scope);
    }
    loop {
        policy.refresh(&notice, config)?;
        if let Some(task) = &mut task {
            if let Some(result) = policy.result {
                task.primary(u32::from(result))?;
            }
            if task.poll() && !cancelled {
                match process::kill_process(pid, Signal::TERM) {
                    Ok(()) | Err(Errno::SRCH) => {}
                    Err(error) => return Err(error.into()),
                }
                cancelled = true;
            }
        }
        if std::mem::take(&mut policy.resumed) {
            let _ = rio::write(&write, b"C");
        }
        if std::mem::take(&mut policy.pause) && policy.policy.is_none() {
            process::kill_process(process::getpid(), Signal::STOP)?;
            let _ = rio::write(&write, b"C");
        }
        #[cfg(target_os = "macos")]
        observed.refresh()?;
        if let Some(status) = anchor.try_wait()? {
            drop(write);
            // A final read cannot race a dead writer; published policy survives anchor loss.
            policy.refresh(&notice, config)?;
            if let (Some(task), Some(result)) = (&mut task, policy.result) {
                task.primary(u32::from(result))?;
            }
            observed.progress().inherit(policy.progress);
            let saved_terminal = policy.terminal;
            let policy = policy
                .policy
                .unwrap_or_else(|| Policy::new(config, status.signal().is_some()));
            let result = finish_anchor(status, &mut observed, policy);
            if status.signal().is_some() {
                if let Some(saved) = &saved_terminal {
                    crate::terminal::restore_saved(saved)?;
                }
            }
            return result;
        }
        for signal in signals.pending().filter(|signal| {
            !matches!(
                *signal,
                SIGCHLD
                    | signal_hook::consts::SIGTSTP
                    | signal_hook::consts::SIGTTIN
                    | signal_hook::consts::SIGTTOU
            )
        }) {
            if interactive && signal == signal_hook::consts::SIGCONT {
                continue;
            }
            process::kill_process(pid, Signal::from_named_raw(signal).unwrap())?;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

pub(crate) fn finish_anchor(
    status: std::process::ExitStatus,
    observed: &mut Inventory,
    policy: Policy,
) -> io::Result<u8> {
    #[cfg(target_os = "macos")]
    if status.signal().is_some() {
        crate::diagnostic("macOS best-effort observer lost; pre-observation descendants may escape after reparenting".into());
    }
    crate::reaper::cleanup(observed, None, &mut None, policy, |_| Ok(None))?;
    Ok(status.code().unwrap_or(125) as u8)
}

fn arm_parent(expected: Pid) -> io::Result<()> {
    // SIGCONT is a targeted kernel wake even if this independent role was stopped.
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    process::set_parent_process_death_signal(Some(Signal::CONT))?;
    if process::getppid() != Some(expected) {
        return Err(io::Error::other(
            "owner lost before parent-death wake was armed",
        ));
    }
    Ok(())
}

pub(crate) fn validate_endpoint(
    fd: rustix::fd::BorrowedFd<'_>,
    access: rustix::fs::OFlags,
) -> io::Result<()> {
    let flags = rustix::fs::fcntl_getfl(fd)?;
    let stat = rustix::fs::fstat(fd)?;
    let valid_access = flags & rustix::fs::OFlags::ACCMODE == access;
    // FreeBSD pipe(2) endpoints are bidirectional: https://man.freebsd.org/cgi/man.cgi?query=pipe&sektion=2
    #[cfg(target_os = "freebsd")]
    let valid_access = valid_access
        || (flags & rustix::fs::OFlags::ACCMODE == rustix::fs::OFlags::RDWR && stat.st_nlink == 0);
    if !valid_access
        || rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::Fifo
    {
        return Err(io::Error::other(format!(
            "invalid native endpoint type/access: flags={flags:?}, mode={:#o}, links={}",
            stat.st_mode, stat.st_nlink
        )));
    }
    Ok(())
}

pub(crate) fn inherited_fd(value: &OsStr, access: rustix::fs::OFlags) -> io::Result<OwnedFd> {
    let raw = value
        .to_str()
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|fd| *fd > 2)
        .ok_or_else(|| io::Error::other("invalid anchor native endpoint"))?;
    let borrowed = unsafe { rustix::fd::BorrowedFd::borrow_raw(raw) };
    rio::fcntl_setfd(borrowed, FdFlags::CLOEXEC)?;
    validate_endpoint(borrowed, access)?;
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

pub fn anchor(args: &[OsString]) -> io::Result<u8> {
    let [
        parent,
        lease,
        publish,
        grace,
        fatal,
        deadline,
        command,
        rest @ ..,
    ] = args
    else {
        return Err(io::Error::other("invalid private anchor invocation"));
    };
    let parent = parent
        .to_str()
        .and_then(|s| s.parse().ok())
        .filter(|pid: &i32| *pid > 0)
        .and_then(Pid::from_raw)
        .ok_or_else(|| io::Error::other("invalid anchor parent"))?;
    arm_parent(parent)?;
    let millis = |value: &OsString| {
        value
            .to_str()
            .and_then(|text| text.parse().ok())
            .ok_or_else(|| io::Error::other("invalid native cleanup configuration"))
    };
    let config = Config::from_millis(millis(grace)?, millis(fatal)?, millis(deadline)?)
        .map_err(io::Error::other)?;
    let retain_descendants =
        std::env::var_os("PROCWARD_PRIVATE_RETAIN_DESCENDANTS").as_deref() == Some(OsStr::new("1"));
    if lease.to_str().and_then(|text| text.parse::<i32>().ok())
        == publish.to_str().and_then(|text| text.parse::<i32>().ok())
    {
        return Err(io::Error::other("duplicate native endpoint"));
    }
    let lease = inherited_fd(lease, rustix::fs::OFlags::RDONLY)?;
    let publish = inherited_fd(publish, rustix::fs::OFlags::WRONLY)?;
    loop {
        let mut grant = [0];
        match rio::read(&lease, &mut grant) {
            Ok(1) if grant[0] == b'R' => break,
            Err(Errno::AGAIN | Errno::INTR) => thread::sleep(Duration::from_millis(1)),
            _ => return Err(io::Error::other("owner lost or invalid launch grant")),
        }
    }
    if !alive(&lease)? || process::getppid() != Some(parent) {
        return Err(io::Error::other("owner lost before payload launch"));
    }
    crate::reaper::run_owned(command, rest, &lease, &publish, config, retain_descendants)
}

pub fn publish(fd: &OwnedFd, policy: Policy) -> io::Result<()> {
    let bytes = policy.record();
    loop {
        match rio::write(fd, &bytes) {
            Ok(RECORD_LEN) => return Ok(()),
            Err(Errno::INTR) => continue,
            Ok(_) => {
                return Err(io::Error::other(
                    "incomplete native cleanup policy publication",
                ));
            }
            Err(error) => return Err(error.into()),
        }
    }
}
pub fn alive(lease: impl rustix::fd::AsFd) -> io::Result<bool> {
    Ok(lease_state(lease)?.0)
}
pub fn lease_state(lease: impl rustix::fd::AsFd) -> io::Result<(bool, bool)> {
    let mut byte = [0];
    match rio::read(lease, &mut byte) {
        Ok(0) => Ok((false, false)),
        Err(Errno::AGAIN | Errno::INTR) => Ok((true, false)),
        Ok(_) if byte[0] == b'C' => Ok((true, true)),
        Ok(_) => Err(io::Error::other("unexpected native lease data")),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) static PROCESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    #[test]
    fn native_endpoints_have_required_access_and_reject_regular_files() {
        let _guard = PROCESS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        use rustix::fd::AsFd;
        let (read, write) = pipe().unwrap();
        validate_endpoint(read.as_fd(), rustix::fs::OFlags::RDONLY).unwrap();
        validate_endpoint(write.as_fd(), rustix::fs::OFlags::WRONLY).unwrap();
        #[cfg(not(target_os = "freebsd"))]
        assert!(validate_endpoint(read.as_fd(), rustix::fs::OFlags::WRONLY).is_err());
        #[cfg(target_os = "freebsd")]
        assert_eq!(
            rustix::fs::fcntl_getfl(&read).unwrap() & rustix::fs::OFlags::ACCMODE,
            rustix::fs::OFlags::RDWR
        );
        let regular = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
        assert!(validate_endpoint(regular.as_fd(), rustix::fs::OFlags::RDONLY).is_err());
    }
    #[test]
    fn policy_transport_preserves_one_record_and_refuses_partial_or_duplicate_records() {
        let _guard = PROCESS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let config = Config::default();
        let policy = Policy::new(config, false);
        let (read, write) = pipe().unwrap();
        publish(&write, policy).unwrap();
        drop(write);
        let mut reader = PolicyReader::new();
        reader.refresh(&read, config).unwrap();
        let current = crate::policy::now();
        assert_eq!(reader.policy.unwrap().phase(current), policy.phase(current));
        let (read, write) = pipe().unwrap();
        rio::write(&write, b"PWP1").unwrap();
        drop(write);
        assert!(PolicyReader::new().refresh(&read, config).is_err());
        let (read, write) = pipe().unwrap();
        publish(&write, policy).unwrap();
        publish(&write, policy).unwrap();
        drop(write);
        assert!(PolicyReader::new().refresh(&read, config).is_err());
        let (read, write) = pipe().unwrap();
        drop(write);
        let mut reader = PolicyReader::new();
        reader.refresh(&read, config).unwrap();
        assert!(
            reader.policy.is_none(),
            "no publication means fallback must select its first policy"
        );
    }

    #[test]
    fn takeover_inherits_signal_progress_only_for_the_same_identity() {
        let _guard = PROCESS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let config = Config::default();
        let (read, write) = pipe().unwrap();
        publish(&write, Policy::new(config, false)).unwrap();
        let mut progress = crate::policy::Progress::default();
        progress.publish_to(&write).unwrap();
        let identity = [42, 100, 0, 0, 0];
        assert_eq!(
            progress
                .signals(crate::policy::Phase::Grace, identity, &mut false)
                .unwrap(),
            &[Signal::TERM, Signal::CONT]
        );
        let mut reader = PolicyReader::new();
        reader.refresh(&read, config).unwrap();
        assert!(reader.policy.is_some());
        assert_eq!(reader.progress.len(), 1);
        let mut fallback = crate::policy::Progress::default();
        fallback.inherit(reader.progress);
        assert!(
            fallback
                .signals(crate::policy::Phase::Grace, identity, &mut false)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            fallback
                .signals(crate::policy::Phase::Grace, [42, 101, 0, 0, 0], &mut false)
                .unwrap(),
            &[Signal::TERM, Signal::CONT]
        );
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn retained_darwin_inventory_cleans_after_observer_loss() {
        use std::{
            fs,
            path::PathBuf,
            process::{Child, Stdio},
            time::Instant,
        };
        struct Case {
            anchor: Child,
            observed: Inventory,
            dir: PathBuf,
        }
        impl Drop for Case {
            fn drop(&mut self) {
                let _ = self.observed.refresh();
                let rescued =
                    self.anchor.try_wait().unwrap().is_none() || !self.observed.is_empty();
                if rescued {
                    eprintln!(
                        "HARNESS RESCUE: native Darwin observer test did not complete cleanup"
                    );
                    let _ = self.anchor.kill();
                    let _ = self.anchor.wait();
                    let deadline = Instant::now() + Duration::from_secs(3);
                    loop {
                        self.observed.refresh().unwrap();
                        self.observed
                            .advance(crate::policy::Phase::Kill, None)
                            .unwrap();
                        if self.observed.is_empty() {
                            break;
                        }
                        assert!(Instant::now() < deadline);
                        thread::sleep(Duration::from_millis(5));
                    }
                }
                let _ = self.anchor.wait();
                fs::remove_dir_all(&self.dir).unwrap();
                assert!(
                    !rescued || thread::panicking(),
                    "native observer cleanup needed rescue"
                );
            }
        }
        let directory = std::env::temp_dir().join(format!(
            "procward-darwin-native-observer-{}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let target = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let (lease, live) = pipe().unwrap();
        let (notice, publish) = pipe().unwrap();
        let lease_raw = lease.as_raw_fd();
        let publish_raw = publish.as_raw_fd();
        let config = Config::from_millis(2000, 1000, 2500).unwrap();
        let mut command = Command::new(target.join("procward"));
        command
            .arg("__anchor")
            .arg(std::process::id().to_string())
            .arg(lease_raw.to_string())
            .arg(publish_raw.to_string())
            .args(["2000", "1000", "2500"])
            .arg(target.join("examples/fixture"))
            .arg("tree")
            .arg(&directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .process_group(0);
        unsafe {
            command.pre_exec(move || {
                for raw in [lease_raw, publish_raw] {
                    rio::fcntl_setfd(rustix::fd::BorrowedFd::borrow_raw(raw), FdFlags::empty())?;
                }
                Ok(())
            });
        }
        let anchor = command.spawn().unwrap();
        drop(lease);
        drop(publish);
        rio::write(&live, b"R").unwrap();
        let mut case = Case {
            anchor,
            observed: Inventory::new(),
            dir: directory,
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let mut ready = true;
            let mut pids = Vec::new();
            for mode in ["tree", "branch", "worker"] {
                let path = case.dir.join(format!("{mode}.pid"));
                match fs::read_to_string(path) {
                    Ok(text) => match text.parse::<i32>().ok().and_then(Pid::from_raw) {
                        Some(pid) => pids.push(pid),
                        None => ready = false,
                    },
                    Err(error) if error.kind() == io::ErrorKind::NotFound => ready = false,
                    Err(error) => panic!("fixture readiness query failed: {error}"),
                }
            }
            case.observed.refresh().unwrap();
            if ready && pids.iter().all(|pid| case.observed.knows(*pid)) {
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        // All live fixture ancestry was swept before the observer can be killed.
        case.observed.refresh().unwrap();
        let mut reader = PolicyReader::new();
        reader.refresh(&notice, config).unwrap();
        assert!(
            reader.policy.is_none(),
            "healthy observer must not publish cleanup policy"
        );
        let fault = Instant::now();
        case.anchor.kill().unwrap();
        let status = loop {
            if let Some(status) = case.anchor.try_wait().unwrap() {
                break status;
            }
            assert!(fault.elapsed() < Duration::from_secs(1));
            thread::sleep(Duration::from_millis(5));
        };
        let code = finish_anchor(status, &mut case.observed, Policy::new(config, true)).unwrap();
        assert_eq!(code, 125);
        assert!(case.observed.is_empty());
        assert!(fault.elapsed() <= config.deadline);
    }
}
