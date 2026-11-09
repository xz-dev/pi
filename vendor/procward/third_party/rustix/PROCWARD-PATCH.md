# Procward rustix patch

Pristine rustix 1.1.6 was committed at `ada471f`, with all original licences and
COPYRIGHT retained. Registry archive SHA-256:
`e5e76742e5294153d4dde1207dbec5bdd81eef6fabdc0d2118babadabfd858aa`.
This is third-party source under its original terms, not new BSD procward code.

FreeBSD returns `rk_fpid = -1` when PROC_REAP_KILL had no failed target. The
original wrapper passes that sentinel to `Pid::from_raw`, which asserts
nonnegative input in debug builds and produces a spurious negative PID value in
release builds. The narrow fix maps nonpositive sentinels to None; positive
failed PIDs and syscall errors retain existing handling. A prominent change
notice is present in the one modified source file. No procctl shim, assertion
suppression, additional feature or host setting is introduced.

Original runtime failure: run
[40533813568](https://github.com/xz-dev/procward/actions/runs/40533813568), FreeBSD
x64 stopped-adoption escalation, `rustix/src/pid.rs:44: assertion failed: raw >= 0`.
New direct regression: `successful_reaper_kill_has_no_failed_pid` in
`tests/freebsd.rs`, invoked before the sequential guest lifecycle scenarios.
It signals one live gated child through the real reaper API, requires exactly
one target and no failed PID, and observes signal-derived child completion.
Pristine-regression branch: `regress/rustix-reaper-kill`, corrected commit
`bbfc5d6`, run [40536071916](https://github.com/xz-dev/procward/actions/runs/40536071916).
The x64 row failed at Pid::from_raw with `assertion failed: raw >= 0` before
lifecycle scenarios. Initial branch run 40535325402 used direct-child-only
signalling and got ESRCH; the correction uses the same whole-domain API form as
production after proving gated membership, retaining all success assertions.

Cargo's path patch uses the same narrow target feature sets as before vendoring.
`UPSTREAM.md` prepares an unfiled report and one-file diff. Do not file it without
parent/user authorization. Remove this vendor/path override when upstream ships
a fix; retain the regression and rerun all ten rows with refreshed lock/notices.
