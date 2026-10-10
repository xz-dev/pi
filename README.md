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

- Single executable, no Node.js needed (JIT)
- FreeBSD support
- Auto-retry interrupted sessions (`/retry`, also automatic on startup)
- WebSocket reconnect for Codex, keeps cached context
- Detach long tool calls, keep chatting (`tool_task`)
- Thinking shown as one preview line (`Ctrl+T` to expand)
- Smaller input dock when reading history
- See where each message came from (you, extension, RPC, SDK)
- Update mirrors and self-update (`pi update --self`, `--mirror`)
- Verified downloads (Sigstore signatures)
- Install extensions without npm or Node
- English locale for tools, keeps your UI language
- Quieter startup screen
- Per-model thinking level picker, sorted and preselected
- `Model: old → new` hint after switching models
- Per-skill on/off switches
- Detect slow extensions (opt-in)
- Clean old backups (`pi update --clean`)
- Scoop/ebuild installs blocked from self-update fights

Fixes:

- Esc now aborts stuck hooks and streams ([#6234](https://github.com/earendil-works/pi/issues/6234))
- Retry errors no longer spam fake tool failures
- Model picker fits small screens and phone keyboards
- No wasted summary after a finished answer
- Models from extensions load before startup
- Context % stays right after model list refresh
- `pi --list-models --refresh`
- Model picker keeps your selection during refresh
- Empty messages from extensions no longer break Gemini

## Installation

xz-dev Pi is distributed through immutable [GitHub Releases](https://github.com/xz-dev/pi/releases). Each Release ships 14 ZIP archives: FreeBSD amd64 and arm64; Darwin x64 baseline/modern and arm64; Linux GNU and musl x64 baseline/modern and arm64; and Windows x64 baseline/modern and arm64, named `pi-<target>.zip`. Each ZIP holds exactly one file, the single-file executable `pi` (`pi.exe` on Windows). The x64 `baseline` and `modern` names are compatibility aliases for the same runtime-dispatched Bun target; they no longer select separate AVX2 and baseline implementations. On Linux, choose `gnu` for glibc systems and `musl` for musl systems. The extracted executable is the complete product; there is no wrapper and no companion `pi-native` binary. No Node.js, Bun, npm, package manager, or generated installer script is required.

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

First install a current [GitHub CLI](https://cli.github.com/) through a trusted channel (for example your OS package manager), independently of the Release mirror. Its `gh attestation verify` command authenticates the archive **before extraction or execution**. Do not download a verifier or a replacement trust root from the same mirror.

Choose `target` from the platform table, and obtain the desired version and full 40-character source commit from a trusted Release page at `https://github.com/xz-dev/pi/releases`. For Linux x64 with glibc:

```sh
target=linux-x64-gnu-modern
version='<VERSION>'
commit='<FULL_COMMIT_SHA>'
mirror=https://gh-proxy.com/https://github.com
base="${mirror}/xz-dev/pi/releases/download/xz-v${version}"
curl --fail --location --output "pi-${target}.zip" "${base}/pi-${target}.zip" &&
curl --fail --location --output attestation-subjects.jsonl "${base}/attestation-subjects.jsonl" &&
gh attestation verify "pi-${target}.zip" --bundle attestation-subjects.jsonl \
  --repo xz-dev/pi \
  --cert-identity 'https://github.com/xz-dev/pi/.github/workflows/publish-github-release.yml@refs/heads/main' \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --source-ref refs/heads/main --source-digest "$commit" --deny-self-hosted-runners &&
unzip "pi-${target}.zip" &&
./pi --version
```

If GH-Proxy is unavailable, set `mirror=https://ghfast.top/https://github.com` (or `https://github.com`) and retry the whole chain. Keep the same exact version and commit. Missing or invalid attestations mean **stop**, not execute anyway. On Windows, download both files, run the same `gh attestation verify` command with your platform ZIP and full commit, and check `$LASTEXITCODE -eq 0` before `Expand-Archive` or running Pi.

These are third-party services, not infrastructure operated by this fork. A mirror can withhold or replay authentic releases; signatures prove origin and integrity, not that a release is the newest. SHA256 checks alone cannot authenticate a mirror that replaces both the archive and checksums. jsDelivr is not included: its GitHub repository-file CDN is not a proxy for these Release ZIP attachments.

### Update

An installed executable updates itself from the matching `pi-<target>.zip`:

```bash
pi update --self
```

To accelerate updates without changing settings:

```sh
pi update --mirror
pi update --mirror-url https://ghfast.top/https://github.com
pi update --mirror-url http://localhost:8080
```

`--mirror` tries **GH-Proxy → GHFast → direct GitHub**, in that order, for release discovery and again for the selected version's ZIP. Each failed source prints one gray message before trying the next; only an exhausted chain reports a final error. Failed requests or invalid downloads advance without skipping verification.

Repeat `--mirror-url` to build your own ordered chain. A single URL is simply a one-element chain. Each value replaces the literal `https://github.com` in download URLs, including its protocol and optional path. Values are not prevalidated or normalized; invalid addresses fail when requested. Do not add a trailing slash, since the original URL already supplies it. Custom chains contain only the sources you name; append GitHub explicitly if you want a direct fallback:

```sh
pi update --mirror-url https://ghfast.top/https://github.com \
          --mirror-url https://gh.llkk.cc/https://github.com \
          --mirror-url https://github.com
```

[gh.llkk.cc](https://gh.llkk.cc/) is another proxy supporting Release downloads. It is not in the built-in chain; availability varies by network.

Save a global default without performing an update:

```sh
pi update --mirror --permanent
# Or save your own ordered chain:
pi update --mirror-url http://localhost:8080 \
          --mirror-url https://ghfast.top/https://github.com --permanent
# A later command uses the saved choice:
pi update
```

`--permanent` **only saves settings and exits**, even if an address is unreachable. Settings are stored in `~/.pi/agent/settings.json` (or the directory selected by `PI_CODING_AGENT_DIR`) as an ordered `updateMirrors` array. `--mirror --permanent` saves the current built-in list; one custom URL is saved as a one-element array. Saved chains also apply to automatic version checks, which remain silent on failure. Project settings cannot override this download source. Extension, npm, and model-catalog requests are unaffected.

```sh
pi update --no-mirror              # Direct GitHub this time; keep the saved setting
pi update --no-mirror --permanent  # Clear the saved mirror; do not update
```

Without a saved setting or a mirror flag, updates continue to use GitHub directly. Command-line choices override saved settings for one invocation unless `--permanent` is present. Mirror flags cannot be combined with `--clean` or extension/model-only updates; `--permanent` also cannot be combined with `--force` or `--all`.

Extension updates are separate:

```bash
pi update --extensions
```

Standalone extension operations spawn the running executable itself, so public `pi` on `PATH` is not required. Git sources also require Git. See [package-manager selection](packages/coding-agent/docs/packages.md#package-manager-selection) for overrides and compatibility limits.

Pi authenticates the manifest using Sigstore trust roots bundled in the trusted client, requiring the `xz-dev/pi` main-branch `publish-github-release.yml` workflow, GitHub-hosted signing runner, and the manifest's source commit. It then checks the ZIP and extracted executable against that authenticated manifest before writing or replacing files. This verification is mandatory for every mirror **and direct GitHub**, including `--force`. Missing, forged, or wrong-identity attestations reject that source; only another fully verified source can succeed. No mirror-supplied trust root or verification-disable flag is accepted. Root rotations require a trusted Pi update; if the installed roots no longer cover a new signer, update through a separately trusted installation path.

On successful update, the old executable is retained as `pi-<old-version>` (`pi-<old-version>.exe` on Windows) and the verified candidate replaces the public path. `pi update --clean` removes only regular backups matching the strict distribution-version pattern; the running executable, symlinks, directories, and unrelated files are left untouched.

Installations from releases up to `xz-v1.0.0-xz.253` (raw `pi-<target>` downloads) cannot self-update onto ZIP releases: their updater only knows the raw asset and reports an invalid manifest. Reinstall once by downloading and extracting the current `pi-<target>.zip` over the old `pi`; later updates work with `pi update --self` again. Older ZIP bundle installations (`pi` + `pi-native` + loose assets) need the same one-time reinstall and should delete the old extracted directory.

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

See [`MAINTAIN.md`](MAINTAIN.md) for the authoritative downstream branch ownership, rebuild, publication, recovery, and patch-retirement rules.

Twice daily, [Upstream Sync](https://github.com/xz-dev/pi/actions/workflows/upstream-sync.yml) rebuilds `main` from the latest `https://github.com/earendil-works/pi.git` `main`, then integrates the maintenance overlay, feature and fix branches, and temporary compatibility branches in a fixed order:

- 01:28 Asia/Shanghai
- 13:28 Asia/Shanghai

Before a lease-protected update of `main`, the workflow installs dependencies, hydrates model data, builds, checks, runs focused integration regressions, validates the exact GitHub Release candidate, audits production and development dependencies, and verifies production dependency signatures. Conflicts, empty integrations, failed blocking gates, or a changed remote lease leave `main` unchanged. Dependency audits and production signature checks are currently advisory (`continue-on-error`); their failure alone does not block the rebuild. A successful push triggers the full [CI](https://github.com/xz-dev/pi/actions/workflows/ci.yml), [Esc Abort Integration](https://github.com/xz-dev/pi/actions/workflows/esc-abort-integration.yml), and [Publish GitHub Release](https://github.com/xz-dev/pi/actions/workflows/publish-github-release.yml) workflows for the rebuilt commit.

## Friends

- [LINUX DO](https://linux.do/)
