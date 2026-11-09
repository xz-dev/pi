# Development

This checkout implements standalone lifecycle/platform ownership, Unix terminal
job control and generic application/task contracts for change
`extract-procward-core`. Release setup is described in [ci-release.md](ci-release.md);
the independent pre-tag review, owner-controlled immutable-release prerequisite,
first release and later pi integration remain separate tasks. No tests launch pi
or use pi-env source/fixtures.

## Build and checks

```sh
# Host: compile only; do not execute Linux fixtures here.
cargo build --locked --bins --examples
cargo test --locked --all-targets --no-run
cargo clippy --locked --all-targets -- -D warnings
cargo fmt --check

# Linux: use a disposable full-system QEMU VM.
python3 ci/vm-test.py --kernel <installed-kernel-version-or-image>
python3 ci/vm-test.py --kernel <installed-kernel-version-or-image> --hazard
```

On FreeBSD, macOS and Windows, keep the native `cargo test --locked --all-targets`
entrypoint. Cargo's Linux runner refuses execution without a separate-kernel VM
manifest; Docker and `qemu-user` alone do not satisfy that boundary.

The Linux host runner reuses `virtme-run`, an existing compatible kernel/modules
and QEMU/KVM. It builds binaries and examples without executing them, inventories
Cargo's JSON test artifacts, then runs each test in a fresh guest cgroup in both
cgroup-enabled and forced-fallback modes. Host root and the manifest are exported
read-only with `--force-9p`; the guest has 2 vCPUs, 2 GiB RAM and no network.
Guest scratch is tmpfs. Kernel/launcher selection is configurable; missing
prerequisites fail rather than falling back to host execution. The host's
independent deadline ends the entire VM and reaps its processes. A distinct
boot ID, every individual result and a matching completion record are required;
VM death, missing records, OOM-assisted cleanup or harness rescue are not passes.
Logs and machine-readable summaries default to `/var/tmp/procward-vm/run-*`.
The three runner control checks are `--selftest ok`, `--selftest exit7` and
`--selftest hang` (the latter two must fail, not pass).

`--hazard` selects only the ignored adversarial integration test in its own VM,
with a whole-command 45-second host deadline; the adversarial product timeout
itself stays the guest-side 5-second case budget with hard `cgroup.kill`. The
ordinary suite does not silently count that case as executed. Run both commands
for full local Linux coverage.

**Remote verification gate:** GNU, musl and riscv64 CI/release jobs now provision
copy-only full-system VM Actions with official exact-target Rust tools. They use
the same guest test driver, both ordinary modes and a separately bounded hazard
VM. [Provider pins, resources, networking and execution plan](../ci/linux-vms.md)
describe the boundary. Actual remote full-matrix CI and dry-run release evidence
remain pending; do not merge or release on the strength of local/static results.

