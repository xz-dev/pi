## Purpose

Provide four-platform ownership with standard facilities, explicit startup failures and honest boundaries rather than assuming that process groups or drop guards supply universal containment.

## ADDED Requirements

### Requirement: Complete all four platforms for v0.1.0
Procward v0.1.0 SHALL support Linux, FreeBSD, macOS and Windows. Linux SHALL include GNU and musl on x64, arm64 and riscv64; both riscv64 targets are required release assets. Every Linux CI/release runtime row SHALL execute inside a disposable full-system guest with a kernel distinct from the actual host: Ubuntu 24.04 GNU or Alpine 3.24 musl through reviewed immutable `vmactions/ubuntu-vm` / `vmactions/alpine-vm` revisions and explicit image/builder provenance. Each guest SHALL use the official native Rust HOST toolchain for its exact target triple, never an Alpine distro alias, qemu-user/binfmt/container execution path or build-only substitute. RISC-V SHALL be identified as full-system QEMU CPU emulation with a RISC-V guest kernel, not native hardware/performance evidence or host-kernel semantic checks. Linux-first development SHALL be an ordering choice, not a released reduction of scope. An unfinished backend SHALL appear as failed/incomplete development CI, not a false passing release result.

Linux workflow guests SHALL use copy-only source synchronization and controlled artifact transfer without writable live host workspace shares, exactly 2 CPUs/2 GiB RAM, unified guest cgroup v2 pids/memory controllers, guest `pid_max` 4096 and nftables restrictions preserving only loopback plus required provider SSH control/transfer traffic during runtime. Actual source/kernel proof, ordinary cgroup-available and product-cgroup-denied fallback passes, and complete matching results SHALL be required under independent real-host hard deadlines. OOM, rescue, missing completion or executor death SHALL fail. Original product fault deadlines, identity/liveness/order assertions and native results SHALL remain unchanged. Linux release suites SHALL run the selected opt-level's exact `dist` binaries/fixtures before package freezing. Both CI and release workflows SHALL also require a separate x64 GNU VM that compiles inside that guest and executes only the ignored hazard case under its own guest-side 5-second case budget plus a whole-command real-host deadline that also covers transport setup, with finite guest workload bounds.

#### Scenario: riscv64 GNU and musl execute under full-system CPU emulation
- **WHEN** their standalone fixtures run in CI or release
- **THEN** the exact official native HOST tools build test binaries inside matching Ubuntu 24.04 GNU or Alpine 3.24 musl RISC-V VMs, and those binaries execute only in those guests
- **AND** logs/docs identify the separate guest kernel and full-system QEMU CPU emulation rather than claim native RISC-V hardware or host-kernel syscall forwarding
- **AND** ordinary CI retains the release profile, release suites use `dist` after opt-level selection, and no product fault/cleanup deadline is scaled for CPU emulation

#### Scenario: A required native guest capability is absent
- **WHEN** a full-system guest cannot satisfy an applicable seccomp, spawn-error, setuid or other required fixture assertion
- **THEN** that result fails or remains explicitly incomplete instead of borrowing a historical qemu-user exemption
- **AND** no architecture-based skip, substituted distro compiler or product workaround converts it into release coverage

#### Scenario: Early skeleton lacks a backend
- **WHEN** the first compiling skeleton reaches the full CI matrix before all backends work
- **THEN** failing rows remain visible for fix-forward work and v0.1.0 is not tagged until applicable coverage passes

### Requirement: Retain Linux reaper and identity guarantees
Linux SHALL provide child-subreaper ownership, safe stable-target signalling and a reliable owner-loss wake for paused work. Missing pidfd freeze support SHALL be visible and SHALL NOT silently disable reaper cleanup. Required wake/setup failure SHALL refuse managed startup.

#### Scenario: pidfd freeze support is unavailable
- **WHEN** the kernel denies or lacks required nondirect freezing capability
- **THEN** procward reports that limitation while keeping identity-safe reaper cleanup active

#### Scenario: Owner dies during startup
- **WHEN** the parent disappears between arming its death wake and granting payload execution
- **THEN** startup denies payload side effects and cleans up already created roles

### Requirement: Prefer an owned Linux cgroup v2 workload group with a visible fallback
Linux SHALL try to create a workload group only inside the owner's own current cgroup v2 group, prove `cgroup.kill` on that empty group, and join the payload before it can execute or fork, while owner, anchor and terminal keeper stay outside. KILL SHALL cover the whole group; completion SHALL need ECHILD and an unpopulated group; the creating owner SHALL keep the group across anchor loss and remove only its own empty groups; after owner loss the surviving anchor SHALL remove the confirmed-empty group through the owner's parent handle and group name, and an already-removed group SHALL count as removed. Procward SHALL NOT change host controllers, delegation, mounts, permissions or services. Without usable delegation procward SHALL attempt exactly one startup diagnostic and keep the subreaper backend with KILL through a streaming walk of identity-validated nondirect pidfds that holds a constant number of descriptors, treats EMFILE/ENFILE as an incomplete pass and stops at the original deadline. A diagnostic SHALL be one write attempt without TTIN/TTOU masking or EINTR/EIO retry; a kernel-denied diagnostic MAY be dropped. Neither backend SHALL claim more than SIGKILL: a live or unknown member SHALL NOT be reported as clean, and the original deadline SHALL NOT be extended.

