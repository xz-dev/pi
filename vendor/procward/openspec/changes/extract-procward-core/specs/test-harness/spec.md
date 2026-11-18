## Purpose

Develop procward through small fresh fixture programs and observable behaviour, with early real-platform feedback instead of copying pi-env tests or reproducing its release ceremony.

## ADDED Requirements

### Requirement: Author independent fixtures without copying source
Procward SHALL use newly written fixture programs for argv/status, descendants, detached/stopped work, orphan reaping, hooks and terminal interaction. Pi-env SHALL be a behavioural reference and source of scenarios only; its implementation, tests and fixture source SHALL NOT be copied or translated. Core tests SHALL never launch pi or require Node/Bun/model credentials.

#### Scenario: Developer reproduces a historical orphan bug
- **WHEN** a release lesson describes zombies retained while the primary remained healthy
- **THEN** a fresh small fixture expresses that behaviour without importing pi-env's test implementation

#### Scenario: Standalone checkout runs tests
- **WHEN** the Rust project and platform tooling are available but pi is absent
- **THEN** its full applicable core suite executes through procward and its own fixtures

### Requirement: Sequence interaction by response
Interaction tests SHALL act, observe effect/output/state, and retry while an explicit response means not ready. Fixed sleeps SHALL NOT sequence input. Silence/no effect SHALL fail by the response deadline, and repeated hints SHALL not extend the overall deadline indefinitely. Observation polling and simulated work SHALL not be mistaken for elapsed-time readiness.

#### Scenario: Quit arrives before ready
- **WHEN** a fixture returns a not-ready hint to a quit attempt
- **THEN** the harness observes that response and retries within the original deadline rather than assuming a delay or terminal setup escape proves readiness

#### Scenario: Program stops responding
- **WHEN** an action produces neither its expected effect nor a not-ready response
- **THEN** the test fails on its bounded deadline with the interaction transcript

### Requirement: Check safety and completion facts
Fixtures SHALL cover startup/owner-loss races, stopped/detached descendants, live identity/PID reuse, adopted zombies, terminal authority, control truncation and leaked descriptors/handles. Stopped means alive; zombie means not yet reaped; query failure means unknown/error, not absence. Tests SHALL demonstrate unrelated work survives and primary status remains intact.

#### Scenario: Cleanup claims success with a stopped child
- **WHEN** a stopped owned identity remains after completion is claimed
- **THEN** the row fails instead of treating the child as exited

#### Scenario: Grandchild is adopted while primary stays healthy
- **WHEN** an orphan fixture exits a grandchild before its primary
- **THEN** tests observe reaping during healthy operation, not only eventual disappearance at shutdown

### Requirement: Preserve deadline assertions and report rescue honestly
Fault tests SHALL measure at most 8 seconds from injection to platform completion with default settings, with default 6/3-second grace and 7.5-second cleanup policy checked separately where applicable. Non-default policy/failover tests SHALL enforce the original configured deadline from first cleanup start, not restart timing when a native role dies. Full-system QEMU CPU emulation MAY require larger boot/build/setup budgets but SHALL NOT scale product fault or cleanup deadlines. Harness rescue SHALL be separate from product cleanup and SHALL not turn failed assertions into success.

#### Scenario: Slow runner reaches startup late
- **WHEN** readiness consumes a larger setup budget before the fault
- **THEN** the fault-relative teardown budget remains unchanged

#### Scenario: Harness kills a leaked fixture
- **WHEN** test cleanup must rescue a known survivor
- **THEN** the failed run stays failed and identifies the rescue

### Requirement: Isolate every Linux runtime test in a complete VM
Linux integration tests SHALL execute only inside a disposable full-system VM with a kernel distinct from the host, fixed CPU/memory resources, no writable live host workspace sharing and an independent host hard deadline. The host MAY compile artifacts and perform static checks but SHALL refuse direct fixture execution, including container-only and bare qemu-user execution. A matching guest completion record and every individual result SHALL be required; missing records, VM death or external rescue SHALL NOT count as a product pass. Missing executor prerequisites SHALL fail closed for local runs and CI/release jobs alike.

