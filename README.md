# xz-dev/pi

This is a downstream distribution fork of [earendil-works/pi](https://github.com/earendil-works/pi).

It tracks upstream `main` with a minimal downstream patch stack.

> [!WARNING]
> This fork relies heavily on vibe coding. Logic changes are manually reviewed, and tests are also written by AI under human direction before the full test gate is run.
>
> Almost none of the code in this fork is handwritten by xz-dev. Do not use this distribution if you are uncomfortable with AI-assisted development.

## Downstream changes

### Features

- Support per-package Skill visibility overrides through `skillOverrides.<name>.disableModelInvocation`, retaining manual `/skill:<name>` invocation and project-over-global precedence.
  - Patch branch: [`patch/skill-overrides`](https://github.com/xz-dev/pi/tree/patch/skill-overrides)

### Fixes

- [earendil-works/pi#6234](https://github.com/earendil-works/pi/issues/6234): make Esc abort recover from lifecycle hooks, extension hooks, provider setup, provider streams, or listener dispatch that never settle.
  - Patch branch: [`patch/esc-abort`](https://github.com/xz-dev/pi/tree/patch/esc-abort)
- Keep TUI hardware cursor positioning and visibility inside DECSET 2026 synchronized-output frames, preventing transient cursor jumps over slow terminals or SSH connections.
  - Patch branch: [`patch/tui-synchronized-cursor`](https://github.com/xz-dev/pi/tree/patch/tui-synchronized-cursor)

### Maintenance

- Keep the fork/pre-release changelog baseline, display, and version handling correct across downstream release cycles.
  - Patch branch: [`patch/changelog-prerelease`](https://github.com/xz-dev/pi/tree/patch/changelog-prerelease)
- Carry current security updates in the dependency lockfiles, validated by production and full dependency audits.
  - Patch branch: [`patch/dependency-audit`](https://github.com/xz-dev/pi/tree/patch/dependency-audit)

### Unsupported

- ~~Provider-transparent compaction keeps one portable session history across providers while allowing compatible providers to resume from private checkpoints.~~ This feature is retired and explicitly unsupported.
  - Archived branch: [`retired/provider-transparent-compaction`](https://github.com/xz-dev/pi/tree/retired/provider-transparent-compaction)
  - Responses API compaction does not reduce API charges: compacted or provider-held context remains billable. It also makes the client-visible state machine opaque, and that hidden state can amplify charges in some cases through unexpected context retention, replay, or repeated compaction.

## Installation

GitHub Packages requires authentication for npm installs, including public packages. Create a GitHub classic token with `read:packages`, then log in:

```bash
npm login --scope=@xz-dev --auth-type=legacy --registry=https://npm.pkg.github.com
```

Install from GitHub Packages:

```bash
npm config set @xz-dev:registry https://npm.pkg.github.com
npm install -g @xz-dev/pi-coding-agent
pi --version
```

> [!NOTE]
> npm 12 disables remote tarball dependencies by default. This distribution uses GitHub Packages tarball URLs for its workspace packages, so installation or `pi update` may fail with `EALLOWREMOTE` and `Fetching packages of type "remote" have been disabled`. Enable them for your user configuration, then retry:
>
> ```bash
> npm config set allow-remote=all --location=user
> pi update
> pi update --extensions
> ```

## Automation upstream sync

Twice daily, [Upstream Sync](https://github.com/xz-dev/pi/actions/workflows/upstream-sync.yml) rebuilds `main` from the latest `https://github.com/earendil-works/pi.git` `main`, then integrates the maintenance overlay, feature and fix branches, and temporary compatibility branches in a fixed order:

- 01:28 Asia/Shanghai
- 13:28 Asia/Shanghai

Before a lease-protected update of `main`, the workflow installs dependencies, hydrates model data, builds, checks, runs focused integration regressions, audits production and development dependencies, and verifies production dependency signatures. Conflicts, empty integrations, failed gates, or a changed remote lease leave `main` unchanged. A successful push triggers the full [CI](https://github.com/xz-dev/pi/actions/workflows/ci.yml), [Esc Abort Integration](https://github.com/xz-dev/pi/actions/workflows/esc-abort-integration.yml), and [Publish GitHub Packages](https://github.com/xz-dev/pi/actions/workflows/publish-github-packages.yml) workflows for the rebuilt commit.
