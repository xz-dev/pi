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

### Fixes

- Wait for extension-provider registration refreshes before startup resolves configured models, while preserving synchronous registration and caller-owned cancellation.
  - Patch branch: [`patch/model-startup-refresh-barrier`](https://github.com/xz-dev/pi/tree/patch/model-startup-refresh-barrier)
- [earendil-works/pi#6234](https://github.com/earendil-works/pi/issues/6234): make Esc abort recover from lifecycle hooks, extension hooks, provider setup, provider streams, or listener dispatch that never settle.
  - Patch branch: [`patch/esc-abort`](https://github.com/xz-dev/pi/tree/patch/esc-abort)

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

xz-dev Pi is distributed through immutable [GitHub Releases](https://github.com/xz-dev/pi/releases). Each Release ships six prebuilt Bun-compiled platform bundles (`pi-darwin-arm64.tar.gz`, `pi-darwin-x64.tar.gz`, `pi-linux-arm64.tar.gz`, `pi-linux-x64.tar.gz`, `pi-windows-arm64.zip`, `pi-windows-x64.zip`). A standalone install requires no Node.js, Bun, npm, or package manager at runtime; the executable and its adjacent native modules, WASM, themes, assets, HTML export templates, docs, and examples travel together as one version-matched archive. Installation keeps only the current, previous, and staging bundles needed for safe switching and Windows cleanup.

### Linux and macOS

```bash
curl -fsSL https://github.com/xz-dev/pi/releases/latest/download/install.sh | sh
pi --version
```

### Windows PowerShell

```powershell
& ([scriptblock]::Create((Invoke-WebRequest https://github.com/xz-dev/pi/releases/latest/download/install.ps1 -UseBasicParsing).Content))
pi --version
```

### Exact Release installation

An installer downloaded from `/releases/download/xz-v<VERSION>/install.sh` installs only that exact Release; it never performs latest discovery and never requires a version argument:

```bash
curl -fsSL https://github.com/xz-dev/pi/releases/download/xz-v<VERSION>/install.sh | sh
```

The generated native installers are standalone and verify the exact Release manifest and bundle/checksum metadata without Node.js, Bun, npm, or a package manager. They also require the [GitHub CLI](https://cli.github.com/) (`gh`) so it can verify the Release-hosted artifact attestation bundle before extracting or executing any bundle code. Public Release verification does not require signing in to GitHub; it may contact Sigstore's TUF service for current trusted-root material. Release assets include `SHA256SUMS` and GitHub build-provenance attestations.

### Update

A managed binary installation updates through the same installer implementation used for fresh installation:

```bash
pi update --self
```

On POSIX, activation creates `current.new` pointing at the new complete bundle and atomically renames it over `current`; `previous` is updated afterward as non-authoritative cleanup metadata. On Windows, a stable launcher reads a small `current` pointer file and never overwrites the running `pi.exe`; locked old bundles are deferred for cleanup. A new Pi invocation uses the new bundle. There is no public rollback or arbitrary retained-version catalog.

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
