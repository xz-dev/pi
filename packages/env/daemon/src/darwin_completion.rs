//! Internal Darwin completion lease, independent of the cleanup acknowledgment C.
use std::io::{self, Read};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Completion {
    Normal,
    Fatal,
}
impl Completion {
    pub(crate) fn record(fatal: bool) -> &'static [u8] {
        if fatal { b"F" } else { b"N" }
    }

    pub(crate) fn finish_record(fatal: bool) -> &'static [u8] {
        if fatal { b"F" } else { b"D" }
    }
}

#[derive(Default)]
pub(crate) struct CompletionLease {
    marker: Option<Completion>,
}
impl CompletionLease {
    /// Drain queued records before classifying EOF; absent/duplicate markers fail closed.
    pub(crate) fn poll(
        &mut self,
        mut reader: impl Read,
        outer_done: bool,
    ) -> io::Result<Option<Completion>> {
        let mut byte = [0];
        loop {
            match reader.read(&mut byte) {
                Ok(0) => {
                    return self
                        .marker
                        .map(Some)
                        .ok_or_else(|| io::Error::other("guardian completion marker missing"));
                }
                Ok(_) if self.marker.is_none() => {
                    self.marker = Some(match byte[0] {
                        b'N' => Completion::Normal,
                        b'F' => Completion::Fatal,
                        _ => return Err(io::Error::other("invalid guardian completion marker")),
                    });
                }
                Ok(_) => return Err(io::Error::other("duplicate guardian completion marker")),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    return if outer_done {
                        Err(io::Error::other(
                            "observer finish before guardian completion EOF",
                        ))
                    } else {
                        Ok(None)
                    };
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
    }
}

pub(crate) fn fatal_status(status: i32) -> bool {
    libc::WIFSIGNALED(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    #[test]
    fn healthy_eof_before_outer_done_preserves_normal_nonzero_status() {
        let (reader, mut guardian) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        let mut lease = CompletionLease::default();
        assert_eq!(lease.poll(&reader, false).unwrap(), None);
        guardian.write_all(Completion::record(false)).unwrap();
        drop(guardian); // Outer has not sent D, observer runs first.
        assert_eq!(
            lease.poll(&reader, false).unwrap(),
            Some(Completion::Normal)
        );
        assert!(!fatal_status(23 << 8));
    }

    #[test]
    fn fatal_cleanup_ack_and_outer_done_cannot_make_signal_normal() {
        let (reader, mut guardian) = UnixStream::pair().unwrap();
        guardian.write_all(Completion::record(true)).unwrap();
        drop(guardian);
        let status = libc::SIGTERM; // Outer handles C and raw status before observer's D.
        assert!(fatal_status(status));
        assert_eq!(
            CompletionLease::default().poll(&reader, true).unwrap(),
            Some(Completion::Fatal)
        );
    }

    #[test]
    fn outer_done_cannot_bypass_marker_validation_or_live_lease() {
        let (reader, mut guardian) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        let mut lease = CompletionLease::default();
        guardian.write_all(b"N").unwrap();
        assert_eq!(lease.poll(&reader, false).unwrap(), None);
        assert!(lease.poll(&reader, true).is_err());
        drop(guardian);
        assert_eq!(lease.poll(&reader, true).unwrap(), Some(Completion::Normal));
    }

    #[test]
    fn missing_malformed_and_duplicate_completion_fail_closed() {
        for bytes in [b"".as_slice(), b"C", b"NN", b"NF", b"NX"] {
            let (reader, mut guardian) = UnixStream::pair().unwrap();
            guardian.write_all(bytes).unwrap();
            drop(guardian);
            assert!(CompletionLease::default().poll(&reader, true).is_err());
        }
    }
}

/// Select completion only after checking the independent physical owner's stream.
#[derive(Default)]
pub(crate) struct Observer {
    completion: CompletionLease,
    record: [u8; 25],
    length: usize,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Event {
    Pending,
    Primary([u8; 24]),
    Normal,
}
impl Observer {
    pub(crate) fn poll(
        &mut self,
        mut outer: impl Read,
        mut guardian: impl Read,
    ) -> io::Result<Event> {
        // N proves only private completion; keep watching the independent owner until D.
        if self.completion.poll(&mut guardian, false)? == Some(Completion::Fatal) {
            return Err(io::Error::other("guardian completed fatal shutdown"));
        }
        let wanted = if self.length == 0 {
            1
        } else {
            self.record.len()
        };
        match outer.read(&mut self.record[self.length..wanted]) {
            Ok(0) => return Err(io::Error::other("physical owner lease closed")),
            Ok(n) => {
                self.length += n;
                if self.record[0] == b'F' {
                    return Err(io::Error::other("physical owner completed fatal shutdown"));
                }
                if self.record[0] == b'D' {
                    return if self.completion.poll(&mut guardian, true)? == Some(Completion::Normal)
                    {
                        Ok(Event::Normal)
                    } else {
                        Err(io::Error::other(
                            "normal observer finish without normal completion",
                        ))
                    };
                }
                if self.record[0] != b'P' {
                    return Err(io::Error::other("invalid wake observer record"));
                }
                if self.length == self.record.len() {
                    self.length = 0;
                    return Ok(Event::Primary(self.record[1..].try_into().unwrap()));
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) => {}
            Err(error) => return Err(error),
        }
        Ok(Event::Pending)
    }
}

#[cfg(test)]
mod observer_tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    #[test]
    fn normal_private_eof_cannot_hide_independent_physical_eof() {
        let (outer, owner) = UnixStream::pair().unwrap();
        let (guardian, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(b"N").unwrap();
        drop(writer);
        drop(owner);
        assert!(Observer::default().poll(&outer, &guardian).is_err());
    }

    #[test]
    fn normal_private_eof_waits_for_explicit_healthy_finish() {
        let (outer, mut owner) = UnixStream::pair().unwrap();
        outer.set_nonblocking(true).unwrap();
        let (guardian, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(b"N").unwrap();
        drop(writer);
        let mut observer = Observer::default();
        assert_eq!(observer.poll(&outer, &guardian).unwrap(), Event::Pending);
        owner.write_all(Completion::finish_record(false)).unwrap();
        assert_eq!(observer.poll(&outer, &guardian).unwrap(), Event::Normal);
        assert!(!fatal_status(23 << 8));
    }

    #[test]
    fn fatal_owner_finish_cannot_be_hidden_by_normal_private_completion() {
        for finish in [Completion::finish_record(true), b"FD"] {
            let (outer, mut owner) = UnixStream::pair().unwrap();
            let (guardian, mut writer) = UnixStream::pair().unwrap();
            writer.write_all(b"N").unwrap();
            owner.write_all(finish).unwrap();
            drop(writer);
            assert!(Observer::default().poll(&outer, &guardian).is_err());
        }
    }

    #[test]
    fn physical_eof_after_private_normal_retains_failure_with_default_stopped_carrier() {
        use std::os::unix::process::CommandExt;
        struct Held(std::process::Child);
        impl Drop for Held {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut carrier = Held(
            std::process::Command::new("/bin/sh")
                .args(["-c", "kill -TSTP $$; read -r line"])
                .stdin(std::process::Stdio::piped())
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let mut status = 0;
            let got = unsafe {
                libc::waitpid(
                    carrier.0.id() as i32,
                    &mut status,
                    libc::WUNTRACED | libc::WNOHANG,
                )
            };
            if got != 0 {
                assert_eq!(got, carrier.0.id() as i32);
                assert!(libc::WIFSTOPPED(status));
                assert_eq!(libc::WSTOPSIG(status), libc::SIGTSTP);
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "carrier did not default-TSTP"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let (outer, owner) = UnixStream::pair().unwrap();
        let (guardian, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(Completion::record(false)).unwrap();
        drop(writer);
        drop(owner);
        // Same selector used by observe(): Err leaves normal=false and takes its fatal wake.
        assert!(Observer::default().poll(&outer, &guardian).is_err());
        // Exercise the existing held-carrier TERM-before-CONT action, not a rescue signal.
        assert_eq!(
            unsafe { libc::kill(carrier.0.id() as i32, libc::SIGTERM) },
            0
        );
        assert_eq!(
            unsafe { libc::kill(carrier.0.id() as i32, libc::SIGCONT) },
            0
        );
        use std::os::unix::process::ExitStatusExt;
        loop {
            if let Some(status) = carrier.0.try_wait().unwrap() {
                assert_eq!(status.signal(), Some(libc::SIGTERM));
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "carrier wake did not finish"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    #[test]
    fn healthy_finish_preserves_full_tail_and_normal_23() {
        let carrier = std::process::Command::new("/bin/sh")
            .args(["-c", "printf 'tail-start\\n'; head -c 131072 /dev/zero; printf '\\ntail-end\\n'; exit 23"])
            .stdout(std::process::Stdio::piped()).spawn().unwrap();
        let (outer, mut owner) = UnixStream::pair().unwrap();
        let (guardian, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(Completion::record(false)).unwrap();
        drop(writer);
        owner.write_all(Completion::finish_record(false)).unwrap();
        assert_eq!(
            Observer::default().poll(&outer, &guardian).unwrap(),
            Event::Normal
        );
        let output = carrier.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(23));
        assert!(output.stdout.starts_with(b"tail-start\n"));
        assert!(output.stdout.ends_with(b"\ntail-end\n"));
        assert_eq!(
            output.stdout.len(),
            131072 + b"tail-start\n\ntail-end\n".len()
        );
    }

    #[test]
    fn healthy_finish_cannot_hide_fatal_missing_malformed_or_duplicate_private_marker() {
        for marker in [b"F".as_slice(), b"", b"C", b"NN", b"NF"] {
            let (outer, mut owner) = UnixStream::pair().unwrap();
            let (guardian, mut writer) = UnixStream::pair().unwrap();
            writer.write_all(marker).unwrap();
            owner.write_all(b"D").unwrap();
            drop(writer);
            assert!(Observer::default().poll(&outer, &guardian).is_err());
        }
    }
}
