# Process ownership

Pi delegates its **local session tree** to [procward](https://github.com/xz-dev/procward). When Pi exits, crashes or is killed, procward cleans up its descendants, including background jobs, double forks and `setsid` descendants, subject to the platform limits below. No root, cgroups or administrator rights are required.

This integration replaces only Pi's outer session owner. Existing **per-task pi-env ownership is unchanged**: bash and extension commands, MCP stdio servers, Chord workers, durable environments and supported remote owned execution keep their current launch, cancellation and completion protocols. One task's cancellation does not cancel another task.

## Startup

Before loading settings, providers or extensions, Pi runs:

```text
procward run --grace 6s --fatal-grace 3s --cleanup-deadline 7500ms -- <same Pi runtime and arguments>
```

Unix replaces the lightweight bootstrap with procward using `execve`. Windows uses a lightweight spawn/wait wrapper; that wrapper does not load the CLI graph. A lone `--version` or `-v` skips automatic wrapping.

A primary already started by procward consumes the versioned managed-child contract instead of starting another owner. Environment alone is not evidence: Pi checks bounded READY records, launch ID, its exact primary PID and the live immediate native parent. Windows additionally compares the parent's full 64-bit creation FILETIME. Pi makes the lifecycle fd/HANDLE non-inheritable and removes contract metadata before loading the CLI or starting tools. Invalid readiness fails startup; invalid active records or EOF cause failed owner-loss shutdown.

The managed primary still publishes the existing `PI_PROCESS_OWNER_BINARY` pointing at bundled `pi-env`. Its task wrappers, Chord IPC and remote execution are not migrated to procward.

## Turning it off

Use `pi --no-process-ownership`, or inherit `PI_NO_PROCESS_OWNERSHIP=1`. This disables **automatic** wrapping and the existing per-task ownership setup. It also suppresses the missing-helper notice and macOS hint. Text used as another option's value, or after `--`, is not an opt-out switch.

An opt-out cannot remove containment already imposed by an external procward or sandbox. Pi still consumes a valid external managed-child contract, including lifecycle notification. Internal `PI_PROCESS_OWNER_*` claims are cleared before a new CLI launch; they are not accepted as proof of an outer owner.

## Compiled executables and source/npm

All 14 Bun release targets embed the matching procward executable, README, BSD-3-Clause license, third-party license notices and a manifest derived from `scripts/lib/procward-pin.mjs`. Ten Rust target ZIPs cover those 14 labels; baseline/modern aliases share their corresponding Rust executable. Pi has **no riscv64 release target**, regardless of procward's separate riscv64 support.

Compiled Pi never substitutes PATH for a missing bundled helper. The helper cache is keyed by version and executable SHA-256, and Pi checks the materialized bytes before use. Pi's small native fd/HANDLE adapter is a separate Pi resource, not another ownership implementation; its materialized bytes are also checked against embedded bytes.

Source/npm uses a supplied packaged helper first, otherwise a user-installed `procward` on PATH. There is no runtime download or postinstall fetch. If neither exists, Pi prints one explicit **ownership disabled** notice and continues; an opt-out suppresses the notice. A present incompatible helper or invalid contract fails launch instead of silently falling back. A PATH helper is user-provided and does **not** acquire bundled-pin provenance. Source builds compile the native consumer adapter alongside the retained pi-env task helper.

## Shutdown and terminal policy

A validated OWNER-LOSS notice is latched until interactive shutdown handlers register. A native TERM handler drains queued notice before deciding whether owner loss occurred. Ordinary external TERM and print/RPC termination retain their existing semantics.

Interactive Pi enters its existing `session_shutdown` hook path, then restores the terminal. The original responsive-hook deadline remains **5 seconds**, armed before the shutdown re-entry guard. A separate worker enforces the original **7-second** notice-driven bound if main JavaScript blocks. Neither extends procward's native grace or cleanup deadline. Native teardown can end the opportunity sooner; Pi does not ask procward to wait for hook acknowledgement.

Windows kill-on-last-Job-handle-close can kill Pi before notification is observed. Shutdown hooks there are **best effort**, not a guarantee for every owner fault. The integration contract tests a cooperative notice with the native parent still alive, independently of TERM, and compares actual saved console modes. Unix tests compare full saved terminal settings, not only escape output.

## Platform guarantees

| Platform | Outer owner boundary |
| --- | --- |
| Linux glibc and musl | procward's kernel subreaper and parent-death containment |
| FreeBSD | procward's kernel reaper boundary |
| Windows | procward's Job Object, no breakaway and kill-on-close; hook notification remains best effort |
| macOS | procward's identity-checked observed-descendant sweep; **best effort**, not kernel containment |

On macOS, descendants can escape if they detach and reparent before observation. Use a Linux VM/container when a hard boundary is required. Interactive Pi retains its macOS hint; quiet/offline and print/JSON/RPC runs do not gain a per-run hint.

Unix job-control and task timeout policy remain Pi/procward platform behavior, not a new guarantee inferred from this adapter. The task ownership implementation, including Windows Chord's existing attach-before-first-message checks and pre-attach limitation, is retained.

## Remote environments

Local procward containment does not extend to another machine. Remote `pi-env` execution remains unchanged: owned execution requires the daemon's `ownedExec1` capability, currently qualified on 64-bit GNU/Linux with glibc exactly 2.44. Other remote hosts keep the previous execution path, without claiming owned descendants.

## Pin, provenance and licenses

`scripts/lib/procward-pin.mjs` is the only hand-maintained identity: version, source commit, workflow/tag and ten ZIP/executable digest pairs. Build/runtime manifests are derived from it. Acquisition verifies the immutable release, release assets, checksum manifest and source-pinned attestations for the ZIP, manifest and executable before execution. ZIP extraction permits only four expected flat regular files and checks both ZIP and executable digests.

An `unpinned-dev` pin may refer to an exact main-branch CI dry-run build for private development. It is **not release provenance**. Publishing fails while this state remains, or when release digests/tag identity are missing. The parent can replace the pin with the authenticated tag and digests in that one file. Acquisition also compares verbatim legal notices against the packaged ZIP; a legal-text change requires a separate reviewed legal update.

`THIRD_PARTY_NOTICES.md` includes procward's complete legal notices and derived pin inventory. Each compiled artifact also carries the verified upstream license tree. Pi's adapter follows the existing TUI N-API helper pattern; Unix PTY test glue follows Pi Durable's openpty/setsid pattern. Neither implements native process-tree ownership.

## Verification

Procward's tagged release CI owns native containment, paused-owner, PTY/job-control and fault matrices. Pi does not duplicate that matrix or claim its retired 227/154/11 lifecycle records or Windows owner runtime gate.

Pi runs one small `procward-contract` on each existing platform row. Evidence binds the Pi artifact hash and procward version/source/ZIP/executable digests, then checks:

- bundled version/digest/licenses and no PATH substitution;
- automatic wrapping, validated-parent no nesting and both opt-outs;
- option values and positional text do not disable ownership;
- externally imposed containment survives a child opt-out;
- notice-only shutdown hook entry, the original 5-second responsive-hook bound and full terminal/console restoration.

Consumer tests separately check invalid/partial READY, deadlines, EOF, malformed notices, environment scrubbing, fd inheritance and the independent notice-driven 7-second worker bound with a live parent and blocked main JS. Linux results do not stand in for Windows, macOS, FreeBSD or musl acceptance. Hosted platform runs remain required before release. Startup figures must name runtime, target and sample size; source measurements are not compiled multi-platform latency claims.

Process ownership manages lifetime. It is **not a security sandbox** and does not restrict files, network or credentials. See [containerization](../packages/coding-agent/docs/containerization.md) for isolation.
