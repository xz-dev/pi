# Full-system Linux CI boundary

The Linux paths in `ci.yml` and `release.yml` use the local composite action
`.github/actions/linux-vm`. This is workflow implementation, **not evidence of a
successful remote matrix**. Actual CI and non-publishing release runs must pass
before integration/release. Local `ci/vm-test.py` remains supported and unchanged.

## Matrix and official targets

| Exact Rust target | Full-system image | GitHub runner | Ordinary CI profile |
| --- | --- | --- | --- |
| x86_64-unknown-linux-gnu | Ubuntu 24.04 x86_64 | ubuntu-24.04 | dev |
| aarch64-unknown-linux-gnu | Ubuntu 24.04 aarch64 | ubuntu-24.04-arm | dev |
| x86_64-unknown-linux-musl | Alpine 3.24 x86_64 | ubuntu-24.04 | dev |
| aarch64-unknown-linux-musl | Alpine 3.24 aarch64 | ubuntu-24.04-arm | dev |
| riscv64gc-unknown-linux-gnu | Ubuntu 24.04 riscv64 | ubuntu-24.04 | release |
| riscv64gc-unknown-linux-musl | Alpine 3.24 riscv64 | ubuntu-24.04 | release |

Each guest installs **official rustup stable host tools for the exact target**.
There is no Alpine vendor-triple rewrite, distro Rust substitution, binfmt,
container, or qemu-user runner. RISC-V is full-system QEMU CPU emulation with a
RISC-V kernel, not real hardware. Native compilation in that guest replaces the
old x64 cross-compilation; GNU still selects `riscv64-linux-gnu-gcc` on the
original Ubuntu 24.04 libc/toolchain family. ELF inspection requires the RISC-V
double-float ABI and correct GNU loader, and rejects any GLIBC symbol requirement
newer than the original Ubuntu 24.04 sysroot's **2.39**, including frozen debug
products. All three musl rows retain `+crt-static` and `link-self-contained=yes`,
but use the matching Alpine guest's system musl `cc` linker driver. Official
rustup `rustc`/`std` remain the compiler/toolchain; this linker choice does not
substitute an Alpine Rust compiler alias. The driver supplies native GCC/musl
library search paths needed by HOST build scripts: direct `rust-lld` failed to
find `-lgcc_s` and `-lc` for the RISC-V `libc` build script despite installed
build tools. Distribution dependency inspection still rejects dynamic
loaders/libraries, and RISC-V ELF checks still require the double-float ABI.
Missing official toolchains, linkers or ABI checks fail, never fall back to a
distro alias or build-only row.

FreeBSD x64/arm64, macOS x64/arm64 and Windows x64/arm64 keep their existing
executors, commands and permissions. The six Linux targets plus these six targets
remain the twelve required distribution targets. An additional x64 GNU job boots
a separate VM for the real ignored adversarial regression in both workflows.

## Official native HOST toolchain evidence

Verified against the official stable HOST distribution manifest dated
**2026-10-15**, Rust **1.99.1** (not only `rust-std` compilation targets):
`https://static.rust-lang.org/dist/2026-10-15/channel-rust-stable.toml`, SHA-256
`fb152be80975c194aa5fc684b2aec3a6e14e2b855efe2faa4e5f8ae6e590f463`.
For **each of the six exact triples in the table**, the manifest marks `rust`,
`rustc`, `cargo` and `rust-std` HOST packages available; both the complete native
`rust-1.99.1-<triple>.tar.xz` release bundle and
`https://static.rust-lang.org/rustup/dist/<triple>/rustup-init` returned HTTP 200.
The reviewed installer detects musl with `ldd --version` and maps the native
`riscv64` CPU to `riscv64gc` before choosing its init binary.

| Target family | Compiler HOST decision | Linker/runtime ABI |
| --- | --- | --- |
| GNU x64 / arm64 | Official native GNU HOST in matching Ubuntu VM | Native GNU linker, glibc requirements <= 2.39 |
| Musl x64 / arm64 | Official native musl HOST in matching Alpine VM | System musl `cc` driver, self-contained static CRT |
| riscv64gc GNU | Official native GNU HOST in Ubuntu 24.04 RISC-V VM | `riscv64-linux-gnu-gcc`, lp64d loader/float ABI, glibc <= 2.39 |
| riscv64gc musl | Official native musl HOST in Alpine RISC-V VM | System musl `cc` driver, self-contained static CRT, double-float ABI |

Thus no target currently requires a cross/prebuilt fallback, and no distro Rust
alias is used. Workflow selection remains `stable` as before, not a new compiler
version pin; rustup install or exact `rustc` HOST mismatches fail closed if the
official host tools become unavailable. Such a future failure is not permission
to substitute an Alpine distro compiler or remove runtime coverage.

## Reviewed provider provenance

The following exact upstream revisions were reviewed (README, action metadata,
shared lifecycle/SSH/sync code and selected release configs):

- `vmactions/ubuntu-vm@ba37729c99c3b7b11f55314a28a7a9a6f3d61262`:
  release `24.04`, `anyvm-org/ubuntu-builder` **v2.0.9**.
- `vmactions/alpine-vm@0bf4a0e96eda91817beb50dd571a362a0da21772`:
  release `3.24`, `anyvm-org/alpine-builder` **v2.0.3**.
- Shared implementation reference: `vmactions/base-vm`
  `42a65770e832a22083599094512231b6f7d05cc1` (not a workflow dependency).

