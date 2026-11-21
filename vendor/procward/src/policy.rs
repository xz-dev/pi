// SPDX-License-Identifier: BSD-3-Clause
use crate::config::Config;
use rustix::process::Signal;
use std::{collections::HashSet, io, time::Duration};

// PID, birth (seconds/ticks and subsecond), and platform identity credentials.
pub type SignalIdentity = [u64; 5];

#[derive(Default)]
pub struct Progress {
    notice: Option<rustix::fd::OwnedFd>,
    inherited: HashSet<SignalIdentity>,
}
impl Progress {
    pub fn publish_to(&mut self, notice: &rustix::fd::OwnedFd) -> io::Result<()> {
        self.notice = Some(rustix::io::fcntl_dupfd_cloexec(notice, 3)?);
        Ok(())
    }
    pub fn inherit(&mut self, sent: HashSet<SignalIdentity>) {
        self.inherited = sent;
    }
    pub fn signals(
        &self,
        phase: Phase,
        identity: SignalIdentity,
        sent: &mut bool,
    ) -> io::Result<&'static [Signal]> {
        if self.inherited.contains(&identity) {
            *sent = true;
        }
        if phase == Phase::Grace && !*sent {
            if let Some(notice) = &self.notice {
                let mut bytes = [0; RECORD_LEN];
                bytes[..4].copy_from_slice(b"PWT1");
                for (slot, value) in bytes[8..].chunks_exact_mut(8).zip(identity) {
                    slot.copy_from_slice(&value.to_le_bytes());
                }
                // Reserve the one TERM/CONT before sending: a dead anchor cannot replay it.
                loop {
                    match rustix::io::write(notice, &bytes) {
                        Ok(RECORD_LEN) | Err(rustix::io::Errno::PIPE) => break,
                        Err(rustix::io::Errno::INTR) => continue,
                        Err(rustix::io::Errno::AGAIN) => return Ok(&[]),
                        Ok(_) => return Err(io::Error::other("partial native signal progress")),
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        }
        Ok(next_signals(phase, sent))
    }
}

pub fn progress_record(bytes: &[u8; RECORD_LEN]) -> io::Result<SignalIdentity> {
    if &bytes[..4] != b"PWT1" || bytes[4..8] != [0; 4] {
        return Err(io::Error::other("invalid native signal progress record"));
    }
    Ok(std::array::from_fn(|index| {
        u64::from_le_bytes(bytes[8 + index * 8..16 + index * 8].try_into().unwrap())
    }))
}

pub const RECORD_LEN: usize = 48;
#[derive(Clone, Copy, Debug)]
pub struct Policy {
    start: Duration,
    config: Config,
    fatal_saved: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Grace,
    Kill,
    Expired,
}

pub fn now() -> Duration {
    let time = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
    Duration::new(time.tv_sec as u64, time.tv_nsec as u32)
}
impl Policy {
    pub fn new(config: Config, fatal_saved: bool) -> Self {
        Self::at(now(), config, fatal_saved)
    }
    fn at(start: Duration, config: Config, fatal_saved: bool) -> Self {
        Self {
            start,
            config,
            fatal_saved,
        }
    }
    pub fn phase(&self, now: Duration) -> Phase {
        let elapsed = now.saturating_sub(self.start);
        let grace = if self.fatal_saved {
            self.config.fatal_grace
        } else {
            self.config.grace
        };
        if elapsed >= self.config.deadline {
            Phase::Expired
        } else if elapsed >= grace {
            Phase::Kill
        } else {
            Phase::Grace
        }
    }
    pub fn record(self) -> [u8; RECORD_LEN] {
        let mut bytes = [0; RECORD_LEN];
        bytes[..4].copy_from_slice(b"PWP1");
        bytes[4..12].copy_from_slice(&self.start.as_secs().to_le_bytes());
        bytes[12..16].copy_from_slice(&self.start.subsec_nanos().to_le_bytes());
        bytes[16..24].copy_from_slice(&(self.config.grace.as_millis() as u64).to_le_bytes());
        bytes[24..32].copy_from_slice(&(self.config.fatal_grace.as_millis() as u64).to_le_bytes());
        bytes[32..40].copy_from_slice(&(self.config.deadline.as_millis() as u64).to_le_bytes());
        bytes[40] = u8::from(self.fatal_saved);
        bytes
    }
    pub fn from_record(bytes: &[u8; RECORD_LEN], expected: Config) -> io::Result<Self> {
        let u64_at = |start| u64::from_le_bytes(bytes[start..start + 8].try_into().unwrap());
        let nanos = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        if &bytes[..4] != b"PWP1"
            || nanos >= 1_000_000_000
            || bytes[40] > 1
            || bytes[41..].iter().any(|byte| *byte != 0)
        {
            return Err(io::Error::other("invalid native cleanup policy record"));
        }
        let config =
            Config::from_millis(u64_at(16), u64_at(24), u64_at(32)).map_err(io::Error::other)?;
        let start = Duration::new(u64_at(4), nanos);
        if config != expected || start > now() {
            return Err(io::Error::other(
                "native cleanup policy disagrees with launch configuration/clock",
            ));
        }
        Ok(Self::at(start, config, bytes[40] == 1))
    }
}
pub fn next_signals(phase: Phase, term_sent: &mut bool) -> &'static [Signal] {
    match phase {
        Phase::Grace if !*term_sent => {
            *term_sent = true;
            &[Signal::TERM, Signal::CONT]
        }
        Phase::Kill => &[Signal::KILL],
        _ => &[],
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_progress_pipe_defers_first_signals_without_consuming_the_permit() {
        let (read, write) = crate::owner::pipe().unwrap();
        let mut progress = Progress::default();
        progress.publish_to(&write).unwrap();
        while rustix::io::write(&write, &[0; RECORD_LEN]).is_ok() {}
        let mut sent = false;
        assert!(
            progress
                .signals(Phase::Grace, [1, 2, 3, 4, 5], &mut sent)
                .unwrap()
                .is_empty()
        );
        assert!(!sent);
        let mut bytes = [0; 4096];
        while rustix::io::read(&read, &mut bytes).is_ok() {}
        assert_eq!(
            progress
                .signals(Phase::Grace, [1, 2, 3, 4, 5], &mut sent)
                .unwrap(),
            &[Signal::TERM, Signal::CONT]
        );
        assert!(sent);
        let mut bytes = [0; RECORD_LEN];
        assert_eq!(rustix::io::read(&read, &mut bytes).unwrap(), RECORD_LEN);
        assert_eq!(progress_record(&bytes).unwrap(), [1, 2, 3, 4, 5]);
    }
    #[test]
    fn eof_first_keeps_six_seconds_and_original_deadline() {
        let start = now();
        let eof = Policy::at(start, Config::default(), false);
        assert_eq!(eof.phase(start + Duration::from_millis(5999)), Phase::Grace);
        assert_eq!(eof.phase(start + Duration::from_secs(6)), Phase::Kill);
        assert_eq!(eof.phase(start + Duration::from_millis(7499)), Phase::Kill);
        assert_eq!(
            eof.phase(start + Duration::from_millis(7500)),
            Phase::Expired
        );
    }
    #[test]
    fn only_already_saved_fatal_status_selects_three_seconds() {
        let start = now();
        let fatal = Policy::at(start, Config::default(), true);
        assert_eq!(
            fatal.phase(start + Duration::from_millis(2999)),
            Phase::Grace
        );
        assert_eq!(fatal.phase(start + Duration::from_secs(3)), Phase::Kill);
        assert_eq!(
            fatal.phase(start + Duration::from_millis(7500)),
            Phase::Expired
        );
    }
    #[test]
    fn term_precedes_one_cont_and_late_adoption_never_gets_rescue_cont() {
        let mut sent = false;
        assert_eq!(
            next_signals(Phase::Grace, &mut sent),
            &[Signal::TERM, Signal::CONT]
        );
        assert!(next_signals(Phase::Grace, &mut sent).is_empty());
        assert_eq!(next_signals(Phase::Kill, &mut false), &[Signal::KILL]);
        assert!(next_signals(Phase::Expired, &mut false).is_empty());
    }
    #[test]
    fn failover_record_preserves_configured_selection_and_original_start() {
        let start = now();
        let config = Config::from_millis(2000, 1000, 2500).unwrap();
        let policy = Policy::at(start, config, false);
        let restored = Policy::from_record(&policy.record(), config).unwrap();
        assert_eq!(
            restored.phase(start + Duration::from_millis(2000)),
            Phase::Kill
        );
        assert_eq!(
            restored.phase(start + Duration::from_millis(2500)),
            Phase::Expired
        );
        let mut broken = policy.record();
        broken[40] = 2;
        assert!(Policy::from_record(&broken, config).is_err());
        assert!(Policy::from_record(&policy.record(), Config::default()).is_err());
    }
}
