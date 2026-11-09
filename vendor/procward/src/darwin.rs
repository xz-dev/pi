// SPDX-License-Identifier: BSD-3-Clause
use crate::policy::{Phase, Progress, SignalIdentity};
use libproc::processes::{ProcFilter, pids_by_type};
use rustix::{
    io::Errno,
    process::{self, Pid},
};
use std::{
    collections::{HashMap, HashSet},
    io,
};

// PID plus the never-reused per-boot unique ID name one process; UIDs can change under it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    pid: u32,
    birth: u64,
    uid: u32,
    real_uid: u32,
    saved_uid: u32,
}
impl Identity {
    fn signal_identity(self) -> SignalIdentity {
        [
            u64::from(self.pid),
            self.birth,
            0,
            (u64::from(self.uid) << 32) | u64::from(self.real_uid),
            u64::from(self.saved_uid),
        ]
    }
    fn same_process(self, other: Self) -> bool {
        (self.pid, self.birth) == (other.pid, other.birth)
    }
}
struct Target {
    identity: Identity,
    term_sent: bool,
    denied: bool,
}
impl Target {
    // setuid exec or setuid() changes credentials, not ownership: keep the target, re-sign it.
    fn follow(&mut self, now: Identity) -> bool {
        if !self.identity.same_process(now) {
            return false;
        }
        if self.identity != now {
            *self = Target {
                identity: now,
                term_sent: false,
                denied: false,
            };
        }
        true
    }
}
pub struct Inventory(HashMap<Pid, Target>, HashSet<Pid>, Progress);

fn list_children(parent: u32) -> io::Result<Vec<u32>> {
    // libproc 0.14.11 checks errno on a valid empty result without clearing stale errno first.
    errno::set_errno(errno::Errno(0));
    pids_by_type(ProcFilter::ByParentProcess { ppid: parent })
}

// xnu bsd/sys/proc_info_private.h; xnu statically asserts this API struct is 56 bytes.
const PROC_PIDUNIQIDENTIFIERINFO: libc::c_int = 17;
#[repr(C)]
struct UniqueIdentifierInfo {
    uuid: [u8; 16],
    unique_id: u64,
    parent_unique_id: u64,
    id_version: i32,
    orig_ppid_version: i32,
    reserved: [u64; 2],
}
const _: () = assert!(std::mem::size_of::<UniqueIdentifierInfo>() == 56);
// proc_info_private.h struct proc_bsdinfowithuniqid: one same-user read of both records.
const PROC_PIDT_BSDINFOWITHUNIQID: libc::c_int = 18;
#[repr(C)]
struct BsdInfoWithUniqueId {
    bsd: libc::proc_bsdinfo,
    unique: UniqueIdentifierInfo,
}
// 136-byte proc_bsdinfo plus the 56-byte unique-ID record.
const _: () = assert!(std::mem::size_of::<BsdInfoWithUniqueId>() == 192);

