## Purpose

Get full-platform feedback early on every development event and publish only reviewed version-tag releases with immutable assets, authenticated provenance and checksums.

## ADDED Requirements

### Requirement: Enable full every-event CI early
GitHub Actions SHALL be enabled when the first Linux skeleton compiles and SHALL run the full applicable standalone fixture suite on every branch `push` and `pull_request` event head. No path/branch filter, fail-fast cancellation or newer-event cancellation SHALL silently remove required coverage. A multi-commit push SHALL test its head rather than enumerate intermediate SHAs. All tests SHALL use procward fixtures, never pi.

#### Scenario: Documentation-only change is pushed
- **WHEN** a documentation-only commit is pushed to a branch or PR
- **THEN** the full applicable platform matrix runs

#### Scenario: New commit arrives before prior tests finish
- **WHEN** another event updates the same branch
- **THEN** earlier required event tests remain runnable rather than being cancelled in favor of the latest revision

### Requirement: Run the four-platform target matrix
CI SHALL execute applicable unit, CLI/contract, lifecycle and terminal tests on Linux GNU/musl x64/arm64/riscv64, FreeBSD x64/arm64 through a VM action, macOS x64/arm64 and Windows x64/arm64 including console/ConPTY: twelve required target rows. Every Linux row SHALL execute inside a full-system VM: Ubuntu 24.04 for GNU and Alpine 3.24 for musl, using reviewed immutable revisions of `vmactions/ubuntu-vm` and `vmactions/alpine-vm`, explicit image releases and documented builder provenance. The exact riscv64 targets SHALL remain `riscv64gc-unknown-linux-gnu` and `riscv64gc-unknown-linux-musl`. Each Linux guest SHALL use the official native Rust HOST toolchain for its exact target, without distro compiler aliases or build-only substitutes. RISC-V logs/docs SHALL identify full-system QEMU CPU emulation with a separate RISC-V guest kernel, not native hardware validation or host-kernel syscall forwarding. Early red rows SHALL support fix-forward development and normal reruns; all applicable rows SHALL pass before a release tag.

#### Scenario: riscv64 has no hosted runner
- **WHEN** every-event CI runs either riscv64 target
- **THEN** it boots the matching Ubuntu 24.04 GNU or Alpine 3.24 musl RISC-V full-system guest, installs the official exact-target native HOST tools, and builds/runs the release-profile binaries and fixtures there
- **AND** GNU retains the Ubuntu toolchain/libc family and `riscv64-linux-gnu-gcc`, while musl retains the official Rust compiler/standard library, static CRT and self-contained linking with the matching guest's system musl `cc` linker driver supplying native GCC/musl library paths for HOST build scripts
- **AND** source, compiler HOST, target and actual ELF ABI are verified without presenting CPU emulation as native RISC-V hardware performance

#### Scenario: A required guest capability is unavailable
- **WHEN** a full-system guest lacks a capability needed by an applicable assertion or the exact official HOST toolchain cannot be installed
- **THEN** the row fails or remains explicitly incomplete rather than borrowing a historical emulator exemption, substituting a distro alias or claiming build-only coverage
- **AND** original product assertions, fault deadlines and native results remain unchanged

#### Scenario: Early backend is unfinished
- **WHEN** a required platform is not yet complete
- **THEN** its failures are visible during development and are not relabelled as release passes

#### Scenario: Flaky test is rerun
- **WHEN** a developer requests an ordinary CI rerun
- **THEN** it runs without sealed manifests, once-only dispatch rules or per-step review gates while retaining the previous attempt's logs

### Requirement: Bound Linux workflow runtime inside disposable full-system guests
All Linux integration fixtures and product runtime measurements in both CI and release workflows SHALL execute only after proving a guest boot ID distinct from the actual host and matching the requested source commit, source bytes and run identity. Guests SHALL have exactly 2 CPUs and 2 GiB RAM. Source transfer SHALL be copy-only, with no writable live host workspace mount; artifact transfer SHALL be limited to controlled outputs. Containers, binfmt and qemu-user SHALL NOT serve as the execution boundary or replace the current native guest execution path. The host MAY compile with `--no-run` and perform static checks, but SHALL NOT execute product probes or fixtures.

Before runtime, the guest harness SHALL require unified cgroup v2 with pids/memory controllers, cap guest `pid_max` at 4096, and apply nftables bounds that allow loopback plus only the required provider SSH peer's control/transfer traffic, denying other external flows. Only loopback provider control/transfer listeners SHALL remain for setup/runtime after provider readiness; any unavoidable provisioning-time exposure SHALL be disclosed. Ordinary suites SHALL execute in both cgroup-available and product-cgroup-denied fallback modes. Independent real-host hard deadlines SHALL bound runtime, separately from guest/test deadlines and outer provisioning/job limits. A different guest boot ID, every individual test result and matching test/provider completion records SHALL be required. OOM kills, rescue, leftovers, nonzero executor exit or missing/inconsistent completion SHALL fail, never count as product cleanup or a pass.

#### Scenario: Guest runtime is entered
- **WHEN** setup finishes for any Linux workflow row
- **THEN** source/kernel proof, fixed resources, cgroup controllers, PID cap and restricted network/control channels are checked before fixtures or startup measurements execute
- **AND** unavailable isolation prerequisites fail closed without host execution or reduced target coverage

#### Scenario: Guest hangs or loses completion records
- **WHEN** the guest exceeds its independent host deadline or cannot return complete matching results
- **THEN** the host fails the run and ends only its bound provider VM rather than treating VM death or external cleanup as success

