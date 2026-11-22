# Platform lifecycle guarantees

These are current lifecycle and Unix terminal guarantees, not release acceptance.
Final documentation/release setup remains pending.

| Backend | Authority and completion | Limits |
| --- | --- | --- |
| Linux | Preferred: an owned cgroup v2 workload group, joined before the payload can fork; KILL phase writes `cgroup.kill`; wait until ECHILD and an unpopulated group. Fallback (one attempted startup diagnostic): subreaper ancestry, birth-checked pidfds or unreaped direct-child authority, KILL through a streaming nondirect pidfd walk; wait until ECHILD | Group needs existing delegation of the owner's own cgroup; no host changes. Missing pidfds visibly limit nondirect freezing and recursive KILL, not direct-child reaper cleanup; in the fallback, descendants the OS forbids this user to signal stay known survivors. SIGKILL cannot end a task in an uninterruptible kernel wait; it then fails at the deadline |
| FreeBSD | Acquired procctl reaper domain, fresh status/pids, nested-reaper subtree KILL and child waits | Required targeted wake/query/signal errors fail startup or cleanup, except signal EPERM: such descendants stay known survivors; no sysctl/module changes |
| Windows | process-wrap Tokio JobObject + KillOnDrop, assignment while suspended, explicit Job completion after primary exit | No inherited/leaked private Job handle; Unix job control is not advertised; Job termination does not depend on descendant process DACLs |
| macOS | Independent observer, retained PID/birth/effective/real/saved-UID observations; completed sweep with no known survivors | Best-effort, not kernel containment; reparenting before outer observation (including early observer loss), fast setsid, final-scan forks and final identity-check/use races can escape; descendants the OS forbids this user to signal stay known survivors |

## Linux workload group and fallback

At startup the owner tries to create `procward-<pid>-<time>` inside its own
current cgroup v2 group (`/proc/self/cgroup` below the visible `cgroup2`
mount). It never creates the group anywhere else and never changes controllers,
delegation, mounts, permissions or services. It proves `cgroup.kill` by writing
it on the new, still empty group, and proves membership transfer with a
short-lived trusted probe. Then the owner passes the group directory handle to
the anchor. A trusted procward stage (`__cgroup_exec`, or the terminal launch
stage under a private PTY) writes itself to `cgroup.procs` and closes the handle.
Only then does it `execve` the payload, so every payload fork is a member. The
owner, anchor and terminal keeper stay in the original group. The KILL phase
writes `cgroup.kill`, which kills every member and nested group without a
signal-permission check. Completion needs ECHILD and `populated 0` in
`cgroup.events`. The creating owner keeps the group handle across anchor loss,
kills the group in its own cleanup, and removes the group and any empty nested
groups (deepest first) through retained directory handles. The anchor also
receives the parent directory handle and the group name; it checks that the name
is `procward-*` and names the same directory as its group handle. It removes the
group only when the owner is lost and its own cleanup has confirmed the group
empty; while the owner lives, removal stays with the owner's own completion
check. A group that is already gone counts as removed, so both roles may try.
If a member cannot be killed, the group stays in place and procward reports
that. The KILL phase does no pidfd walk while the group is in use, because
`cgroup.kill` already reaches every member.

If any step fails (no writable own group, no `cgroup.kill`, migration denied),
the owner attempts to write exactly one line:
`procward: Linux cgroup v2 workload group unavailable (<reason>); cleanup falls
back to subreaper and pidfd termination`. This is the only output difference;
payload stdout/stderr bytes are unchanged. No line is printed when the group
is in use. Every procward diagnostic is one `write(2)` attempt to stderr, with
no retry on EINTR or EIO and no TTIN/TTOU masking. When the kernel denies it,
for example a background job on a TOSTOP terminal, the line is dropped and the
job receives the kernel's normal SIGTTOU. On Linux the owner and anchor catch
TTIN/TTOU without `SA_RESTART`, so a denied write fails once instead of
restarting in a SIGTTOU loop.

