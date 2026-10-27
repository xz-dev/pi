//! Pure syscall schedule at the production cleanup/reap boundary, not native acceptance.
use super::*;
use std::collections::VecDeque;

const GUARDIAN: i32 = 11;
const PI: i32 = 12;
const BACKUP: i32 = 13;
const EXISTING: i32 = 14;

struct WaitStep {
    at: Duration,
    result: io::Result<(i32, i32)>,
    direct: Option<Vec<i32>>,
}
impl WaitStep {
    fn reap(at_ms: u64, pid: i32, direct: Vec<i32>) -> Self {
        Self {
            at: Duration::from_millis(at_ms),
            result: Ok((pid, 9)),
            direct: Some(direct),
        }
    }
    fn error(errno: i32) -> Self {
        Self {
            at: Duration::ZERO,
            result: Err(io::Error::from_raw_os_error(errno)),
            direct: None,
        }
    }
}

struct Model {
    start: Instant,
    elapsed: Duration,
    direct: Vec<i32>,
    waits: VecDeque<WaitStep>,
    deliveries: Vec<(i32, i32, Duration)>,
    reaped: Vec<(i32, i32)>,
    children_errors: VecDeque<Option<i32>>,
    send_error: Option<(i32, i32, i32)>,
    signal_cost: Duration,
}
impl Model {
    fn eof_before_guardian_waitable() -> Self {
        Self {
            start: Instant::now(),
            elapsed: Duration::ZERO,
            direct: vec![GUARDIAN, BACKUP],
            // Anchor observed lease EOF before guardian was waitable. Cleanup's
            // first wait now reaps guardian and exposes stopped Pi to its reaper.
            waits: [WaitStep::reap(0, GUARDIAN, vec![PI, BACKUP])].into(),
            deliveries: Vec::new(),
            reaped: Vec::new(),
            children_errors: VecDeque::new(),
            send_error: None,
            signal_cost: Duration::ZERO,
        }
    }
    fn signals(&self, pid: i32) -> Vec<i32> {
        self.deliveries
            .iter()
            .filter(|(p, _, _)| *p == pid)
            .map(|(_, s, _)| *s)
            .collect()
    }
    fn run(&mut self) -> io::Result<()> {
        cleanup_reap(
            self.start,
            Duration::from_secs(6),
            self.start + Duration::from_millis(7500),
            None,
            None,
            true,
            self,
        )
    }
}
impl CleanupOps for Model {
    fn now(&mut self) -> Instant {
        self.start + self.elapsed
    }
    fn signal_owned(&mut self, signal: i32) -> io::Result<()> {
        for pid in self.direct.clone() {
            if pid != BACKUP {
                self.send(pid, signal)?;
            }
        }
        Ok(())
    }
    fn send(&mut self, pid: i32, signal: i32) -> io::Result<()> {
        assert!(self.direct.contains(&pid), "cached PID used as authority");
        assert_ne!(pid, BACKUP, "physical backup must remain excluded");
        if let Some((p, s, errno)) = self.send_error
            && (p, s) == (pid, signal)
        {
            self.send_error = None;
            return Err(io::Error::from_raw_os_error(errno));
        }
        self.deliveries.push((pid, signal, self.elapsed));
        self.elapsed += self.signal_cost;
        Ok(())
    }
    fn wait(&mut self) -> io::Result<(i32, i32)> {
        if let Some(step) = self.waits.pop_front() {
            self.elapsed = self.elapsed.max(step.at);
            if let Some(direct) = step.direct {
                self.direct = direct;
            }
            return step.result;
        }
        if let Some(pid) = self
            .direct
            .iter()
            .copied()
            .find(|p| *p != BACKUP && self.signals(*p).contains(&libc::SIGKILL))
        {
            self.direct.retain(|p| *p != pid);
            return Ok((pid, 9));
        }
        Ok((0, 0))
    }
    fn backup_reaped(&mut self, pid: i32, status: i32) {
        self.reaped.push((pid, status));
    }
    fn backup_pid(&self) -> i32 {
        BACKUP
    }
    fn children(&mut self) -> io::Result<Vec<i32>> {
        match self.children_errors.pop_front().flatten() {
            Some(errno) => Err(io::Error::from_raw_os_error(errno)),
            None => Ok(self.direct.clone()),
        }
    }
    fn sleep(&mut self, duration: Duration) {
        self.elapsed += duration;
    }
}

