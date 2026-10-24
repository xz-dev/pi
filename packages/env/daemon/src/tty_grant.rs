//! Causal level production: a held-waiter witness precedes each level sample.
//! Q requests W(epoch, stopped); L(epoch, foreground) completes that production.
//! P retains the physical pause path. A(epoch, foreground) abandons a witness
//! interrupted by P before requesting a fresh witness after physical resume.
//! Only matching stopped epochs can resume; level alone never grants CONT.
use std::io::{self, Read, Write};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Witness {
    pub epoch: u64,
    pub paused: bool,
}
impl Witness {
    pub fn observe(&mut self, paused: bool) -> io::Result<()> {
        if paused {
            self.epoch = self
                .epoch
                .checked_add(1)
                .ok_or_else(|| io::Error::other("tty stop epoch exhausted"))?;
        }
        self.paused = paused;
        Ok(())
    }
    fn record(self, tag: u8, value: bool) -> [u8; 10] {
        let mut bytes = [0; 10];
        bytes[0] = tag;
        bytes[1..9].copy_from_slice(&self.epoch.to_be_bytes());
        bytes[9] = u8::from(value);
        bytes
    }
}

#[derive(Default)]
struct Frame {
    bytes: [u8; 10],
    length: usize,
}
impl Frame {
    fn read(
        &mut self,
        mut stream: impl Read,
        short: u8,
        long: u8,
    ) -> io::Result<Option<(u8, Witness)>> {
        loop {
            let end = if self.length == 0 || self.bytes[0] == short {
                1
            } else {
                10
            };
            match stream.read(&mut self.bytes[self.length..end]) {
                Ok(0) => return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
                Ok(n) => self.length += n,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
                Err(error) => return Err(error),
            }
            if !matches!(self.bytes[0], byte if byte == short || byte == long || (long == b'L' && byte == b'A'))
            {
                return Err(io::Error::other("invalid ordered tty frame"));
            }
            let end = if self.bytes[0] == short { 1 } else { 10 };
            if self.length == end {
                self.length = 0;
                if end == 1 {
                    return Ok(Some((short, Witness::default())));
                }
                if self.bytes[9] > 1 {
                    return Err(io::Error::other("invalid ordered tty state"));
                }
                return Ok(Some((
                    self.bytes[0],
                    Witness {
                        epoch: u64::from_be_bytes(self.bytes[1..9].try_into().unwrap()),
                        paused: self.bytes[9] == 1,
                    },
                )));
            }
        }
    }
}

#[derive(Default)]
pub(super) struct Consumer {
    frame: Frame,
    offered: Option<Witness>,
}
#[derive(Debug)]
pub(super) struct Level {
    pub resume: bool,
}
impl Consumer {
    pub const fn new() -> Self {
        Self {
            frame: Frame {
                bytes: [0; 10],
                length: 0,
            },
            offered: None,
        }
    }
    pub fn poll(
        &mut self,
        mut stream: impl Read + Write,
        mut witness: impl FnMut() -> io::Result<Witness>,
    ) -> io::Result<Option<Level>> {
        let mut latest = None;
        while let Some((tag, record)) = self.frame.read(&mut stream, b'Q', b'L')? {
            if tag == b'Q' {
                if self.offered.is_some() {
                    return Err(io::Error::other("duplicate tty witness request"));
                }
                let current = witness()?;
                stream.write_all(&current.record(b'W', current.paused))?;
                self.offered = Some(current);
            } else {
                let offered = self
                    .offered
                    .take()
                    .ok_or_else(|| io::Error::other("unwitnessed tty level"))?;
                if record.epoch != offered.epoch {
                    return Err(io::Error::other("invalid tty witness epoch"));
                }
                let current = witness()?;
                latest = Some((
                    offered.epoch,
                    Level {
                        resume: tag == b'L'
                            && offered.paused
                            && current.paused
                            && current.epoch == offered.epoch,
                    },
                ));
            }
        }
        if let Some((epoch, level)) = &mut latest {
            let current = witness()?;
            level.resume &= current.paused && current.epoch == *epoch;
        }
        Ok(latest.map(|(_, level)| level))
    }
}

#[derive(Default)]
pub(super) struct Producer {
    frame: Frame,
    requested: bool,
    ready: Option<Witness>,
    renew: bool,
}
impl Producer {
    /// Carrier publication gate and shared fresh/buffered input readiness.
    pub fn update(
        &mut self,
        stream: impl Write,
        published: &mut Option<bool>,
        foreground: bool,
    ) -> io::Result<bool> {
        if *published != Some(foreground) {
            // An unfinished operation cannot retain an older level's input permission.
            *published = self.publish(stream, foreground)?.then_some(foreground);
        }
        Ok(*published == Some(foreground))
    }