The fallback keeps the subreaper and adds identity-safe recursive KILL.
Nondirect descendants are reached only through parent/birth edges validated
around `pidfd_open`. The KILL walk streams: it opens one pidfd, checks the
child's and parent's birth again, sends KILL, and closes it before going on, so
descriptor use does not grow with the tree. Handles retained by job-control
freezing get KILL once and are then released. Stale numeric PIDs of nondirect
descendants are never signalled. EMFILE/ENFILE only leave the current pass
incomplete; cleanup keeps retrying until the original deadline. An unreaped
direct child without a pidfd is still signalled by PID, which cannot be reused
before reap. Each walk checks the original deadline at every step, so a rolling
child tree cannot extend it. A live ancestor that never exits, for example a
credential-denied one, therefore no longer shields a signalable descendant until
adoption. Grace TERM still goes to adopted direct children only. Both backends
keep the original policy start and deadline through anchor/owner failover; no
descendant gets a fresh grace. Ready exits are reaped in a batch before the next
inventory scan; neither a large zombie backlog nor a continuously changing tree
gets a replacement deadline. The recursive fallback is not a kernel-atomic
kill-all primitive: concurrent forks still require repeated observation and
progress within the original budget.

Neither backend is stronger than SIGKILL. A task in an uninterruptible kernel
wait can survive until the deadline. Procward then exits 125 and does not
claim cleanup. The tests do not create real D-state tasks. The credential-denied
guardian in `tests/boundary.rs` simulates a live ancestor that blocks adoption;
it is not an unkillable task. SIGSTOP is not treated as unkillable.

`tests/cgroup.rs` is real delegated-cgroup integration. It runs only when
`PROCWARD_TEST_CGROUP_PARENT` names an existing, already writable cgroup v2
directory. It creates one fresh test group there and moves only a freshly
spawned shell into it before that shell execs procward. It checks payload
membership before the first fork, nested groups, anchor-loss failover,
unrelated-process survival and group removal. Without the variable it prints
`CGROUP-NOT-RUN`; that is not a pass. The full-system Linux VM runner supplies
it in the cgroup-enabled pass. Linux fixtures run only through
`ci/vm-test.py` locally, or the copy-only full-system VM Actions in CI/release,
with a separate `--hazard`/hazard job for the preserved uncapped rolling/deep/wide
reproducer; see [development.md](development.md#build-and-checks).
[VM provisioning and result gates](../ci/linux-vms.md) are implemented, but actual
remote CI/dry-run verification remains required. Local/static validation is not
remote CI acceptance.

## Descendants across an access boundary

A descendant may deny the controller access, for example a setuid-root program.
On every backend procward kills what the OS allows. It keeps the payload status
only if denied descendants exit before the cleanup deadline; otherwise it exits
125.
`tests/boundary.rs` runs this family on all twelve CI rows. On Unix it installs
the fixture setuid root (as root, or with passwordless `sudo -n`) and runs
procward unprivileged: one helper keeps our real UID like `ps`, one becomes
fully root like `sudo`, and on Linux one unprivileged helper becomes
non-dumpable (`prctl(PR_SET_DUMPABLE, 0)`). On Windows a descendant replaces its
own process DACL to deny Everyone.

- **Signal permission:** a sender may signal a target only when its real or
  effective UID matches the target's real or saved UID (POSIX `kill(2)`; Linux
  `kill_ok_by_cred`, FreeBSD `cr_cansignal`, xnu `cansignal_nomac`). A setuid
  program that keeps our real UID stays signalable. One that switched all UIDs,
  as `sudo` does, returns EPERM. FreeBSD's default
  `security.bsd.conservative_signals` also limits signals to set-ID processes.
- **Linux workload group:** `cgroup.kill` is a kernel kill that credential
  checks cannot deny. When the group is in use, a fully root member is killed
  at the KILL phase and the payload status is kept; TERM during grace can
  still be denied and reported. The Unix denial rules below apply to the Linux
  fallback.