Build binaries and examples explicitly before focused or `--all-targets` tests:
the example's test harness is not its executable image, and the native Darwin
observer test launches the real procward binary. The example `fixture` is
test-only, not an installed binary. Cargo declares Rust 1.87 (process-wrap 10's MSRV); GNU x64
CI installs that compiler and checks all Linux targets alongside stable runtime
tests. The lockfile includes target-specific dependency resolution.

## Dependency updates

Dependabot checks Cargo and GitHub Actions daily, with up to 20 open
version-update PRs for each ecosystem. Its PRs run the normal full `pull_request`
CI; no auto-merge is configured. SHA-pinned `uses:` references keep their version comments (`# v4`,
`# v7.0.2`, etc.) so Dependabot can update the SHA and version comment together.

`process-wrap` and `rustix` are explicitly excluded from automatic version updates
because `[patch.crates-io]` selects their patched vendors. Check their upstream
releases manually; review `third_party/*/PROCWARD-PATCH.md` and remove/update each
vendor only after its required fixes are available and the full matrix passes.
Refresh Cargo.lock and the dependency licence inventory/bundle with dependency
changes. An ignored vendor is not automatically monitored by this configuration.

### VM executor updates

Linux CI/release uses pinned full-system VM Actions. The retired container image
manifests and their Docker Dependabot entries have been removed; bare containers
or binfmt/qemu-user do not provide the required separate-kernel runtime boundary.

| Linux targets | Full-system provider | Explicit release |
| --- | --- | --- |
| GNU x64 / arm64 / riscv64 | `vmactions/ubuntu-vm` | Ubuntu 24.04 |
| Musl x64 / arm64 / riscv64 | `vmactions/alpine-vm` | Alpine 3.24 |

Review action SHA, release and builder/image provenance changes together; see
[the provider pins and update boundary](../ci/linux-vms.md). Action dependency
updates do not replace image/kernel review or real full-matrix fixture execution.
Do not substitute a build-only check for runtime coverage.

## Runtime fixtures

Linux fixtures cover native argv/cwd/environment/stdio/status, rejected startup,
exec failures without shell fallback, healthy adopted-orphan reaping, unrelated
work, detached/stopped descendants, stale pidfds, launch-gate EOF/stale parents,
owner/anchor loss and targeted wake. Stable handles and observable file/input
responses sequence actions; polling has fixed deadlines, not readiness sleeps.
Tests distinguish stopped, zombie, gone and query failure. The stale-pidfd test
checks stable-handle safety; it does not force numeric PID reuse in the kernel.

Linux cleanup has two backends (see
[platforms.md](platforms.md#linux-workload-group-and-fallback)). Hosts without a
writable own cgroup run the fallback, and exact-stderr tests accept only its one
startup diagnostic. `tests/boundary.rs` adds a fully root guardian whose
signalable child must die at KILL while the guardian lives; this simulates a
live ancestor that blocks adoption, not a D-state task. Boundary expectations
select the backend from that diagnostic: a real `cgroup.kill` also ends root
members. `tests/cgroup.rs` is the real delegated-cgroup gate:

```sh
python3 ci/vm-test.py --kernel <installed-kernel-version-or-image> --mode cgroup
```

The VM runner supplies `PROCWARD_TEST_CGROUP_PARENT` to `tests/cgroup.rs` inside
each fresh guest group. The test creates one fresh `procward-test-*` group,
moves only its freshly spawned shell into it, and kills/removes only that group
on failure. Without the variable it prints `CGROUP-NOT-RUN`, which is not proof
of that backend. The forced-fallback pass records these cgroup-only tests as
not applicable, separately from passes. Do not run the old environment-variable
command directly on the host; it does not put other tests inside a VM.

Small Linux regressions cover the review repairs. A background job on a TOSTOP
terminal must not leak the denied fallback diagnostic or cause a SIGTTOU storm
(`tests/terminal.rs`). A live TERM-ignoring root with 48 TERM-ignoring children
under `RLIMIT_NOFILE` 32 must still be killed within the original deadline
(`tests/cli.rs`). After owner SIGKILL the surviving anchor must remove the empty
workload group (`tests/cgroup.rs`). Where the test's own cgroup is writable, the
TOSTOP and descriptor tests run procward in a fresh child group with
`cgroup.max.descendants` 0, so they exercise the fallback.

`tests/fixtures/pwbomb-original.c` is the independent review reproducer, kept
byte-for-byte and never built. `tests/fixtures/hazard.rs` is its faithful port
(fixture mode `pwbomb`): uncapped rolling fork chain, deep and wide subtrees,
TERM ignored. It refuses to fork without separate-kernel VM proof and an own
cgroup inside `PROCWARD_HAZARD_GROUP` with finite `pids.max` <= 768 and
`memory.max` <= 512 MiB. `tests/hazard.rs` preserves the real failure case:
product cgroup unavailable, `RLIMIT_NOFILE` 32, all three adversarial branches
actually started, task population above the descriptor limit, original cleanup
deadline, no unrelated-process kill and no survivors. It also checks that OOM
did not do the cleanup. The unchanged original C source is never built or run.

The first VM run exposed another real defect: rescanning the full inventory
between every reaped zombie exhausted the original 2-second deadline. Cleanup
now drains ready child exits before another scan, checking the same deadline
during the drain. Four independent bounded VM runs then completed in about
0.53–0.79 seconds, with task peaks 452/637/638/412, no OOM and no harness rescue.
The final case waits for observed branch entry and a population peak of at least
400 instead of sleeping to infer load readiness.
These are regression observations, not a kernel-atomic guarantee for every
possible uncontained adversarial workload.

FreeBSD guest fixtures exercise nested reapers, stopped adoption, healthy orphan
reaping, targeted parent-death SIGCONT and kernel query errors. Windows fixtures
check kill-on-close Job membership at payload startup, launch restrictions,
owner termination without destructors, primary versus Job completion, native
32-bit results, console Ctrl-C/Break and real ConPTY readiness/quit exchanges.
Darwin tests cover retained identity after setsid/reparenting, denied identity
queries, birth/UID/PID mismatches, owner loss, a native explicitly inventoried
observer-loss fallback and a separately rescued pre-observation escape
demonstration. The CLI early-observer-loss case asserts failure 125 and the
published limitation; any survivors are labelled test harness cleanup, not
product cleanup. PID-file readiness does not establish observation. Darwin
completion is best-effort.

The raw-terminal anchor-loss regression in CI `40718431017` at `24f14ab`
returned 125 with the explicit macOS pre-observation limitation, then failed its
unconditional owned-identity absence check. That test now permits labelled
harness cleanup of known fixture PIDs only when the product emits
`macOS best-effort observer lost; pre-observation descendants may escape after reparenting`.
Status 125, original teardown deadline, terminal restoration and unrelated
foreground-state assertions remain strict. Without that message, identity
absence still requires product cleanup; no product code or other test changed.

With defaults, Linux/FreeBSD use one immutable cleanup policy: TERM then one CONT
per newly adopted child during grace, KILL afterwards, no late rescue CONT and a
7.5-second cap.
EOF-first selects 6 seconds. Only already-saved fatal helper status selects 3.
Tiny deterministic policy tests check exact boundaries; runtime ignoring-TERM
and stopped-adoption fixtures preserve the default fault-relative 8-second assertion.
Cleanup is generic/configurable: `--grace 6s --fatal-grace 3s
--cleanup-deadline 7500ms` are defaults, with validation described in
[platforms.md](platforms.md). A one-shot private CLOEXEC record publishes the
system-wide monotonic start/selection before cleanup actions so outer fallback
cannot restart either configured grace or deadline. The same pipe now retains
per-identity TERM/CONT reservations across takeover, preventing replay for an
already-treated identity while allowing first signals for new adopted work.
Reservations precede syscalls: a crash in between may omit that grace attempt,
never replay it; original KILL/deadline policy is unchanged. Backpressure defers
grace signals without blocking KILL. The non-default late-loss
fixture uses 2s/1s/2500ms; discarding the record made its negative control fail at
2.821 seconds. Loss before publication is a separate checked case.

Historical pre-VM checks used task-owned `pw-*` tmux sessions to avoid the
installed pi subreaper's unreaped zombies. That was not an independent safety
boundary and is no longer a supported Linux test entrypoint; use the full-system
VM commands above. The records below describe those earlier checks, not commands
to repeat on the host.

Test-only rescue is explicit, identity-safe and leaves failed runs failed.
Pipe drain and child exit are observed separately with deadlines, so a dead
shell-facing owner cannot hide a stopped helper holding output open. Negative
controls disabled detached cleanup, replaced the parent-death CONT wake, and
omitted cleanup CONT; corresponding fresh fixtures failed. Restored code passed.
An early negative-control attempt exposed an unbounded test pipe drain and
required separately logged manual rescue; that harness was fixed, then its
negative control failed cleanly on deadline and reported its own rescue.
A child-only Linux seccomp filter also denies PR_SET_PDEATHSIG to verify required
wake setup refuses payload execution. Omitting arming made that new negative
control fail with payload status 0 instead of 125; the syscall was restored.

## Pre-tag review fix-forward

The review at `200cc58` blocked tagging. Three independent fixes have local
red→green evidence under `/var/tmp/pwf-fixes/` (task-owned `pwf-*` tmux sessions,
server PPID 1, no installed pi subreaper ancestor):

| Concern | Regression / evidence | Result |
| --- | --- | --- |
| SIGTTIN restart loop (`c7e3e68`) | `cargo test --locked --bin procward background_read_after_foreground_reclaim_returns_to_cleanup -- --nocapture`; `ttin-red.log` / `ttin-green.log` | Before fix: denied background read never returned after shell reclaim, test failed at its unchanged 2s reader deadline. After fix: direct read returns to cleanup. |
| Repeated unchanged blocked terminal fixture (`c7e3e68`) | `PROCWARD_TERMINAL_STRESS=200 cargo test --locked --test terminal repeated_blocked_terminal_cleanup_survives_foreground_reclaim -- --nocapture`; `ttin-green.log` | All 200 passed; ordinary full-suite CI repeats eight times by default, retaining each original assertion/deadline. |
| Raw terminal on anchor loss (`d07ec8b`) | `cargo test --locked --test terminal anchor_loss_restores_raw_terminal_only_with_foreground_authority -- --nocapture`; `restore-red.log` / `restore-green.log` | Before fix: status 125 but `restored=false`, cooked flags lost. After fix: `restored=true`, status 125, all owned identities gone; unrelated-foreground variant preserves its settings. |
| Repeated teardown CONT (`11cab0a`) | `cargo test --locked --test cli early_anchor_loss_does_not_repeat_teardown_cont_for_adopted_identity -- --nocapture`; `cont-red.log` / `cont-green.log` | Before fix: `true 2`, expected `true 1`. After fix: count one, status 125, no survivors within original 2500ms deadline. FreeBSD also exercises early loss with its existing order fixture. |

After these fixes, local `cargo test --locked --all-targets -- --nocapture`
passed 55 applicable Linux tests (zero failures/ignored). The direct read fixture
was subsequently narrowed to a single-threaded post-fork syscall child, matching
the relay instead of depending on libtest's process-directed signal routing.
The original threaded reader timed out in both Darwin CI rows in run
`40698997567`; no product assertion/deadline was relaxed. The revised fixture
also fails with SIGTTIN SA_RESTART deliberately restored
(`ttin-portable-red.log`, 2s read-return deadline), then passes with the handler
fixed (`ttin-portable-green.log`), including checks for both TTIN/TTOU flags.
Full build, clippy
`-D warnings`, formatting, strict OpenSpec validation and three release-safety
regressions passed. This local result does not replace the required twelve-row
ordinary CI or independent review approval. No tags, releases, repository settings
or pi code changed. Local commits used command-scoped signing disable after the
configured GPG pinentry timed out; no persistent Git setting changed.

Follow-up: the Darwin normal-exit absence flake remains unclassified. Tests now
label each poll phase and print retained/current PID, parent, birth, state and
UIDs, captured stderr and fixture-readiness facts before failed fixture cleanup.
No assertion/deadline changed. Harness readiness alone is not proof that product
inventory retained the identity; classify the next failure rather than treating
an unchanged-source rerun as a fix.

## Restoration-owed re-review fix-forward

The re-review at `9f7d9ee` found that unconditional outer restoration could
replace newer shell settings even when the relay never entered raw mode.
Failover now uses only the outstanding acquisition-time snapshot from the
private pipe. Restore/release clears it; foreground reacquisition saves current
settings. See [platforms.md](platforms.md) for the bounded write-ahead intent
window and unchanged kernel-authority checks.

Evidence under `/var/tmp/pwg-restore-owed/` comes from task-owned
`pwg-restore-owed` tmux, server PPID 1, outside the installed pi subreaper;
`wakeup` was not touched. Before the fix, both new CLI regressions failed with
status 125 but stale startup settings:

```sh
cargo build --locked --bins --examples
cargo test --locked --test terminal never_raw_anchor_loss_preserves_newer_shell_settings -- --exact --nocapture
cargo test --locked --test terminal reacquired_terminal_failover_restores_latest_shell_settings -- --exact --nocapture
```

`red-never_raw_anchor_loss_preserves_newer_shell_settings.log` and
`red-reacquired_terminal_failover_restores_latest_shell_settings.log` retain
those state-mismatch failures. The independent reviewer's probe was copied with
only evidence/binary paths changed: `probe-red.log` reports
`preserved_modified=False restored_stale_initial=True`; `probe-green.log`
reports `preserved_modified=True restored_stale_initial=False`, status 125 in
both. Ten additional fixed probe runs passed (`probe-green-01.log` through
`probe-green-10.log`).

`green-terminal.log` passes all twelve terminal tests, including existing
active/raw recovery and unrelated-foreground denial, the never-raw and
reacquisition regressions, and released-before-loss preservation. The small
native-record codec test checks all saved settings, including baud and control
codes (`codec-green.log`). Full applicable Linux suite passes 59 tests with no
failures/ignored (`full-test.log`); 300 unchanged blocked-terminal iterations
pass (`stress.log`). Build, clippy `-D warnings`, formatting, strict OpenSpec
validation and release-safety regression checks pass. These local checks are
not independent review approval or release authorization.

## Every-event CI and normal reruns

Repository metadata was verified with
`gh repo view --json url,description,repositoryTopics`: canonical URL
`https://github.com/xz-dev/procward`, exact design description and all 13 topics.
No settings, tags or releases were changed during backend implementation.

All pushes and pull requests now require twelve rows: GNU/musl Linux
x64/arm64/riscv64, FreeBSD x64/arm64 guests, macOS x64/arm64 and Windows x64/arm64.
The Linux rows use [copy-only full-system QEMU VMs](../ci/linux-vms.md), with
native official Rust tools and no Alpine vendor-alias rewrite or qemu-user runner.
RISC-V CPU emulation does not scale product deadlines. An additional independent
x64 GNU VM runs the ignored adversarial regression. No path/branch filters,
fail-fast or newer-event cancellation. Actual source SHA, executor, compiler host
and individual fixture results appear in ordinary logs. Historical runs below
predate this VM migration and are not evidence that the new executors pass.

Early unimplemented backends ran the fixture assertion and reported
`BACKEND INCOMPLETE (expected-unsupported during early development, NOT release coverage)`
as red, never a fake release pass. Initial full matrix: `bec61c5`, run
`40523401056`; docs-only event: `db91523`, run `40523519264`. Ordinary failed-job
rerun of the first run retained attempt 1 logs. A genuine fixture-publication
race occurred in GNU x64 at `b6fde08`, run `40528359033`: forced KILL could catch
`fs::write` after truncate. Its ordinary job rerun kept the old source/assertions;
fix-forward `c98a0c4` publishes the observation with atomic rename instead.
GNU x64 attempt 2 passed with old source/assertions, confirming normal flaky-job
reruns work without deleting attempt 1. One historical macOS arm64 row was not
acquired by a hosted runner (GitHub annotations cite capacity constraints), not
cancelled by matrix/new-event policy; current required rows are watched/rerun
normally until complete.

## Narrow dependency fixes

The real fixtures found two upstream bugs, handled through separately committed
pristine vendors and minimal documented patches, not new OS implementations:

- process-wrap 10.0.1 returned Job completion after any completion packet.
  Pristine deterministic regression: run `40532870970`, both Windows arches red;
  fix `44ed740` waits for this Job's ACTIVE_PROCESS_ZERO and propagates errors.
- rustix 1.1.6 converted FreeBSD's no-failed-PID sentinel -1 as a positive Pid.
  Pristine corrected regression: run `40536071916`; fix `ebdb103` maps the
  sentinel to None. No procctl shim or disabled assertion.

See `third_party/*/PROCWARD-PATCH.md` and their unfiled `UPSTREAM.md` reports/diffs.
Remote regression branches were deleted after recording red evidence; source
commits and ordinary Actions logs remain attributable. No upstream issue/PR was
filed. Parent/user approval is needed before filing, and vendors should be
removed once upstream ships fixes. Original licences and modification notices
are preserved; [licensing.md](licensing.md) lists all 64 locked crate/versions.

## Original ten-row section 2–3 checkpoint

Code commit `eb8ca7d`: [run 40545740279](https://github.com/xz-dev/procward/actions/runs/40545740279)
completed **success on all ten rows**, with real fixture execution:

| Runtime target | Result |
| --- | --- |
| x86_64-unknown-linux-gnu | success, including Rust 1.87 check |
| aarch64-unknown-linux-gnu | success |
| x86_64-unknown-linux-musl | success |
| aarch64-unknown-linux-musl | success |
| x86_64-unknown-freebsd | success, FreeBSD 14.3 guest |
| aarch64-unknown-freebsd | success, FreeBSD 14.3 guest |
| x86_64-apple-darwin | success |
| aarch64-apple-darwin | success |
| x86_64-pc-windows-msvc | success, console and ConPTY |
| aarch64-pc-windows-msvc | success, console and ConPTY |

This is an ordinary development checkpoint, not release acceptance or a sealed
artifact packet. The later binding riscv64 addition expands the requirement to
12 rows and reopens task 2.2 until both emulated GNU/musl fixture rows pass.
Subsequent documentation-only pushes still run the full matrix.
At that ten-row checkpoint, tasks 1–3 were complete (14/34); sections 4–7 remained, including interactive Unix
job control, application/task contracts, release setup/review, owner-controlled
release prerequisites and later pi integration. No tag, release, repository
setting or pi/pi-env code was changed in this slice.

## Expanded riscv64 checkpoint

The binding riscv64 addition is implemented at `41210c0` in
[run 40557371203](https://github.com/xz-dev/procward/actions/runs/40557371203).
All twelve workflow rows concluded successfully after the ordinary failed-row
rerun (attempt 2). This closes the reopened task 2.2; tasks 1–3 are again complete
(14/34), with sections 4–7 still pending. This is not release acceptance.

| Target | Result in 40557371203 |
| --- | --- |
| x86_64-unknown-linux-gnu | Passed, including Rust 1.87 check |
| aarch64-unknown-linux-gnu | Passed |
| x86_64-unknown-linux-musl | Passed |
| aarch64-unknown-linux-musl | Passed |
| riscv64gc-unknown-linux-gnu | Applicable assertions passed; **2 EMULATOR-UNSUPPORTED** cases |
| riscv64gc-unknown-linux-musl | Applicable assertions passed; **1 EMULATOR-UNSUPPORTED** case |
| x86_64-unknown-freebsd | Passed |
| aarch64-unknown-freebsd | Passed |
| x86_64-apple-darwin | Passed |
| aarch64-apple-darwin | Passed on unchanged-source ordinary rerun |
| x86_64-pc-windows-msvc | Passed, including console/ConPTY |
| aarch64-pc-windows-msvc | Passed, including console/ConPTY |

Both riscv64 jobs use the official rustup target, cross-build release-profile
binaries/tests and execute the full invoked suite in pinned target containers.
GNU uses the Ubuntu cross GCC/sysroot; musl uses shipped rust-lld plus
`-C target-feature=+crt-static -C link-self-contained=yes`. ELF machine checks
verify RISC-V outputs. Each exercised 7 unit, 19 CLI and 3 portable cases, but the
Rust harness's successful return does **not** make the explicitly unsupported
cases product passes. Job summaries count/list them: seccomp installation
`ENOSYS` in both rows, plus known-missing-path std spawn returning a child exiting
127 through qemu's broken vfork/posix_spawn error path in GNU. Musl's exec-error
assertions ran normally. Genuine primary status 127 remains strict in both.
See [platforms.md](platforms.md) for exact limits and full-system VM follow-up.
Timing scale stays **1×**, with no wider budgets or weakened native assertions.
No product code was changed for emulation.

Initial expansion commit `e42091c`,
[run 40552699322](https://github.com/xz-dev/procward/actions/runs/40552699322),
kept both red riscv64 rows visible. GNU exposed the two emulator limitations;
Alpine's distro Rust reported `riscv64-alpine-linux-musl`, not the required exact
triple. Rather than alias that compiler or work around emulation in product code,
`41210c0` switched both variants to official exact-target release builds and
explicit runtime-probed unsupported results.

Run 40557371203 attempt 1 also failed Darwin arm64's one-second post-normal-exit
absence check and labelled its known-survivor harness rescue. The unchanged-source
rerun passed; no assertion or timing was changed. Root cause is not established
by those logs, so the nondeterministic observation/completion failure remains a
risk, not a fixed product defect. Both attempts' logs remain available.

Local follow-up gates passed outside the installed pi subreaper in task-owned
`pw-riscv-*` tmux sessions: full Linux tests, clippy `-D warnings`, formatting,
plus an official self-contained riscv64 musl release cross-build. Setting the
emulator flag alone on native Linux still ran both original capability assertions
and emitted zero unsupported markers. Strict OpenSpec validation passed.

## Default nesting checkpoint (addendum-15)

The pi contract now requires a new pi-added layer under pi or any external
procward. Only the launcher's ownership flag/environment opt-out disables that
layer; only pi's private one-shot bootstrap marker plus valid READY suppresses
that bootstrap's second wrapping. Pi implementation remains section 7 work, not
code changed here. Procward itself always supports nested `run` scopes.

The new `tests/nesting.rs` executes the real
`procward run -- procward run -- <fixture>` boundary. It checks payload result
23 through both layers, outer-owner loss, inner-owner loss (Unix 137 / explicit
Windows native 71), and exclusive inner contract metadata/transport. Unix's
worker ignores TERM; Linux/FreeBSD also detach the branch and stop the worker,
and FreeBSD gives that branch a subordinate reaper. The outer policy is
2s / 1s / 2500ms against the inner defaults 6s / 3s / 7500ms. Fault timing starts
immediately before the actual kill, after identity preflight; every fault still
must complete inside the unchanged outer 2500ms deadline. Normal exit allows
the inner ordinary grace to finish before the outer primary exits. macOS uses
an attached tree and retains the documented best-effort observation boundary.

The fixtures found one product defect: an incoming lifecycle endpoint survived
into the nested payload even though its environment had been replaced.
`c207383` discards that endpoint before native roles/new handoff setup, reusing
Unix pipe/access validation and checking Windows pipe handles. Stale application
metadata is discarded rather than accepted as managed authority; explicit
native/task endpoints and consumer READY validation remain fail-closed. The first red test saw outer fd 6;
a later negative control, omitting the discard after caller-hygiene fixes, still
failed with pipes `[6, 7]` instead of only inner `[7]`. Restored code passed.

Fix-forward CI also corrected harness assumptions without weakening assertions:

- Linux reads procfs for parent/state facts instead of assuming procps `ps -p`
  exists in BusyBox/minimal target containers.
- FreeBSD traverses subordinate reaper domains because GETPIDS omits their
  descendants. Its pipe check scans the real descriptor limit; default devfs
  `/dev/fd` lists only 0, 1 and 2.
- CI runners leave unrelated pipes inheritable. The launcher makes those pipes,
  including Windows ambient stdio copies, non-inheritable before its first
  spawn. Scenarios are serialized to exclude another test's transient handles.
  The payload still enumerates all descriptors / snapshots all Windows handles
  and requires only its inner pipe beyond stdio. Windows stdio aliases are
  identified by kernel-object equality, not HANDLE numbers; unexpected handles
  retain server-PID diagnostics. Outer lifecycle/native pipes are not whitelisted.

At `ca0aaba`, [run 40677604462](https://github.com/xz-dev/procward/actions/runs/40677604462)
concluded **success on all twelve rows**, attempt 2. The ordinary unchanged-source
rerun followed an existing Darwin arm64 best-effort CLI fixture deadline failure
before nesting tests; its failed attempt and labelled harness rescue remain in
history. This does not establish a fix for that intermittent observation failure.

| Target | Result in 40677604462 |
| --- | --- |
| x86_64-unknown-linux-gnu | Passed, including Rust 1.87 check |
| aarch64-unknown-linux-gnu | Passed |
| x86_64-unknown-linux-musl | Passed |
| aarch64-unknown-linux-musl | Passed |
| riscv64gc-unknown-linux-gnu | All four nesting cases passed; **2 existing EMULATOR-UNSUPPORTED** cases |
| riscv64gc-unknown-linux-musl | All four nesting cases passed; **1 existing EMULATOR-UNSUPPORTED** case |
| x86_64-unknown-freebsd | Passed |
| aarch64-unknown-freebsd | Passed; outer/inner-loss completion 2.306s / 2.345s, both below 2.5s |
| x86_64-apple-darwin | Passed, best-effort |
| aarch64-apple-darwin | Passed on unchanged-source ordinary rerun, best-effort |
| x86_64-pc-windows-msvc | Passed; outer Job kill-on-close ended inner Job work in 2.138ms |
| aarch64-pc-windows-msvc | Passed; outer Job kill-on-close ended inner Job work in 4.739ms |

No Windows nested-Job containment defect was observed. Assignment remained
suspended-before-run with no breakaway request. Both owner-loss cases confirm
all retained inner process handles signalled; primary results and contract
isolation passed independently. The Windows pipe failures in earlier runs were
caller/stdio inheritance in the test harness, not a kernel Job failure.

Earlier fix-forward runs remain available: `40670356940` (initial harness
portability/inherited-runner-pipe failures), `40673115511` (Windows stdio copies
and FreeBSD arm64 preflight counted as fault time), `40674452842` (pipe-origin
diagnostics, plus an existing riscv64 GNU terminal fixture failure), and
`40676790053` (stdio alias diagnostics before final caller serialization).
No old failure was relabelled as a product pass or erased.

Final checkpoint local Linux suite: **48 passed**, run in a task-owned tmux session outside
the installed pi subreaper as described above. Native clippy `-D warnings`,
formatting, Rust 1.87 all-target checks, Windows/FreeBSD all-target cross-checks
and strict OpenSpec validation passed. Optional strict Windows clippy still
finds the pre-existing `unnecessary_unwrap` in `tests/fixtures/windows.rs:169`;
allowing only that known lint reports no other warnings. No unrelated lint fix
was added. FreeBSD's existing vendored process-wrap unused-import warning also
remains unchanged.

Tasks 4.7–4.9 are complete. Independent pre-tag review (5.5), owner-controlled
release prerequisites/publication (6), pi integration (7), and full-system
riscv64 coverage remain open. No tags, releases, settings or pi/pi-env code were
changed by this slice.

### Ordinary intermediaries

A late follow-up reproduced `procward run -- python3 -c 'subprocess.run(...)'`
returning 125: Python closes descriptors by default but retains the outer
application metadata. The approved correction treats stale/closed/mismatched
application metadata as non-authoritative, leaves unrelated non-pipe resources
alone, scrubs the outgoing environment, and always establishes fresh ownership.
It does not relax explicit native/task endpoint validation or a consumer's own
READY checks. Focused tests now cover both Python subprocess and `sh -c`, with a
real inner tree/result/cleanup check and a separate exhaustive contract-isolation
probe. Both intermediary cases passed locally. No architecture skip was added.

Python is a fixture prerequisite, not a procward runtime dependency. Current
Linux VM jobs install it with their guest build tools before runtime networking
is restricted; no package installation is included in startup measurements.
The earlier container implementation layered Python onto pinned container bases.
The final follow-up matrix must confirm the added intermediary cases on all
twelve rows; the earlier matrix above remains evidence for the
four direct-nesting cases, not that follow-up or the full-system VM migration.
