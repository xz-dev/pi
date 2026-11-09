// SPDX-License-Identifier: BSD-3-Clause
use rustix::{
    event::{PollFd, PollFlags, Timespec, poll},
    fd::OwnedFd,
    io::Errno,
    process::{self, Pid, PidfdFlags},
};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
};

pub struct Inventory(
    HashMap<Pid, Target>,
    HashMap<Pid, Retained>,
    crate::policy::Progress,
    Option<crate::cgroup::Scope>,
    // The original cleanup policy bounds every walk; no new budget for a rolling tree.
    Option<crate::policy::Policy>,
    // Denied nondirect identities already reported, so repeated passes stay quiet.
    HashSet<(Pid, u64)>,
);

// A descendant reached only through validated parent/birth edges; the pidfd is its identity.
struct Retained {
    fd: OwnedFd,
    birth: u64,
    parent: Pid,
}

struct Target {
    fd: Option<OwnedFd>,
    identity: crate::policy::SignalIdentity,
    term_sent: bool,
    denied: bool,
}

impl Inventory {
    pub fn new() -> Self {
        Self(
            HashMap::new(),
            HashMap::new(),
            crate::policy::Progress::default(),
            None,
            None,
            HashSet::new(),
        )
    }

    pub fn own(&mut self, scope: crate::cgroup::Scope) {
        self.3 = Some(scope);
    }

    // Only after owner loss and a settled cleanup may the anchor remove the owner's group.
    pub fn arm_orphan_removal(&mut self) {
        if let Some(scope) = &mut self.3 {
            scope.arm_orphan_removal();
        }
    }

    pub fn bound(&mut self, policy: crate::policy::Policy) {
        self.4 = Some(policy);
    }

    fn expired(&self) -> bool {
        self.4.is_some_and(|policy| {
            policy.phase(crate::policy::now()) == crate::policy::Phase::Expired
        })
    }

    // An owned workload group must be empty as well as every direct child reaped.
    pub fn settled(&self) -> io::Result<bool> {
        self.3
            .as_ref()
            .map_or(Ok(true), |scope| Ok(!scope.populated()?))
    }

    pub fn progress(&mut self) -> &mut crate::policy::Progress {
        &mut self.2
    }

    pub fn refresh(&mut self) -> io::Result<()> {
        // Unreaped direct children cannot be reused; detached descendants enter here on adoption.
        // Descriptor shortage only delays observation to a later pass; cleanup keeps going.
        let pids = match children() {
            Ok(pids) => pids,
            Err(error) if scarce(&error) => return Ok(()),
            Err(error) => return Err(error),
        };
        for pid in pids {
            if let std::collections::hash_map::Entry::Vacant(entry) = self.0.entry(pid) {
                let born = match birth(pid) {
                    Ok(born) => born.unwrap_or(0),
                    Err(error) if scarce(&error) => continue,
                    Err(error) => return Err(error),
                };
                entry.insert(Target {
                    // An unreaped direct child cannot be reused, so numeric signals stay safe.
                    fd: match open_identity(pid) {
                        Ok(fd) => fd,
                        Err(error) if scarce(&error) => None,
                        Err(error) => return Err(error),
                    },
                    // The unreaped child binds this observation until forget/reap.
                    identity: [pid.as_raw_nonzero().get() as u64, born, 0, 0, 0],
                    term_sent: false,
                    denied: false,
                });
            }
        }
        Ok(())
    }