- **Unix denial:** each backend reports `<OS> denied signals to privileged
  descendant <pid>; it remains a known survivor` once per descendant. The
  descendant still blocks completion; if it remains at the cleanup deadline,
  cleanup fails with `cleanup deadline expired` and exit 125 instead of claiming
  containment (tested). Job-control freeze cannot stop it. Other errors stay
  fatal. FreeBSD's `PROC_REAP_KILL` signals every permitted member but names a
  denied one only when it precedes every successful signal in the kernel walk
  (`kern_procctl.c` `reap_kill_proc_locked`). When every member is denied the
  call fails with EPERM and the report reads `(unnamed)`, because rustix does not
  return `rk_fpid` on error. Cleanup repeats the KILL each pass.
- **FreeBSD resume:** with the default `security.bsd.conservative_signals=1`,
  `cr_cansignal` lets SIGSTOP but not SIGCONT reach a set-ID descendant, and
  `PROC_REAP_KILL` has no same-session SIGCONT exemption. Job-control resume
  reports a named denial (`FreeBSD denied SIGCONT to privileged descendant
  <pid>; it may remain stopped`) and then reports every member still stopped
  after resume (`FreeBSD descendant <pid> is still stopped after resume`) from
  the kernel's stopped flag. Linux and macOS allow SIGCONT
  whenever SIGSTOP was allowed (same UID rule, plus a same-session SIGCONT
  exemption).
- **Credential changes:** a known descendant that later execs a setuid program
  stays owned on every Unix backend. Linux and FreeBSD identities hold no
  credentials, and macOS updates the UIDs of the same unique ID. Tests cover an
  orphan that execs the setuid helper after adoption (Linux/FreeBSD CLI, macOS
  inventory).
- **Inventory:** Linux pidfds (`pidfd_open`) and `/proc/<pid>/stat` stay
  available for other-UID and non-dumpable processes on default procfs mounts;
  `hidepid` mounts are outside this guarantee. FreeBSD `kern.proc.pid` needs the
  default `security.bsd.see_other_uids=1`. macOS uses the other-effective-UID
  path described in the cleanup section below.
- **Windows:** the Job object terminates members without opening their process
  handles, so a descendant's DACL cannot exempt it. The test proves the boundary
  by requiring `OpenProcess` to fail with `ERROR_ACCESS_DENIED`. A
  higher-integrity child would need an elevated launcher; it is not tested.
- **qemu-user:** if binfmt does not honour the setuid bit, the riscv64 rows
  report a counted `EMULATOR-UNSUPPORTED` reason instead of a pass.

Linux/FreeBSD have a shell-facing owner and a reaper anchor. Noninteractive
anchors use a separate process group; interactive native roles share the caller's
job group and catch TTIN/TTOU without masking them. Both handlers disable
SA_RESTART: a foreground-reclaim race must return EINTR to cleanup rather than
restart a denied terminal read/write indefinitely. On Linux noninteractive
roles disable it too, so a denied diagnostic write fails once. Both can reap; the surviving
role cleans after the other dies. The
anchor's required parent-death SIGCONT wake is armed and its live parent checked
before launch permission. A close-on-exec pipe carries the one launch grant and
then owner liveness, not a payload-inherited ownership lease. macOS uses the same
small native arrangement, with polling and retained inventories in both roles;
its observer remains outside the stopped workload rather than claiming an
unavailable parent-death syscall.

Loss of all independent roles, host/kernel failure and privilege transitions
that clear parent-death notification are excluded. A killed process cannot run
its own destructor or terminal cleanup. Standard crates do not remove those OS
limits. Unavailable or denied queries are errors, never evidence of absence.
Stopped work is alive; zombies are not reaped completion.

## Nested ownership

