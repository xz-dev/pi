## Why

Pi needs reliable process-tree ownership and job control, but developing it inside pi-env and testing through the full pi application has become unmaintainable. Build procward as a small standalone Rust tool using mature crates and OS facilities, with fresh fixture-program tests independent of pi.

## What Changes

- **Superseding direction:** do not extract, copy or translate pi-env implementation or test code. Write new procward code; use pi-env only to understand observable behaviour, failures and edge-case scenarios. The historical change name `extract-procward-core` remains, but its implementation is no longer an extraction.
- Implement `procward run [options] -- <cmd> [args...]` as a scoped process owner. Prefer `process-wrap`, `rustix` and `signal-hook`; use a PTY crate only for the interactive isolation that fixture evidence requires, and `windows-sys` only for gaps in higher-level support. Research and explicit crate/OS gaps are recorded in design.
- Keep Linux, FreeBSD, macOS and Windows in v0.1.0 scope. Linux/FreeBSD/Windows use kernel-backed facilities; macOS remains honestly best-effort with birth-validated observed descendants and a documented pre-observation escape window.
- Preserve user-facing invariants: cleanup on primary exit, owner death, signals and terminal loss; identity-safe signalling; prompt orphan reaping; bounded TERM → CONT → KILL policy; group Ctrl-Z/`bg`/`fg`; and terminal restoration that respects unrelated foreground jobs. Do not reproduce pi-env's internal process topology merely because it exists.
- Develop a walking skeleton: minimal Linux command/fixture slice, publish the compiling project and full GitHub Actions matrix early, then fix forward through remaining platforms and job control. Red CI during development and ordinary flaky reruns are normal. No once-only packets, sealed acceptance manifests or per-step review ceremony.
- Run the full applicable standalone fixture suite on every branch push and pull-request event head across Linux GNU/musl x64/arm64, FreeBSD x64/arm64 via VM action, macOS x64/arm64 and Windows x64/arm64. No pi process participates. A multi-commit push tests its event head, not each intermediate SHA; do not cancel required event coverage when a newer event arrives.
- Before the first `v0.1.0` tag, obtain one independent review and a passing complete matrix. Releases come only from pushed `vX.Y.Z` tags, rebuild/retest all targets, stage all assets in a draft, and publish with GitHub release immutability, native Sigstore-backed artifact attestations and `SHA256SUMS`.
- After standalone release, integrate with pi as a normal pi change: bundle procward, bootstrap before heavy CLI imports, add an ownership layer under pi or any external procward by default, skip only its own private one-shot bootstrap handoff with valid READY, preserve explicit ownership opt-outs, and coordinate owner-loss hooks through a small documented contract. Pi's own adapter tests remain separate from procward's fixture suite.
- Keep README limited to what procward is, installation, usage and background. Professional documentation belongs under `docs/`. Background links to [pi](https://github.com/xz-dev/pi) as project origin/main consumer without falsely claiming copied implementation; pi's process-tree feature links back through its normal owning patch-ref workflow.
- Procward's new implementation is **BSD-3-Clause**: canonical **BSD 3-Clause License**, exact Cargo licence metadata and accurate SPDX identifiers. No pi-env code is copied, so no pi-env MIT notice or relicensing permission is needed for this implementation. Dependency licence/notice obligations remain separate.

## Capabilities

### New Capabilities

- `process-tree-ownership`: scoped tree lifetime, safe signalling, orphan reaping, cleanup deadlines and exit results.
- `job-control-tty`: interactive pause/resume, foreground authority, terminal restoration, fatal-output behaviour and Windows console/ConPTY compatibility.
- `platform-backends`: Linux, FreeBSD, macOS and Windows guarantees and limitations built on mature crates/OS facilities.
- `pi-integration-contract`: standalone managed handoff, lightweight pi bootstrap, opt-outs, task completion and owner-loss shutdown coordination.
- `test-harness`: fresh standalone fixture programs, observation-driven interaction, fault scenarios and ordinary fix-forward development.
- `ci-release`: early every-event four-platform CI, one pre-first-tag independent review and version-tag-only immutable attested releases.

### Modified Capabilities

None. This repository has no existing main capability specs.

## Impact

- New binary-first Rust project. No stable public library is required; split a library out only if it reduces immediate code/testing cost, not for speculative pi-env reuse.
- New direct dependencies selected from verified crate versions; platform glue is limited to what crates do not supply. All source and fixtures are newly authored. Keep pi-env's remote daemon, exec-spec/ownedExec1 path, protocol, filesystem/list/scan/watch/window/PTY RPC and implementation files untouched and out of procward.
- Behaviour reference: `/var/tmp/pi-B10zzzzV-preflight-kFqWFM`, HEAD `2c22500f80609c2d1fc288e951427c3297dba9a2`, plus release addenda 6–12. These inform examples, not source import or source-hash replay machinery.
- New GitHub repository metadata, README/docs, BSD licence, early push/PR workflows and tag-release workflow. Exact metadata, current GitHub permissions, native attestation action and manual immutable-setting prerequisite are specified in design.
- Later pi work touches bundling, bootstrap, local task adapters, hook/terminal handling and the root README feature link on its current owning patch ref. Procward development/release does not depend on pi's build or release system.
- This revision changes planning artifacts only. It authorizes no implementation, repository creation, push, commit, live workflow, settings change or release during this task.