#[test]
fn anchor_grace_requires_a_saved_signalled_guardian_status() {
    for raw in [libc::SIGKILL, libc::SIGTERM, libc::SIGSEGV | 0x80] {
        assert_eq!(anchor_cleanup_grace(Some(raw)), Duration::from_secs(3));
    }
    // EOF/errors without status, normal/nonzero exits, stops and continuations
    // do not prove an abnormal exit. A later reap cannot change this selection.
    for status in [
        None,
        Some(0),
        Some(23 << 8),
        Some((libc::SIGSTOP << 8) | 0x7f),
        Some(0xffff),
    ] {
        assert_eq!(anchor_cleanup_grace(status), Duration::from_secs(6));
    }
}

#[test]
fn fatal_anchor_grace_keeps_status_backup_and_original_adoption_deadline() {
    for at_ms in [0, 2900, 3000, 3100, 7500] {
        let mut model = Model::eof_before_guardian_waitable();
        model.waits = [WaitStep::reap(at_ms, GUARDIAN, vec![PI, BACKUP])].into();
        let raw = libc::SIGSEGV | 0x80;
        let mut status = Some(raw);
        let grace = anchor_cleanup_grace(status);
        let result = cleanup_reap(
            model.start,
            grace,
            model.start + Duration::from_millis(7500),
            Some((GUARDIAN, &mut status)),
            None,
            true,
            &mut model,
        );
        assert_eq!(result.is_err(), at_ms == 7500);
        assert_eq!(
            status,
            Some(raw),
            "later PID reuse must not replace raw status"
        );
        assert!(model.signals(BACKUP).is_empty());
        assert_eq!(
            model.signals(PI),
            if at_ms < 3000 {
                vec![libc::SIGTERM, libc::SIGCONT, libc::SIGKILL]
            } else if at_ms < 7500 {
                vec![libc::SIGKILL]
            } else {
                vec![]
            }
        );
        let kills: Vec<_> = model
            .deliveries
            .iter()
            .filter(|(_, signal, _)| *signal == libc::SIGKILL)
            .collect();
        assert_eq!(kills.is_empty(), at_ms == 7500);
        assert!(kills.iter().all(|(_, _, at)| *at >= Duration::from_secs(3)));
        assert!(model.elapsed <= Duration::from_millis(at_ms.max(3000) + 10));
    }
}

#[test]
fn eof_then_signalled_reap_does_not_reselect_fatal_grace() {
    let mut model = Model::eof_before_guardian_waitable();
    let mut status = None;
    let grace = anchor_cleanup_grace(status);
    cleanup_reap(
        model.start,
        grace,
        model.start + Duration::from_millis(7500),
        Some((GUARDIAN, &mut status)),
        None,
        true,
        &mut model,
    )
    .unwrap();
    assert_eq!(status, Some(9));
    assert_eq!(model.elapsed, Duration::from_secs(6));
}

#[test]
fn fatal_anchor_cleanup_preserves_failures() {
    let mut model = Model::eof_before_guardian_waitable();
    model.send_error = Some((PI, libc::SIGTERM, libc::EPERM));
    let error = cleanup_reap(
        model.start,
        anchor_cleanup_grace(Some(libc::SIGKILL)),
        model.start + Duration::from_millis(7500),
        None,
        None,
        true,
        &mut model,
    )
    .unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EPERM));
    assert!(!model.signals(PI).contains(&libc::SIGCONT));
    assert!(model.signals(BACKUP).is_empty());
}

