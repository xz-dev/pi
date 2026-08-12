# xz-dev/pi

This is a downstream distribution fork of [earendil-works/pi](https://github.com/earendil-works/pi).

It tracks upstream `main` with a minimal downstream patch stack.

> [!WARNING]
> This fork relies heavily on vibe coding. Logic changes are manually reviewed, and tests are also written by AI under human direction before the full test gate is run.
>
> Almost none of the code in this fork is handwritten by xz-dev. Do not use this distribution if you are uncomfortable with AI-assisted development.

## Downstream changes

### Features

- Continue from the nearest protocol-safe conversation boundary with `/retry` or RPC `retry`, preserving superseded history as an append-only sibling branch, retaining completed tool results, and synthesizing explicit unknown-outcome errors only for missing results without replaying old tool calls.
  - Patch branch: [`patch/manual-retry`](https://github.com/xz-dev/pi/tree/patch/manual-retry)
- Support per-package Skill visibility overrides through `skillOverrides.<name>.disableModelInvocation`, retaining manual `/skill:<name>` invocation and project-over-global precedence.
  - Patch branch: [`patch/skill-overrides`](https://github.com/xz-dev/pi/tree/patch/skill-overrides)
- Allow `settings.retry.nonRetryableErrorPatterns` to fail-fast on gateway-specific terminal quota/limit error messages without expanding the built-in retry classifier.
  - Patch branch: [`patch/retry-non-retryable-patterns`](https://github.com/xz-dev/pi/tree/patch/retry-non-retryable-patterns)
- Let extensions run an immediate internal Agent turn with hidden presentation while retaining native provider hooks, retry, compaction, tools, usage, and extension lifecycle; public subscribers and persistence receive only redacted result metadata.
  - Patch branch: [`patch/hidden-internal-runs`](https://github.com/xz-dev/pi/tree/patch/hidden-internal-runs)

### Fixes

- Wait for extension-provider registration refreshes before startup resolves configured models, while preserving synchronous registration and caller-owned cancellation.
  - Patch branch: [`patch/model-startup-refresh-barrier`](https://github.com/xz-dev/pi/tree/patch/model-startup-refresh-barrier)
- Rebind active and scoped sessions to refreshed same-ID model metadata so context percentages and automatic compaction use the current context window.
  - Patch branch: [`patch/model-refresh-session-rebind`](https://github.com/xz-dev/pi/tree/patch/model-refresh-session-rebind)
- [earendil-works/pi#6234](https://github.com/earendil-works/pi/issues/6234): make Esc abort recover from lifecycle hooks, extension hooks, provider setup, provider streams, or listener dispatch that never settle.
  - Patch branch: [`patch/esc-abort`](https://github.com/xz-dev/pi/tree/patch/esc-abort)
- Keep content and hardware-cursor state in one synchronized terminal release so tmux cannot redraw centered overlays from an intermediate cursor position.
  - Patch branch: [`patch/tui-synchronized-cursor-fleet`](https://github.com/xz-dev/pi/tree/patch/tui-synchronized-cursor-fleet)

The integrated Esc and manual-retry patches both extend the Agent failure lifecycle. Their independent branches remain directly reviewable; [`tmp/patch/esc-manual-retry-compat`](https://github.com/xz-dev/pi/tree/tmp/patch/esc-manual-retry-compat) supplies only the downstream combined `handleRunFailure()` resolution and is merged immediately after them.

### Temporarily disabled

These branches still exist but are not squash-merged into rebuilt `main` until they are rebased onto current upstream:

- Provider catalog refresh consistency
  - Patch branch: [`patch/model-refresh-consistency`](https://github.com/xz-dev/pi/tree/patch/model-refresh-consistency)
- TUI synchronized-output hardware cursor positioning
  - Patch branch: [`patch/tui-synchronized-cursor`](https://github.com/xz-dev/pi/tree/patch/tui-synchronized-cursor)

### Maintenance

- Keep the fork/pre-release changelog baseline, display, and version handling correct across downstream release cycles.
  - Patch branch: [`patch/changelog-prerelease`](https://github.com/xz-dev/pi/tree/patch/changelog-prerelease)

### Unsupported

- ~~Provider-transparent compaction keeps one portable session history across providers while allowing compatible providers to resume from private checkpoints.~~ This feature is retired and explicitly unsupported.
  - Archived branch: [`retired/provider-transparent-compaction`](https://github.com/xz-dev/pi/tree/retired/provider-transparent-compaction)
  - Responses API compaction does not reduce API charges: compacted or provider-held context remains billable. It also makes the client-visible state machine opaque, and that hidden state can amplify charges in some cases through unexpected context retention, replay, or repeated compaction.

## Installation

xz-dev Pi is distributed through immutable [GitHub Releases](https://github.com/xz-dev/pi/releases). Each Release ships 12 ZIP bundles: Darwin x64 baseline/modern and arm64; Linux GNU and musl x64 baseline/modern and arm64; and Windows x64 baseline/modern and arm64. Choose `modern` on an AVX2-capable x64 CPU and `baseline` otherwise; on Linux, choose `gnu` for glibc systems and `musl` for musl systems. Each ZIP contains `pi` plus `pi-native` (`.exe` on Windows) and all version-matched runtime assets. No Node.js, Bun, npm, package manager, or generated installer script is required.

### Linux and macOS

```bash
# Download the matching pi-<target>.zip from the latest Release, then:
unzip pi-<target>.zip -d pi
chmod +x pi/pi pi/pi-native
./pi/pi --version
```

### Windows PowerShell

```powershell
# Download the matching pi-<target>.zip from the latest Release, then:
Expand-Archive .\pi-<target>.zip -DestinationPath .\pi
.\pi\pi.exe --version
```

### Exact Release installation

Download `pi-<target>.zip` from the exact `xz-v<VERSION>` Release instead of Latest, then extract it using the same commands above.

Release assets include `SHA256SUMS` and GitHub build-provenance attestations for independent verification.

### Update

An extracted binary updates itself directly from the matching target ZIP:

```bash
pi update --self
```

The first update converts the extracted directory into a managed layout: the complete ZIP is staged under `bundles/<version>`, then `current` is atomically replaced. On POSIX, the root wrapper is also atomically refreshed. On Windows, `pi.exe` remains stable, waits for `pi-native.exe`, and returns its exit status without overwriting the running wrapper. A new invocation reads `current` and starts the activated bundle.

### Source checkout

A documented source installation uses the xz-dev checkout and is user-managed:

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

See [`MAINTAIN.md`](MAINTAIN.md) for the authoritative downstream branch ownership, rebuild, publication, recovery, and patch-retirement rules.

Twice daily, [Upstream Sync](https://github.com/xz-dev/pi/actions/workflows/upstream-sync.yml) rebuilds `main` from the latest `https://github.com/earendil-works/pi.git` `main`, then integrates the maintenance overlay, feature and fix branches, and temporary compatibility branches in a fixed order:

- 01:28 Asia/Shanghai
- 13:28 Asia/Shanghai

Before a lease-protected update of `main`, the workflow installs dependencies, hydrates model data, builds, checks, runs focused integration regressions, validates the exact GitHub Release candidate, audits production and development dependencies, and verifies production dependency signatures. Conflicts, empty integrations, failed gates, or a changed remote lease leave `main` unchanged. A successful push triggers the full [CI](https://github.com/xz-dev/pi/actions/workflows/ci.yml), [Esc Abort Integration](https://github.com/xz-dev/pi/actions/workflows/esc-abort-integration.yml), and [Publish GitHub Release](https://github.com/xz-dev/pi/actions/workflows/publish-github-release.yml) workflows for the rebuilt commit.
