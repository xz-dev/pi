// SPDX-License-Identifier: BSD-3-Clause
use crate::policy::{Phase, Progress, SignalIdentity};
use rustix::{
    io::Errno,
    process::{self, Pid, PidInfoFlags, Signal},
};
use std::{
    collections::{HashMap, HashSet},
    io,
};

pub struct Inventory(
    HashMap<Pid, (bool, SignalIdentity)>,
    Progress,
    HashSet<Option<Pid>>,
);

// cr_cansignal()/p_cansignal() refusal: still owned and awaited, never treated as gone.
fn report_denied(reported: &mut HashSet<Option<Pid>>, pid: Option<Pid>) {
    if reported.insert(pid) {
        let pid = pid.map_or_else(|| "(unnamed)".into(), |pid| pid.to_string());
        crate::diagnostic(format!(
            "FreeBSD denied signals to privileged descendant {pid}; it remains a known survivor"
        ));
    }
}

impl Inventory {
    pub fn new() -> Self {
        Self(HashMap::new(), Progress::default(), HashSet::new())
    }

    pub fn progress(&mut self) -> &mut Progress {
        &mut self.1
    }

    pub fn refresh(&mut self) -> io::Result<()> {
        process::get_reaper_status(None)?;
        for pid in children()? {
            if let std::collections::hash_map::Entry::Vacant(entry) = self.0.entry(pid) {
                if let Some(identity) = identity(pid)? {
                    entry.insert((false, identity));
                }
            }
        }
        Ok(())
    }

    pub fn advance(&mut self, phase: Phase, protected: Option<Pid>) -> io::Result<()> {
        if phase == Phase::Kill && protected.is_none() {
            // Kernel targets the entire owned subtree, including nested reapers.
            let result = match process::reaper_kill(None, Signal::KILL, false, None) {
                Ok(result) => result,
                Err(Errno::SRCH) => {
                    let remaining = process::get_reaper_pids(None)?;
                    if remaining.iter().all(|info| {
                        info.flags
                            .intersects(PidInfoFlags::ZOMBIE | PidInfoFlags::EXITING)
                    }) {
                        // No signalable member remains; wait/reaper facts still decide completion.
                        return Ok(());
                    }
                    return Err(Errno::SRCH.into());
                }
                // kern_procctl.c reap_kill_proc_locked(): rk_fpid and EPERM record a denial only
                // while nothing was signalled yet, so EPERM means every member was denied. rustix
                // drops rk_fpid on error, so that case is reported as (unnamed); a denied member
                // is named only when it precedes every successful signal in the kernel walk.
                Err(Errno::PERM) => {
                    report_denied(&mut self.2, None);
                    return Ok(());
                }
                Err(error) => return Err(error.into()),
            };
            // rk_fpid comes from any cr_cansignal() refusal (also prison/see_other_uids
            // visibility), all access-control decisions, so it is reported as a denial.
            if result.first_failed.is_some() {
                report_denied(&mut self.2, result.first_failed);
            }
            return Ok(());
        }
        for (pid, (sent, identity)) in &mut self.0 {
            if Some(*pid) == protected {
                continue;
            }
            // These direct children remain unreaped until after this call.
            for signal in self.1.signals(phase, *identity, sent)? {
                match process::kill_process(*pid, *signal) {
                    Ok(()) | Err(Errno::SRCH) => {}
                    Err(Errno::PERM) => {
                        report_denied(&mut self.2, Some(*pid));
                        break;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(())
    }

    pub fn empty_except(&self, pid: Pid) -> io::Result<bool> {
        Ok(process::get_reaper_pids(None)?
            .iter()
            .all(|info| info.pid == pid))
    }

    pub fn freeze(&mut self, paused: bool) -> io::Result<()> {
        let signal = if paused { Signal::STOP } else { Signal::CONT };
        // Job control cannot stop a descendant the OS forbids this user to signal.
        let denied = match process::reaper_kill(None, signal, false, None) {
            Ok(result) => result.first_failed.map(Some),
            Err(Errno::PERM) => Some(None),
            Err(error) => return Err(error.into()),
        };
        // kern_prot.c cr_cansignal(): with security.bsd.conservative_signals a set-ID
        // descendant accepts SIGSTOP but not SIGCONT, and PROC_REAP_KILL has no same-session
        // SIGCONT exemption. Never leave it stopped silently.
        // A denial after a success is not named (kern_procctl.c), so also report every member the
        // kernel still flags stopped (REAPER_PIDINFO_STOPPED from P_STOPPED) after the resume.
        if !paused {
            if let Some(pid) = denied {
                let pid = pid.map_or_else(|| "(unnamed)".into(), |pid| pid.to_string());
                crate::diagnostic(format!(
                    "FreeBSD denied SIGCONT to privileged descendant {pid}; it may remain stopped"
                ));
            }
            for info in process::get_reaper_pids(None)? {
                if info.flags.contains(PidInfoFlags::STOPPED) {
                    crate::diagnostic(format!(
                        "FreeBSD descendant {} is still stopped after resume",
                        info.pid
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn forget(&mut self, pid: Pid) {
        self.0.remove(&pid);
        self.2.remove(&Some(pid));
    }
}

pub fn children() -> io::Result<Vec<Pid>> {
    Ok(process::get_reaper_pids(None)?
        .into_iter()
        .filter(|info| info.flags.contains(PidInfoFlags::CHILD))
        .map(|info| info.pid)
        .collect())
}

fn identity(pid: Pid) -> io::Result<Option<SignalIdentity>> {
    let mut mib = [
        libc::CTL_KERN,
        libc::KERN_PROC,
        libc::KERN_PROC_PID,
        pid.as_raw_nonzero().get(),
    ];
    let mut info: libc::kinfo_proc = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of_val(&info);
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as _,
            (&mut info as *mut libc::kinfo_proc).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if size == 0 {
        return Ok(None);
    }
    if size != std::mem::size_of_val(&info) || info.ki_pid != pid.as_raw_nonzero().get() {
        return Err(io::Error::other("invalid FreeBSD child identity"));
    }
    Ok(Some([
        info.ki_pid as u64,
        info.ki_start.tv_sec as u64,
        info.ki_start.tv_usec as u64,
        0,
        0,
    ]))
}
