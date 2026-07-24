# xz-dev/pi

This is a downstream distribution fork of [earendil-works/pi](https://github.com/earendil-works/pi).

It tracks upstream `main` with a minimal downstream patch stack.

> [!WARNING]
> This fork relies heavily on vibe coding. Logic changes are manually reviewed, and tests are also written by AI under human direction before the full test gate is run.
>
> Almost none of the code in this fork is handwritten by xz-dev. Do not use this distribution if you are uncomfortable with AI-assisted development.

## Downstream changes

### Features

- Per-package Skill visibility overrides through `skillOverrides.<name>.disableModelInvocation`: setting it to `true` hides a packaged skill from model invocation while keeping manual `/skill:<name>` invocation available; `false` can override the skill frontmatter visibility. Project delta settings take precedence over global defaults.
  - Patch branch: [`patch/skill-overrides`](https://github.com/xz-dev/pi/tree/patch/skill-overrides)

### Fixes

- [earendil-works/pi#6234](https://github.com/earendil-works/pi/issues/6234): fix Esc abort paths that could leave Pi stuck when awaited lifecycle hooks, extension hooks, provider setup, provider streams, or listener dispatch never settled.
  - Fix commit: [`4146c1e1`](https://github.com/xz-dev/pi/commit/4146c1e18d281ea291d40779bebf211a5fd2da7e) `fix(agent): make abort clear stuck runs`
  - Test commit: [`8e3bc693`](https://github.com/xz-dev/pi/commit/8e3bc693172b0eb12142b3cfbbdd9d13167fb6cc) `fix(agent): cover stuck stream abort`
- Keep TUI hardware cursor positioning and visibility inside DECSET 2026 synchronized-output frames, preventing the cursor from briefly appearing on a spinner or other render endpoint before returning to the input editor over slow terminals or SSH connections.
  - Patch branch: [`patch/tui-synchronized-cursor`](https://github.com/xz-dev/pi/tree/patch/tui-synchronized-cursor)
  - Fix commit: [`3d9b88b3`](https://github.com/xz-dev/pi/commit/3d9b88b367a3fb80e52219e7c1aa3aad913bd602) `fix(tui): synchronize hardware cursor updates`

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

This fork automatically rebases `main` on `https://github.com/earendil-works/pi.git` daily:

- 01:28 Asia/Shanghai
- 13:28 Asia/Shanghai

If the rebase conflicts, the sync workflow fails and leaves `main` unchanged.