#[test]
fn eof_before_guardian_reap_delivers_adopted_stopped_pi_term_before_cont() {
    let mut model = Model::eof_before_guardian_waitable();
    model.run().unwrap();
    assert_eq!(
        model.signals(PI),
        [libc::SIGTERM, libc::SIGCONT, libc::SIGKILL],
        "post-reap stopped Pi must receive TERM then CONT before original grace, not only SIGKILL"
    );
    assert_eq!(model.signals(GUARDIAN), [libc::SIGTERM, libc::SIGCONT]);
    assert!(model.signals(BACKUP).is_empty());
    assert_eq!(model.elapsed, Duration::from_secs(6));
    assert!(
        model
            .deliveries
            .iter()
            .filter(|(p, s, _)| *p == PI && *s != libc::SIGKILL)
            .all(|(_, _, at)| *at < Duration::from_secs(6))
    );
}

#[test]
fn adoption_before_grace_keeps_original_kill_time_without_resuming_existing_children() {
    let mut model = Model::eof_before_guardian_waitable();
    model.direct.push(EXISTING);
    model.waits = [WaitStep::reap(5900, GUARDIAN, vec![EXISTING, PI, BACKUP])].into();
    model.run().unwrap();
    assert_eq!(
        model.signals(EXISTING),
        [libc::SIGTERM, libc::SIGCONT, libc::SIGKILL]
    );
    assert_eq!(
        model.signals(PI),
        [libc::SIGTERM, libc::SIGCONT, libc::SIGKILL]
    );
    assert_eq!(model.elapsed, Duration::from_secs(6));
}

#[test]
fn adoption_at_or_after_grace_never_adds_grace_or_continue() {
    for at_ms in [6000, 6100, 7500] {
        let mut model = Model::eof_before_guardian_waitable();
        model.waits = [WaitStep::reap(at_ms, GUARDIAN, vec![PI, BACKUP])].into();
        let result = model.run();
        assert!(model.signals(PI).iter().all(|s| *s == libc::SIGKILL));
        assert_eq!(result.is_err(), at_ms == 7500);
        assert!(model.elapsed <= Duration::from_millis(at_ms + 10));
    }
}

