# CI and releases

## Every-event checks

`.github/workflows/ci.yml` runs on every push and pull request, including docs-only
changes. No path/branch filter, fail-fast or newer-event cancellation removes a
required row. Jobs have `contents: read` only. See [development](development.md)
for fixture commands and ordinary rerun history, [platforms](platforms.md) for
backend boundaries, and [contract](contract.md) for application integration.

| Target | Fixture executor |
| --- | --- |
| x86_64-unknown-linux-gnu | Ubuntu 24.04 x64 full-system VM |
| aarch64-unknown-linux-gnu | Ubuntu 24.04 arm64 full-system VM |
| x86_64-unknown-linux-musl | Alpine 3.24 x64 full-system VM, official Rust target |
| aarch64-unknown-linux-musl | Alpine 3.24 arm64 full-system VM, official Rust target |
| riscv64gc-unknown-linux-gnu | Ubuntu 24.04 riscv64 full-system QEMU VM, official Rust target |
| riscv64gc-unknown-linux-musl | Alpine 3.24 riscv64 full-system QEMU VM, official Rust target |
| x86_64-unknown-freebsd | FreeBSD 14.3 x64 VM |
| aarch64-unknown-freebsd | FreeBSD 14.3 arm64 VM |
| x86_64-apple-darwin | macOS x64 |
| aarch64-apple-darwin | macOS arm64 |
| x86_64-pc-windows-msvc | Windows x64, including console/ConPTY |
| aarch64-pc-windows-msvc | Windows arm64, including console/ConPTY |

All six Linux rows run in separately booted full-system guests. RISC-V uses CPU
emulation, **not qemu-user or host-kernel syscall forwarding**, and keeps all
original capability assertions and deadlines. Linux jobs use both cgroup and
forced-fallback passes, plus an additional separately bounded x64 GNU hazard job.
[Provider revisions, image provenance, copy-only transfer, network restriction
and outside-guest deadlines](../ci/linux-vms.md) define the implementation.
Actual remote CI/dry-run verification is still required; historical container
results below do not close this new gate. Non-Linux behavior and all publication
eligibility/authorization conditions are unchanged.

## Size-first distribution builds

`[profile.dist]` inherits release and explicitly sets fat LTO, one codegen unit,
symbol stripping, no debuginfo, no incremental compilation and `panic = "unwind"`.
The default `opt-level = "z"` is the smallest in the local comparison below.
Release jobs measure **2, 3, s and z independently on every target**, select the
smallest binary (first measured wins an exact size tie), then rebuild its binary
and fixtures with that setting. Startup never changes this choice. Every-event
CI reports default-dist size/startup in its job summary; release/dry-run summaries
include all four candidates, chosen setting and both zip sizes. Raw measurements
are retained in `measurements.json` alongside dependency inspection output.

