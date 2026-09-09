# Patched Bun runtime

Official Bun 1.4.2 fixes the npm-lock migration bug that could silently omit Git dependencies. It still rejects `info` and `pm view` outside a project. `bun-info-no-project.patch` enables Bun's existing projectless initialization for those commands without changing cwd or creating a manifest. The patch includes four local-registry regressions covering npmrc/bunfig configuration, scoped authentication, selectors, and unchanged directory contents.

## Review status: not release-ready

The frozen runtime passed functional acceptance only on the local Linux host. Its ELF requires `GLIBC_2.43`, while official Bun 1.4.2 requires at most `GLIBC_2.17`. It cannot run directly on the existing Ubuntu 24.04 runner. This is a build-environment compatibility regression, not a requirement of the metadata-query patch. The current runtime hash records that local experiment; it does not attest a portable GNU/Linux release.

Restoring the official glibc baseline, rerunning acceptance for the new runtime, and provisioning it in release CI remain review blockers. No binary from this experiment has been published.

## Build binding

`bun-runtime.json` binds the source patch and each accepted runtime by SHA-256. The binary build entrypoint requires `BUN_COMPILE_EXECUTABLE_PATH`, verifies the patch, host, target, and runtime hashes before installing/building anything, and uses that same executable as both compiler and embedded runtime. There is no stock Bun fallback.

The build-entrypoint changes are maintained separately on `ci` and submitted for review at `JohnsonRan/pi:review/pr5-runtime-binding`, without updating the active `xz-dev/pi:ci` branch. The Bun behavior patch and binding belong to `patch/use-embedded-bun-package-manager` (PR #5). Use their combined tree.

The already accepted runtime is frozen in `.artifacts/pr5/frozen/accepted-runtime.zip`. Extract its `bun` executable and point `BUN_COMPILE_EXECUTABLE_PATH` at it to reuse the validated bytes without rebuilding Bun.

Only `linux-x64-gnu-modern` currently has a locally verified runtime binding. Other targets deliberately fail preflight. The proposed build entrypoint checks hashes and host OS/architecture, not glibc compatibility. Release workflows have **not** been provisioned with a compatible patched runtime; official Bun version pins alone do not satisfy the binding. Do not integrate the CI companion into active publishing until those blockers are resolved.

## Reproduce the local experiment

The following reproduces the functional experiment, not a portable release build. A distributable build must also restore the official glibc 2.17 target-library baseline.

Use Bun tag `bun-v1.4.2`, commit `744846f844374847c902b5e7fd59b4342a51ef99`. Follow that revision's [build prerequisites](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/CONTRIBUTING.md). The accepted Linux build used LLVM 21, Rust `nightly-2026-07-20`, Ninja, NASM, and two build jobs.

```sh
PI_SOURCE=$PWD
BUN_SOURCE=/absolute/path/to/bun

git -C "$BUN_SOURCE" rev-parse HEAD  # must equal the commit above
cd "$BUN_SOURCE"
git apply --check "$PI_SOURCE/patches/bun-info-no-project.patch"
git apply "$PI_SOURCE/patches/bun-info-no-project.patch"
bun install --frozen-lockfile --ignore-scripts
CARGO_BUILD_JOBS=2 CMAKE_BUILD_PARALLEL_LEVEL=2 \
  bun scripts/build.ts --profile=release --lto=off -j2
build/release/bun test test/cli/install/bun-info-no-project.test.ts test/cli/install/bun-info.test.ts

cd "$PI_SOURCE"
export BUN_COMPILE_EXECUTABLE_PATH="$BUN_SOURCE/build/release/bun"
# With the workspace already built and Zig 0.15.2 available:
bash scripts/build-binaries.sh --skip-install --skip-build \
  --platform linux-x64-gnu-modern --distribution-version 0.85.1-xz.pr5.1.g627c958 \
  --out /absolute/path/to/candidate
```

A new build may not be byte-identical. Do not update the binding merely to make preflight pass. Validate a changed runtime and resulting standalone first; identical executable hashes can reuse the existing acceptance evidence.

## Locally verified candidate

Version: `0.85.1-xz.pr5.1.g627c958`, based on Pi commit `627c95875c774dd3e0c2a1a04ac4c51e51491de9` plus the recorded build-input patch.

| File | SHA-256 |
| --- | --- |
| `pi` | `a0007d23da1e8fc768013f5a014e76b78947c0863d679540eeb9eaf9494ccab2` |
| `pi-native` | `032afe1c4ca572a10afd38915445999523d8226e9c501ed801225043f6005e59` |
| `pi-linux-x64-gnu-modern.zip` | `753ca78475a6833506f4a937da5fee9f9fa15c52cfa3948bba6ab6e438fd980f` |

Frozen local artifacts: `.artifacts/pr5/frozen/`, including `acceptance-receipts.zip` and `SHA256SUMS.json`.

Verified with the exact candidate: Bun queries 23/23; public installation and RPC loading of pinned pi-notify/pi-subagents; a real notification action; a native child reading a random fixture, normal completion delivery, and observed exit; the existing 18-mode matrix; isolated/coexisting plugins; update/reload/removal; and bulk/explicit updates retaining installed 2.0.0 when the registry target is 1.0.0. Original plugin manifests and npm locks remained unchanged. Runtime sandboxes had no executable external Node/npm/Bun, no network, and no host credentials or paid provider calls. Installation and update commands had network access.
