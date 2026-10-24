//! Darwin's sampled descendant inventory. No subreaper or ancestry containment exists here.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io;
use std::time::{Duration, Instant};

#[path = "darwin_record.rs"]
mod record;
pub(super) use record::Identity;
use record::{Query, Record, bsd_query, full_query};

unsafe extern "C" {
    fn pi_env_darwin_record(pid: i32, output: *mut Record) -> i32;
}

fn info(pid: libc::pid_t) -> io::Result<Option<Record>> {
    // SAFETY: libproc writes at most the supplied, correctly sized record.
    let mut record: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&record) as i32;
    unsafe {
        *libc::__error() = 0;
    }
    let got = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut record as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    let error = io::Error::last_os_error().raw_os_error().unwrap_or(0);
    match full_query(got, size, error)? {
        Query::Absent => Ok(None),
        Query::Complete => Record {
            pbi_pid: record.pbi_pid,
            pbi_ppid: record.pbi_ppid,
            pbi_pgid: record.pbi_pgid,
            pbi_status: record.pbi_status,
            pbi_uid: record.pbi_uid,
            pbi_ruid: record.pbi_ruid,
            pbi_start_tvsec: record.pbi_start_tvsec,
            pbi_start_tvusec: record.pbi_start_tvusec,
        }
        .checked(pid)
        .map(Some),
        Query::Bsd => {
            let mut record = Record::default();
            // SAFETY: the SDK shim initializes this fixed-width record only on complete success.
            match bsd_query(unsafe { pi_env_darwin_record(pid, &mut record) })? {
                Query::Complete => record.checked(pid).map(Some),
                Query::Absent => Ok(None),
                Query::Bsd => unreachable!(),
            }
        }
    }
}

fn identity(record: &Record) -> Identity {
    record.identity()
}

impl Identity {
    pub(super) fn current(pid: libc::pid_t) -> io::Result<Self> {
        info(pid)?
            .map(|record| identity(&record))
            .ok_or_else(|| io::Error::from_raw_os_error(libc::ESRCH))
    }
    pub(super) fn child(self, parent: libc::pid_t) -> io::Result<()> {
        match info(self.pid)? {
            Some(record) if identity(&record) == self && record.pbi_ppid == parent as u32 => Ok(()),
            _ => Err(io::Error::other(
                "session primary identity/parent changed before grant",
            )),
        }
    }
    pub(super) fn signal(self, signal: i32) -> io::Result<()> {
        // Darwin's existing birth/UID check-use boundary; never an unchecked group signal.
        if let Some(record) = info(self.pid)?
            && identity(&record) == self
            && unsafe { libc::kill(self.pid, signal) } != 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
}

fn list(root: libc::pid_t, group: bool) -> io::Result<Vec<libc::pid_t>> {
    // libproc returns a PID count, not bytes. A full buffer may be truncated.
    for capacity in [64, 256, 1024, 4096, 16384, 65536] {
        let mut pids = vec![0; capacity];
        let bytes = (capacity * std::mem::size_of::<libc::pid_t>()) as i32;
        // SAFETY: writable PID array; the API respects its byte capacity.
        // libproc may return zero on failure; distinguish empty lists.
        unsafe {
            *libc::__error() = 0;
        }
        let count = unsafe {
            if group {
                libc::proc_listpgrppids(root, pids.as_mut_ptr().cast(), bytes)
            } else {
                libc::proc_listchildpids(root, pids.as_mut_ptr().cast(), bytes)
            }
        };
        let error = io::Error::last_os_error();
        if count < 0
            || (count == 0
                && error.raw_os_error() != Some(0)
                && error.raw_os_error() != Some(libc::ESRCH))
        {
            return Err(error);
        }
        if (count as usize) < capacity {
            pids.truncate(count as usize);
            if pids.iter().any(|pid| *pid <= 0) {
                return Err(io::Error::other("invalid libproc PID list"));
            }
            return Ok(pids);
        }
    }
    Err(io::Error::other("libproc PID enumeration exceeded bound"))
}

pub(super) struct Inventory {
    root: libc::pid_t,
    origin: Option<Identity>,
    known: HashMap<libc::pid_t, Identity>,
    private_groups: bool,
    groups: HashSet<libc::pid_t>,
}

impl Inventory {
    pub(super) fn new(private_groups: bool) -> Self {
        Self {
            root: std::process::id() as libc::pid_t,
            origin: None,
            known: HashMap::new(),
            private_groups,
            groups: HashSet::new(),
        }
    }

    pub(super) fn observer(root: Identity) -> Self {
        let mut inventory = Self::new(false);
        inventory.root = root.pid();
        inventory.origin = Some(root);
        inventory
    }

    pub(super) fn seed(&mut self, held: Identity) -> io::Result<()> {
        if let Some(record) = info(held.pid)?
            && identity(&record) == held
        {
            self.remember(&record);
            return Ok(());
        }
        Err(io::Error::other(
            "session primary identity unavailable before grant",
        ))
    }

