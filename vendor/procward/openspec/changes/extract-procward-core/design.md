## Context

See `proposal.md` for motivation. The latest direction supersedes every earlier code-extraction decision: procward is **new code built on mature crates**, not a renamed pi-env crate. No pi-env implementation, tests, fixtures, C shims or TypeScript utilities are copied or translated. The historical change directory name remains only to preserve this planning thread.

### Behaviour reference, not source to import

The inspected pi tree is `/var/tmp/pi-B10zzzzV-preflight-kFqWFM`, HEAD `2c22500f80609c2d1fc288e951427c3297dba9a2`. Its `packages/env/daemon/src/supervise*.rs`, job-control/TTY modules, platform modules, ownership tests, `packages/env/README.md`/docs, pi `process-owner.ts`/CLI/shutdown paths, Unix PTY and Windows console fixtures, and 14-label release catalog explain existing behaviour and failure cases. Their code and old native role topology are not a starting implementation.

Release addenda 6–12 supply scenarios: healthy adopted-orphan reaping (xz.357 retained zombies); stopped processes are alive; TERM-before-CONT; no late rescue CONT; 6-second versus already-proved-fatal-only 3-second grace within 7.5 seconds; fault-relative ≤8-second teardown; terminal authority and final-tail handling; Windows `/quit` before readiness; and pi's doubled CLI imports. A Darwin missing-hook proof failure and a separate version-latency failure were not established as one cause. Build fresh tests for these facts; do not import historical release packets, sealed manifests or diagnostic fixtures.

## Goals / Non-Goals

**Goals:**

- Deliver the smallest new `procward run -- <cmd>` implementation whose observable guarantees pass independently written fixtures.
- Use maintained process/OS crates for spawning, groups/sessions, Jobs, signals, reaping and terminal primitives; write only missing coordination.
- Push a compiling Linux walking skeleton early, get all-platform CI feedback immediately, fix forward and use ordinary reruns. Complete four-platform behaviour before v0.1.0.
- Release standalone procward first; integrate pi afterwards through a narrow contract and normal pi workflow.

**Non-Goals:**

- No copied/translated pi-env code, public supervisor framework, remote daemon/protocol, PIEXSPEC/ownedExec1 migration, or speculative pi-env library dependency.
- No assumption that `kill()` on a group, `ProcessSession` or `Drop` alone owns all detached descendants or survives SIGKILL.
- No universal macOS containment, privileged-runtime guarantees, arbitrary-descendant managed discovery or Windows Unix-job-control emulation.
- No once-only CI packets, sealed manifests, re-arm classifiers, special flaky-rerun approvals, per-step independent review or delayed first push until everything is green.
- No implementation, repository creation, commit, push, settings change or release during this planning task. Early-push tasks apply to the later authorized implementation phase.

## Decisions

### 1. Verified crate selection and maintenance evidence

Versions below were checked against crates.io metadata, docs.rs and the published crate sources while drafting this revision. Pin reviewed versions in Cargo.lock, use only required features and check updates normally. Publication dates are registry dates, not guarantees of future maintenance; docs.rs rebuild dates are not substituted for them.

