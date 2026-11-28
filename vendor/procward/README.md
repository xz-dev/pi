# procward

Procward owns a command's process tree and provides job control for CLI programs
on Linux, FreeBSD, macOS and Windows. By default, it cleans up owned work when the command
exits or its owner disappears, while preserving the command's exit status.
macOS cleanup is best-effort for observed descendants, not kernel containment.

## Installation

Download your target's `procward-<target>.zip` and `SHA256SUMS` from
[Releases](https://github.com/xz-dev/procward/releases). Debug builds are named
`procward-<target>-debug.zip`. Verify before extracting or running:

```sh
# Substitute the published version and your target.
tag=v0.3.0
target=x86_64-unknown-linux-gnu
asset="procward-$target.zip"
gh release download "$tag" --repo xz-dev/procward --pattern "$asset" --pattern SHA256SUMS
grep "  $asset$" SHA256SUMS | sha256sum --check -
gh attestation verify "$asset" --repo xz-dev/procward \
  --signer-workflow xz-dev/procward/.github/workflows/release.yml \
  --source-ref "refs/tags/$tag"
unzip "$asset"
```

Use `shasum -a 256` on macOS or `Get-FileHash -Algorithm SHA256` in PowerShell
when `sha256sum` is unavailable. Put `procward` (`procward.exe` on Windows) on
`PATH`. Full target list and source-pinned verification commands:
[CI and releases](docs/ci-release.md).

## Usage

```sh
procward run -- command arg1 "two words"
procward run --grace 6s --fatal-grace 3s --cleanup-deadline 7500ms -- command
```

Arguments execute directly, without an added shell. Durations use integer `s`
or `ms`; require `0 < fatal-grace <= grace < cleanup-deadline`. Defaults are
6s, 3s and 7500ms. Use `procward --help` for options.

Use `procward run --quiet -- command` to omit the routine Linux
cgroup-fallback startup notice. Command stderr and errors remain visible;
quiet mode does not change ownership or cleanup behavior.

Task controllers can add `--retain-descendants` to receive the primary result
while ordinary background work continues under ownership. The tree ends on
natural completion, cancellation or owner/controller loss. This option requires
`--control-fd` (Unix descriptor or Windows CRT descriptor) or
`--control-handle` (Windows raw HANDLE); it does not detach or redirect the command.
Windows controllers using ordinary extra inherited stdio, such as Node's
`stdio[3]`, use `--control-fd 3`, not `--control-handle 3`. See the [task contract](docs/contract.md#retaining-ordinary-task-descendants).

## Development

Run Linux integration tests only in the disposable full-system VM:
`python3 ci/vm-test.py --kernel <installed-kernel>` and the separate `--hazard`
run. Host Cargo execution is guarded; containers and qemu-user alone are not
isolation. See [development](docs/development.md#build-and-checks) for prerequisites,
static checks, result records and the remote CI verification gate. Remote Linux
jobs use [copy-only full-system VM Actions](ci/linux-vms.md), not host containers.

## Background

Procward originated from the process-ownership needs of
[pi](https://github.com/xz-dev/pi), its main intended consumer. This is a new
standalone Rust implementation built on maintained crates and native OS
facilities, not copied or translated pi or pi-env code.

Licensed under [BSD-3-Clause](LICENSE).
