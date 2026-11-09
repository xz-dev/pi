# Prepared upstream report — NOT FILED

Target: https://github.com/bytecodealliance/rustix

## Suggested title

FreeBSD reaper_kill maps no-failure sentinel -1 through Pid::from_raw

## Observed behavior

In rustix 1.1.6, `process::reaper_kill` maps `req.rk_fpid` directly through
`Pid::from_raw`. Successful FreeBSD PROC_REAP_KILL returns -1 for no failed PID.
Pid::from_raw asserts nonnegative input in debug builds. Thus a successful
kernel signal operation panics after delivery, and release builds may expose a
spurious negative first_failed PID instead of None.

Observed on FreeBSD 14.3 x64 guest in procward CI run:
https://github.com/xz-dev/procward/actions/runs/40533813568
Failure: rustix/src/pid.rs:44, `assertion failed: raw >= 0`.

## Reproducer

Acquire reaper status. Spawn a fresh gated child and prove it is running. Call
`reaper_kill(None, Signal::TERM, false, None)`. Require killed == 1 and
first_failed == None, then wait for the child's TERM-derived exit.

Procward test helper: `tests/freebsd.rs::successful_reaper_kill_has_no_failed_pid`,
called from its sequential native lifecycle test. Commands:
`cargo build --locked --examples` then `cargo test --locked --test freebsd`.
Pristine regression branch commit: bbfc5d6; run:
https://github.com/xz-dev/procward/actions/runs/40536071916
Archive SHA-256: e5e76742e5294153d4dde1207dbec5bdd81eef6fabdc0d2118babadabfd858aa.

## Proposed fix

Map nonpositive no-failure sentinels to None before Pid conversion. Keep positive
failed PIDs and OS errors unchanged. No procctl FFI shim or disabled assertions.
Only one original source file changes, with its original licence preserved and
a modification notice added. No issue or PR has been filed.

```diff
diff --git a/src/process/procctl.rs b/src/process/procctl.rs
index 24d5530..8a53c2c 100644
--- a/src/process/procctl.rs
+++ b/src/process/procctl.rs
@@ -1,3 +1,4 @@
+// Modified for procward: map FreeBSD's no-failed-PID sentinel to None.
 //! Bindings for the FreeBSD `procctl` system call.
 //!
 //! There are similarities (but also differences) with Linux's `prctl` system
@@ -442,7 +443,11 @@ pub fn reaper_kill(
     unsafe { procctl(PROC_REAP_KILL, process, as_mut_ptr(&mut req).cast())? };
     Ok(KillResult {
         killed: req.rk_killed as _,
-        first_failed: Pid::from_raw(req.rk_fpid),
+        first_failed: if req.rk_fpid > 0 {
+            Pid::from_raw(req.rk_fpid)
+        } else {
+            None
+        },
     })
 }
 
```
