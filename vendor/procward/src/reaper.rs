// SPDX-License-Identifier: BSD-3-Clause
use crate::{
    config::Config,
    inventory::{Inventory, children},
    policy::{Phase, Policy},
};
use process_wrap::std::{CommandWrap, ProcessGroup};
use rustix::{
    io::Errno,
    process::{self, Pid, WaitId, WaitIdOptions, WaitOptions},
};
use signal_hook::{
    consts::{SIGCHLD, SIGHUP, SIGINT, SIGTERM},
    iterator::Signals,
};
use std::{
    ffi::{OsStr, OsString},
    io,
    process::Command,
    thread,
    time::Duration,
};

pub fn acquire() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    process::set_child_subreaper(Some(Pid::INIT))?;
    #[cfg(target_os = "freebsd")]
    {
        process::set_reaper_status(true)?;
        if !process::get_reaper_status(None)?
            .flags
            .contains(process::ReaperStatusFlags::OWNED)
        {
            return Err(io::Error::other("required FreeBSD reaper was not acquired"));
        }
    }
    Ok(())
}

pub fn run_owned(
    command: &OsStr,
    args: &[OsString],
    lease: &rustix::fd::OwnedFd,
    notice: &rustix::fd::OwnedFd,
    config: Config,
) -> io::Result<u8> {
    acquire()?;
    #[cfg(target_os = "linux")]
    let scope = crate::cgroup::Scope::inherited()?;
    let mut terminal =
        if std::env::var_os("PROCWARD_PRIVATE_TASK").as_deref() == Some(OsStr::new("1")) {
            None
        } else {
            crate::terminal::Terminal::open(notice)?
        };
    let mut signals = Signals::new([
        SIGCHLD,
        SIGHUP,
        SIGINT,
        SIGTERM,
        signal_hook::consts::SIGTTIN,
        signal_hook::consts::SIGTTOU,
        signal_hook::consts::SIGTSTP,
        signal_hook::consts::SIGCONT,
    ])?;
    // A background anchor's TOSTOP-denied diagnostic fails once instead of restarting.
    #[cfg(target_os = "linux")]
    crate::terminal::interrupt_job_control()?;
    children()?;
    let mut handoff = if terminal.is_none() {
        Some(crate::contract::Handoff::new()?)
    } else {
        None
    };
    let mut payload = if let Some(terminal) = &mut terminal {
        terminal.command(command, args, config.deadline)?
    } else {
        let mut payload = Command::new(command);
        payload.args(args);
        #[cfg(target_os = "linux")]
        if scope.is_some() {
            // A trusted stage joins the group before the untrusted command can fork.
            payload = Command::new(std::env::current_exe()?);
            payload.arg("__cgroup_exec").arg(command).args(args);
        }
        payload
    };
    #[cfg(target_os = "linux")]
    {
        payload.env_remove(crate::cgroup::ENV);
        if let Some(scope) = &scope {
            scope.pass(&mut payload);
        }
    }
    crate::contract::clear(&mut payload);
    payload.env_remove("PROCWARD_PRIVATE_TASK");
    if let Some(handoff) = &handoff {
        payload.envs(handoff.environment()?);
    }
    if !crate::owner::alive(lease)? {
        return Err(io::Error::other(
            "owner lost before payload launch permission",
        ));
    }
    // No pre_exec on the untrusted command: libc execvp adds an ENOEXEC shell fallback.
    let child = if terminal.is_some() {
        CommandWrap::from(payload).spawn()?
    } else {
        CommandWrap::from(payload)
            .wrap(ProcessGroup::leader())
            .spawn()?
    };
    let primary = Pid::from_raw(child.id() as i32).expect("spawn returned a positive PID");
    let ready = handoff
        .as_mut()
        .map_or(Ok(()), |handoff| handoff.ready(child.id()));
    let mut inventory = Inventory::new();
    #[cfg(target_os = "linux")]
    if let Some(scope) = scope {
        inventory.own(scope);
    }
    inventory.progress().publish_to(notice)?;
    let mut result = None;
    let mut requested = None;
    let mut owner_lost = false;
    let mut paused = false;
    let mut waiting_resume = false;
    let observed = (|| -> io::Result<()> {
        loop {
            if !paused {
                if let Some(terminal) = &mut terminal {
                    terminal.pump()?;
                }
            }
            inventory.refresh()?;
            let (alive, acknowledged) = crate::owner::lease_state(lease)?;
            if acknowledged {
                waiting_resume = false;
            }
            if !alive {
                owner_lost = true;
                return Ok(());
            }
            if let Some(terminal) = &mut terminal {
                if let Some(code) = terminal.result()? {
                    result = Some(code);
                    let _ = rustix::io::write(notice, &[b'X', code]);
                    return Ok(());
                }
            }
            match process::waitid(
                WaitId::Pid(primary),
                WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
            ) {
                Ok(Some(status)) => {
                    if let Some(code) = status
                        .exit_status()
                        .or_else(|| status.terminating_signal().map(|signal| 128 + signal))
                    {
                        result = Some(code as u8);
                        let _ = rustix::io::write(notice, &[b'X', code as u8]);
                        return Ok(());
                    }
                    // Darwin can return a nonterminal/empty notification with WNOHANG.
                    // Stopped/continued work is still alive and must retain ownership.
                    if status.raw_code() != 0
                        && !status.stopped()
                        && !status.continued()
                        && !status.trapped()
                    {
                        return Err(io::Error::other(format!(
                            "unexpected waitid code {}",
                            status.raw_code()
                        )));
                    }
                }
                Ok(None) | Err(Errno::INTR) => {}
                Err(error) => return Err(error.into()),
            }
            reap_adopted(primary, &mut inventory)?;
            // Fatal requests select one immutable policy now, even if primary ignores TERM.
            let events: Vec<_> = signals.pending().collect();
            if let Some(signal) = events
                .iter()
                .copied()
                .find(|signal| matches!(*signal, SIGHUP | SIGINT | SIGTERM))
            {
                requested = Some(signal);
                return Ok(());
            }
            if let Some(terminal) = &mut terminal {
                let was_paused = paused;
                let stop =
                    terminal.pause_requested() || events.contains(&signal_hook::consts::SIGTSTP);
                let resume = events.contains(&signal_hook::consts::SIGCONT);
                if resume && paused {
                    inventory.freeze(false)?;
                    paused = false;
                    waiting_resume = true;
                    rustix::io::write(notice, b"R")?;
                }
                if stop && !was_paused {
                    inventory.freeze(true)?;
                    terminal.restore()?;
                    paused = true;
                    waiting_resume = false;
                    if rustix::io::write(notice, b"S")? != 1 {
                        return Err(io::Error::other("incomplete native pause acknowledgement"));
                    }
                }
                if paused {
                    inventory.freeze(true)?;
                } else if waiting_resume {
                    // Own live group anchors identity; repeat until outer acknowledges its STOP returned.
                    process::kill_process_group(process::getpgrp(), process::Signal::CONT)?;
                }
            }
            if let Some(terminal) = &terminal {
                terminal.wait(lease, !paused)?;
            } else {
                thread::sleep(Duration::from_millis(5));
            }
        }
    })();
    let policy = Policy::new(config, false);
    let published = crate::owner::publish(notice, policy);
    let notified = if owner_lost || requested.is_some() || observed.is_err() {
        handoff
            .as_mut()
            .map_or(Ok(()), |handoff| handoff.owner_lost())
    } else {
        Ok(())
    };
    let forwarded = match requested {
        Some(signal) => child.signal(signal),
        None => Ok(()),
    };
    let mut fatal = observed.is_err() || requested.is_some() || owner_lost;
    let result_sent = result.is_some();
    cleanup(
        &mut inventory,
        Some(primary),
        &mut result,
        policy,
        |inventory| {
            if let Some(terminal) = &mut terminal {
                if !fatal {
                    if !crate::owner::alive(lease)?
                        || signals
                            .pending()
                            .any(|signal| matches!(signal, SIGHUP | SIGINT | SIGTERM))
                    {
                        fatal = true;
                    } else {
                        terminal.drain()?;
                        if inventory.empty_except(primary)? {
                            terminal.release_if_drained()?;
                        }
                        terminal.wait(lease, true)?;
                        return Ok(Some(primary));
                    }
                }
            }
            Ok(None)
        },
    )?;
    // Cleanup confirmed the group empty. A lost owner can no longer remove it, so this
    // surviving anchor does; a live owner keeps removal after its own completion check.
    #[cfg(target_os = "linux")]
    if owner_lost || matches!(crate::owner::alive(lease), Ok(false)) {
        inventory.arm_orphan_removal();
    }
    if !result_sent {
        if let Some(code) = result {
            let _ = rustix::io::write(notice, &[b'X', code]);
        }
    }
    if let Some(terminal) = &mut terminal {
        if !fatal {
            terminal.finish_output();
            while !terminal.drained() {
                if !crate::owner::alive(lease)?
                    || signals
                        .pending()
                        .any(|s| matches!(s, SIGHUP | SIGINT | SIGTERM))
                {
                    break;
                }
                terminal.drain()?;
                if !terminal.drained() {
                    terminal.wait(lease, true)?;
                }
            }
        }
        terminal.restore()?;
    }
    if let Err(error) = published {
        if !owner_lost || error.raw_os_error() != Some(Errno::PIPE.raw_os_error()) {
            return Err(error);
        }
    }
    ready?;
    notified?;
    forwarded?;
    observed?;
    if owner_lost {
        return Ok(125);
    }
    result.ok_or_else(|| io::Error::other("primary result missing after cleanup"))
}

