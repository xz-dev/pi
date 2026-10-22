//! Session-only Darwin wake relay. Sibling of guardian, never in its frozen subtree.
//! Retains birth-validated inventory and owns cleanup if either old owner disappears.
use super::inventory::{Identity, Inventory};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

pub(super) struct Sockets {
    pub outer: UnixStream,
    pub observer: UnixStream,
    pub guardian: UnixStream,
    pub observer_guardian: UnixStream,
}
impl Sockets {
    pub(super) fn new() -> io::Result<Self> {
        let (outer, observer) = UnixStream::pair()?;
        let (guardian, observer_guardian) = UnixStream::pair()?;
        for stream in [&outer, &observer, &guardian, &observer_guardian] {
            stream.set_nonblocking(true)?;
        }
        Ok(Self {
            outer,
            observer,
            guardian,
            observer_guardian,
        })
    }
}
pub(super) use crate::job_control::lease_live as live;

fn pause(streams: &[&UnixStream]) -> io::Result<()> {
    let mut fds: Vec<_> = streams
        .iter()
        .map(|stream| libc::pollfd {
            fd: stream.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 25) } < 0
        && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) struct Guardian {
    pub stream: UnixStream,
    pub outer: Identity,
}
impl Guardian {
    pub(super) fn check(&self) -> io::Result<()> {
        match live(&self.stream) {
            Ok(true) => Ok(()),
            result => {
                crate::job_control::begin_cleanup(super::receive);
                // Arm the outer's cleanup protection before waking it into this failure.
                self.outer.signal(libc::SIGTERM)?;
                self.outer.signal(libc::SIGCONT)?;
                result.and(Err(io::Error::other("session wake observer lost")))
            }
        }
    }
}

pub(super) struct Outer {
    pub stream: UnixStream,
    pid: libc::pid_t,
    status: Option<i32>,
}
impl Outer {
    pub(super) fn new(stream: UnixStream, pid: libc::pid_t) -> Self {
        Self {
            stream,
            pid,
            status: None,
        }
    }
    pub(super) fn reply(&mut self, expected: u8) -> io::Result<()> {
        // Start after publication; read replies before checking elapsed time so an ordinary
        // default-action Ctrl-Z/fg cannot turn an already queued ACK into a false timeout.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut byte = [0];
            match self.stream.read(&mut byte) {
                Ok(1) if byte[0] == expected => return Ok(()),
                Ok(_) => {
                    return Err(io::Error::other(
                        "wake observer startup/identity acknowledgment lost",
                    ));
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                    ) => {}
                Err(error) => return Err(error),
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "wake observer acknowledgment timed out",
                ));
            }
            pause(&[&self.stream])?;
        }
    }
    pub(super) fn publish(&mut self, primary: Identity) -> io::Result<()> {
        let mut record = [0; 25];
        record[0] = b'P';
        record[1..].copy_from_slice(&primary.encode());
        self.stream.write_all(&record)?;
        self.reply(b'P')
    }
    pub(super) fn exited(&mut self) -> io::Result<bool> {
        if self.status.is_some() {
            return Ok(true);
        }
        let mut status = 0;
        let got = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
        if got == self.pid {
            self.status = Some(status);
        } else if got < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(io::Error::last_os_error());
        }
        Ok(self.status.is_some())
    }
    pub(super) fn finish(&mut self, deadline: Instant) -> io::Result<()> {
        if !self.exited()? {
            let _ = self.stream.write_all(b"D");
            // Only our held unreaped direct observer, never an ancestor or job group.
            if unsafe { libc::kill(self.pid, libc::SIGCONT) } != 0
                && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
            {
                return Err(io::Error::last_os_error());
            }
            let force = deadline
                .checked_sub(Duration::from_millis(250))
                .unwrap_or(deadline);
            while !self.exited()? {
                if Instant::now() >= force {
                    unsafe {
                        libc::kill(self.pid, libc::SIGKILL);
                    }
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "wake observer did not exit",
                    ));
                }
                pause(&[&self.stream])?;
            }
        }
        let status = self.status.unwrap();
        if !libc::WIFEXITED(status) || libc::WEXITSTATUS(status) != 0 {
            return Err(io::Error::other("session wake observer failed"));
        }
        Ok(())
    }
}

pub(super) fn observe(mut outer: UnixStream, guardian: UnixStream, outer_id: Identity) -> i32 {
    let mut primary: Option<Identity> = None;
    let mut inventory = Inventory::observer(outer_id);
    let mut normal = false;
    let result = (|| {
        if unsafe { libc::getpgrp() } != unsafe { libc::getpid() } {
            return Err(io::Error::other(
                "wake observer remained in foreground group",
            ));
        }
        if !live(&guardian)? {
            return Err(io::Error::other("guardian lost before observer ready"));
        }
        inventory.snapshot()?;
        outer.write_all(b"R")?;
        let mut record = [0; 25];
        let mut length = 0;
        loop {
            let wanted = if length == 0 { 1 } else { record.len() };
            match outer.read(&mut record[length..wanted]) {
                Ok(0) => break,
                Ok(n) => {
                    length += n;
                    if record[0] == b'D' {
                        normal = true;
                        return Ok(());
                    }
                    if record[0] != b'P' {
                        return Err(io::Error::other("invalid wake observer record"));
                    }
                    if length == record.len() {
                        if primary.is_some() {
                            return Err(io::Error::other("duplicate session primary identity"));
                        }
                        let held = Identity::decode(record[1..].try_into().unwrap())?;
                        if Identity::current(held.pid())? != held {
                            return Err(io::Error::other("session primary birth identity changed"));
                        }
                        inventory.seed(held)?;
                        inventory.snapshot()?;
                        primary = Some(held);
                        outer.write_all(b"P")?;
                        length = 0;
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                    ) => {}
                Err(error) => return Err(error),
            }
            inventory.snapshot()?;
            if !live(&guardian)? {
                break;
            }
            if super::SIGNALS.load(std::sync::atomic::Ordering::Relaxed)
                & ((1 << libc::SIGTERM)
                    | (1 << libc::SIGHUP)
                    | (1 << libc::SIGINT)
                    | (1 << libc::SIGQUIT))
                != 0
            {
                return Err(io::Error::other("wake observer interrupted"));
            }
            pause(&[&outer, &guardian])?;
        }
        Ok(())
    })();
    // Independent inventory retains observed ownership after both old owners die.
    // Queue TERM for the entire set before any CONT; Pi's worker wakes with Pi.
    let deadline = Instant::now()
        + if normal {
            Duration::from_secs(4)
        } else {
            Duration::from_millis(7500)
        };
    let clean = inventory.cleanup_after(
        if normal {
            Duration::from_millis(250)
        } else {
            Duration::from_secs(6)
        },
        deadline,
    );
    let wake = if normal {
        Ok(())
    } else {
        outer_id.signal(libc::SIGCONT)
    };
    match result.and(clean).and(wake) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("pi-env wake observer: {error}");
            125
        }
    }
}