These pinned configs select AnyVM **v0.7.6**, downloaded from that exact release,
and builder-tagged image assets, not `latest`. Image URLs have the form
`https://github.com/anyvm-org/<os>-builder/releases/download/v<builder>/<os>-<release>[-<arch>].qcow2.zst`
(x86_64 omits the suffix). Builder sources reviewed at those tags are Ubuntu
`12fe48c3253e240f1feb77eb5c2b9434ce681084`, Alpine
`a84790d6e22bee5fc2527958355edd43d48b6bd1`.
Ubuntu builders customize official cloud images; Alpine uses official
3.24.1 cloud images for x64/arm64 and the official 3.24.1 installer ISO for RISC-V.
The provider release assets are a supply-chain trust dependency: version selection
is pinned, but the action does not cryptographically pin each downloaded qcow2
or AnyVM release asset by a repository-owned digest. Review provider updates as
VM/kernel supply changes, not only JavaScript changes. VM/prepared-image caches
are disabled. Retired container image manifests and Docker updater entries have
been removed. Guarded `run-musl.sh` / `run-riscv64.sh` wrappers are not Linux
workflow executors. The old binfmt setup
and `emulation-summary.py` calls/runner environments were removed from both
workflows; new full-system results never borrow qemu-user unsupported-case credit.

## Isolation, resources and completion

1. The host records its real boot ID, nonce, exact checkout commit and SHA-256 of
   every tracked source file. Checkout selection stays unchanged (PR head in CI;
   exact event checkout in release). No Linux product runs on the host: GNU host
   steps only build `--no-run`, clippy/fmt and the existing Rust 1.87 MSRV checks.
2. Each action boots with **2 CPUs / 2048 MiB**, explicit architecture/release,
   `sync: rsync`, `copyback: false`, a dedicated data-dir and no debug/VNC request.
   Rsync copies a private disk workspace. No NFS, SSHFS, live host mounts or
   workspace copyback is used. Guest builds keep embedded `CARGO_BIN_EXE` paths
   valid without host-path translation or running host-built fixture probes.
3. AnyVM initially opens SSH on loopback and runner private interfaces during
   boot/source synchronization (and its internal rsync preparation). Once the
   action returns readiness, before our package/toolchain setup, the host binds
   the unique data-dir QEMU using pidfd plus checked process identity. It verifies
   its SSH alias is loopback, uses that VM's already-local monitor to remove only
   non-loopback SSH forwards, checks its owned TCP listeners (IPv4/IPv6) are all
   loopback and verifies SSH still responds. Unexpected/unsupported listeners or
   identity changes fail closed. No host firewall, routing or sshd is changed.
   This unavoidable **provisioning-time private-interface SSH exposure** is not
   claimed to be absent; no extra forward remains for our setup/runtime phase.
4. Guest root verifies a different boot ID and identical source bytes before
   creating `/run/procward-vm/manifest.json`. Setup fetches tools/dependencies;
   subsequent builds are offline. Before runtime, the guest requires unified
   cgroup v2 with pids/memory controllers, caps `kernel.pid_max` at **4096**, and
   checks the CPU/RAM budget. The preserved hazard adds its own 768-PID/512-MiB
   workload cgroup; these are containment budgets, never evidence of cleanup.
5. Guest nftables denies non-loopback input/output/forwarding except the
   provider SSH peer's port-22 control/transfer traffic. No DNS, mirror, metadata
   or guest-originated new external flow is allowed during tests/measurements.
   Loopback remains available for fixtures. The host never uses the provider's
   auto-syncing custom shell (it would push/pull the workspace again).
6. The shared `ci/vm-guest.py` runs all non-hazard tests, serialized per case,
   in both cgroup-available and product-cgroup-denied fallback modes. Original
   product assertions/deadlines remain unchanged; per-case budget is 60 seconds.
   Hazard uses only its ignored test, 5-second case budget and an independent
   **45-second whole-command host deadline** (transport setup included), after compilation
   in its own VM. The guest's own 5-second case budget with hard `cgroup.kill` remains
   the product-bound adversarial timeout; the host deadline only catches transport hang.
7. A real-host subprocess timeout bounds all runtime work (including measurement,
   post-measurement builds and packaging): CI 1800 seconds for x64/arm64, 3600
   for RISC-V; release 3600/5400 respectively. Setup has its own host timeout
   (2700/5400 seconds), plus outer action/job deadlines. Larger total build/CPU
   emulation budgets do not scale any product deadline. The bound QEMU is killed
   after success or failure. Timeout, nonzero SSH exit, missing/duplicate boot or
   completion, inconsistent records, rescue, leftovers or guest OOM kills fail.
8. Release measures all opt-level candidates **inside the VM**, rebuilds the
   selected exact dist binary/fixtures, runs both complete suites, then invokes
   the existing hash-checked packager. Only allowlisted flat artifacts are read
   back over SSH. `vm-console.txt`/`vm-results.json` retain individual verdicts,
   including records from failed guest runs. The composite appends the copied
   summary only after successful transfer; CI's RISC-V jobs always upload available
   host-side logs/results/measurements under `linux-vm-<exact-target>`, with missing
   artifacts honestly warned rather than presented as runtime coverage.
   Tag/source eligibility, workflow-dispatch dry-run status, all-24-package fan-in,
   frozen checksums, attestation and publish conditions remain unchanged; manifest
   fan-in additionally requires the independent hazard job.

Remote gates still need evidence: provider boot/SSH identity/monitor behavior,
image cgroup support, exact native Rust availability, RISC-V compile time and all
unchanged fixture deadlines. A failure at any gate is not permission to run on the
host, increase product deadlines, omit target coverage or claim a passing matrix.