fn reap_adopted(primary: Pid, inventory: &mut Inventory) -> io::Result<()> {
    for pid in children()? {
        if pid != primary {
            match process::waitpid(Some(pid), WaitOptions::NOHANG) {
                Ok(Some((_, status)))
                    if status.exit_status().is_some() || status.terminating_signal().is_some() =>
                {
                    inventory.forget(pid)
                }
                Ok(Some(_)) | Ok(None) | Err(Errno::INTR) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
}

pub(crate) fn cleanup(
    inventory: &mut Inventory,
    primary: Option<Pid>,
    result: &mut Option<u8>,
    policy: Policy,
    mut before_advance: impl FnMut(&mut Inventory) -> io::Result<Option<Pid>>,
) -> io::Result<()> {
    // Every Linux walk inside a pass also stops at this original deadline.
    #[cfg(target_os = "linux")]
    inventory.bound(policy);
    'cleanup: loop {
        let phase = policy.phase(crate::policy::now());
        if phase == Phase::Expired {
            return Err(io::Error::other(
                "cleanup deadline expired: owned children remain",
            ));
        }
        inventory.refresh()?;
        let protected = before_advance(inventory)?;
        inventory.advance(phase, protected)?;
        // Drain ready exits before another tree walk; rescanning for every zombie makes
        // teardown quadratic and can spend the whole deadline after the work already died.
        loop {
            if policy.phase(crate::policy::now()) == Phase::Expired {
                continue 'cleanup;
            }
            match process::wait(WaitOptions::NOHANG) {
                Ok(Some((pid, status))) => {
                    if let Some(code) = status
                        .exit_status()
                        .or_else(|| status.terminating_signal().map(|signal| 128 + signal))
                    {
                        inventory.forget(pid);
                        if Some(pid) == primary {
                            if let Some(expected) =
                                result.filter(|expected| *expected != code as u8)
                            {
                                return Err(io::Error::other(format!(
                                    "terminal keeper result mismatch: expected {expected}, got {code}, phase {phase:?}"
                                )));
                            }
                            *result = Some(code as u8);
                        }
                    } else if !status.stopped() && !status.continued() {
                        return Err(io::Error::other("unexpected nonterminal child wait status"));
                    }
                    continue;
                }
                Err(Errno::INTR) => continue,
                Err(Errno::CHILD) => {
                    // No reapable child is not enough while the owned workload group is populated.
                    #[cfg(target_os = "linux")]
                    if !inventory.settled()? {
                        thread::sleep(Duration::from_millis(5));
                        continue 'cleanup;
                    }
                    #[cfg(target_os = "macos")]
                    if !inventory.is_empty() {
                        thread::sleep(Duration::from_millis(5));
                        continue 'cleanup;
                    }
                    return Ok(());
                }
                Err(error) => return Err(error.into()),
                Ok(None) => break,
            }
        }
        if protected.is_some() {
            thread::yield_now();
        } else {
            thread::sleep(Duration::from_millis(5));
        }
    }
}