    pub fn advance(
        &mut self,
        phase: crate::policy::Phase,
        protected: Option<Pid>,
    ) -> io::Result<()> {
        for (pid, target) in &mut self.0 {
            if Some(*pid) == protected {
                continue;
            }
            for signal in self
                .2
                .signals(phase, target.identity, &mut target.term_sent)?
            {
                let result = match &target.fd {
                    Some(fd) => process::pidfd_send_signal(fd, *signal),
                    None => process::kill_process(*pid, *signal),
                };
                match result {
                    Ok(()) | Err(Errno::SRCH) => {}
                    // Real/saved UIDs no longer match ours (e.g. after sudo): not signalable, still owned.
                    Err(Errno::PERM) => {
                        if !std::mem::replace(&mut target.denied, true) {
                            crate::diagnostic(format!(
                                "Linux denied signals to privileged descendant {pid}; it remains a known survivor"
                            ));
                        }
                        break;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        if phase == crate::policy::Phase::Kill {
            self.kill_retained(protected)?;
            match &self.3 {
                // cgroup.kill already reaches every member; no redundant pidfd traversal.
                Some(scope) => scope.kill()?,
                None => self.kill_walk(protected)?,
            }
        }
        Ok(())
    }

    // Handles retained by job-control freezing are signalled once at KILL, then released.
    fn kill_retained(&mut self, protected: Option<Pid>) -> io::Result<()> {
        if self.1.is_empty() {
            return Ok(());
        }
        // Bounded walk: stale edges after PID reuse cannot form an endless chain.
        let shielded = |mut pid: Pid, retained: &HashMap<Pid, Retained>| {
            for _ in 0..=retained.len() {
                if Some(pid) == protected {
                    return true;
                }
                match retained.get(&pid) {
                    Some(entry) => pid = entry.parent,
                    None => return false,
                }
            }
            protected.is_some()
        };
        let mut denied = Vec::new();
        for (pid, entry) in &self.1 {
            if shielded(*pid, &self.1) {
                continue;
            }
            match process::pidfd_send_signal(&entry.fd, process::Signal::KILL) {
                Ok(()) | Err(Errno::SRCH) => {}
                Err(Errno::PERM) if !self.0.contains_key(pid) => denied.push((*pid, entry.birth)),
                Err(Errno::PERM) => {}
                Err(error) => return Err(error.into()),
            }
        }
        for (pid, birth) in denied {
            self.report_denied(pid, birth);
        }
        // The streaming walk re-identifies survivors; retained descriptors must not accumulate.
        self.1.clear();
        Ok(())
    }

    // A live ancestor may never exit, so KILL reaches nondirect descendants without adoption.
    // Streaming: one pidfd is open at a time and closed after its KILL, so descriptor use is
    // constant however large the tree is. Only validated parent/birth edges are followed and
    // only pidfds are signalled, never bare nondirect PIDs. The original deadline ends a pass.
    fn kill_walk(&mut self, protected: Option<Pid>) -> io::Result<()> {
        let root = process::getpid();
        let mut pending = vec![(root, None)];
        let mut visited = HashSet::new();
        while let Some((parent, expected)) = pending.pop() {
            if self.expired() {
                return Ok(());
            }
            if !visited.insert(parent) {
                continue;
            }
            let before = match birth(parent) {
                Ok(Some(before)) if expected.is_none_or(|birth| birth == before) => before,
                Ok(_) => continue,
                // Descriptor shortage leaves this pass incomplete; the next pass retries.
                Err(error) if scarce(&error) => continue,
                Err(error) => return Err(error),
            };
            let observed_edges = match edges(parent) {
                Ok(edges) => edges,
                Err(error) if scarce(&error) => continue,
                Err(error) => return Err(error),
            };
            // Previously observed children remain owned if their parent is
            // reaped during validation. This snapshot can omit reparenting
            // children; cleanup must rescan fresh adoptions after reap progress.
            let parent_dead = expected.is_some() && matches!(birth(parent), Ok(None));
            for (pid, observed) in observed_edges {
                // The protected keeper and its whole subtree are never reached.
                if Some(pid) == protected {
                    continue;
                }
                if self.expired() {
                    return Ok(());
                }
                let fd = match open_identity(pid) {
                    Ok(Some(fd)) => fd,
                    Ok(None) => continue,
                    Err(error) if scarce(&error) => continue,
                    Err(error) => return Err(error),
                };
                // The handle must name the observed child. If the parent is
                // already reaped, validate the child's own birth after adoption.
                if parent_dead {
                    match birth(pid) {
                        Ok(Some(child)) if child == observed => {}
                        Ok(_) => continue,
                        Err(error) if scarce(&error) => continue,
                        Err(error) => return Err(error),
                    }
                } else {
                    match (birth(pid), birth(parent)) {
                        (Ok(Some(child)), Ok(Some(now))) if child == observed && now == before => {}
                        (Err(error), _) | (_, Err(error)) if !scarce(&error) => return Err(error),
                        _ => continue,
                    }
                }
                let mut denied = false;
                match process::pidfd_send_signal(&fd, process::Signal::KILL) {
                    Ok(()) | Err(Errno::SRCH) => {}
                    Err(Errno::PERM) => {
                        denied = true;
                        if !self.0.contains_key(&pid) {
                            self.report_denied(pid, observed);
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
                // pidfd readiness observes nondirect exit too; waitid's ECHILD
                // does not prove death. Keep waits inside the original policy.
                let has_children = match edges(pid) {
                    Ok(children) => !children.is_empty(),
                    Err(error) if scarce(&error) => true,
                    Err(error) => return Err(error),
                };
                if !denied && has_children && !self.wait_for_death(&fd)? {
                    return Ok(());
                }
                if self.expired() {
                    return Ok(());
                }
                drop(fd);
                pending.push((pid, Some(observed)));
            }
        }
        Ok(())
    }

    fn wait_for_death(&self, fd: &OwnedFd) -> io::Result<bool> {
        if self.4.is_none() {
            return Err(io::Error::other("pidfd death wait requires cleanup policy"));
        }
        let mut readiness = [PollFd::new(fd, PollFlags::IN)];
        while !self.expired() {
            match poll(
                &mut readiness,
                Some(&Timespec {
                    tv_sec: 0,
                    tv_nsec: 2_000_000,
                }),
            ) {
                Ok(_) => {}
                Err(Errno::INTR) => continue,
                Err(error) => return Err(error.into()),
            }
            let events = readiness[0].revents();
            if events.intersects(PollFlags::ERR | PollFlags::NVAL) {
                return Err(io::Error::other(format!(
                    "invalid pidfd readiness: {events:?}"
                )));
            }
            if events.intersects(PollFlags::IN | PollFlags::HUP) {
                return Ok(true);
            }
            if !events.is_empty() {
                return Err(io::Error::other(format!(
                    "unexpected pidfd readiness: {events:?}"
                )));
            }
        }
        Ok(false)
    }

    fn report_denied(&mut self, pid: Pid, birth: u64) {
        if self.5.insert((pid, birth)) {
            crate::diagnostic(format!(
                "Linux denied signals to privileged descendant {pid}; it remains a known survivor"
            ));
        }
    }

    pub fn empty_except(&self, pid: Pid) -> io::Result<bool> {
        Ok(self.0.keys().all(|target| *target == pid))
    }

    pub fn freeze(&mut self, paused: bool) -> io::Result<()> {
        self.discover()?;
        let signal = if paused {
            process::Signal::STOP
        } else {
            process::Signal::CONT
        };
        let mut gone = Vec::new();
        for (pid, entry) in &self.1 {
            // Job control cannot stop a descendant the OS forbids this user to signal.
            match process::pidfd_send_signal(&entry.fd, signal) {
                Ok(()) | Err(Errno::PERM) => {}
                Err(Errno::SRCH) => gone.push(*pid),
                Err(error) => return Err(error.into()),
            }
        }
        for pid in gone {
            self.1.remove(&pid);
        }
        for (pid, target) in &self.0 {
            if target.fd.is_none() {
                match process::kill_process(*pid, signal) {
                    Ok(()) | Err(Errno::SRCH) | Err(Errno::PERM) => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(())
    }

    // Extends retained handles from this process and still-valid retained parents only.
    // Descriptor shortage leaves freezing incomplete for this pass instead of aborting.
    fn discover(&mut self) -> io::Result<()> {
        let root = process::getpid();
        let mut pending: Vec<_> = self.1.keys().copied().chain([root]).collect();
        let mut visited = HashSet::new();
        while let Some(parent) = pending.pop() {
            if self.expired() {
                return Ok(());
            }
            if !visited.insert(parent) {
                continue;
            }
            let before = match birth(parent) {
                Ok(Some(before)) => before,
                Ok(None) => continue,
                Err(error) if scarce(&error) => continue,
                Err(error) => return Err(error),
            };
            if parent != root
                && self
                    .1
                    .get(&parent)
                    .is_none_or(|entry| entry.birth != before)
            {
                continue;
            }
            // Observed edges hold no descriptors; each handle is opened only when retained.
            let observed = match edges(parent) {
                Ok(observed) => observed,
                Err(error) if scarce(&error) => continue,
                Err(error) => return Err(error),
            };
            for (pid, birth_seen) in observed {
                // A retained handle keeps its identity across reparenting; never replace it.
                if let Some(entry) = self.1.get_mut(&pid) {
                    if entry.birth == birth_seen {
                        entry.parent = parent;
                        pending.push(pid);
                        continue;
                    }
                }
                let fd = match open_identity(pid) {
                    Ok(Some(fd)) => fd,
                    Ok(None) => continue,
                    Err(error) if scarce(&error) => continue,
                    Err(error) => return Err(error),
                };
                // A stable handle plus live birth checks bind each edge to the observed parent.
                match (birth(pid), birth(parent)) {
                    (Ok(Some(child)), Ok(Some(now))) if child == birth_seen && now == before => {}
                    (Err(error), _) | (_, Err(error)) if !scarce(&error) => return Err(error),
                    _ => continue,
                }
                self.1.insert(
                    pid,
                    Retained {
                        fd,
                        birth: birth_seen,
                        parent,
                    },
                );
                pending.push(pid);
            }
        }
        Ok(())
    }

    pub fn forget(&mut self, pid: Pid) {
        self.0.remove(&pid);
        self.1.remove(&pid);
    }
}

pub fn children() -> io::Result<Vec<Pid>> {
    fs::read_to_string("/proc/thread-self/children")?
        .split_whitespace()
        .map(|raw| {
            raw.parse()
                .ok()
                .and_then(Pid::from_raw)
                .ok_or_else(|| io::Error::other("invalid child PID from procfs"))
        })
        .collect()
}

// EMFILE/ENFILE are a transient observation gap, never a reason to stop cleanup early.
fn scarce(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::EMFILE | libc::ENFILE))
}

// A vanished observed process is not an inventory failure. Other errors stay unknown.
fn vanished(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
        || error.raw_os_error() == Some(Errno::SRCH.raw_os_error())
}

// Children of `parent` whose own stat still names it, with their birth; no handles are held.
fn edges(parent: Pid) -> io::Result<Vec<(Pid, u64)>> {
    let tasks = match fs::read_dir(format!("/proc/{parent}/task")) {
        Ok(tasks) => tasks,
        Err(error) if vanished(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut observed = Vec::new();
    for task in tasks {
        let task = match task {
            Ok(task) => task,
            Err(error) if vanished(&error) => break,
            Err(error) => return Err(error),
        };
        let text = match fs::read_to_string(task.path().join("children")) {
            Ok(text) => text,
            Err(error) if vanished(&error) => continue,
            Err(error) => return Err(error),
        };
        for raw in text.split_whitespace() {
            let pid = raw
                .parse()
                .ok()
                .and_then(Pid::from_raw)
                .ok_or_else(|| io::Error::other("invalid descendant PID"))?;
            let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
                Ok(text) => text,
                Err(error) if vanished(&error) => continue,
                Err(error) => return Err(error),
            };
            let actual_parent = stat
                .rsplit_once(')')
                .and_then(|(_, fields)| fields.split_whitespace().nth(1))
                .and_then(|v| v.parse::<i32>().ok())
                .and_then(Pid::from_raw);
            if actual_parent == Some(parent) {
                observed.push((pid, parse_birth(&stat)?));
            }
        }
    }
    Ok(observed)
}

fn birth(pid: Pid) -> io::Result<Option<u64>> {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(text) => parse_birth(&text).map(Some),
        Err(error) if vanished(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn parse_birth(stat: &str) -> io::Result<u64> {
    stat.rsplit_once(')')
        .and_then(|(_, fields)| fields.split_whitespace().nth(19))
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| io::Error::other("invalid process birth from procfs"))
}

fn open_identity(pid: Pid) -> io::Result<Option<OwnedFd>> {
    let Some(before) = birth(pid)? else {
        return Ok(None);
    };
    let fd = match process::pidfd_open(pid, PidfdFlags::empty()) {
        Ok(fd) => fd,
        Err(Errno::SRCH) => return Ok(None),
        Err(Errno::NOSYS | Errno::PERM | Errno::INVAL) => {
            static REPORTED: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            if !REPORTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                crate::diagnostic("pidfd unavailable; nondirect freezing unsupported, direct-child reaper cleanup remains active".into());
            }
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    match birth(pid)? {
        Some(after) if before == after => Ok(Some(fd)),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn procfs_disappearance_is_not_inventory_failure() {
        for errno in [libc::ENOENT, libc::ESRCH] {
            assert!(vanished(&io::Error::from_raw_os_error(errno)));
        }
        for errno in [libc::EPERM, libc::EACCES, libc::EIO, libc::EMFILE] {
            assert!(!vanished(&io::Error::from_raw_os_error(errno)));
        }
    }
    #[test]
    fn nondirect_pidfd_wait_requires_readiness_and_preserves_adoption() {
        use std::{
            os::fd::AsFd,
            process::{Command, Stdio},
            thread,
            time::{Duration, Instant},
        };
        // Native process fixture: execute only through the separate-kernel VM runner.
        crate::reaper::acquire().unwrap();
        let dir = std::env::temp_dir().join(format!("procward-pidfd-wait-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let executable = std::env::current_exe().unwrap();
        let fixture = executable
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("examples/fixture");
        let mut parent = Command::new(fixture)
            .arg("tree")
            .arg(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let read_pid = |name: &str| {
            fs::read_to_string(dir.join(format!("{name}.pid")))
                .ok()
                .and_then(|value| value.parse().ok())
                .and_then(Pid::from_raw)
        };
        let ready_by = Instant::now() + Duration::from_secs(5);
        let (branch, worker) = loop {
            if let (Some(branch), Some(worker)) = (read_pid("branch"), read_pid("worker")) {
                break (branch, worker);
            }
            assert!(Instant::now() < ready_by, "finite pidfd fixture readiness");
            thread::sleep(Duration::from_millis(2));
        };
        let fd = open_identity(branch).unwrap().unwrap();
        assert!(matches!(
            process::waitid(
                process::WaitId::PidFd(fd.as_fd()),
                process::WaitIdOptions::EXITED | process::WaitIdOptions::NOWAIT
            ),
            Err(Errno::CHILD)
        ));
        assert!(process::test_kill_process(branch).is_ok());
        let mut expired = Inventory::new();
        expired.bound(crate::policy::Policy::new(
            crate::config::Config::from_millis(5, 5, 50).unwrap(),
            false,
        ));
        assert!(
            !expired.wait_for_death(&fd).unwrap(),
            "a live nonchild is not dead at ECHILD or timeout"
        );
        assert!(parent.try_wait().unwrap().is_none());
        assert!(process::test_kill_process(branch).is_ok());
        // A separate observation policy, not a restarted production cleanup budget.
        let mut observed = Inventory::new();
        observed.bound(crate::policy::Policy::new(
            crate::config::Config::from_millis(50, 25, 1000).unwrap(),
            false,
        ));
        process::pidfd_send_signal(&fd, process::Signal::KILL).unwrap();
        assert!(observed.wait_for_death(&fd).unwrap());
        assert!(parent.try_wait().unwrap().is_none());
        assert!(
            edges(branch).unwrap().is_empty(),
            "dead parent no longer lists adopted children"
        );
        assert!(
            edges(process::getpid())
                .unwrap()
                .iter()
                .any(|(pid, _)| *pid == worker),
            "fresh adoption must be rescanned at the reaper, including libtest's other threads"
        );
        // Explicit teardown of the finite test actors; not product cleanup evidence.
        process::kill_process(worker, process::Signal::KILL).unwrap();
        process::waitpid(Some(worker), process::WaitOptions::empty()).unwrap();
        parent.kill().unwrap();
        parent.wait().unwrap();
        process::waitpid(Some(branch), process::WaitOptions::empty()).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn birth_parser_handles_spaces_and_parentheses_in_comm() {
        let stat = "23 (worker ) (name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 4242 0";
        assert_eq!(parse_birth(stat).unwrap(), 4242);
        assert!(parse_birth("23 (truncated) S 1").is_err());
    }
}
