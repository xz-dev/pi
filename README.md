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

xz-dev Pi is distributed through immutable [GitHub Releases](https://github.com/xz-dev/pi/releases). It keeps the canonical `@earendil-works/pi-*` runtime and package names; no npm registry login or remote-tarball npm setting is required.

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

The bootstrap is deliberately thin: it pins and verifies the exact Release manifest and authoritative `install.ts`, then runs it with Node 22.19+ or Bun. The transaction installer also requires the [GitHub CLI](https://cli.github.com/) (`gh`) so it can verify the artifact attestation before installing or executing package code. Public Release verification does not require signing in to GitHub. Release assets include `SHA256SUMS` and GitHub build-provenance attestations.

### One-time migration from the old GitHub Packages distribution

The old `@xz-dev/pi-coding-agent` updater never silently crosses package identities. Run the new installer once with `--migrate`; it replaces only the managed installation and preserves `~/.pi` user data.

The migration installer requires the exact legacy npm global prefix. Confirm that the old package is present there before running it.

Linux/macOS:

```bash
legacy_prefix="$(npm prefix -g)"
test -f "$legacy_prefix/lib/node_modules/@xz-dev/pi-coding-agent/package.json"
curl -fsSL https://github.com/xz-dev/pi/releases/latest/download/install.sh \
  | PI_XZ_LEGACY_PREFIX="$legacy_prefix" sh -s -- --migrate
```

Windows PowerShell:

```powershell
$legacyPrefix = (npm prefix -g).Trim()
if (-not (Test-Path (Join-Path $legacyPrefix 'node_modules/@xz-dev/pi-coding-agent/package.json'))) {
  throw "@xz-dev/pi-coding-agent was not found under $legacyPrefix"
}
$env:PI_XZ_LEGACY_PREFIX = $legacyPrefix
& ([scriptblock]::Create((Invoke-WebRequest https://github.com/xz-dev/pi/releases/latest/download/install.ps1 -UseBasicParsing).Content)) --migrate
```

`PI_XZ_LEGACY_PREFIX` is intentionally explicit; a plain `--migrate` does not search arbitrary global prefixes. Existing GitHub Packages users must perform this hard migration manually; installing or updating the old package alone will not migrate it.

### Update and rollback

A managed installation updates directly through the currently running Node/Bun runtime; it does not invoke a shell or PowerShell bootstrap:

```bash
pi update --self
```

Installed versions are retained under `${XDG_DATA_HOME:-$HOME/.local/share}/pi-xz/versions` on Linux/macOS and `%LOCALAPPDATA%\pi-xz\versions` on Windows. To reactivate one retained version, run the exact Release installer for that version with `--rollback <version>`:

```bash
version="0.82.1-xz.<run>.<attempt>.g<sha8>"
curl -fsSL "https://github.com/xz-dev/pi/releases/download/xz-v${version}/install.sh" \
  | sh -s -- --rollback "$version"
```

```powershell
$version = '0.82.1-xz.<run>.<attempt>.g<sha8>'
$script = "https://github.com/xz-dev/pi/releases/download/xz-v$version/install.ps1"
& ([scriptblock]::Create((Invoke-WebRequest $script -UseBasicParsing).Content)) --rollback $version
```

Rollback accepts only a retained version whose Release receipt, tarball hashes, package identity, and installed tree integrity still verify. It does not download or restore an arbitrary version.

## Automation upstream sync

See [`MAINTAIN.md`](MAINTAIN.md) for the authoritative downstream branch ownership, rebuild, publication, recovery, and patch-retirement rules.

Twice daily, [Upstream Sync](https://github.com/xz-dev/pi/actions/workflows/upstream-sync.yml) rebuilds `main` from the latest `https://github.com/earendil-works/pi.git` `main`, then integrates the maintenance overlay, feature and fix branches, and temporary compatibility branches in a fixed order:

- 01:28 Asia/Shanghai
- 13:28 Asia/Shanghai

Before a lease-protected update of `main`, the workflow installs dependencies, hydrates model data, builds, checks, runs focused integration regressions, validates the exact GitHub Release candidate, audits production and development dependencies, and verifies production dependency signatures. Conflicts, empty integrations, failed gates, or a changed remote lease leave `main` unchanged. A successful push triggers the full [CI](https://github.com/xz-dev/pi/actions/workflows/ci.yml), [Esc Abort Integration](https://github.com/xz-dev/pi/actions/workflows/esc-abort-integration.yml), and [Publish GitHub Release](https://github.com/xz-dev/pi/actions/workflows/publish-github-release.yml) workflows for the rebuilt commit.
