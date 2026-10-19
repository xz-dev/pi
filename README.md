# xz-dev/pi

This is a downstream distribution fork of [earendil-works/pi](https://github.com/earendil-works/pi).

> [!NOTE]
> 🌟 Star this fork to show your support for its direction and encourage change in upstream Pi.
>
> All patches in this fork are free to submit upstream directly, or to use as a reference for your own upstream PR. I waive any code ownership over these downstream patches; please credit [this repository](https://github.com/xz-dev/pi) as the source in your PR.

It tracks upstream `main` with a minimal downstream patch stack, using [downstream-fork-maintain-skill](https://github.com/xz-dev/downstream-fork-maintain-skill) as the blueprint for ongoing maintenance.

> [!WARNING]
> This fork relies heavily on vibe coding. Logic changes are manually reviewed, and tests are also written by AI under human direction before the full test gate is run.
>
> Almost none of the code in this fork is handwritten by xz-dev. Do not use this distribution if you are uncomfortable with AI-assisted development.

Release platforms (one `pi-<target>.zip` each, see [Installation](#installation)):

| OS | Release assets |
| --- | --- |
| Linux glibc | `linux-x64-gnu-baseline`, `linux-x64-gnu-modern`, `linux-arm64-gnu` |
| Linux musl | `linux-x64-musl-baseline`, `linux-x64-musl-modern`, `linux-arm64-musl` |
| macOS | `darwin-x64-baseline`, `darwin-x64-modern`, `darwin-arm64` |
| Windows | `windows-x64-baseline`, `windows-x64-modern`, `windows-arm64` |
| FreeBSD 14.3+ | `freebsd-x64`, `freebsd-arm64` |

## Downstream changes

Highlights only; full details with use cases, limits, and patch branches: [docs/downstream-changes.md](docs/downstream-changes.md).

Features:

- Single executable, no Node.js needed (Bun JIT + precompiled bytecode)
- FreeBSD support
- Resume interrupted work (`/retry`, eligible sessions also recover on startup)
- WebSocket recovery and incremental context for OpenAI Responses and Codex
- [Response checkpoints](docs/downstream-changes.md#response-checkpoints) across reconnects and session restarts
- Lossless [request-body compression](docs/request-compression.md) for model JSON posts and Responses WebSocket frames
- Custom fail-fast patterns for terminal gateway errors
- Actual connection and request mode beside Working (`SSE`, `WS/full`, `WS/continuation`, or another reported protocol)
- Detach long tool calls, keep chatting (`tool_task`)
- Optional background compaction: keep working while summarizing (`/settings`, off by default)
- Thinking shown as one preview line (`Ctrl+T` to expand)
- Smaller input dock when reading fullscreen history
- See where each message came from (you, extension, RPC, SDK)
- [Self-update and mirrors](docs/updating.md) (`pi update --self`, `--mirror`)
- [Update retries](docs/updating.md#automatic-retries) with 3, 6 and 12 second waits
- [Verified downloads](docs/updating.md#verification-backups-and-managed-installs) (Sigstore signatures)
- Install extensions without npm or Node
- English locale for tools, keeps your UI language
- Quieter startup screen
- Refresh provider catalogs from CLI (`pi --list-models --refresh`)
- Per-model thinking level picker, sorted and preselected
- [Model and thinking switch hints](docs/downstream-changes.md#model-and-thinking-switches) (`old → new` until the next request starts)
- Per-skill automatic invocation controls; manual `/skill:<name>` stays available
- Detect slow extensions (opt-in)
- Clean old binary backups in the install directory (`pi update --clean`)
- Scoop/ebuild installs blocked from self-update fights

Fixes:

- Esc now aborts stuck hooks and streams ([#6234](https://github.com/earendil-works/pi/issues/6234))
- Provider errors stay visible during retries without fake tool failures
- Selection panels fit small screens and phone keyboards
- No wasted summary after a finished answer
- Compaction summaries survive `/tree` navigation to retained messages
- Models from extensions load before startup
- Context % stays right after model list refresh
- Model picker keeps your selection during refresh
- Empty messages from extensions no longer break Gemini

## Installation

xz-dev Pi is distributed through immutable [GitHub Releases](https://github.com/xz-dev/pi/releases). Each Release ships 14 ZIP archives: FreeBSD amd64 and arm64; Darwin x64 baseline/modern and arm64; Linux GNU and musl x64 baseline/modern and arm64; and Windows x64 baseline/modern and arm64, named `pi-<target>.zip`. Each ZIP holds exactly one file, the single-file executable `pi` (`pi.exe` on Windows). The x64 `baseline` and `modern` names are compatibility aliases for the same runtime-dispatched Bun target; they no longer select separate AVX2 and baseline implementations. On Linux, choose `gnu` for glibc systems and `musl` for musl systems. The extracted executable is the complete product; there is no wrapper and no companion `pi-native` binary. No Node.js, Bun, npm, package manager, or generated installer script is required.

The executable embeds Bun's JIT runtime and precompiled JavaScript bytecode. All 14 Release targets use `--minify --bytecode --format=esm`, moving parsing and initial bytecode generation to build time without disabling runtime JIT.

The executable materializes its embedded runtime assets (docs, themes, native clipboard helper) into a per-user tmpdir cache at `os.tmpdir()/pi-resources-<uid>/<target>/<version>` on first use; a nonempty cache directory is reused as-is. Linux clipboard support follows upstream: the native X11 helper uses the system's `libxcb.so.1` and an available X11 display. Their absence does not prevent basic CLI or TUI startup; clipboard availability and fallback tools depend on the desktop environment.

### Linux and macOS

```bash
# Download the matching pi-<target>.zip from the latest Release, then:
unzip pi-<target>.zip
./pi --version
# Optionally install it on PATH:
mv pi ~/.local/bin/pi
```

### FreeBSD

Download `pi-freebsd-x64.zip` (amd64) or `pi-freebsd-arm64.zip` (arm64) on FreeBSD 14.3 or newer, then:

```sh
pkg install fd-find ripgrep
unzip pi-freebsd-<arch>.zip
./pi --version
```

`fd-find` is the Rust search tool, not FreeBSD's unrelated `fd` package. Bash is optional: command tools fall back to `/bin/sh`. No Node.js or Bun installation is needed. Desktop clipboard reads require `pkg install libxcb xclip` for X11, or `pkg install wl-clipboard` for Wayland. Without a display, copy uses terminal OSC 52; availability depends on the terminal.

### Windows Scoop

```powershell
$scoopRoot = (Resolve-Path (Join-Path (scoop prefix scoop) '..\..\..')).Path
$bucket = Join-Path $scoopRoot 'buckets\xz-dev'
git clone --branch scoop --single-branch https://github.com/xz-dev/pi.git $bucket
scoop install xz-dev/pi
```

Scoop installs the x64 `modern` ZIP, or the native arm64 ZIP on Windows arm64, and shims the extracted `pi.exe`. The x64 asset uses the same runtime-dispatched Bun target as the `baseline` alias. Update with `scoop update pi`.

The Scoop install writes an empty `.scoop.managed.lock` next to the executable, so `pi update --self` refuses and points at `scoop update pi` instead; scoop owns the upgrade. Direct ZIP downloads carry no lock file and keep self-update enabled.

### Windows PowerShell

```powershell
# Download the matching pi-<target>.zip from the latest Release, then:
Expand-Archive pi-<target>.zip -DestinationPath pi
.\pi\pi.exe --version
```

### Exact Release installation

Download `pi-<target>.zip` from the exact `xz-v<VERSION>` Release instead of Latest, then extract and run it using the same commands above. Minimal Debian/Ubuntu images need `apt install unzip` first; `bsdtar -xf pi-<target>.zip` also works.

Release assets include `SHA256SUMS` and GitHub build-provenance attestations for independent verification.

### Install through a GitHub mirror

Follow the [mirror installation and verification guide](docs/updating.md#install-through-a-mirror).
Use an independently trusted `gh` to verify the exact archive, workflow identity
and full source commit **before extraction or execution**. Missing or invalid
proof means stop; a mirror must not supply the verifier or a replacement trust root.

### Update

For the standalone executable:

```sh
pi update --self        # Pi itself
pi update --extensions  # Installed packages
pi update --models      # Pi-managed model catalogs
```

Failed eligible operations retry after **3, 6 and 12 seconds**, without repeating
successful siblings or bypassing verification. See the
[update guide](docs/updating.md) for retry scope, mirrors, saved preferences,
package sources, mandatory signatures, backups and managed-install limits.

### Building without the native X11 helper

For package-manager builds such as Gentoo `USE=-X`, pass `--without-x11` to `scripts/build-binaries.sh`. Linux and FreeBSD executables then omit the native X11 clipboard helper; musl builds also no longer need `--clipboard-musl-dir`. The default build and macOS/Windows native helpers are unchanged. This option does not disable command-line clipboard fallbacks such as `wl-paste` or `xclip`.

```bash
bash scripts/build-binaries.sh --platform linux-x64-gnu-baseline --without-x11
```

### Source checkout

A documented source installation uses the xz-dev checkout and is user-managed. Source/npm execution requires Node.js **22.22.2+ within 22.x, 24.15.0+ within 24.x, or 26+** (`^22.22.2 || ^24.15.0 || >=26.0.0`) for the hardened Sigstore verifier. Standalone Release executables retain their embedded Bun runtime and do not require Node.js.

```bash
git clone https://github.com/xz-dev/pi.git
cd pi
npm ci --ignore-scripts
npm run build
cd packages/coding-agent
npm link
```

For this installation, `pi update --self` never runs a package-manager update and never queries official upstream Release/update sources; it prints xz-dev source-checkout update instructions that you run yourself.

## Automation upstream sync

Release CI signs accepted candidates before self-update acceptance on native, offline musl, and FreeBSD runners; publication waits for these update gates. Signature-gated update acceptance and publication run only on `refs/heads/main`. A non-main `workflow_dispatch` can build and smoke-test, but cannot pass the main-only release identity policy and therefore skips those signed-update/publication jobs.

See [`MAINTAIN.md`](MAINTAIN.md) for the authoritative downstream branch ownership, rebuild, publication, recovery, and patch-retirement rules. Upstream now supplies the websocket test dependencies; the never-published test-only repair input is retired, while real Chord websocket and thinking-preview gates remain enabled. Upstream now supplies the Xiaomi model-fixture updates, so the duplicate [`patch/model-catalog-test-fixtures`](https://github.com/xz-dev/pi/tree/patch/model-catalog-test-fixtures) input is retired. Its source ref is retained; the tests and their assertions remain upstream.

Twice daily, [Upstream Sync](https://github.com/xz-dev/pi/actions/workflows/upstream-sync.yml) rebuilds `main` from the latest `https://github.com/earendil-works/pi.git` `main`, then integrates the maintenance overlay and feature/fix branches in a fixed order:

- 01:28 Asia/Shanghai
- 13:28 Asia/Shanghai

Before a lease-protected update of `main`, the workflow installs dependencies, hydrates model data, builds, checks, runs focused integration regressions, validates the exact GitHub Release candidate, audits production and development dependencies, and verifies production dependency signatures. Conflicts, empty integrations, failed blocking gates, or a changed remote lease leave `main` unchanged. Dependency audits and production signature checks are currently advisory (`continue-on-error`); their failure alone does not block the rebuild. A successful push triggers the full [CI](https://github.com/xz-dev/pi/actions/workflows/ci.yml), [Esc Abort Integration](https://github.com/xz-dev/pi/actions/workflows/esc-abort-integration.yml), and [Publish GitHub Release](https://github.com/xz-dev/pi/actions/workflows/publish-github-release.yml) workflows for the rebuilt commit.

## Friends

- [LINUX DO](https://linux.do/)