[Cargo profile reference](https://doc.rust-lang.org/cargo/reference/profiles.html):
`codegen-units = 1` with default `lto = false` does not enable LTO, so fat LTO is
explicit. Tests ignore the panic setting; the shipped binary keeps unwinding.
Abort remains deferred until a controller-panic fault seam proves cleanup safety.
Debug flavour uses the unoptimized dev profile with debuginfo, not stripped dist.
Windows debug zips include `procward.pdb` beside the executable (presence/size
asserted). macOS debug builds set `split-debuginfo = "packed"` and include the
Apple-standard `procward.dSYM` bundle, checked with `dwarfdump --verify`.
Linux/FreeBSD retain embedded DWARF; `readelf` asserts debug info/line sections.
Symbol files are covered by the zip's checksum/provenance and compared byte-for-byte
at fan-in; binaries inside are also individual attestation subjects.

Local comparison, x86_64-unknown-linux-gnu, rustc 1.99.1 / LLVM 23.1.1, same
source and profile except opt-level (2026-10-28):

| opt-level | Binary bytes | Startup median ms |
| --- | ---: | ---: |
| 2 | 568544 | 0.240 |
| 3 | 573648 | 0.260 |
| s | 531248 | 0.331 |
| **z** | **521752** | **0.336** |

Startup measurement: 21 warm-cache `procward --version` subprocess launches after
3 warmups, wall-clock median, no performance gate. It measures CLI startup, not
managed-command setup or cleanup. Current Linux measurements execute inside the
full-system guest, including every release opt-level candidate, before fixtures
and packaging. Historical container/qemu-user timings below include their old
executor overhead. Neither those numbers nor VM/CPU-emulation timings compare
hardware/OS performance or relax fixture deadlines.

Windows x64/arm64 set `+crt-static` in `.cargo/config.toml`; `dumpbin /DEPENDENTS`
rejects dynamic MSVC/UCRT runtime imports. Windows still imports OS DLLs. Musl
builds use official exact-target Rust, static CRT and self-contained linking;
`readelf` rejects any `NEEDED` library or `INTERP` segment in both flavours. GNU
and FreeBSD `readelf` permits only explicit OS runtime libraries/loaders; macOS
`otool -L` permits only `/usr/lib` and `/System/Library`. These platforms depend on
OS services and are not advertised as fully static. No third-party runtime
library may be required. Inspection output travels with dry-run artifacts.

## Non-publishing dry run

```sh
gh workflow run release.yml --ref main
gh run list --workflow release.yml
gh run download RUN_ID --name release-dry-run --dir dry-run
```

A manual dispatch always builds/tests/packages all twelve targets but cannot sign
or publish, even when dispatched on a tag. There is no publish input. Its event
eligibility output is false, signing/publishing jobs have independent tag-push
conditions, and build/fan-in jobs have read-only permissions. This exercises the
same size selection, dependency inspection, zip contents, missing-target checks
and checksum verification as a release. It does **not** exercise OIDC issuance,
attestation upload, draft creation or publication; those require a real tag.

## One-time owner prerequisite

Before the first tag, obtain the independent implementation/release review and
all twelve passing applicable rows. A repository owner must enable
**Settings → General → Releases → Enable release immutability**, record confirmation
and recheck with their existing owner login:

```sh
gh api repos/xz-dev/procward/immutable-releases
```

Confirm feature availability too: artifact attestations support public repositories;
private/internal repositories require GitHub Enterprise Cloud and GHES is not
supported. This check needs administrative read access; normal Actions
`contents: write` does not grant it. Never add an admin PAT/App secret to Actions
for this check. Implementation/dry-run work does not change this setting.

Official references: [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases),
[owner setting](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes),
[setting API](https://docs.github.com/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository),
[attestation availability and permissions](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds).

## Tag, rebuild, draft, publish, verify

Publication eligibility requires a pushed exact stable `vX.Y.Z` tag equal to
Cargo.toml's package version and the checked-out/event commit. Branches, PRs,
prerelease tags, manual dispatches and release edits cannot publish. An invalid
tag fails before building. No previously uploaded branch artifact is reused.

1. Rebuild all twelve targets from the tag. Compare optimization settings, build
   dist, inspect dependencies, and rerun the full applicable fixture suite against
   **dist binaries before packaging**. Any failed/missing row blocks fan-in.
2. Require the measured/tested dist bytes to remain unchanged, then build dev
   with debuginfo and inspect its dependencies/symbols. Freeze each
   `procward-<target>.zip` and `procward-<target>-debug.zip` with maximum
   DEFLATE compression. Each contains `procward`/`procward.exe`, `LICENSE`,
   `README.md` and `third-party-licenses.md`, plus PDB/dSYM in Windows/macOS debug
   zips. Distribution documents use LF checkouts on every OS via `.gitattributes`;
   fan-in compares their exact bytes, not newline-normalized text. No executable
   is repackaged later.
3. Require all 24 zips and exact embedded binary/document bytes. Generate
   `SHA256SUMS` over the 24 downloadable zips, not itself. Changing any package or
   embedded subject after freezing fails verification.
4. Per-target signing-only jobs attest each target's zips and exact inner binaries
   (including VM-returned bytes) with [actions/attest](https://github.com/actions/attest),
   GitHub OIDC and Sigstore build provenance. A separate fan-in signer attests the
   checksum manifest only after every target signer succeeds. Signing jobs have
   `contents: read`, `id-token: write` and `attestations: write`. The older
   `actions/attest-build-provenance` is a supported wrapper, but upstream recommends
   `actions/attest`.
5. The publisher alone has `contents: write` (and `attestations: read`, no OIDC).
   It rechecks frozen bytes and all provenance with expected repository, workflow,
   tag and source digest before creating anything. It creates a **draft** for the
   existing tag with all 24 zips plus `SHA256SUMS`, then publishes the draft.
6. After publication it runs `gh release verify`, `gh release verify-asset` for
   every downloadable asset, and source-pinned `gh attestation verify` again.
   Only a `no attestations` result from `gh release verify` (GitHub's release
   attestation propagation delay, seen in v0.1.0 run 40729063671) is retried, for
   at most 5 minutes. Any other or persisting failure fails the workflow loudly;
   it does not overwrite/recreate assets.

The automatic GitHub immutable-release attestation binds the tag, commit and
release assets; it complements build provenance. Assets/tag are locked, not
release title, notes, latest or prerelease metadata. If the owner setting drifts
off, publication can occur before post-publication verification detects a
mutable release. These checks **detect**, not prevent, that already-published
state. Inspect the failure and use a new version/tag for corrections, never move
a published tag or replace immutable bytes. Partial drafts from failed attempts
require owner inspection; no automatic credential fallback or clobber is used.

References: [GitHub draft creation](https://docs.github.com/rest/releases/releases#create-a-release),
[release integrity verification](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity),
[`gh release verify`](https://cli.github.com/manual/gh_release_verify),
[`gh release verify-asset`](https://cli.github.com/manual/gh_release_verify-asset).

## Consumer verification

Use an up-to-date GitHub CLI with release and artifact verification support.
Obtain the expected tag commit from a trusted release/source review, not an
untrusted checksum mirror. Replace `EXPECTED_TAG_COMMIT` below.

```sh
repo=xz-dev/procward
tag=v0.1.1
target=x86_64-unknown-linux-gnu
commit=EXPECTED_TAG_COMMIT
asset="procward-$target.zip"
gh release download "$tag" --repo "$repo" --pattern "$asset" --pattern SHA256SUMS

gh release verify "$tag" --repo "$repo"
for file in "$asset" SHA256SUMS; do
  gh release verify-asset "$tag" "$file" --repo "$repo"
  gh attestation verify "$file" --repo "$repo" \
    --signer-workflow "$repo/.github/workflows/release.yml" \
    --source-ref "refs/tags/$tag" --source-digest "$commit"
done
grep "  $asset$" SHA256SUMS | sha256sum --check -
unzip "$asset" -d procward-download
gh attestation verify procward-download/procward --repo "$repo" \
  --signer-workflow "$repo/.github/workflows/release.yml" \
  --source-ref "refs/tags/$tag" --source-digest "$commit"
```

For Windows, verify `procward-download/procward.exe`; for debug, download
`procward-<target>-debug.zip` (inner name stays `procward`/`procward.exe`). On macOS,
use `shasum -a 256` and compare to the selected manifest line. On PowerShell use
`Get-FileHash -Algorithm SHA256` and compare to that line, then `Expand-Archive`.
Checksums alone are not authenticated provenance. The signed manifest authenticates
all listed zip digests, while source-pinned attestations authenticate the package
and binary actually received. See [`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify)
for additional policy controls.

## Verified setup checkpoint — not a release

Code/configuration `12eb25b` (2026-10-28):

- [CI 40643574061](https://github.com/xz-dev/procward/actions/runs/40643574061):
  all twelve rows successful on attempt 1.
- [Dry run 40643608524](https://github.com/xz-dev/procward/actions/runs/40643608524):
  all twelve dist-fixture/package rows and fan-in successful on attempt 1.
  Eligibility refused publication; `attest-packages`, `attest` and `publish` were
  **skipped**, not signing/publication passes.
- Actions artifact `release-dry-run` (ID `12798665510`) is **189069438 bytes**,
  including frozen binaries, debug symbols, dependency inspections and measurement
  records as well as the 24 download zips and **2560-byte `SHA256SUMS`**.
- Downloaded all candidate assets and reran `release-assets.py verify`: all 24
  exact embedded binary/document/symbol subjects and checksums matched. A normal
  consumer `sha256sum --check` passed; a copied real zip with appended bytes was
  rejected with `SHA256SUMS mismatch: frozen assets changed`.
- GNU riscv64 reports **2 EMULATOR-UNSUPPORTED** cases (seccomp ENOSYS and broken
  missing-path std spawn); musl reports **1** (seccomp ENOSYS). These remain
  unsupported, not product passes. Timing scale stays 1×.
- No tag, release, repository setting or pi/pi-env change was made. Real OIDC
  signing, draft creation, publication and post-publication verification remain
  unexecuted until the separately authorized tag/release tasks.

Each filename is `procward-<target>.zip` or `procward-<target>-debug.zip`:

| Target | CI | Dist dry run | Release zip bytes | Debug zip bytes |
| --- | --- | --- | ---: | ---: |
| x86_64-unknown-linux-gnu | Passed | Passed | 272193 | 3312852 |
| aarch64-unknown-linux-gnu | Passed | Passed | 276652 | 2797500 |
| x86_64-unknown-linux-musl | Passed | Passed | 324876 | 3431651 |
| aarch64-unknown-linux-musl | Passed | Passed | 314531 | 3398838 |
| riscv64gc-unknown-linux-gnu | Applicable passed; 2 unsupported | Applicable passed; 2 unsupported | 275400 | 2795901 |
| riscv64gc-unknown-linux-musl | Applicable passed; 1 unsupported | Applicable passed; 1 unsupported | 330387 | 3675187 |
| x86_64-unknown-freebsd | Passed | Passed | 257829 | 1989333 |
| aarch64-unknown-freebsd | Passed | Passed | 245818 | 2230276 |
| x86_64-apple-darwin | Passed | Passed | 251713 | 2630143 |
| aarch64-apple-darwin | Passed | Passed | 239636 | 2664950 |
| x86_64-pc-windows-msvc | Passed | Passed | 258987 | 3177505 |
| aarch64-pc-windows-msvc | Passed | Passed | 246892 | 3074074 |

Full comparison from that dry run, each cell **binary bytes / startup median ms**.
Container/emulator/VM timings include their executor overhead, not comparable
native-hardware performance. Size alone selects the setting; aarch64 GNU has
an exact 2/s/z size tie and selects first-measured 2.

| Target | 2 bytes / ms | 3 bytes / ms | s bytes / ms | z bytes / ms | Selected |
| --- | ---: | ---: | ---: | ---: | --- |
| x86_64-unknown-linux-gnu | 566096 / 0.566 | 571200 / 0.572 | 528864 / 0.577 | 519144 / 0.570 | z |
| aarch64-unknown-linux-gnu | 529248 / 0.558 | 529256 / 0.565 | 529248 / 0.585 | 529248 / 0.587 | 2 |
| x86_64-unknown-linux-musl | 669672 / 183.610 | 674728 / 181.286 | 632008 / 181.642 | 622120 / 181.130 | z |
| aarch64-unknown-linux-musl | 593224 / 154.932 | 609024 / 155.603 | 572728 / 161.837 | 561664 / 162.049 | z |
| riscv64gc-unknown-linux-gnu | 504784 / 208.142 | 517072 / 203.857 | 492496 / 202.699 | 484304 / 205.653 | z |
| riscv64gc-unknown-linux-musl | 572392 / 185.613 | 581888 / 183.523 | 559984 / 184.744 | 549328 / 184.229 | z |
| x86_64-unknown-freebsd | 532256 / 1.094 | 538816 / 1.095 | 497888 / 1.090 | 494480 / 1.095 | z |
| aarch64-unknown-freebsd | 486888 / 46.125 | 502360 / 45.087 | 456936 / 44.036 | 451824 / 46.170 | z |
| x86_64-apple-darwin | 501536 / 7.436 | 505648 / 8.614 | 468800 / 7.685 | 456656 / 6.068 | z |
| aarch64-apple-darwin | 505584 / 3.101 | 505584 / 3.241 | 489120 / 2.412 | 456592 / 2.924 | z |
| x86_64-pc-windows-msvc | 605184 / 7.167 | 613376 / 7.351 | 545792 / 7.529 | 531456 / 7.617 | z |
| aarch64-pc-windows-msvc | 571904 / 9.757 | 578560 / 9.788 | 524800 / 9.492 | 509952 / 10.097 | z |

Fix-forward history is retained in ordinary logs: first CI `40636720688` exposed
root-owned Alpine build output blocking the host dist step; first dry run
`40636732809` exposed Cargo's hashed `deps/` dSYM location. `7c2180a` restores
host target ownership and selects the dSYM by matching executable UUID, then
verifies its DWARF. Dry run `40637258166` built/tested all twelve rows but its
fan-in correctly rejected Windows CRLF distribution documents; `dd894e9` pins
only the three packaged documents to LF. A separate `core.autocrlf=true` checkout
self-check confirms exact source bytes. The final dry run above passed all checks.

CI `40641026022` at `c79378b` passed all twelve rows on attempt 2 after an ordinary
unchanged-source GNU riscv64 rerun. Attempt 1's blocked-physical-output terminal
fixture exceeded its 8-second fault bound and reported harness rescue. No
assertion/deadline or product code was changed for that rerun; root cause is not
established and remains a pre-tag review risk, not a claimed fix. Image-refactor
dry run `40656679344` also reproduced this blocked-output timeout on **native
x86_64 musl**, reporting harness rescue; no emulator exception applies to that
failure. The `12eb25b` checkpoint CI and dry run passed on attempt 1. Independent implementation review
(task 5.5), owner prerequisites/release (section 6), later pi integration (section
7) and full-system riscv64 coverage remain open.