/// # Safety
/// `T` must be the plain-data struct the kernel writes for `flavor`.
unsafe fn pid_info<T>(pid: Pid, flavor: libc::c_int) -> io::Result<T> {
    let mut info = std::mem::MaybeUninit::<T>::zeroed();
    let size = std::mem::size_of::<T>() as libc::c_int;
    // SAFETY: the kernel writes at most `size` bytes into the zeroed buffer.
    let written = unsafe {
        libc::proc_pidinfo(
            pid.as_raw_nonzero().get(),
            flavor,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    match written {
        written if written == size => Ok(unsafe { info.assume_init() }),
        written if written <= 0 => Err(io::Error::last_os_error()),
        _ => Err(io::Error::other("short proc_pidinfo result")),
    }
}

// xnu bsd/kern/kern_fork.c forkproc(): p_uniqueid = ++nextuniqueid, never reused this boot;
// an exec copy of the proc keeps it. Same-euid processes need one read; for others xnu
// bsd/kern/proc_info.c proc_pidinfo_internal() denies BSDINFO* with EPERM but serves
// SHORTBSDINFO and UNIQIDENTIFIERINFO without the same-user check.
fn identify(pid: Pid) -> io::Result<(Identity, u32)> {
    // SAFETY: BSDINFOWITHUNIQID writes proc_bsdinfowithuniqid.
    match unsafe { pid_info::<BsdInfoWithUniqueId>(pid, PROC_PIDT_BSDINFOWITHUNIQID) } {
        Ok(info) => {
            if info.bsd.pbi_pid != pid.as_raw_nonzero().get() as u32 {
                return Err(io::Error::other(
                    "proc_pidinfo returned a mismatched process PID",
                ));
            }
            Ok((
                Identity {
                    pid: info.bsd.pbi_pid,
                    birth: info.unique.unique_id,
                    uid: info.bsd.pbi_uid,
                    real_uid: info.bsd.pbi_ruid,
                    saved_uid: info.bsd.pbi_svuid,
                },
                info.bsd.pbi_ppid,
            ))
        }
        Err(error) if error.raw_os_error() == Some(Errno::PERM.raw_os_error()) => {
            identify_short(pid)
        }
        Err(error) => Err(error),
    }
}

fn identify_short(pid: Pid) -> io::Result<(Identity, u32)> {
    // SAFETY: each flavor is paired with its xnu struct.
    let (before, info, after) = unsafe {
        (
            pid_info::<UniqueIdentifierInfo>(pid, PROC_PIDUNIQIDENTIFIERINFO)?,
            pid_info::<libc::proc_bsdshortinfo>(pid, libc::PROC_PIDT_SHORTBSDINFO)?,
            pid_info::<UniqueIdentifierInfo>(pid, PROC_PIDUNIQIDENTIFIERINFO)?,
        )
    };
    // The unique ID on both sides binds the short record to one process.
    if before.unique_id != after.unique_id {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("process {pid} changed during its identity query"),
        ));
    }
    if info.pbsi_pid != pid.as_raw_nonzero().get() as u32 {
        return Err(io::Error::other(
            "proc_pidinfo returned a mismatched process PID",
        ));
    }
    Ok((
        Identity {
            pid: info.pbsi_pid,
            birth: before.unique_id,
            uid: info.pbsi_uid,
            real_uid: info.pbsi_ruid,
            saved_uid: info.pbsi_svuid,
        },
        info.pbsi_ppid,
    ))
}

fn query(pid: Pid) -> io::Result<Option<(Identity, u32)>> {
    let error = match identify(pid) {
        Ok(found) => return Ok(Some(found)),
        Err(error) if error.raw_os_error().is_none() => return Err(error),
        Err(error) => error,
    };
    match process::test_kill_process(pid) {
        Err(Errno::SRCH) => Ok(None),
        // EPERM proves existence of a process this user may not signal.
        Ok(()) | Err(Errno::PERM) if error.raw_os_error() == Some(Errno::SRCH.raw_os_error()) => {
            Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("process {pid} still exists but has no identity yet"),
            ))
        }
        _ => Err(io::Error::other(format!(
            "macOS identity query for {pid} failed: {error}"
        ))),
    }
}

fn current(pid: Pid) -> io::Result<Option<Identity>> {
    Ok(query(pid)?.map(|(identity, _)| identity))
}

fn signal_if_current(
    expected: Identity,
    current: io::Result<Option<Identity>>,
    send: impl FnOnce() -> io::Result<()>,
) -> io::Result<bool> {
    if current? != Some(expected) {
        return Ok(false);
    }
    send()?;
    Ok(true)
}