    /// Nonblocking: carrier still processes owner loss, signals, and output each tick.
    pub fn poll(&mut self, mut stream: impl Read) -> io::Result<bool> {
        let mut pause = false;
        while let Some((tag, witness)) = self.frame.read(&mut stream, b'P', b'W')? {
            if tag == b'P' {
                pause = true;
                self.renew |= self.requested;
            } else {
                if !self.requested || self.ready.is_some() {
                    return Err(io::Error::other("unexpected tty witness"));
                }
                self.ready = Some(witness);
            }
        }
        Ok(pause)
    }
    pub fn publish(&mut self, mut stream: impl Write, foreground: bool) -> io::Result<bool> {
        if let Some(witness) = self.ready.take() {
            let renew = std::mem::take(&mut self.renew);
            stream.write_all(&witness.record(if renew { b'A' } else { b'L' }, foreground))?;
            self.requested = false;
            if renew {
                stream.write_all(b"Q")?;
                self.requested = true;
                return Ok(false);
            }
            return Ok(true);
        }
        if !self.requested {
            stream.write_all(b"Q")?;
            self.requested = true;
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tty_handoff as tty;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;

    #[test]
    fn ordered_levels_follow_held_stop_epochs_and_actual_freeze() {
        const CHILD: &str = "PI_ORDERED_GRANT_TEST";
        if std::env::var_os(CHILD).is_none() {
            assert!(std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "tty_handoff::ordered::tests::ordered_levels_follow_held_stop_epochs_and_actual_freeze", "--nocapture"])
                .env(CHILD, "1").env("PI_PROCESS_OWNER_PENDING", "1").status().unwrap().success());
            return;
        }
        let (reader, mut carrier) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        carrier.set_nonblocking(true).unwrap();
        tty::PRIVATE
            .set(tty::Private {
                master: std::fs::File::open("/dev/null").unwrap(),
                grants: reader,
                slave: std::fs::File::open("/dev/null").unwrap(),
                redirect_stderr: false,
            })
            .ok()
            .unwrap();
        let (updates, mut physical) = UnixStream::pair().unwrap();
        physical.set_nonblocking(true).unwrap();
        tty::UPDATES.set(updates).ok().unwrap();
        crate::job_control::initialize()
            .unwrap()
            .activate(true)
            .unwrap();
        let mut producer = Producer::default();
        // Same E0/not-paused startup service used before Primary::spawn on Darwin.
        assert!(!producer.publish(&mut carrier, true).unwrap());
        assert_eq!(tty::ordered_grant(|| Ok(Witness::default())).unwrap(), None);
        assert!(!producer.poll(&mut carrier).unwrap());
        assert!(producer.publish(&mut carrier, true).unwrap());
        assert_eq!(
            tty::ordered_grant(|| Ok(Witness::default())).unwrap(),
            Some(false)
        );
        struct Held(std::process::Child, bool);
        impl Drop for Held {
            fn drop(&mut self) {
                if !self.1 {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
        }
        let mut child = Held(std::process::Command::new("/bin/sh")
            .args(["-c", "i=0; while [ $i -lt 5 ]; do read -r line; kill -TSTP $$; read -r line; i=$((i+1)); done; exit 23"])
            .stdin(std::process::Stdio::piped()).process_group(0).spawn().unwrap(), false);
        let (error, _writer) = UnixStream::pair().unwrap();
        let mut primary = crate::job_control::Primary::Session {
            pid: child.0.id() as i32,
            error,
            bytes: [0; 4],
            length: 0,
            started: true,
            status: None,
            witness: Witness::default(),
        };
        let mut state = crate::job_control::State::default();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut last_epoch = 0;
        for cycle in 0..4 {
            // COMPLETE production of a valid witnessed later G/B, then default STOP.
            assert!(!producer.publish(&mut carrier, cycle % 2 == 0).unwrap());
            assert_eq!(tty::grant_primary(&mut primary).unwrap(), None);
            producer.poll(&mut carrier).unwrap();
            assert!(producer.publish(&mut carrier, cycle % 2 == 0).unwrap());
            child
                .0
                .stdin
                .as_mut()
                .unwrap()
                .write_all(b"stop\n")
                .unwrap();
            loop {
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                assert_eq!(
                    unsafe {
                        libc::waitid(
                            libc::P_PID,
                            child.0.id(),
                            &mut info,
                            libc::WSTOPPED | libc::WNOWAIT | libc::WNOHANG,
                        )
                    },
                    0
                );
                if unsafe { info.si_pid() } != 0 {
                    break;
                }
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            primary.reconcile_pause().unwrap();
            let epoch = primary.witness().unwrap().epoch;
            assert!(epoch > last_epoch);
            last_epoch = epoch;
            assert_eq!(tty::grant_primary(&mut primary).unwrap(), Some(false));
            assert!(!tty::take_resume());
            assert!(crate::job_control::pause_requested());
            let mut operations = Vec::new();
            if cycle % 2 == 0 {
                state
                    .update(|paused| {
                        operations.push(paused);
                        if paused && cycle == 2 {
                            assert!(!producer.publish(&mut carrier, true).unwrap());
                            tty::grant_primary(&mut primary).unwrap();
                            producer.poll(&mut carrier).unwrap();
                            assert!(producer.publish(&mut carrier, true).unwrap());
                            tty::refresh_primary(&mut primary).unwrap();
                        }
                        Ok(())
                    })
                    .unwrap();
                assert_eq!(
                    operations,
                    if cycle == 2 {
                        vec![true, false]
                    } else {
                        vec![true]
                    }
                );
                let mut byte = [0];
                physical.read_exact(&mut byte).unwrap();
                assert_eq!(byte, *b"P");
            }
            // STOP precedes witness; matching level is queued before main State application.
            if cycle != 2 {
                assert!(!producer.publish(&mut carrier, cycle % 2 != 0).unwrap());
                tty::grant_primary(&mut primary).unwrap();
                producer.poll(&mut carrier).unwrap();
                assert!(producer.publish(&mut carrier, cycle % 2 != 0).unwrap());
                if cycle == 3 {
                    // A paused-E witness must not survive CONT followed by a new STOP.
                    assert_eq!(unsafe { libc::kill(primary.id() as i32, libc::SIGCONT) }, 0);
                    child
                        .0
                        .stdin
                        .as_mut()
                        .unwrap()
                        .write_all(b"resume\nstop\n")
                        .unwrap();
                    loop {
                        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                        assert_eq!(
                            unsafe {
                                libc::waitid(
                                    libc::P_PID,
                                    child.0.id(),
                                    &mut info,
                                    libc::WSTOPPED | libc::WNOWAIT | libc::WNOHANG,
                                )
                            },
                            0
                        );
                        if unsafe { info.si_pid() } != 0 {
                            break;
                        }
                        assert!(std::time::Instant::now() < deadline);
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    assert!(primary.witness().unwrap().epoch > epoch);
                    assert_eq!(tty::grant_primary(&mut primary).unwrap(), Some(false));
                    assert!(!tty::take_resume());
                    state
                        .update(|paused| {
                            assert!(paused);
                            Ok(())
                        })
                        .unwrap();
                    let mut byte = [0];
                    physical.read_exact(&mut byte).unwrap();
                    assert_eq!(byte, *b"P");
                    assert!(!producer.publish(&mut carrier, true).unwrap());
                    tty::grant_primary(&mut primary).unwrap();
                    producer.poll(&mut carrier).unwrap();
                    assert!(producer.publish(&mut carrier, true).unwrap());
                }
                tty::refresh_primary(&mut primary).unwrap();
            }
            operations.clear();
            state
                .update(|paused| {
                    operations.push(paused);
                    Ok(())
                })
                .unwrap();
            if cycle == 0 || cycle == 3 {
                assert_eq!(operations, [false]);
            } else {
                assert!(operations.is_empty());
            }
            assert!(!crate::job_control::pause_requested());
            assert!(tty::take_resume());
            assert!(!tty::take_resume());
            assert_eq!(unsafe { libc::kill(primary.id() as i32, libc::SIGCONT) }, 0);
            child
                .0
                .stdin
                .as_mut()
                .unwrap()
                .write_all(b"resume\n")
                .unwrap();
            // Consume CONT before next producer witness, using the same sole waiter.
            loop {
                if primary.observe_pause().unwrap() == Some(false) {
                    break;
                }
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        loop {
            primary.reconcile_pause().unwrap();
            if let Some(status) = primary.try_wait().unwrap() {
                child.1 = true;
                assert_eq!(status.code(), Some(23));
                assert!(!primary.witness().unwrap().paused);
                assert_eq!(primary.try_wait().unwrap(), Some(status));
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert_eq!(
            child.0.wait().unwrap_err().raw_os_error(),
            Some(libc::ECHILD)
        );
        eprintln!(
            "five real default-TSTP stops across four cycles: valid old epochs rejected; actual P/freeze; post-STOP G/B cancel before apply; resume once; terminal23/ECHILD/cache"
        );
    }

    #[test]
    fn pause_interrupts_witness_without_replaying_resume() {
        let (mut carrier, mut guardian) = UnixStream::pair().unwrap();
        carrier.set_nonblocking(true).unwrap();
        guardian.set_nonblocking(true).unwrap();
        let mut producer = Producer::default();
        let mut consumer = Consumer::default();
        let stopped = Witness {
            epoch: 1,
            paused: true,
        };
        assert!(!producer.publish(&mut carrier, true).unwrap());
        consumer.poll(&mut guardian, || Ok(stopped)).unwrap();
        guardian.write_all(b"P").unwrap();
        assert!(producer.poll(&mut carrier).unwrap());
        assert!(!producer.publish(&mut carrier, true).unwrap());
        assert!(
            !consumer
                .poll(&mut guardian, || Ok(stopped))
                .unwrap()
                .unwrap()
                .resume
        );
        assert!(!producer.poll(&mut carrier).unwrap());
        assert!(producer.publish(&mut carrier, true).unwrap());
        assert!(
            consumer
                .poll(&mut guardian, || Ok(stopped))
                .unwrap()
                .unwrap()
                .resume
        );
        guardian.write_all(&stopped.record(b'W', true)).unwrap();
        assert!(producer.poll(&mut carrier).is_err());
    }

    #[test]
    fn carrier_gate_completes_foreground_round_trip_before_input() {
        const CASE: &str = "PI_CARRIER_GATE_CASE";
        let Ok(case) = std::env::var(CASE) else {
            for case in ["stopped-inflight", "stopped-ready", "running-inflight"] {
                assert!(std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "tty_handoff::ordered::tests::carrier_gate_completes_foreground_round_trip_before_input", "--nocapture"])
                    .env(CASE, case).env("PI_PROCESS_OWNER_PENDING", "1").status().unwrap().success(), "{case}");
            }
            return;
        };
        crate::job_control::initialize()
            .unwrap()
            .activate(true)
            .unwrap();
        let (reader, mut carrier) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        carrier.set_nonblocking(true).unwrap();
        tty::PRIVATE
            .set(tty::Private {
                master: std::fs::File::open("/dev/null").unwrap(),
                grants: reader,
                slave: std::fs::File::open("/dev/null").unwrap(),
                redirect_stderr: false,
            })
            .ok()
            .unwrap();
        let (updates, mut physical) = UnixStream::pair().unwrap();
        physical.set_nonblocking(true).unwrap();
        tty::UPDATES.set(updates).ok().unwrap();
        let stopped = case.starts_with("stopped");
        struct Held(std::process::Child, bool);
        impl Drop for Held {
            fn drop(&mut self) {
                if !self.1 {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
        }
        let script = if stopped {
            "read -r line; kill -TSTP $$; read -r line; exit 23"
        } else {
            "read -r line; exit 23"
        };
        let mut held = Held(
            std::process::Command::new("/bin/sh")
                .args(["-c", script])
                .stdin(std::process::Stdio::piped())
                .process_group(0)
                .spawn()
                .unwrap(),
            false,
        );
        let (error, _writer) = UnixStream::pair().unwrap();
        let mut primary = crate::job_control::Primary::Session {
            pid: held.0.id() as i32,
            error,
            bytes: [0; 4],
            length: 0,
            started: true,
            status: None,
            witness: Witness::default(),
        };
        let mut producer = Producer::default();
        let mut published = None;
        // Exactly the gate/readiness function invoked by carry, not copied predicates.
        assert!(!producer.update(&mut carrier, &mut published, true).unwrap());
        tty::grant_primary(&mut primary).unwrap();
        producer.poll(&mut carrier).unwrap();
        assert!(producer.update(&mut carrier, &mut published, true).unwrap());
        assert_eq!(tty::grant_primary(&mut primary).unwrap(), Some(false));
        for _ in 0..3 {
            assert!(producer.update(&mut carrier, &mut published, true).unwrap());
        }
        assert!(!producer.requested);
        assert_eq!(
            (&tty::PRIVATE.get().unwrap().grants)
                .read(&mut [0])
                .unwrap_err()
                .kind(),
            io::ErrorKind::WouldBlock,
            "unchanged foreground must not emit Q"
        );
        // true -> false starts Q. Both physical.read and buffered master.write use this result.
        assert!(
            !producer
                .update(&mut carrier, &mut published, false)
                .unwrap()
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        if stopped {
            held.0.stdin.as_mut().unwrap().write_all(b"stop\n").unwrap();
            loop {
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                assert_eq!(
                    unsafe {
                        libc::waitid(
                            libc::P_PID,
                            held.0.id(),
                            &mut info,
                            libc::WSTOPPED | libc::WNOWAIT | libc::WNOHANG,
                        )
                    },
                    0
                );
                if unsafe { info.si_pid() } != 0 {
                    break;
                }
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        // Actual held child supplies W; main State application has not happened.
        assert_eq!(tty::grant_primary(&mut primary).unwrap(), None);
        let ready_before_return = case.ends_with("ready");
        let mut early_input_ready = false;
        if ready_before_return {
            producer.poll(&mut carrier).unwrap();
        } else {
            early_input_ready = producer.update(&mut carrier, &mut published, true).unwrap();
            producer.poll(&mut carrier).unwrap();
        }
        assert_eq!(producer.ready.unwrap().paused, stopped);
        let input_ready = producer.update(&mut carrier, &mut published, true).unwrap();
        let level = tty::grant_primary(&mut primary).unwrap();
        if level == Some(true) {
            crate::job_control::receive(libc::SIGCONT);
        }
        let mut freeze = Vec::new();
        crate::job_control::State::default()
            .update(|paused| {
                freeze.push(paused);
                Ok(())
            })
            .unwrap();
        let mut p = [0];
        let actual_p = physical.read(&mut p).ok() == Some(1) && p == *b"P";
        eprintln!(
            "{case}: early_input_ready={early_input_ready} input_ready={input_ready} level={level:?} freeze={freeze:?} actual_P={actual_p}"
        );
        assert_eq!(
            level,
            Some(stopped),
            "outstanding production must complete after foreground returns"
        );
        assert!(
            !early_input_ready,
            "fresh and buffered input must wait for completion"
        );
        assert!(input_ready);
        assert!(freeze.is_empty());
        assert!(!actual_p);
        assert_eq!(published, Some(true));
        assert!(!producer.requested);
        assert_eq!(tty::take_resume(), stopped);
        assert!(!tty::take_resume());
        for _ in 0..3 {
            assert!(producer.update(&mut carrier, &mut published, true).unwrap());
        }
        assert_eq!(
            (&tty::PRIVATE.get().unwrap().grants)
                .read(&mut [0])
                .unwrap_err()
                .kind(),
            io::ErrorKind::WouldBlock
        );
        if stopped {
            assert_eq!(unsafe { libc::kill(primary.id() as i32, libc::SIGCONT) }, 0);
        }
        held.0.stdin.as_mut().unwrap().write_all(b"exit\n").unwrap();
        loop {
            primary.reconcile_pause().unwrap();
            if let Some(status) = primary.try_wait().unwrap() {
                held.1 = true;
                assert_eq!(status.code(), Some(23));
                assert!(!primary.witness().unwrap().paused);
                assert_eq!(primary.try_wait().unwrap(), Some(status));
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert_eq!(
            held.0.wait().unwrap_err().raw_os_error(),
            Some(libc::ECHILD)
        );
    }

    #[test]
    fn framing_rejects_unwitnessed_duplicate_malformed_and_eof() {
        for bytes in [b"QQ".as_slice(), b"G", b"L\0\0\0\0\0\0\0\0\0", b"QX"] {
            let (mut reader, mut writer) = UnixStream::pair().unwrap();
            reader.set_nonblocking(true).unwrap();
            writer.write_all(bytes).unwrap();
            assert!(
                Consumer::default()
                    .poll(&mut reader, || Ok(Witness::default()))
                    .is_err()
            );
        }
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        let mut consumer = Consumer::default();
        writer.write_all(b"Q").unwrap();
        assert!(
            consumer
                .poll(&mut reader, || Ok(Witness::default()))
                .unwrap()
                .is_none()
        );
        let frame = Witness::default().record(b'L', true);
        writer.write_all(&frame[..4]).unwrap();
        assert!(
            consumer
                .poll(&mut reader, || Ok(Witness::default()))
                .unwrap()
                .is_none()
        );
        writer.write_all(&frame[4..]).unwrap();
        assert!(
            !consumer
                .poll(&mut reader, || Ok(Witness::default()))
                .unwrap()
                .unwrap()
                .resume
        );
        let mut reply = [0; 10];
        writer.read_exact(&mut reply).unwrap();
        drop(writer);
        assert_eq!(
            consumer
                .poll(&mut reader, || Ok(Witness::default()))
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut witness = Witness {
            epoch: u64::MAX,
            paused: false,
        };
        assert!(witness.observe(true).is_err());
    }
}