`procward run -- procward run -- command` is supported without a no-nesting
detection mode. Both layers preserve the payload result on normal completion.
Outer-owner loss cleans the whole nested tree under the outer configured
deadline; inner-owner loss cleans the inner subtree and the outer layer reports
its primary's native termination result. The inner payload gets a fresh contract,
not the outer layer's environment or lifecycle endpoint. See
[contract.md](contract.md#nested-scopes) for consumer/bootstrap rules.

- **Linux:** a subreaper can run below another subreaper. Inner reaping stays
  local while healthy; on loss, ancestor reapers adopt and clean remaining work.
  With a workload group, the inner owner is a member of the outer group and
  creates its own group inside it; the outer `cgroup.kill` covers both, and the
  outer owner removes empty nested groups that an inner owner left.
  Nesting tests include a detached branch and stopped, TERM-ignoring worker.
- **FreeBSD:** each layer acquires its own reaper domain. Cleanup includes nested
  reapers, not only ordinary direct children. The nested fixture also acquires a
  reaper for its detached branch and checks stopped work as live.
- **Windows:** each procward creates a kill-on-close Job inside the enclosing
  Job hierarchy, without requesting breakaway. The outer Job contains the inner
  controller and its Job's processes. Tests kill the outer controller and require
  all retained inner process handles to signal, proving outer kill-on-close
  terminates the nested Job's work; inner-controller termination must also clean
  its subtree and preserve its native status through the outer layer. Assignment
  failure remains a visible startup error, never an unmanaged fallback.
- **macOS:** two nested observers retain separate inventories; neither supplies
  kernel containment. The CLI fixture uses an attached, gated tree rather than
  asserting cleanup of a pre-observation setsid/reparent escape. Both existing
  best-effort/identity-query limits and all-independent-role-loss exclusions
  still apply. A fixture readiness marker alone is not proof of observation.

All twelve CI rows run these scenarios. Fault checks use an outer 2s ordinary
/ 1s fatal / 2500ms deadline against the inner default 6s / 3s / 7500ms policy;
Unix's ignoring worker proves the inner policy cannot extend outer cleanup.
Normal exit allows the inner ordinary grace to finish before the outer primary
exits. Riscv64 qemu-user keeps the same assertions and deadlines; only a matching
runtime capability probe may label an affected case EMULATOR-UNSUPPORTED.

## riscv64 execution and release scope

Required targets remain `riscv64gc-unknown-linux-gnu` and
`riscv64gc-unknown-linux-musl`. CI/release now boot Ubuntu 24.04 and Alpine 3.24
RISC-V **full-system QEMU VMs** respectively, each with a separate RISC-V guest
kernel. There is no qemu-user/binfmt/container runtime or host-kernel syscall
forwarding. This is CPU emulation, not real RISC-V hardware performance evidence.

Official rustup native host tools compile the exact target inside each guest.
GNU selects `riscv64-linux-gnu-gcc` in the original Ubuntu 24.04 sysroot family;
ELF inspection rejects GLIBC symbol requirements above 2.39. Musl retains official
Rust compiler/standard-library tools, static flags and self-contained linking,
with the matching guest's system musl `cc` linker driver supplying native
GCC/musl library paths for build scripts. ELF inspection checks RISC-V double-float ABI;
no Alpine compiler alias is substituted. Compiling in the copied private guest
workspace preserves every embedded fixture executable path. Source bytes,
compiler host and native guest architecture are checked before execution.
See [provider pins and full-system execution plan](../ci/linux-vms.md).

Tests run serialized in both cgroup-available and forced-fallback modes, with
all original timing, ordering, identity, liveness and completion assertions.
Timing scale remains **1×**; longer whole-job limits accommodate boot/build CPU
emulation only. The old `PROCWARD_TEST_QEMU_USER` opt-in is not set, so seccomp,
spawn-error and setuid capability assertions are not replaced by historical
`EMULATOR-UNSUPPORTED` outcomes. Historical qemu-user results remain historical,
not passes for the new full-system executor. Missing provisioning/toolchain or
unchanged fixture failures remain failures pending actual remote verification.

Both riscv64 variants are required future release binary/package assets, covered
by the same checksum, provenance and full tagged-source fixture gates as other
targets. Their inclusion does not claim a new pi runtime/bundle label.

## Cleanup timings

```sh
procward run --grace 6s --fatal-grace 3s --cleanup-deadline 7500ms -- command args
```

Defaults are ordinary grace **6s**, already-saved-fatal grace **3s**, and cleanup
deadline **7500ms**. Durations use integers with `ms` or `s` suffix;
validation requires `0 < fatal-grace <= grace < cleanup-deadline`. Malformed,
missing, duplicated or out-of-order timing values return **2 before payload
execution**. Unix uses both grace values; Windows terminates its Job on primary
exit and uses the configured completion deadline, not Unix signal grace.
Pi will pass its own chosen values via these generic options in its later adapter.

Unix cleanup selects one **global per-tree** monotonic policy. EOF-first uses
configured ordinary grace; only already-saved fatal helper status selects
configured fatal grace. Before cleanup actions, the anchor publishes one bounded
private record containing CLOCK_MONOTONIC start, configuration and selection.
A separate CLOEXEC policy pipe never reaches the payload. Outer fallback keeps
that original start/selection: late role loss, adoption and later status discovery
cannot restart grace or deadline. The same pipe carries atomic per-identity
TERM/CONT reservations before signalling. The outer retains these even after
anchor death, so fallback does not replay teardown CONT. PID plus birth binds
progress to an identity (and Darwin also includes its checked UIDs); new identities
still receive their first ordered signals during grace. Full progress pipes defer
new grace signals, never extend the deadline or delay KILL. A crash between a
reservation and its syscall can omit that grace attempt, not duplicate it; KILL
and completion checks still use the original budget. Without a published policy
record, the anchor had not
started cleanup and outer selects its first policy at fault observation.

TERM precedes one permitted CONT per newly owned direct child during grace;
escalation uses KILL without fresh CONT. Unknown completion evidence or known
survivors at the configured deadline fail cleanup. Default runtime fault checks
remain **8 seconds**; a non-default 2s/1s/2500ms late-anchor-loss fixture enforces
the original configured deadline and also checks loss before publication.
An early-loss fixture kills the anchor after `true 1` (TERM seen, one CONT) and
requires the count to remain one through fallback and final cleanup.

macOS keeps an ESRCH-with-existing-PID identity transition as unknown, not gone:
it neither signals from that observation nor completes while it remains pending.

macOS identifies every process by PID plus its per-boot, never-reused unique ID
(xnu `bsd/kern/kern_fork.c` `forkproc()`; exec keeps it). For processes with our
effective UID one `PROC_PIDT_BSDINFOWITHUNIQID` read returns the parent, UIDs
and unique ID together. For other-effective-UID processes (setuid-root
`ps`/`top`, `sudo`) that flavor fails with EPERM, so procward reads
`PROC_PIDT_SHORTBSDINFO` between two `PROC_PIDUNIQIDENTIFIERINFO` reads; xnu
`bsd/kern/proc_info.c` exempts both from the same-user check. A unique ID that
changes during that query is an unknown observation. UIDs are attributes,
not identity: when a known process execs a setuid program or calls `setuid()`,
including after its parent exited, procward keeps it, records the new UIDs and
restarts its ordered signals for them. Every signal still requires a fresh,
fully matching PID, unique ID and UIDs. If `kill(2)` returns EPERM (real and
saved UIDs no longer match the caller, for example after `sudo` switches users),
procward reports the descendant once as a known survivor it cannot signal. It
still blocks completion, and the cleanup deadline fails if it remains.
Job-control freeze cannot stop such a descendant. Other denied or failed
queries remain errors. Linux (pidfd plus `/proc` start time) and FreeBSD (PID
plus `ki_start`) never include credentials in identity, so a credential change
cannot drop a known descendant there.

FreeBSD KILL ESRCH is tolerated only when a fresh kernel list proves no signalable member remains; wait/reaper facts,
not that signal result, still decide completion.

Observer loss returns failure **125**, not an unmanaged success. macOS reports
that descendants reparented before the outer inventory's first observation may
escape. A native test explicitly primes the real retained inventory, kills its
observer, and exercises the same outer fallback function to prove observed-tree
cleanup and failure status. The CLI early-observer-loss case checks failure and
that disclosure; any unobserved survivors are removed by separately labelled
**harness cleanup**, not credited to procward.

The Darwin unseen-escape fixture deliberately waits until its parent exited
before the first inventory observation. Its surviving worker is reported as the
expected platform limitation and rescued separately. This passing limitation
demonstration is not evidence of universal containment or product cleanup of
that worker.

## Unix private terminal lifetime

Interactive commands use one private PTY. A small same-binary session keeper
outlives the foreground payload until the relay has drained normal output. This
is the standard shell/login arrangement, not another reaper, watchdog or public
mode. Native ownership/cleanup roles stay in the caller's session, outside the
frozen workload; the private keeper is inside that workload and pauses with it.
Noninteractive and per-task execution creates no PTY/session keeper.
Before each foreground raw-mode acquisition, the relay captures current physical
termios and publishes that snapshot with an outstanding restoration obligation
on the existing private pipe. The outer keeps no startup restoration snapshot.
On signalled anchor exit it restores only an outstanding acquisition snapshot
after cleanup, including cleanup failure, using the same unmasked
kernel-authority check as the relay. Restore/release clears the obligation;
later acquisition takes a fresh snapshot, including shell changes made during
a pause. Never-raw and already-released failover leave newer shell settings
untouched and still return status 125. Active raw-payload failover requires
restored cooked settings; unrelated-foreground takeover must retain its state.

Acquisition uses a write-ahead intent record immediately before the raw ioctl.
A kill between publication and ioctl can therefore restore the just-captured
foreground snapshot even though raw mode was not entered. This bounded window
prefers a harmless restore of current acquisition state over missing recovery
and leaving the terminal raw; it never authorizes use of startup state. A full
pipe defers acquisition without changing the physical terminal. No mode-equality
comparison substitutes for kernel authority.

The restoration record travels only on an anonymous, close-on-exec private pipe
that no keeper, payload or ordinary child inherits. procward is not a sandbox:
another process running as the same user can still reach the pipe through
`/proc/<pid>/fd` or `ptrace`. That is outside the threat model, as it is for the
native policy transport (see [contract](contract.md)).

FreeBSD requires this retained session lifetime. Its
[exit1 path](https://github.com/freebsd/freebsd-src/blob/releng/14.3/sys/kern/kern_exit.c)
notes that killjobc revokes a session leader's controlling tty. The
[tty close path](https://github.com/freebsd/freebsd-src/blob/releng/14.3/sys/kern/tty.c)
then frees tty queues. A fresh fixture proved the effect: the direct session
leader flushed its final stdout/stderr and exited 23, while the relay returned
23 with no final marker and zero pending physical output. Holding an extra slave
fd did not prevent the loss. Retaining the session leader until output drain
avoids that revocation race on the same Unix path.

The keeper performs login_tty once. A trusted startup gate puts the actual
payload in the private foreground group before untrusted exec; it does not
stack a second session setup on login_tty. The payload's managed READY record
names that live immediate native parent and the actual payload PID, as required
by [contract.md](contract.md). Ordinary children get no private keeper control
or startup-grant endpoints.

On normal primary exit, the native relay continues output while cleaning other
owned descendants. Only after no other owned work remains and private/relay
output queues are empty does it release the keeper, preserving the payload's
exact exit/signal-derived result. The keeper bounds its own final-drain wait by
the configured cleanup deadline; it cannot restart or extend native escalation.
A missing drain acknowledgement, controller loss or expired deadline is failure,
not successful output completion. Fatal cleanup can discard output and remains
independent of stopped keepers or blocked physical output.

Restoration still uses authorized kernel calls on the physical terminal; no
TTIN/TTOU masking or private-session physical write bypasses denial. BSD's
transient PENDIN state is settled by the shell fixture's read-only input
readiness query before comparing all saved cooked settings; it neither consumes
nor flushes input and does not mask a configuration mismatch.