#### Scenario: Delegated group is usable
- **WHEN** the owner's own cgroup accepts a new child group with `cgroup.kill` and membership transfer
- **THEN** the payload is a member before its first fork, no fallback diagnostic is printed, and cleanup kills and removes the group

#### Scenario: Delegation is absent
- **WHEN** the owner cannot create or use a group in its own cgroup
- **THEN** startup attempts the fallback diagnostic once and cleanup uses the subreaper and recursive pidfd KILL

#### Scenario: Diagnostic from a background job on a TOSTOP terminal
- **WHEN** the fallback diagnostic is written to a TOSTOP terminal by a background job
- **THEN** the kernel denial stands, no diagnostic bytes reach the terminal, and the job sees no repeated SIGTTOU

#### Scenario: Live ancestor blocks adoption in the fallback
- **WHEN** a credential-denied ancestor stays alive above a signalable TERM-ignoring descendant
- **THEN** the descendant is killed at the KILL phase without waiting for adoption, and the denied ancestor still yields exit 125 at the original deadline

### Requirement: Use FreeBSD reaper ownership and targeted wakes
FreeBSD SHALL provide kernel reaper ownership including nested reapers, fresh owned-child enumeration/signalling and a reliable targeted wake for paused cleanup. Wake setup failure SHALL refuse startup without host sysctl/module changes; query/signal failures SHALL remain failures.

#### Scenario: Stopped descendant is adopted
- **WHEN** a FreeBSD reaper adopts a stopped descendant before grace expires
- **THEN** TERM precedes any permitted CONT and the existing escalation deadline remains unchanged

#### Scenario: Required wake cannot be established
- **WHEN** startup cannot arm the necessary targeted owner-loss wake
- **THEN** it fails visibly before payload execution and changes no host configuration

### Requirement: State macOS best-effort limits
macOS SHALL retain observed process identities across reparenting and validate PID, birth and relevant credentials before signals. An independent observer SHALL preserve owner-loss cleanup progress. Completion SHALL mean a best-effort sweep with no known survivors, not kernel containment. Errors SHALL NOT count as absence.

#### Scenario: Observed descendant detaches and reparents
- **WHEN** a previously observed descendant changes session/parent without changing its validated identity
- **THEN** it remains a cleanup target while unrelated processes are excluded

#### Scenario: Descendant escapes before observation
- **WHEN** a fixture detaches and reparents to launchd before the first observation
- **THEN** the test/documentation identify the best-effort escape window and attribute fixture rescue separately rather than claim universal no-leak containment

#### Scenario: Observer is lost
- **WHEN** a required observer dies while normal owners remain
- **THEN** the session fails closed rather than silently running without its cleanup anchor

#### Scenario: Observer dies before the outer inventory's first sweep
- **WHEN** observer loss reparents a descendant before the surviving owner ever observed its identity
- **THEN** procward reports failure 125 and the explicit pre-observation best-effort limitation
- **AND** a fixture may clean known test PIDs separately as labelled harness cleanup, without crediting product containment

#### Scenario: Observed inventory survives observer loss
- **WHEN** a native test establishes retained identities before killing its observer
- **THEN** the same production fallback path cleans those observed identities and returns the defined failure status without harness rescue

### Requirement: Establish Windows Job containment before payload work
Windows SHALL assign the command to a non-inheritable kill-on-last-handle-close Job before untrusted payload work. Dropping/killing an owner SHALL not leave a leaked Job handle that keeps descendants alive. Normal cleanup SHALL confirm Job completion; Unix process-group assumptions SHALL NOT substitute for this guarantee.

#### Scenario: Owner is killed after launch
- **WHEN** a Job-owning procward process is killed while descendants run
- **THEN** the last ownership handle closes and Job members terminate without executing a Rust destructor

#### Scenario: Assignment or launch permission fails
- **WHEN** ownership assignment fails or the owner disappears before launch permission
- **THEN** payload side effects are absent and suspended children/handles are cleaned up

### Requirement: Document unsupported failure boundaries
Procward SHALL disclose privilege transitions that clear owner-death wakes, loss of all independent cleanup roles, host/kernel failure and macOS unseen escape. Standard crates SHALL NOT be represented as removing these OS limitations.

#### Scenario: Runtime transition clears death notification
- **WHEN** a set-ID/capability/credential transition invalidates the required wake
- **THEN** documentation excludes the corresponding paused-owner guarantee instead of promising unsupported recovery