### Requirement: Run the adversarial regression in a separate bounded workflow VM
Both every-event CI and release workflows SHALL require an additional, separate x64 GNU full-system VM job for the ignored rolling/deep/wide TERM-ignoring regression. That job SHALL compile its fixtures inside its own guest before the runtime phase, then execute only the single ignored hazard case with a 5-second case budget enforced inside the guest (hard `cgroup.kill` timeout) while an independent real-host deadline bounds the whole runtime command including transport setup. The hazard workload SHALL retain finite 768-PID/512-MiB guest cgroup containment, product cgroup denial and the preserved low-descriptor condition without changing product deadlines. Ordinary suites SHALL exclude the hazard executable. OOM or harness/watchdog intervention SHALL fail; a failed/missing hazard job SHALL block release fan-in.

#### Scenario: Ordinary suites and hazard coverage are scheduled
- **WHEN** either CI or the release workflow runs
- **THEN** ordinary Linux suites execute both normal modes without the hazard, and a distinct VM executes only the ignored hazard case
- **AND** neither job can borrow a host/container pass or another VM's completion record

### Requirement: Obtain one independent review before the first tag
Before pushing `v0.1.0`, the project SHALL obtain one independent implementation review covering ownership/terminal safety, crate/API assumptions, tests and release setup, and SHALL address its blocking findings. Per-commit or per-step independent reviews SHALL NOT be mandatory process gates.

#### Scenario: Skeleton compiles before review
- **WHEN** the first compiling skeleton is ready
- **THEN** it can be pushed for CI immediately without waiting for the pre-release review

#### Scenario: Reviewer finds a cleanup defect
- **WHEN** the independent pre-first-tag review identifies a blocking ownership defect
- **THEN** it is fixed and validated before `v0.1.0` is tagged

### Requirement: Publish only from stable version-tag pushes
Releases SHALL be cut only by pushing exact `vX.Y.Z` version tags, beginning with `v0.1.0`. The tag workflow SHALL validate package/tag agreement, build all twelve targets (including riscv64 GNU and musl) and rerun the full applicable suite from the tagged source and release binaries. All Linux opt-level candidate startup measurements SHALL run inside their full-system guests. After selecting the smallest binary from opt-levels 2, 3, s and z, each Linux release suite SHALL build/run the exact selected `dist` profile binaries and fixtures in both ordinary modes before hash-checked package freezing. The separate bounded hazard job SHALL also pass before release fan-in. Branch/PR/manual/live-release updates SHALL not publish; `workflow_dispatch` SHALL always be a non-publishing dry run. A failed/missing tag row SHALL block publication; corrections SHALL use a new tag rather than overwrite a published version.

#### Scenario: Branch CI passes
- **WHEN** a branch passes CI without a version-tag push
- **THEN** no public release is created or updated

#### Scenario: First version tag is pushed
- **WHEN** `v0.1.0` is pushed for package version `0.1.0`
- **THEN** all release targets are rebuilt/retested before publication is eligible

#### Scenario: riscv64 release assets are prepared
- **WHEN** a version tag is eligible for publication
- **THEN** both riscv64 GNU and musl binary/package assets are included in the frozen downloads, SHA256SUMS and provenance attestations
- **AND** missing/failed full-system guest fixture rows block publication just like other required targets

#### Scenario: Prior branch pass differs from tag result
- **WHEN** a required tag-workflow row fails
- **THEN** publication is blocked despite an earlier branch pass

### Requirement: Use GitHub immutable draft-first publication
A repository owner SHALL enable **Enable release immutability**, record confirmation and recheck it before the first tag. The workflow SHALL stage all final assets in a draft before publishing and then verify release/asset integrity with GitHub CLI. Published assets and tag SHALL be protected by GitHub immutability; title/notes SHALL not be falsely described as immutable. Setting drift SHALL be disclosed as a residual risk detected by post-publication verification, not hidden by an invented token permission.

#### Scenario: Owner prepares the first tag
- **WHEN** the first release is prepared
- **THEN** owner confirmation precedes the tag and all assets are attached before publication

#### Scenario: Immutability setting drifted
- **WHEN** publication produced a mutable release after the setting was disabled
- **THEN** post-publication verification fails loudly without pretending it prevented publication or automatically repairs protected assets

### Requirement: Publish native artifact provenance and checksums
Release binaries/packages and `SHA256SUMS` SHALL have GitHub OIDC/Sigstore-backed build-provenance attestations through the currently recommended `actions/attest`. `SHA256SUMS` SHALL cover exact downloadable platform assets without self-hashing. Consumers SHALL be able to run `gh attestation verify` against expected repository/workflow/tag/source and verify checksums. GitHub's automatic immutable-release attestation SHALL complement, not replace, artifact provenance. The older `actions/attest-build-provenance` wrapper SHALL be documented accurately.

#### Scenario: Downloaded package is checked
- **WHEN** a consumer downloads a package and checksum manifest
- **THEN** checksums and `gh attestation verify` can validate their bytes and expected provenance

#### Scenario: Bytes change after attestation
- **WHEN** candidate bytes are modified after checksumming/attesting
- **THEN** verification rejects publication

### Requirement: Keep credentials role-limited
Ordinary push/PR CI SHALL use read-only repository access without signing/publication credentials. Trusted tag attestation jobs SHALL use `contents: read`, `id-token: write` and `attestations: write`; only publishing jobs SHALL receive `contents: write`. Admin credentials SHALL NOT be added for the manual immutability-setting check. Reviewed immutable action revisions, explicit VM image releases and documented builder provenance SHALL be used; provider asset mutability or digest-verification limits SHALL be disclosed rather than represented as cryptographic image pinning.

#### Scenario: Fork PR runs fixtures
- **WHEN** an untrusted PR enters CI
- **THEN** it runs tests without OIDC signing or repository write permission

#### Scenario: Tag workflow signs and publishes
- **WHEN** trusted release jobs execute
- **THEN** attestation and publishing permissions are limited to their respective jobs