    pub(super) fn snapshot(&mut self) -> io::Result<()> {
        let mut roots = VecDeque::new();
        if self.origin.is_none()
            || info(self.root)?.is_some_and(|record| {
                self.origin
                    .is_some_and(|origin| origin.same_birth(identity(&record)))
            })
        {
            roots.push_back(self.root);
        }
        let mut groups = HashSet::new();
        // Retain identities across reparenting, but never across PID reuse.
        for held in self.known.clone().values() {
            match info(held.pid)? {
                Some(record) if held.same_birth(identity(&record)) => {
                    // Credentials may change without a new process; refresh only after full birth proof.
                    self.known.insert(held.pid, identity(&record));
                    roots.push_back(held.pid);
                    // A live known member anchors the group against PGID reuse.
                    // Workload groups are private; never expand the caller's group.
                    if self.groups.contains(&(record.pbi_pgid as libc::pid_t)) {
                        groups.insert(record.pbi_pgid as libc::pid_t);
                    }
                }
                _ => {
                    self.known.remove(&held.pid);
                }
            }
        }
        self.groups = groups.clone();
        for group in groups {
            for pid in list(group, true)? {
                if let Some(record) = info(pid)?
                    && record.pbi_pgid == group as u32
                    && pid != self.root
                    && pid != std::process::id() as libc::pid_t
                {
                    self.remember(&record);
                    roots.push_back(pid);
                }
            }
        }
        let mut visited = HashSet::new();
        while let Some(root) = roots.pop_front() {
            if !visited.insert(root) {
                continue;
            }
            if visited.len() > 65536 {
                return Err(io::Error::other("descendant snapshot exceeded bound"));
            }
            // Revalidate cached roots immediately before ancestry enumeration.
            if root != self.root && !self.current(root)? {
                continue;
            }
            for pid in list(root, false)? {
                if let Some(record) = info(pid)?
                    && record.pbi_ppid == root as u32
                    && pid != self.root
                    && pid != std::process::id() as libc::pid_t
                {
                    self.remember(&record);
                    roots.push_back(pid);
                }
            }
        }
        Ok(())
    }

    fn remember(&mut self, record: &Record) {
        if record.pbi_pid as i32 == crate::tty_handoff::backup_pid() {
            return;
        }
        if self.private_groups
            && record.pbi_pid == record.pbi_pgid
            && record.pbi_pgid != unsafe { libc::getpgrp() } as u32
        {
            self.groups.insert(record.pbi_pgid as libc::pid_t);
        }
        self.known
            .insert(record.pbi_pid as libc::pid_t, identity(record));
    }

    fn current(&self, pid: libc::pid_t) -> io::Result<bool> {
        Ok(match (self.known.get(&pid), info(pid)?) {
            (Some(held), Some(record)) => held.same_birth(identity(&record)),
            _ => false,
        })
    }

    pub(super) fn signal(&self, pid: libc::pid_t, signal: i32) -> io::Result<()> {
        if let Some(held) = self.known.get(&pid) {
            held.signal(signal)?;
        }
        Ok(())
    }

    pub(super) fn signal_other_groups(
        &self,
        signal: i32,
        primary: &mut crate::job_control::Primary,
    ) -> io::Result<()> {
        let own_group = unsafe { libc::getpgrp() } as u32;
        for pid in self.known.keys() {
            if signal == libc::SIGSTOP {
                crate::tty_handoff::refresh_primary(primary)?;
                if !crate::job_control::pause_requested() {
                    break;
                }
            }
            // Primary already stopped by default TSTP, never substitute SIGSTOP.
            if *pid != primary.id() as i32
                && let Some(record) = info(*pid)?
                && record.pbi_pgid != own_group
            {
                self.signal(*pid, signal)?;
            }
        }
        Ok(())
    }

    pub(super) fn signal_all(&self, signal: i32) -> io::Result<()> {
        let mut failure = None;
        for pid in self.known.keys() {
            if let Err(error) = self.signal(*pid, signal) {
                failure = Some(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    fn survivors(&self) -> io::Result<bool> {
        for held in self.known.values() {
            if let Some(record) = info(held.pid)?
                && held.same_birth(identity(&record))
                && record.pbi_status != libc::SZOMB
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(super) fn cleanup(&mut self) -> io::Result<()> {
        self.cleanup_until(Instant::now() + Duration::from_secs(5))
    }
    pub(super) fn cleanup_until(&mut self, deadline: Instant) -> io::Result<()> {
        self.cleanup_after(Duration::from_millis(250), deadline)
    }
    pub(super) fn cleanup_after(&mut self, grace: Duration, deadline: Instant) -> io::Result<()> {
        // Final inventory precedes TERM, including termination of any parent.
        // Keep failures sticky while still attempting the rest of the sweep.
        let mut failure = self.snapshot().err();
        if let Err(error) = self.signal_all(libc::SIGTERM) {
            failure = Some(error);
        }
        if let Err(error) = self.signal_all(libc::SIGCONT) {
            failure = Some(error);
        }
        let start = Instant::now();
        loop {
            if let Err(error) = self.snapshot() {
                failure = Some(error);
            }
            let signal = if start.elapsed() >= grace {
                libc::SIGKILL
            } else {
                libc::SIGTERM
            };
            if let Err(error) = self.signal_all(signal) {
                failure = Some(error);
            }
            // Only direct children are waitable. ECHILD is NOT proof of an empty tree.
            loop {
                let mut status = 0;
                let got = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
                if got > 0 {
                    crate::tty_handoff::backup_reaped(got, status);
                    continue;
                }
                if got < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    if error.raw_os_error() != Some(libc::ECHILD) {
                        failure = Some(error);
                    }
                }
                break;
            }
            match self.survivors() {
                Ok(false) => return failure.map_or(Ok(()), Err),
                Err(error) => {
                    failure = Some(error);
                }
                Ok(true) => {}
            }
            if Instant::now() >= deadline {
                return Err(failure.unwrap_or_else(|| {
                    io::Error::new(io::ErrorKind::TimedOut, "known Darwin descendants remain")
                }));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}