impl Inventory {
    pub fn new() -> Self {
        Self(HashMap::new(), HashSet::new(), Progress::default())
    }
    pub fn progress(&mut self) -> &mut Progress {
        &mut self.2
    }
    pub fn refresh(&mut self) -> io::Result<()> {
        let root = process::getpid();
        // Unknown observations remain completion blockers, never signalling authority.
        let mut absent = Vec::new();
        for pid in &self.1 {
            match query(*pid) {
                Ok(None) => absent.push(*pid),
                Ok(Some(_)) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
        }
        for pid in absent {
            self.1.remove(&pid);
        }
        let mut pending: Vec<_> = self.0.keys().copied().chain([root]).collect();
        let mut visited = HashSet::new();
        while let Some(parent) = pending.pop() {
            if !visited.insert(parent) {
                continue;
            }
            let before = match current(parent) {
                Ok(Some(identity)) => identity,
                Ok(None) => {
                    self.0.remove(&parent);
                    continue;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Err(error) => return Err(error),
            };
            if parent != root
                && !self
                    .0
                    .get_mut(&parent)
                    .is_some_and(|target| target.follow(before))
            {
                self.0.remove(&parent);
                continue;
            }
            let mut observed = Vec::new();
            for raw in list_children(before.pid)? {
                let pid = Pid::from_raw(raw as i32)
                    .ok_or_else(|| io::Error::other("invalid libproc child PID"))?;
                match query(pid) {
                    Ok(Some((identity, ppid))) if ppid == before.pid => {
                        observed.push((pid, identity))
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        self.1.insert(pid);
                    }
                    Err(error) => return Err(error),
                }
            }
            let after = match current(parent) {
                Ok(identity) => identity,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Err(error) => return Err(error),
            };
            if !after.is_some_and(|after| after.same_process(before)) {
                continue;
            }
            for (pid, identity) in observed {
                self.1.remove(&pid);
                let entry = self.0.entry(pid).or_insert(Target {
                    identity,
                    term_sent: false,
                    denied: false,
                });
                if !entry.follow(identity) {
                    *entry = Target {
                        identity,
                        term_sent: false,
                        denied: false,
                    };
                }
                pending.push(pid);
            }
        }
        Ok(())
    }
    pub fn advance(&mut self, phase: Phase, protected: Option<Pid>) -> io::Result<()> {
        let mut gone = Vec::new();
        for (pid, target) in &mut self.0 {
            if Some(*pid) == protected {
                continue;
            }
            let now = match current(*pid) {
                Ok(identity) => identity,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Err(error) => return Err(error),
            };
            if !now.is_some_and(|now| target.follow(now)) {
                gone.push(*pid);
                continue;
            }
            for signal in self.2.signals(
                phase,
                target.identity.signal_identity(),
                &mut target.term_sent,
            )? {
                // macOS has an unavoidable final identity-check/use race, not kernel containment.
                let now = match current(*pid) {
                    Ok(identity) => identity,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) => return Err(error),
                };
                match signal_if_current(target.identity, Ok(now), || {
                    process::kill_process(*pid, *signal).map_err(io::Error::from)
                }) {
                    Ok(true) => {}
                    // Changed credentials only: the next pass re-signs the same process.
                    Ok(false) if now.is_some_and(|now| target.identity.same_process(now)) => break,
                    Ok(false) => {
                        gone.push(*pid);
                        break;
                    }
                    Err(error) if error.raw_os_error() == Some(Errno::SRCH.raw_os_error()) => {
                        gone.push(*pid);
                        break;
                    }
                    // Real/saved UIDs no longer match ours (e.g. after sudo): not signalable, still owned.
                    Err(error) if error.raw_os_error() == Some(Errno::PERM.raw_os_error()) => {
                        if !std::mem::replace(&mut target.denied, true) {
                            crate::diagnostic(format!(
                                "macOS denied signals to privileged descendant {pid}; it remains a known survivor"
                            ));
                        }
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        for pid in gone {
            self.0.remove(&pid);
        }
        Ok(())
    }
    pub fn empty_except(&self, pid: Pid) -> io::Result<bool> {
        Ok(self.1.is_empty() && self.0.keys().all(|target| *target == pid))
    }

    pub fn freeze(&mut self, paused: bool) -> io::Result<()> {
        let signal = if paused {
            process::Signal::STOP
        } else {
            process::Signal::CONT
        };
        self.refresh()?;
        for (pid, target) in &self.0 {
            let now = match current(*pid) {
                Ok(identity) => identity,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Err(error) => return Err(error),
            };
            signal_if_current(target.identity, Ok(now), || {
                match process::kill_process(*pid, signal) {
                    // Job control cannot stop a descendant the OS forbids this user to signal.
                    Ok(()) | Err(Errno::SRCH) | Err(Errno::PERM) => Ok(()),
                    Err(error) => Err(error.into()),
                }
            })?;
        }
        Ok(())
    }

    pub fn forget(&mut self, pid: Pid) {
        self.0.remove(&pid);
        self.1.remove(&pid);
    }
    #[cfg(test)]
    pub(crate) fn knows(&self, pid: Pid) -> bool {
        self.0.contains_key(&pid)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty() && self.1.is_empty()
    }
}

pub fn children() -> io::Result<Vec<Pid>> {
    list_children(std::process::id())?
        .into_iter()
        .map(|pid| {
            Pid::from_raw(pid as i32)
                .ok_or_else(|| io::Error::other("invalid libproc direct child"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        process::{Child, Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    fn poll(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !condition() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
    }
    struct Fixture {
        child: Child,
        dir: PathBuf,
        worker: Option<Identity>,
        expected_escape: bool,
    }
    impl Fixture {
        fn new(mode: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("procward-darwin-{}-{mode}", std::process::id()));
            fs::create_dir(&dir).unwrap();
            let fixture = std::env::current_exe()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("examples/fixture");
            let child = Command::new(fixture)
                .arg(mode)
                .arg(&dir)
                .stdin(Stdio::null())
                .spawn()
                .unwrap();
            Self {
                child,
                dir,
                worker: None,
                expected_escape: false,
            }
        }
        fn remember(&mut self, name: &str) -> Pid {
            let path = self.dir.join(format!("{name}.pid"));
            poll(|| {
                path.try_exists().unwrap()
                    && fs::read_to_string(&path).unwrap().parse::<i32>().is_ok()
            });
            let pid = Pid::from_raw(fs::read_to_string(path).unwrap().parse().unwrap()).unwrap();
            self.worker = Some(current(pid).unwrap().unwrap());
            pid
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            if let Some(identity) = self.worker {
                let pid = Pid::from_raw(identity.pid as i32).unwrap();
                if current(pid).unwrap() == Some(identity) {
                    eprintln!(
                        "HARNESS RESCUE: Darwin known survivor {}, expected unseen-escape demonstration: {}; NOT product cleanup",
                        identity.pid, self.expected_escape
                    );
                    process::kill_process(pid, process::Signal::KILL).unwrap();
                    poll(|| match query(pid) {
                        Ok(None) => true,
                        Ok(Some(_)) => false,
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => false,
                        Err(error) => panic!("fixture reaping query failed: {error}"),
                    });
                    assert!(
                        self.expected_escape || thread::panicking(),
                        "observed fixture needed rescue"
                    );
                }
            }
            fs::remove_dir_all(&self.dir).unwrap();
        }
    }
    fn effective_uid(pid: Pid) -> Option<u32> {
        // SAFETY: SHORTBSDINFO writes proc_bsdshortinfo.
        unsafe { pid_info::<libc::proc_bsdshortinfo>(pid, libc::PROC_PIDT_SHORTBSDINFO) }
            .ok()
            .map(|info| info.pbsi_uid)
    }
    #[test]
    fn setuid_root_descendant_is_observed_without_failing_refresh() {
        let _guard = crate::owner::tests::PROCESS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // ps prints this argv, larger than any pipe buffer, so setuid-root ps stays blocked and observable.
        let mut holder = Command::new("/bin/sh")
            .args(["-c", "read line", "sh", &"x".repeat(256 * 1024)])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ps = Command::new("/bin/ps")
            .args(["-ww", "-o", "command=", "-p", &holder.id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = Pid::from_raw(ps.id() as i32).unwrap();
        poll(|| effective_uid(pid) == Some(0));
        let mut inventory = Inventory::new();
        let refreshed = inventory.refresh();
        let observed = inventory.0.get(&pid).map(|target| target.identity);
        let still_blocked = ps.try_wait().unwrap().is_none();
        ps.kill().unwrap();
        ps.wait().unwrap();
        holder.kill().unwrap();
        holder.wait().unwrap();
        refreshed.expect("setuid-root descendant made inventory refresh fail");
        assert!(still_blocked, "setuid-root ps finished before observation");
        let observed = observed.expect("setuid-root descendant missing from inventory");
        assert_eq!(
            (observed.pid, observed.uid, observed.real_uid),
            (
                pid.as_raw_nonzero().get() as u32,
                0,
                process::getuid().as_raw()
            )
        );
        let unique = unsafe {
            pid_info::<UniqueIdentifierInfo>(process::getpid(), PROC_PIDUNIQIDENTIFIERINFO)
        }
        .unwrap();
        assert_eq!(
            current(process::getpid()).unwrap().unwrap().birth,
            unique.unique_id,
            "birth must be the unique ID"
        );
    }
    #[test]
    fn known_orphan_keeps_ownership_after_setuid_exec() {
        let _guard = crate::owner::tests::PROCESS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("procward-darwin-orphan-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let mut holder = Command::new("/bin/sh")
            .args(["-c", "read line", "sh", &"x".repeat(256 * 1024)])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        // The subshell is observed with our credentials, orphaned, then execs setuid-root ps,
        // which blocks on the unread stdout pipe.
        let script = r#"(while [ ! -e "$1/go" ]; do sleep 0.01; done; exec /bin/ps -ww -o command= -p "$2") &
echo $! > "$1/pid.tmp" && mv "$1/pid.tmp" "$1/pid"
while [ ! -e "$1/exit" ]; do sleep 0.01; done"#;
        let mut intermediate = Command::new("/bin/sh")
            .args(["-c", script, "sh"])
            .arg(&dir)
            .arg(holder.id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let path = dir.join("pid");
        poll(|| path.try_exists().unwrap());
        let pid: Pid =
            Pid::from_raw(fs::read_to_string(&path).unwrap().trim().parse().unwrap()).unwrap();
        let mut inventory = Inventory::new();
        poll(|| {
            inventory.refresh().unwrap();
            inventory.0.contains_key(&pid)
        });
        let before = inventory.0[&pid].identity;
        fs::write(dir.join("exit"), b"go").unwrap();
        intermediate.wait().unwrap();
        fs::write(dir.join("go"), b"go").unwrap();
        poll(|| effective_uid(pid) == Some(0));
        let refreshed = inventory.refresh();
        let after = inventory.0.get(&pid).map(|target| target.identity);
        // Signal only this test's orphan, never other children of the test process.
        inventory.0.retain(|known, _| *known == pid);
        let advanced =
            refreshed.is_ok() && after.is_some() && inventory.advance(Phase::Kill, None).is_ok();
        if !advanced {
            let _ = process::kill_process(pid, process::Signal::KILL);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut killed = false;
        while Instant::now() < deadline {
            if matches!(current(pid), Ok(None)) {
                killed = true;
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        if !killed {
            let _ = process::kill_process(pid, process::Signal::KILL);
        }
        holder.kill().unwrap();
        holder.wait().unwrap();
        drop(intermediate);
        fs::remove_dir_all(&dir).unwrap();
        refreshed.unwrap();
        let after = after.expect("orphan was forgotten after setuid exec");
        assert_eq!((before.uid, after.uid), (process::getuid().as_raw(), 0));
        assert!(advanced, "advance failed for the known orphan");
        assert!(
            killed,
            "known orphan survived advance(Kill) after its setuid exec"
        );
    }
    #[test]
    fn denied_signal_keeps_privileged_target_as_known_survivor() {
        // xnu bsd/kern/kern_sig.c cansignal_nomac(): nobody, not even root, may signal initproc.
        let launchd = Pid::from_raw(1).unwrap();
        let identity = current(launchd).unwrap().unwrap();
        let mut inventory = Inventory::new();
        inventory.0.insert(
            launchd,
            Target {
                identity,
                term_sent: true,
                denied: false,
            },
        );
        inventory.advance(Phase::Kill, None).unwrap();
        assert!(inventory.0[&launchd].denied);
        assert!(!inventory.is_empty(), "unsignalable survivor was dropped");
    }
    #[test]
    fn same_user_and_other_user_paths_report_one_identity() {
        let me = process::getpid();
        assert_eq!(identify(me).unwrap(), identify_short(me).unwrap());
    }
    #[test]
    fn credential_change_follows_the_same_process_but_never_a_new_birth() {
        let saved = Identity {
            pid: 42,
            birth: 100,
            uid: 501,
            real_uid: 501,
            saved_uid: 501,
        };
        let mut target = Target {
            identity: saved,
            term_sent: true,
            denied: true,
        };
        let root = Identity { uid: 0, ..saved };
        assert!(target.follow(root));
        assert_eq!(target.identity, root);
        assert!(
            !target.term_sent && !target.denied,
            "new credentials need fresh signals"
        );
        assert!(!target.follow(Identity { birth: 101, ..root }));
        assert!(!target.follow(Identity { pid: 43, ..root }));
        assert_eq!(target.identity, root);
    }
    #[test]
    fn unknown_observation_blocks_completion_without_signal_authority() {
        let mut inventory = Inventory::new();
        inventory.1.insert(process::getpid());
        inventory.advance(Phase::Grace, None).unwrap();
        assert!(!inventory.is_empty());
        assert!(query(process::getpid()).unwrap().is_some());
    }
    #[test]
    fn changed_birth_pid_or_credentials_and_unknown_queries_never_authorize_signal() {
        let saved = Identity {
            pid: 42,
            birth: 100,
            uid: 501,
            real_uid: 501,
            saved_uid: 501,
        };
        for current in [
            Identity { pid: 43, ..saved },
            Identity {
                birth: 101,
                ..saved
            },
            Identity { uid: 0, ..saved },
            Identity {
                real_uid: 0,
                ..saved
            },
            Identity {
                saved_uid: 0,
                ..saved
            },
        ] {
            assert!(
                !signal_if_current(saved, Ok(Some(current)), || panic!(
                    "stale observation signalled unrelated work"
                ))
                .unwrap()
            );
        }
        assert!(
            signal_if_current(
                saved,
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied")),
                || panic!("unknown query authorized a signal")
            )
            .is_err()
        );
        let mut sent = false;
        assert!(
            signal_if_current(saved, Ok(Some(saved)), || {
                sent = true;
                Ok(())
            })
            .unwrap()
        );
        assert!(sent);
    }
    #[test]
    fn retained_observation_survives_setsid_and_reparenting_but_unseen_escape_is_explicit() {
        let _guard = crate::owner::tests::PROCESS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        {
            let mut fixture = Fixture::new("observed-tree");
            let worker = fixture.remember("observed-worker");
            let mut inventory = Inventory::new();
            poll(|| {
                inventory.refresh().unwrap();
                inventory.0.contains_key(&worker)
            });
            fs::write(fixture.dir.join("detach"), b"go").unwrap();
            poll(|| fixture.child.try_wait().unwrap().is_some());
            assert_eq!(fixture.child.wait().unwrap().code(), Some(23));
            poll(|| fs::metadata(fixture.dir.join("observed-detached")).is_ok());
            inventory.refresh().unwrap();
            assert!(
                inventory.0.contains_key(&worker),
                "reparenting lost observed identity"
            );
            inventory.advance(Phase::Grace, None).unwrap();
            poll(|| {
                inventory.refresh().unwrap();
                inventory.is_empty()
            });
        }
        {
            let mut fixture = Fixture::new("fast-escape");
            let worker = fixture.remember("escape-worker");
            poll(|| fixture.dir.join("escaped").try_exists().unwrap());
            fs::write(fixture.dir.join("exit-escape"), b"go").unwrap();
            poll(|| fixture.child.try_wait().unwrap().is_some());
            fixture.child.wait().unwrap();
            let mut inventory = Inventory::new();
            inventory.refresh().unwrap();
            assert!(!inventory.0.contains_key(&worker));
            assert!(
                query(worker).unwrap().is_some(),
                "escape fixture was not alive"
            );
            fixture.expected_escape = true;
            eprintln!(
                "EXPECTED MACOS LIMITATION: setsid/reparent before first observation escapes best-effort inventory; rescue follows separately"
            );
        }
        // Keep real child-owning cases sequential: concurrent inventories would own each other's fixtures.
        crate::owner::tests::retained_darwin_inventory_cleans_after_observer_loss();
    }
}
