# Procward dependency patch

Upstream package: process-wrap 10.0.1, Apache-2.0 OR MIT, including the preserved
Apache-only Windows routines described in COPYRIGHT. The pristine archive was
committed separately at `d10d15b`; SHA-256 is
`1f21b97672d2dc848e7b25701ab4535618b92f4861c13cc3f7f7bed52ad3c8da`.
Original licence and copyright files remain unchanged. This is a third-party
modification, not BSD-licensed procward source.

## Defect and narrow change

The original `wait_on_job` returns completion after any successful completion-port
packet, not only `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`. A queued NEW_PROCESS or
primary EXIT_PROCESS packet can therefore make Job wait return while descendants
are still alive. It also treats arbitrary failed finite waits as timeout.

The patch:

- waits until the empty notification matches this Job's completion key;
- ignores other notifications without resetting the caller's finite budget;
- returns Continue on that budget's expiry, and propagates other errors;
- passes the Job handle/key from the existing std/Tokio wrappers;
- enables the windows binding module containing the empty-message constant.

No new Job implementation, handle enumeration or altered containment policy.
Modified source/manifest files carry change notices. Procward intentionally
observes primary exit through `inner_mut().try_wait()` and awaits one Job wait;
it does not consume Job events through wrapper `try_wait` or retry a cancelled
Job wait. Other wrapper cancellation/event-caching semantics are not broadened
by this narrow patch.

## Red/green evidence

New procward regression:
`job_wait_does_not_complete_while_gated_descendants_are_alive` in
`tests/windows.rs`. It proves primary exit, holds live descendant process
handles, polls Job wait and requires Pending; only then does it terminate those
descendants and await completion under the unchanged deadline.

Pristine-source run: [40532870970](https://github.com/xz-dev/procward/actions/runs/40532870970),
commit `cd19b63`, temporary branch `regress/process-wrap-job-wait` (deleted after
recording both Windows failures). Both x64 and arm64 failed with:

```text
Job wait completed while gated descendant process handles are still live
```

The registry source in that run is byte-identical to the pristine vendored
archive. Main receives the regression and fix together through Cargo's
`[patch.crates-io]` path override. Ordinary subsequent full-matrix CI is the green
gate; no test predicate or teardown budget was relaxed.

## Removal

`UPSTREAM.md` contains an unfiled report and source patch. No upstream issue, PR,
repository or release was created. Parent/user authorization is required before
filing it. Remove the vendor/path override when an upstream release supplies the
fix, preserve the regression, refresh notices/lockfile, and rerun all ten rows.