#[test]
fn deadline_can_end_post_adoption_grace_before_six_seconds() {
    let mut model = Model::eof_before_guardian_waitable();
    model.waits = [WaitStep::reap(5000, GUARDIAN, vec![PI, BACKUP])].into();
    let error = cleanup_reap(
        model.start,
        Duration::from_secs(6),
        model.start + Duration::from_secs(5),
        None,
        None,
        true,
        &mut model,
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(model.signals(PI).is_empty());
    assert_eq!(model.elapsed, Duration::from_secs(5));
}

#[test]
fn crossing_grace_between_term_and_cont_does_not_resume_late() {
    let mut model = Model::eof_before_guardian_waitable();
    model.signal_cost = Duration::from_millis(1);
    model.waits = [WaitStep::reap(5999, GUARDIAN, vec![PI, BACKUP])].into();
    model.run().unwrap();
    assert_eq!(model.signals(PI), [libc::SIGTERM, libc::SIGKILL]);
}

#[test]
fn reaped_pid_membership_is_invalidated_but_never_used_as_signal_authority() {
    let mut model = Model::eof_before_guardian_waitable();
    // Reuse guardian's numeric PID for a newly eligible, kernel-owned child.
    model.waits = [WaitStep::reap(0, GUARDIAN, vec![GUARDIAN, PI, BACKUP])].into();
    model.run().unwrap();
    assert_eq!(
        model.signals(GUARDIAN),
        [
            libc::SIGTERM,
            libc::SIGCONT,
            libc::SIGTERM,
            libc::SIGCONT,
            libc::SIGKILL
        ]
    );
    assert_eq!(
        model.signals(PI),
        [libc::SIGTERM, libc::SIGCONT, libc::SIGKILL]
    );
    // First regression also asserts the absent old guardian is never signalled again.
}

#[test]
fn eintr_retries_and_reserved_status_survives_adoption() {
    let mut model = Model::eof_before_guardian_waitable();
    model.waits.push_front(WaitStep::error(libc::EINTR));
    let mut status = None;
    cleanup_reap(
        model.start,
        Duration::from_secs(6),
        model.start + Duration::from_millis(7500),
        Some((GUARDIAN, &mut status)),
        None,
        true,
        &mut model,
    )
    .unwrap();
    assert_eq!(status, Some(9));
    assert_eq!(model.reaped, [(GUARDIAN, 9), (PI, 9)]);
    assert_eq!(
        model.signals(PI),
        [libc::SIGTERM, libc::SIGCONT, libc::SIGKILL]
    );
}

#[test]
fn reused_pid_cannot_overwrite_reserved_guardian_status() {
    for initial in [None, Some(7 << 8)] {
        let mut model = Model::eof_before_guardian_waitable();
        model.waits = [
            WaitStep::reap(0, GUARDIAN, vec![GUARDIAN, BACKUP]),
            WaitStep {
                at: Duration::from_millis(10),
                result: Ok((GUARDIAN, 23 << 8)),
                direct: Some(vec![BACKUP]),
            },
        ]
        .into();
        let mut status = initial;
        cleanup_reap(
            model.start,
            Duration::from_secs(6),
            model.start + Duration::from_millis(7500),
            Some((GUARDIAN, &mut status)),
            None,
            true,
            &mut model,
        )
        .unwrap();
        assert_eq!(status, initial.or(Some(9)));
    }
}

#[test]
fn echild_preserves_prior_failure_and_other_wait_errors_propagate() {
    for prior in [None, Some(libc::EIO)] {
        let mut model = Model::eof_before_guardian_waitable();
        model.waits = [WaitStep::error(libc::ECHILD)].into();
        let result = cleanup_reap(
            model.start,
            Duration::from_secs(6),
            model.start + Duration::from_millis(7500),
            None,
            prior.map(io::Error::from_raw_os_error),
            true,
            &mut model,
        );
        assert_eq!(result.err().and_then(|e| e.raw_os_error()), prior);
    }
    let mut model = Model::eof_before_guardian_waitable();
    model.waits = [WaitStep::error(libc::EINVAL)].into();
    assert_eq!(model.run().unwrap_err().raw_os_error(), Some(libc::EINVAL));
}

#[test]
fn snapshot_and_signal_failures_remain_cleanup_failures_without_unqueued_continue() {
    for signal in [libc::SIGTERM, libc::SIGCONT] {
        let mut model = Model::eof_before_guardian_waitable();
        model.send_error = Some((PI, signal, libc::EPERM));
        assert_eq!(model.run().unwrap_err().raw_os_error(), Some(libc::EPERM));
        assert!(!model.signals(PI).contains(&libc::SIGCONT));
    }
    let mut model = Model::eof_before_guardian_waitable();
    model.children_errors = [None, Some(libc::EIO)].into();
    assert_eq!(model.run().unwrap_err().raw_os_error(), Some(libc::EIO));
    assert_eq!(model.signals(PI), [libc::SIGKILL]);
    let mut model = Model::eof_before_guardian_waitable();
    model.children_errors = [None, None, Some(libc::EIO)].into();
    assert_eq!(model.run().unwrap_err().raw_os_error(), Some(libc::EIO));
}

#[test]
fn repeated_reaps_do_not_resume_children_already_running_shutdown() {
    let mut model = Model::eof_before_guardian_waitable();
    model.direct.push(EXISTING);
    model.waits = [
        WaitStep::reap(0, GUARDIAN, vec![EXISTING, PI, BACKUP]),
        WaitStep::reap(100, PI, vec![EXISTING, BACKUP]),
        WaitStep::reap(200, EXISTING, vec![BACKUP]),
    ]
    .into();
    model.run().unwrap();
    assert_eq!(model.signals(EXISTING), [libc::SIGTERM, libc::SIGCONT]);
    assert_eq!(model.signals(PI), [libc::SIGTERM, libc::SIGCONT]);
    assert_eq!(model.elapsed, Duration::from_millis(200));
}

#[test]
fn legacy_non_direct_cleanup_keeps_initial_signals_and_kill_only_after_adoption() {
    let mut model = Model::eof_before_guardian_waitable();
    cleanup_reap(
        model.start,
        Duration::from_secs(6),
        model.start + Duration::from_millis(7500),
        None,
        None,
        false,
        &mut model,
    )
    .unwrap();
    assert_eq!(model.signals(PI), [libc::SIGKILL]);
    assert_eq!(model.signals(GUARDIAN), [libc::SIGTERM, libc::SIGCONT]);
}