| Crate / researched version | Licence and maintenance signal | Decision |
| --- | --- | --- |
| [`process-wrap` 10.0.1](https://docs.rs/process-wrap/10.0.1/process_wrap/), [Watchexec repository](https://github.com/watchexec/process-wrap), [registry](https://crates.io/api/v1/crates/process-wrap/10.0.1) | Apache-2.0 OR MIT; published 2026-09-23, with 8.x/9.x maintenance backports that day; MSRV 1.87, edition 2024 | Main command wrapper. Select 10.0.1 deliberately: registry `newest_version` currently reports the later-published 8.2.2 backport, whereas max stable is 10.0.1. Unix `std` frontend; Windows Tokio frontend for actual kill-on-close support. |
| [`rustix` 1.1.6](https://docs.rs/rustix/1.1.6/rustix/), [Bytecode Alliance repository](https://github.com/bytecodealliance/rustix), [registry](https://crates.io/api/v1/crates/rustix/1.1.6) | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT; published 2026-10-27, previous 1.1.5 on 2026-09-16; MSRV 1.65 | Unix process/reaper/pidfd/wait/termios/pipe primitives, with target-specific APIs and narrow features. |
| [`signal-hook` 0.4.5](https://docs.rs/signal-hook/0.4.5/signal_hook/), [repository](https://github.com/vorner/signal-hook), [registry](https://crates.io/api/v1/crates/signal-hook/0.4.5) | MIT OR Apache-2.0; published 2026-10-04, preceding release 2026-04-04; MSRV 1.66 | Unix signal notification/flags; own main loop applies policy outside handlers. It is not a cross-platform tree supervisor. |
| [`tokio` 1.54.1](https://docs.rs/tokio/1.54.1/tokio/runtime/), [repository](https://github.com/tokio-rs/tokio), [registry](https://crates.io/api/v1/crates/tokio/1.54.1) | MIT; published 2026-10-21; MSRV 1.85 | Windows-only current-thread runtime/process/time support for process-wrap's JobObject + KillOnDrop; no async framework on Unix merely for symmetry. |
| [`windows-sys` 0.61.2](https://docs.rs/windows-sys/0.61.2/windows_sys/), [Microsoft repository](https://github.com/microsoft/windows-rs), [registry](https://crates.io/api/v1/crates/windows-sys/0.61.2) | MIT OR Apache-2.0; Microsoft-maintained bindings, version published 2025-10-06; MSRV 1.71 | Only needed console/ConPTY fixture, process-identity and handle/control gaps; do not reimplement a Job wrapper already provided by process-wrap. |
| [`libproc` 0.14.11](https://docs.rs/libproc/0.14.11/libproc/), [repository](https://github.com/andrewdavidmackenzie/libproc-rs), [registry](https://crates.io/api/v1/crates/libproc/0.14.11) | MIT; published 2025-10-01; MSRV 1.72 | macOS-only candidate for libproc enumeration/BSD birth/UID records instead of copied ABI/C shims. It supplies queries, not retained ownership or an observer policy. |
| [`rustix-openpty` 0.2.0](https://docs.rs/rustix-openpty/0.2.0/rustix_openpty/), [repository](https://github.com/sunfishcode/rustix-openpty), [registry](https://crates.io/api/v1/crates/rustix-openpty/0.2.0) | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT; published 2025-03-06; small focused API, MSRV 1.63 | Add only with the interactive slice, for safe Unix PTY allocation/login primitives after demonstrating the terminal-isolation need. Not in the first Linux pipe/argv slice. |
| [`portable-pty` 0.9.0](https://docs.rs/portable-pty/0.9.0/portable_pty/), [WezTerm repository](https://github.com/wezterm/wezterm/tree/main/pty), [registry](https://crates.io/api/v1/crates/portable-pty/0.9.0) | MIT; registry publication 2025-02-11, mature WezTerm origin; package declares no MSRV | Evaluated alternative, not an initial dependency. Owns a portable spawn/PTY path that is unnecessary for ordinary commands and can duplicate wrapper/session setup. Use only if real cross-platform PTY work saves more code than the focused Unix helper plus small Windows fixture. Do not add both PTY crates for flexibility. |

Chosen project MSRV must satisfy process-wrap 10's 1.87 requirement; exercise that toolchain and a current stable toolchain in ordinary CI as affordable, rather than claiming the older backport's MSRV. All dependencies retain their own licences/notices.

### 2. What crates provide, and the exact gaps

| Responsibility | Verified crate/OS facility | Minimal procward responsibility |
| --- | --- | --- |
| Unix group/session creation | process-wrap `std::ProcessGroup` and `ProcessSession` | Choose one according to invocation mode; they are not a detached-tree containment mechanism. Do not stack them: ProcessSession already includes group setup. |
| Windows assign-before-run | process-wrap JobObject starts suspended, assigns to Job, then resumes; wrapper propagates assignment failure | Keep the payload behind that gate; observe primary exit separately and request tree termination instead of indefinitely waiting for descendants to exit voluntarily. |
| Windows owner-death kill | process-wrap **Tokio** `JobObject` + `KillOnDrop` sets `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` | Use this actual combination and ensure handles are non-inherited/nonleaking. Published 10.0.1 **std JobObject calls `make_job_object(..., false)`**, so std alone does not supply kill-on-owner-death. `KillOnDrop` is not a std wrapper. Rust destructors do not run on SIGKILL; Windows kernel last-handle closure supplies the guarantee. |
| Unix signals | signal-hook registers safe notification/flags | Forward at the main-loop policy boundary, avoid double terminal Ctrl-C, preserve child masks/dispositions and keep fork/pre-exec work async-signal-safe. A signal iterator does not freeze/reap a tree. |
| Linux subreaping | rustix `process::set_child_subreaper` (`PR_SET_CHILD_SUBREAPER`) | Reap healthy adopted orphans and preserve primary status; keep a surviving ownership role for owner death. A dead subreaper cannot perform cleanup. |
| Linux identity signalling | rustix `pidfd_open`, `pidfd_send_signal`; `waitid` including pidfd support | Open/validate identities, track relevant descendants, invalidate after reap and handle unsupported pidfds visibly. Opening a handle to an already reused numeric PID is not itself birth proof. |
| FreeBSD reaper | rustix `set_reaper_status`, `get_reaper_status`, `get_reaper_pids`, `reaper_kill`, `ProcSelector` | Acquire and drive the reaper domain, include nested reapers, preserve TERM/CONT/escalation order and handle errors. No custom procctl FFI is needed. APIs are FreeBSD-gated and may be absent from Linux-target rustdoc listings. |
| Owner-death notification | rustix Linux/FreeBSD `set_parent_process_death_signal`; pipes/OS process handles | Independent liveness/wake/cleanup coordination, live-parent recheck after arming, and a runnable observer/anchor for stopped-owner and ordinary-owner-loss cases. No preferred crate provides this complete lifecycle policy. |
| Foreground/terminal state | rustix `tcgetpgrp`, `tcsetpgrp`, `tcgetattr`, `tcsetattr`, winsize operations | Save/restore authority, Ctrl-Z/CONT ordering, background/foreground grants and denial handling. No command wrapper supplies shell handoff/restoration. |
| Unix PTY allocation | rustix PTY primitives or optional rustix-openpty `openpty`/`login_tty` | Only if interaction requires isolation: relay, resize, bounded output/fatal drain and foreground policy. PTY allocation is not a supervisor. `login_tty` establishes a session, so do not also stack ProcessSession/ProcessGroup pre-exec session setup on that branch. |
| macOS process facts | libproc enumeration, `pidinfo::<BSDInfo>` including birth seconds/microseconds and UID; Unix wait primitives | Small retained observed-identity inventory and independent observer/wake. No subreaper exists; no evaluated crate supplies arbitrary escaped-descendant containment. Failed queries remain unknown/error, not proof of absence. |
| Windows console/ConPTY | process-wrap inherits console behaviour; windows-sys supplies missing native console/ConPTY/handle APIs | Fresh console host fixture, appropriate Ctrl-C/Break handling and application lifecycle transport. Do not build a generic terminal daemon. |
| Tree cleanup completion | Unix wait/reaper facts; process-wrap Job completion-port wait/kill | Distinguish primary result from tree-empty completion and bound waits. Job completion can supply kernel evidence without duplicating raw Job accounting; use windows-sys only if a verified wrapper gap actually requires it. |

API source checks: [process-wrap std JobObject source](https://docs.rs/crate/process-wrap/10.0.1/source/src/std/job_object.rs), [Tokio JobObject source](https://docs.rs/crate/process-wrap/10.0.1/source/src/tokio/job_object.rs), [Windows Job internals](https://docs.rs/crate/process-wrap/10.0.1/source/src/windows.rs), [rustix FreeBSD procctl source](https://docs.rs/crate/rustix/1.1.6/source/src/process/procctl.rs), [rustix process APIs](https://docs.rs/rustix/1.1.6/rustix/process/), [rustix termios](https://docs.rs/rustix/1.1.6/rustix/termios/), [libproc BSDInfo](https://docs.rs/libproc/0.14.11/libproc/bsd_info/struct.BSDInfo.html). Published crate archives were also inspected to verify cfg/frontend limitations rather than infer support from feature names.

### 3. Binary first, small responsibilities, no speculative library

Start with one Cargo binary, `src/main.rs` plus private modules. CLI integration tests do not require a public library. Add a library only if a concrete immediate caller/test needs it and doing so removes code; future remote pi-env adoption is not a reason. Use OsString argv and standard-library parsing; no shell-string mode or new configuration framework.

**Panic policy (addendum-14):** release keeps `panic = "unwind"`. Abort is not enabled because no controller-panic fault seam proves cleanup safety. Follow-up: evaluate abort with a controller fault-injection seam; no release-profile change is part of section 4.

Planned layout, created only during implementation:

```text
Cargo.toml / Cargo.lock       # version 0.1.0, licence BSD-3-Clause
LICENSE                       # canonical BSD 3-Clause License
README.md                     # only what it is, install, usage, background
src/main.rs                   # run/help/version and private role bootstrap
src/owner.rs                  # lifecycle/result/deadline coordination
src/unix.rs                   # process-wrap/rustix/signal-hook glue
src/windows.rs                # Job wrapper + narrowly needed console/handle glue
src/darwin.rs                 # observed identity inventory and wake policy
src/terminal.rs               # only missing interactive handoff/relay policy
tests/                        # CLI tests and fresh test-only fixture program
docs/architecture.md
docs/platforms.md
docs/contract.md
docs/pi-integration.md
docs/development.md
docs/ci-release.md
docs/licensing.md
.github/workflows/ci.yml
.github/workflows/release.yml
```

These are responsibility boundaries, not mandatory empty files to scaffold. Begin with fewer modules and split only when needed. Keep a small test-only helper with modes such as argv/status, tree, stopped worker, orphan producer, blocked/cooperative hook and interactive readiness. No copied fixture scaffolding, large generic harness, application runtime or model access.

### 4. Walking skeleton, then only the coordination crates lack

**First slice:** on Linux, parse `run --`, establish subreaping before spawn, use process-wrap ProcessGroup for the noninteractive command, observe primary status, clean remaining owned work and reap. Add argv/status/normal-descendant fixtures immediately. No PTY, public library, pi integration or release framework is needed to prove this slice. Push once it compiles and enable the full platform CI matrix; unfinished applicable platform tests may be red, never fake-green skipped release claims.

**First-slice implementation notes (tasks 1.1–1.4):** process-wrap 10.0.1's group `try_wait` may reap the primary while other group members are still running, so this slice uses its spawn/signal wrappers but drives waits through rustix. Keep the primary waitable with `waitid(Pid, EXITED | NOHANG | NOWAIT)` until the final group signal; its unreaped PID anchors the PGID against reuse. rustix 1.1.6 has no returned-PID accessor on `WaitIdStatus`, so healthy reaping enumerates this single-threaded owner's direct children through `/proc/thread-self/children` and calls `waitpid` only for non-primary children. Procfs errors fail visibly; validate availability before spawning. Also, this rustix release types the subreaper boolean as `Option<Pid>`: `Some(Pid::INIT)` passes the enabling value 1, not a target process.

This walking skeleton immediately KILLs the ordinary process group on primary exit and waits for `ECHILD`, with a 7.5-second completion cap. It does **not** yet claim detached-tree containment, owner-death recovery, interactive job control or the section 3.3 TERM/CONT/grace policy. Noninteractive TERM/INT/HUP forwarding is present; an ignoring primary still needs the later bounded shutdown policy. Unsupported platforms reject execution rather than run unmanaged. These are implementation-stage boundaries, not reductions to v0.1.0 requirements.

**Owner-loss extension:** add a small private same-binary native helper/liveness channel before claiming crash containment. Kernel reapers/pidfds/Jobs provide authority; a runnable independent cleanup role provides progress when an ordinary owner dies. Where paused or double ordinary-owner loss needs another anchor, add the smallest independent native observer/reaper role demonstrated by the fault fixtures. Native cleanup roles stay outside the frozen workload; Linux/FreeBSD ancestors retain a reaper domain, and macOS retains an observer. Do not mirror pi-env's carrier/guardian/backup structure by default or count a destructor as death handling. If every independent cleanup role is killed, recovery is outside the documented guarantee.

Drive one **global per-tree** monotonic cleanup deadline. `run --grace <dur>`, `--fatal-grace <dur>` and `--cleanup-deadline <dur>` are generic options, with defaults 6s/3s/7500ms and validation `0 < fatal-grace <= grace < cleanup-deadline` before payload; invalid timing inputs return 2. Pi will pass its selected values through these options during section 7. Deliver TERM before permitted teardown CONT, then KILL. On Linux/FreeBSD select configured ordinary grace for abnormal owner loss, or configured fatal grace only when saved fatal helper wait status is already known at selection. EOF-first never reselects later. Adoption and native-role failover do not restart either grace or deadline. Test exact default/configured boundaries with the small policy seam.

**Section 3 implementation notes:** Linux now retains birth-checked pidfds for
unreaped direct/adopted children. Kernel reaper ancestry is the authority for
recursive cleanup: killing a direct owner exposes its detached children on the
next adoption sweep, without opening handles to arbitrary numeric descendants.
Healthy reaping removes inventory entries. If pidfds are unavailable, the visible
limitation is nondirect freezing; unreaped direct-child cleanup remains active.

The smallest owner-loss arrangement has two same-binary native processes: the
shell-facing owner and a separate-process-group anchor that owns the payload.
Both are subreapers. A close-on-exec nonblocking pipe carries one launch grant and
then owner liveness; it is never inherited by the payload. The anchor arms
parent-death SIGCONT and rechecks its live parent before granting launch. A killed
anchor is reaped by the surviving outer owner, which then cleans adopted work.
Loss of both roles remains excluded. No copied role topology is used.

An implementation experiment showed that adding `Command::pre_exec` to an
untrusted payload switches this host's std path to libc execvp's ENOEXEC shell
fallback (the plain-text negative fixture ran). Therefore only the trusted native
anchor has a pre-exec hook. Payload launch permission is the anchor's final live
lease check immediately before ordinary process-wrap spawn; owner loss after
permission starts cleanup, rather than claiming to undo an already granted exec.

Early CI also corrected two tooling assumptions: `cargo test --all-targets`
builds the example's test harness, not its runnable fixture image, so CI explicitly
builds examples first. **Superseded executor history:** at that early checkpoint,
Alpine's distro compiler reported `*-alpine-linux-musl`; the row mapped that vendor
alias to the required `*-unknown-linux-musl` label while printing actual rustc
host. The current Linux VM requirements instead require official exact-target
native Rust HOST tools and do not permit that alias substitution.

**Backend/runtime corrections:** FreeBSD reaper acquisition is process-scoped and
returns EBUSY on a second acquisition; the test rescue reaper is acquired once,
not once per scenario. The native x64/arm64 guest lifecycle rows passed after
that fix. Windows Job tests passed on x64/arm64 using Tokio's actual kill-on-close
combination, including native u32 results and owner termination. Job completion
waits are bounded; runtime shutdown also has a bound so a completion-port
blocking task cannot make timeout handling hang during runtime destruction.

macOS has no `pipe2`/rustix `pipe_with`, so its single-threaded startup uses a
pipe followed by explicit CLOEXEC and NONBLOCK fcntls before any child spawn.
Both ordinary owner and independent observer retain observations for failover;
no parent-death syscall is claimed there. Credential comparison includes
effective, real and saved UIDs alongside PID and microsecond birth time.

The new ConPTY harness must establish virtual-console stdio in its attached
fixture child: a CreateProcess from a redirected test host retained that host's
stdio instead of providing the intended virtual terminal streams. A tiny
fixture-only bootstrap opens CONIN$/CONOUT$ in the attached context, then launches
procward with those handles. Production continues to preserve inherited stdio,
including intentional redirection. Communication ends stay open through native
process creation and output drains independently, as Microsoft documents.

A shutdown-observation fixture race (KILL between truncate and write) was fixed
with atomic rename, not relaxed predicates or deadlines. Its old-source flaky
job was rerun normally with both attempts retained.

**Global-policy audit correction (supervisor-approved):** a final audit found that independent per-role Policy construction could restart grace after late anchor loss. The anchor now atomically publishes one fixed private record before cleanup actions: CLOCK_MONOTONIC start plus configured grace/fatal/deadline and the already-selected classification. The outer owner retains it and drains it after anchor exit before fallback. The record travels on a separate CLOEXEC pipe, never the application transport and never into payload exec. An anchor that dies before publication has not started cleanup, so outer selects its first policy at fault observation. A non-default 2s/1s/2500ms, response-gated late-anchor-loss fixture enforces the original configured budget; its negative control (discarding the record) failed at 2.821 seconds. No default 8-second fault assertion was relaxed.

**Verified dependency gaps (supervisor-approved):** process-wrap 10.0.1's shared Windows wait returned on any completion packet, not matching Job ACTIVE_PROCESS_ZERO. Pristine source was committed before a minimal vendored completion fix, with red/green standalone regression, preserved licences and an unfiled upstream patch/report. rustix 1.1.6 likewise passed FreeBSD's successful `rk_fpid = -1` sentinel to Pid::from_raw; a separate pristine vendor and one-field conversion fix retain its original terms and prepare, but do not file, an upstream report. These are third-party crate modifications, not copied pi-env code or new Job/procctl implementations. See third_party/*/PROCWARD-PATCH.md and docs/licensing.md. No newer rustix release/upstream main fix was available when checked by parent.

libproc 0.14.11 also checks stale errno on a valid empty child-list result; macOS clears errno immediately before that query, preserving actual returned errors. BSDInfo may be unavailable with ESRCH while the PID still exists in an exiting/zombie transition: those observations remain unknown completion blockers without signal authority and are retried within the same deadline. Real denied/other queries fail; no failed query counts as absence. FreeBSD reaper KILL's ESRCH is accepted only after a fresh kernel list proves no signalable member remains; waits still establish completion, and live/denied/unknown states remain failures.

**Final native audit corrections:** FreeBSD pipe(2) anonymous endpoints are
bidirectional, so FIFO endpoints with zero link count may legitimately report
O_RDWR; other platforms retain exact RDONLY/WRONLY validation and non-pipe fds
are rejected. Native endpoint tests cover that distinction. Darwin waitid can
produce empty/nonterminal notifications with WNOHANG: only a genuine exited or
signalled status supplies primary result, while stopped/continued work retains
ownership.

A fixture's PID file never proves an independent observer already inventoried
it. The Darwin CLI observer-loss case now checks fail-closed 125 plus explicit
pre-observation disclosure, with separately labelled harness cleanup of any test
survivors. A native test primes the real retained inventory before killing its
observer and exercises the same production fallback function, requiring cleanup
without rescue and the defined failure status. This tests the observed-tree
contract without a fake readiness delay, a test-only product flag or a new
startup protocol. Real child-owning native cases are sequential so inventories
do not accidentally own another test's fixtures.

**Interactive extension:** direct groups alone do not prevent a physical tty background syscall from stopping application progress after shell reclaim. The behavioural reference documents this real failure, so interactive isolation is justified for the preserved terminal/cleanup guarantee, not for ordinary pipe execution. Add a focused Unix private PTY path only in this slice, using rustix-openpty if it reduces correct code. Keep physical authority with runnable native roles in the caller session; primary input/output uses the private terminal, redirected stderr remains unchanged, and fatal draining cannot wait on stopped output. The own code is grant/stop/resume/restore/relay coordination, not another PTY implementation. Preserve normal output; fatal cleanup may discard it. If a simpler direct-handoff path passes every adversarial authority/blocked-IO fixture, prefer it instead; externally required behaviour and task coverage do not change.

Ctrl-Z restores cooked state and stops shell-facing/owned work, not every cleanup helper. `bg` resumes private work without physical IO; `fg` grants IO and continues. Reconcile a CONT racing freeze, never issue healthy grants during irreversible cleanup, and never mask TTIN/TTOU to force a denied restoration. Linux nondirect freeze uses birth-checked pidfds; FreeBSD uses its kernel subtree; macOS uses retained observed identities. A missing pidfd can visibly reduce freezing capability but not disable reaper cleanup.

**Windows:** use current-thread Tokio only in its backend so process-wrap actually enables kill-on-last-Job-handle-close. Observe the primary through the wrapper/native process handle, trigger Job tree termination on its exit/cancel, and await Job completion within the deadline. Process-wrap's suspended assignment avoids a new custom bootstrap implementation. Fresh fixtures must prove owner SIGKILL-equivalent termination, handle closure, prelaunch failure, native u32 status and inherited console/ConPTY interaction; do not assume wrapper names prove these facts.

### 5. Honest platform guarantees and OS-standard prior art

| Platform | v0.1.0 guarantee | Limits |
| --- | --- | --- |
| Linux | Subreaper lifetime, safe pidfd/unreaped-child signalling, adopted-orphan reaping and surviving native cleanup role | pidfd support probed; privilege transitions can clear parent-death wakes; all cleanup roles lost is not recoverable |
| FreeBSD | procctl reaper/nested-reaper lifetime, fresh kernel-owned targets and reliable paused cleanup wake | Must establish required wake without host configuration changes; enumeration/permission failure is not absence |
| macOS | Independent observer plus retained birth/UID-validated observed identities, best-effort sweep with no known survivors | No subreaper; fast setsid + reparent to launchd before observation, unseen children/final-scan forks and check/use races can escape; never claim kernel containment |
| Windows | Job assignment before payload, kill-on-last-handle-close and explicit Job completion | No leaked ownership handles or permitted arbitrary breakaway; Unix Ctrl-Z/termios is not a Windows feature |

Use standard mechanisms rather than inventing replacements: [tini](https://github.com/krallin/tini), [dumb-init](https://github.com/Yelp/dumb-init), [catatonit](https://github.com/openSUSE/catatonit), [systemd-run --scope](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html), [s6](https://skarnet.org/software/s6/) and [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) establish useful init/signal/reaping/liveness principles. None is asserted to supply the whole cross-platform interactive contract. Host/kernel failure, all independent role loss and wake-clearing privileged transitions remain explicit exclusions.

### 6. Small independently tested application contract; pi comes later

Document a generic versioned managed-child handoff: `PROCWARD_PROTOCOL=1`, immediate `PROCWARD_OWNER_PID` and an explicitly granted application-facing `PROCWARD_LIFECYCLE_FD`/Windows inherited-pipe equivalent. Native launch gates establish identity before exec; any consuming application reads a bounded ready record and rechecks live parent identity before accepting managed state. Environment strings alone do not authorize managed state. Keep this app endpoint separate from native reaper/terminal grants and Job handles, exclude private endpoints/one-shot claims from ordinary descendants, and fail incomplete, stale, oversized or unsupported handoffs closed. No pi-specific procward mode exists.

The same small stream supports readiness, transport EOF and owner-loss/pre-hook shutdown notification to the primary. The primary's cooperative pre-kill window is bounded by the selected generic `--grace`, `--fatal-grace` and `--cleanup-deadline` policy; notification cannot extend or restart it. Standalone fixtures cover cooperative and blocked primaries, not-ready retry, silence timeout and deadline preemption. Procward imposes no fixed application hook or watchdog duration.

Generic per-task `procward run --control-fd N` uses non-session ownership and bounded startup/primary-result/error/cleanup records; retaining `S`/`X`/`E`/`C` semantics is an interface compatibility choice, not copied pi-env code. Success requires valid completion plus transport drain/helper close; Darwin completion is best-effort. Do not build the pi-env framed RPC or expose all native role internals. Version and exact bounds/fields are documented and fixture-tested before any application adopts them.

After standalone v0.1.0, make a normal pi change to bundle the release and adapt local session/task consumers (`process-owner.ts`, core exec/bash callers). A tiny entrypoint handles opt-outs/binary/handoff before heavy static imports; only managed or disabled inner execution imports the full CLI graph. Verify source/npm/compiled entrypoints with import-count instrumentation, not an arbitrary startup-percentage SLA. Preserve version-only fast path and `--no-process-ownership`/`PI_NO_PROCESS_OWNERSHIP=1`, with option-value/`--` handling. Direct `procward run -- pi` and pi under pi add pi's own ownership layer by default. Only the launcher's `--no-process-ownership` or `PI_NO_PROCESS_OWNERSHIP=1` disables that layer. Pi skips only its own bootstrap handoff, identified by its private one-shot marker plus a valid READY record; external procward metadata alone never suppresses wrapping. `procward run` inside another procward-managed tree is supported: each layer owns its subtree, preserves primary status, obeys its configured cleanup deadline and replaces inherited contract metadata/transport before launching its own primary.

Pi retains UI/hook policy. On Unix owner loss, responsive hooks get up to 5 seconds and a separately armed watchdog self-terminates by 7 seconds from observed loss if JS cannot progress. Native/observer wake must work after pause; notification precedes signal hooks; re-entrant shutdown still arms the deadline. Native fatal policy, including 3-second proved-fatal cleanup, can preempt hooks and is never extended. Pi's small adapter/package tests and reciprocal README edit run through its normal owning patch-ref workflow, not procward CI or a recreation of the previous release ceremony.

### 7. Early full CI, ordinary reruns, one pre-tag review

As soon as the Linux skeleton compiles, create/use the GitHub repository, push it and enable `push` on every branch plus `pull_request`. Test each event head (not every intermediate SHA in a multi-commit push), including docs-only changes. Set matrix fail-fast false and do not cancel older event coverage. Run all currently applicable tests; unfinished required backends stay visibly red during development rather than being excluded. Fix forward. Rerunning flaky jobs is normal and requires no packet, preclassification approval or per-step review. Keep ordinary logs/attempt history and never relax test predicates to obtain green.

#### Superseded executor history

The following table and qemu-user paragraphs preserve the pre-VM execution design
and explain its historical CI evidence. They are **not current execution
instructions**: container/binfmt paths, host-kernel labels, emulator exemptions,
row-only deadline scales and the future full-system follow-up are superseded by
`specs/ci-release`, `specs/platform-backends` and `specs/test-harness`. Prior green
runs do not satisfy the new full-system CI/release verification gate.

| Required Rust/runtime target | Executor | Pi labels later mapped to it |
| --- | --- | --- |
| x86_64-unknown-linux-gnu | Linux x64 GNU | linux-x64-gnu-baseline/modern |
| aarch64-unknown-linux-gnu | Linux arm64 GNU | linux-arm64-gnu |
| x86_64-unknown-linux-musl | Matching-arch musl container | linux-x64-musl-baseline/modern |
| aarch64-unknown-linux-musl | Matching-arch musl container | linux-arm64-musl |
| riscv64gc-unknown-linux-gnu | Pinned Debian riscv64 container through pinned qemu-user/binfmt on Linux x64 | standalone asset; pi label mapping not claimed |
| riscv64gc-unknown-linux-musl | Pinned Alpine riscv64 container through pinned qemu-user/binfmt on Linux x64 | standalone asset; pi label mapping not claimed |
| x86_64-unknown-freebsd | Pinned vmactions/freebsd-vm, x64 guest | freebsd-x64 |
| aarch64-unknown-freebsd | Same VM action, declared arm64 guest/emulation | freebsd-arm64 |
| x86_64-apple-darwin | macOS x64 | darwin-x64-baseline/modern |
| aarch64-apple-darwin | macOS arm64 | darwin-arm64 |
| x86_64-pc-windows-msvc | Windows x64, console/ConPTY | windows-x64-baseline/modern |
| aarch64-pc-windows-msvc | Windows arm64, console/ConPTY | windows-arm64 |

Twelve Rust triples cover four OS families, the existing 14 pi labels and two
additional standalone riscv64 release assets; do not invent extra CPU backends
or claim a new pi runtime mapping. Both riscv64 rows are **emulated (qemu-user) —
semantics of prctl/pidfd/process groups are passed through to the host kernel;
timings are not representative**. GitHub has no native riscv64 runner. Use pinned
`docker/setup-qemu-action` plus a digest-pinned binfmt image and digest-pinned
Debian GNU/Alpine musl riscv64 containers, cross-building release-profile binaries
and tests with the official rustup target triple before executing them there.
Do not map Alpine's `riscv64-alpine-linux-musl` compiler alias to the requested
release target. Pin existing native musl images too.
Print source/target/executor/toolchain and the emulation caveat. Current timing
scale is 1×: no deadlines or assertions are relaxed. If emulation needs a wider
budget, document an explicit emulated-row-only scale, preserve ordering/identity/
completion assertions and configured-deadline-relative checks, and keep native
budgets unchanged. Release assets, checksums and attestations must include both
riscv64 GNU and musl outputs.

qemu-user lacks seccomp installation and can break libc vfork/posix_spawn
exec-error reporting. Runtime capability probes, never `target_arch`, identify
these limitations only in explicitly marked emulated test executors. Report
`EMULATOR-UNSUPPORTED` for affected cases and count/list them in job summaries;
never call them product passes, reinterpret 127 as success, change product code
for emulation or weaken other/native assertions. Full-system riscv64
`qemu-system` CI is a follow-up for complete coverage of these cases.

#### Current full-system execution model

All six Linux rows now require copy-only full-system guests: pinned Ubuntu 24.04
VM Actions for GNU and Alpine 3.24 VM Actions for musl, with official exact-target
native Rust HOST tools. RISC-V remains QEMU CPU emulation with a separate RISC-V
kernel, not native hardware or host-kernel syscall forwarding. Fixed 2CPU/2GiB,
guest cgroup/nft/PID bounds and independent host deadlines contain each run without
scaling product fault deadlines. Both workflows require a separate bounded hazard
VM; Linux release measurements and selected-opt-level `dist` suites remain inside
the guest before packaging. The detailed constraints are in the current delta
specs; actual new remote CI/dry-run results remain required, not inferred from the
superseded executor history above.

Build-only/cross-compile does not replace runtime tests. Setup budgets may account for guest startup but native fault teardown stays ≤8 seconds. Behaviour-driven interactions act → observe effect/not-ready hint → retry while not ready; silence fails by deadline and endless hints cannot extend the overall bound. Polling observations is allowed; sleeps must not sequence input. A stopped identity is alive, a zombie is unreaped, and a failed query is not absence. If a harness rescues a survivor, the test still failed.

Before first tag, get **one independent review** of actual code, crate assumptions/gaps, safety tests and release setup, fix blocking findings and obtain a complete passing matrix. Do not require independent reviews before every small implementation step or early push. No review or runtime pass is claimed by this planning document.

### 8. Version-tag releases and GitHub-native supply chain

Release only from pushed exact stable `vX.Y.Z` tags, beginning with `v0.1.0`. A broad `v*` trigger must be followed by exact syntax/Cargo-version/commit checks. Branches/PR/manual/live-release updates never publish. Build every target and rerun its full applicable fixture suite, including the release binary, from the tagged source rather than relying on old branch artifacts.

A repository owner enables **Settings → General → Releases → Enable release immutability** once, records confirmation and rechecks `gh api repos/OWNER/procward/immutable-releases` with their existing owner login before the first tag. That API requires admin-read access; normal Actions `contents: write` does not provide it. Do not add an admin PAT/App credential or invent an Actions administration permission.

Freeze final binary/package bytes, generate `SHA256SUMS` over downloadable platform assets (not itself), and attest binaries/packages plus the checksum manifest with GitHub's currently recommended **actions/attest** using OIDC/Sigstore build provenance. The older actions/attest-build-provenance is a supported wrapper whose README now recommends actions/attest. Per-target trusted jobs attest their output, including VM-returned bytes; fan-in attests/verifies the manifest. No repackaging follows attestation. This is normal artifact handling, not a custom sealed acceptance system.

Ordinary push/PR jobs: `contents: read` only, no privileged `pull_request_target` execution of untrusted code. Tag attestation jobs: `contents: read`, `id-token: write`, `attestations: write`. Only the publisher gets `contents: write`; it needs attestation permissions only if it signs there. Pin reviewed immutable action revisions.

Verify subject bytes, checksums and expected repo/workflow/tag/source before publication. Example: `gh attestation verify <asset-path> --repo OWNER/procward --signer-workflow OWNER/procward/.github/workflows/release.yml --source-ref refs/tags/v0.1.0 --source-digest <tag-commit-sha>`. Create a draft for the existing tag, attach all assets, then publish. Run `gh release verify v0.1.0 --repo OWNER/procward` and `gh release verify-asset v0.1.0 <asset-path> --repo OWNER/procward` afterwards. A failure is loud and actionable; do not claim it prevented an already completed publication. Setting drift can permit a mutable release before this verification fails; record that residual risk in docs/ci-release.md, not README. Published fixes use a new version tag, never replacement assets/tag movement.

GitHub automatic immutable-release attestation binds tag/commit/assets and complements artifact build provenance. Only assets/tag are locked; title/notes/latest/pre-release metadata can change. Checksums alone are not authenticated provenance. Public repositories support artifact attestations on current plans; private/internal repositories require GitHub Enterprise Cloud; GHES is unsupported. Confirm feature availability before the first tag.

Verified official references: [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases), [exact setting](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes), [admin-read setting API](https://docs.github.com/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository), [artifact attestation permissions](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds), [actions/attest](https://github.com/actions/attest), [older wrapper](https://github.com/actions/attest-build-provenance), [gh attestation verify](https://cli.github.com/manual/gh_attestation_verify), [release verification](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity), [release API](https://docs.github.com/rest/releases/releases#create-a-release). If token/workflow authorization blocks publication, report/fix it normally; no secret credential fallback.

### 9. BSD licence, docs split, repository metadata and reciprocal links

All procward implementation and fixture code is newly authored under **BSD-3-Clause**, with root `LICENSE` titled **BSD 3-Clause License**, canonical [SPDX text](https://spdx.org/licenses/BSD-3-Clause.html), confirmed own copyright information and exact `license = "BSD-3-Clause"` in Cargo.toml. Use `SPDX-License-Identifier: BSD-3-Clause` where appropriate. **No pi-env code is copied, so no upstream pi-env MIT notice or relicensing permission is needed.** The previous source-attribution/relicensing gate and temporary-code-duplication/library-migration plan are superseded. Do not copy even test helper implementations or substantial prose; describe reference scenarios in new words. Dependency licences still apply: retain notices required by selected crate licences in source/binary distributions and document them under docs/licensing.md, without mislabelling dependencies as BSD.

README contains **only** what procward is, installation, usage and background. Background links to **https://github.com/xz-dev/pi** as project origin/main consumer and explains that procward is a new standalone implementation, not copied source. Detailed architecture/platform internals, pi contract/integration, CI/release/attestation verification, development/testing and dependency licence material belong in the mapped docs/ pages. No extra licence/CI/developer sections in README.

When the repository is created early, set this exact truthful description:

> Cross-platform process-tree ownership and job control for CLI programs, built in Rust for pi and standalone use.

Exact topics: `process-supervisor`, `process-management`, `subreaper`, `job-control`, `init`, `pty`, `cross-platform`, `rust`, `cli`, `windows-job-objects`, `freebsd`, `macos`, `linux`.

```sh
gh repo edit "$PROCWARD_REPO" \
  --description 'Cross-platform process-tree ownership and job control for CLI programs, built in Rust for pi and standalone use.' \
  --add-topic process-supervisor --add-topic process-management \
  --add-topic subreaper --add-topic job-control --add-topic init \
  --add-topic pty --add-topic cross-platform --add-topic rust --add-topic cli \
  --add-topic windows-job-objects --add-topic freebsd --add-topic macos --add-topic linux
gh repo view "$PROCWARD_REPO" --json url,description,repositoryTopics
```

Use the actual created repository ID/URL, not an assumed owner. During later normal pi integration, update its root README process-tree feature to link to that canonical procward URL, preserving its macOS caveat. Carry the edit on pi's current owning patch ref per its normal fork workflow, not by editing downstream main or from procward. No special release-packet process is added.

## Risks / Trade-offs

- [Crate API name is mistaken for a complete ownership guarantee] → Pin verified frontend/features and test crash/descendant behaviour; std JobObject and Unix Drop are explicit counterexamples.
- [New code grows into another pi-env] → Start binary-only and noninteractive; add only coordination needed by failing behavioural fixtures. No remote features, copied modules, public framework or speculative flexibility.
- [Small code cannot eliminate OS limits] → Keep independent native cleanup progress, identity validation and honest macOS/privilege/all-role-loss exclusions; do not trade safety for an arbitrary line-count promise.
- [PTY integration duplicates session setup or adds unnecessary dependencies] → Defer it to demonstrated interactive need; choose one focused path and do not combine login_tty with a second setsid wrapper.
- [Recent crate release/backport metadata misleads selection] → Record exact checked versions/MSRV and lock dependencies; confirm FreeBSD/Windows behaviour on real CI rather than infer from Linux rustdoc.
- [Early red CI becomes accepted incomplete scope] → Push and fix forward freely, rerun normally, but require complete applicable passing coverage and one independent review before v0.1.0.
- [Manual immutability setting drifts] → Owner enable/recheck, draft-first assets and postpublication verification; document residual detection-after-publication risk without extra credentials.
- [BSD code choice is confused with dependency licensing] → No pi-env copying/no inherited pi-env notice; retain actual dependency obligations under docs/ and in packages.
- [Pi migration revives doubled imports or old lifecycle races] → Integrate only after standalone release, use thin contract/import-count tests and response-driven adapter smoke tests in pi.

## Migration Plan

1. Replace extraction assumptions with the fresh implementation/crate decisions in this revision. Keep the pi-env repository untouched as a read-only behavioural reference.
2. Build the Linux walking skeleton and fresh argv/tree fixtures. Once it compiles, create/use the repository, set metadata, push and enable the entire four-platform push/PR matrix. Red development CI and normal reruns are expected feedback.
3. Fix forward through reaping/owner-loss edges, remaining backends, interactive job control and standalone contract tests. Keep full fixture CI independent of pi.
4. Complete README/docs/BSD/dependency notices and the tag-only release workflow. Obtain one independent review, address blockers and get full applicable runtime coverage passing.
5. Owner checks immutable-release prerequisites; push `v0.1.0`. Rebuild/retest, attest/checksum, stage draft assets, publish and verify. Rollback means consumers pin an earlier accepted version; corrections require a new tag, not editing immutable bytes.
6. Make a normal pi change to bundle/adapt procward, bootstrap once, preserve opt-outs/hooks and add the reciprocal README feature link on its owning ref. Pi rollback restores its previous matching adapter/helper pair; procward standalone release remains independent.

## Open Questions / Follow-ups

- Stronger future macOS tracking (for example kqueue exit observations or entitled EndpointSecurity) is outside v0.1.0; the documented best-effort boundary is fixed.
- Choose the least-cost native helper/TTY coordination that passes the specified owner-loss/authority scenarios; exact private role count is an implementation detail, not a reason to copy pi-env's topology. No externally required behaviour is deferred.
- Reconfirm hosted runner/guest capacity and crate support on the actual early CI jobs; missing coverage is visible red development feedback and a release blocker.
- Default nesting is required in v0.1.0: procward inside procward is supported, and pi adds its own layer under pi or external procward unless explicitly disabled. A public Rust library remains a separate later request if a real caller needs it.
- Pi's release pin/update cadence is a later integration policy. GitHub hosting, BSD project licence and native immutable attested tag releases are already decided.