#### Scenario: Developer invokes Cargo tests directly on Linux
- **WHEN** no separate-kernel VM manifest is present
- **THEN** the runtime entrypoint refuses before launching the test executable and points to the supported VM runner

#### Scenario: Guest exits before reporting complete results
- **WHEN** the guest fails, hangs or returns without all results and its completion record
- **THEN** the host runner fails the run, ends/reaps its own VM processes and does not infer success from VM shutdown

### Requirement: Preserve and safely exercise the original rolling-fork reproducer
The test suite SHALL retain the original review reproducer and a faithful runnable fixture with uncapped rolling PID turnover, deep/wide branches and ignored TERM. The runnable fixture SHALL refuse before fork without separate-kernel proof and verified finite process/memory caps. The adversarial integration case SHALL run in its own independently limited VM, with the product cgroup unavailable and descriptor limit below the observed workload population. It SHALL observe branch startup/population rather than use elapsed time as readiness; original product deadlines SHALL remain unchanged. OOM, scope rescue or VM watchdog intervention SHALL remain test failures, never product cleanup.

#### Scenario: Descriptor pressure and continuous PID turnover coexist
- **WHEN** the original adversarial branches are running above the controller's descriptor limit and cleanup is requested without a product cgroup
- **THEN** the controller terminates and reaps its owned work within the original deadline, preserves the primary's native result, and leaves unrelated work alive without external rescue

### Requirement: Use early CI and ordinary fix-forward work
As soon as the Linux walking skeleton compiles, development SHALL publish it and enable the full push/PR platform matrix rather than waiting for all backends. Failing applicable platform tests SHALL remain visible as work lands. Developers SHALL be able to rerun flaky jobs normally and fix forward; once-only packets, sealed manifests, pre-rerun classification approvals and per-step independent reviews SHALL NOT be required. Reruns SHALL not alter assertions or erase previous logs.

#### Scenario: First Windows CI row is red
- **WHEN** the early skeleton reaches Windows before its backend is complete
- **THEN** developers keep the row visible and implement/fix it through normal commits rather than disable required v0.1.0 coverage

#### Scenario: Suspected flaky job is rerun
- **WHEN** a developer reruns a flaky CI job
- **THEN** the rerun is permitted without a special packet or review ritual and original logs remain attributable

### Requirement: Release only complete applicable coverage
Before release, the full applicable suite SHALL pass for Linux GNU/musl x64/arm64/riscv64, FreeBSD x64/arm64 guests, macOS x64/arm64 and Windows x64/arm64. All Linux CI/release runtime rows SHALL execute in full-system VM guests using the official native Rust HOST toolchain for the exact target: Ubuntu 24.04 GNU or Alpine 3.24 musl through reviewed pinned VM Actions. RISC-V SHALL remain honestly identified as full-system QEMU CPU emulation with a separate guest kernel, not native hardware evidence. Containers, binfmt and qemu-user SHALL NOT substitute for this execution path or supply exemptions from its native guest assertions. Copy-only source synchronization, fixed 2CPU/2GiB resources, guest cgroup/nft/PID bounds, independent real-host hard deadlines and complete matching results SHALL satisfy the Linux workflow constraints in `ci-release`. Linux release suites SHALL execute the exact selected opt-level's `dist` binaries/fixtures before packaging, and both workflows SHALL additionally require the separate bounded hazard VM job. Test output SHALL identify actual source/target/executor and results without a custom sealed evidence system. Build-only success SHALL not replace runtime acceptance.

#### Scenario: A required full-system guest capability is absent
- **WHEN** a current Linux guest cannot satisfy an applicable seccomp, spawn-error, setuid or other required fixture assertion
- **THEN** the affected case fails or remains explicitly incomplete, with its reason retained rather than borrowing an old qemu-user exemption
- **AND** there is no architecture-based skip, weakened assertion or product workaround, and genuine primary status 127 remains tested
- **AND** historical pre-VM emulator outcomes do not provide coverage for the current full-system rows

#### Scenario: Target compiles but fixtures fail
- **WHEN** a target builds successfully without passing its applicable fixtures
- **THEN** it remains incomplete for release even though early development pushes are allowed
