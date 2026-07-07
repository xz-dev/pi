# xz-dev/pi

This is a downstream distribution fork of [earendil-works/pi](https://github.com/earendil-works/pi).

It tracks upstream `main` with a minimal downstream patch stack.

> [!WARNING]
> This fork relies heavily on vibe coding. Logic changes are manually reviewed, and tests are also written by AI under human direction before the full test gate is run.
>
> Almost none of the code in this fork is handwritten by xz-dev. Do not use this distribution if you are uncomfortable with AI-assisted development.

## Automation upstream sync

This fork automatically rebases `main` on `https://github.com/earendil-works/pi.git` daily:

- 01:00 Asia/Shanghai
- 13:00 Asia/Shanghai

If the rebase conflicts, the sync workflow fails and leaves `main` unchanged.

## Fixes

- [earendil-works/pi#6234](https://github.com/earendil-works/pi/issues/6234): fix Esc abort paths that could leave Pi stuck when awaited lifecycle hooks, extension hooks, provider setup, provider streams, or listener dispatch never settled.
  - Fix commit: [`4146c1e1`](https://github.com/xz-dev/pi/commit/4146c1e18d281ea291d40779bebf211a5fd2da7e) `fix(agent): make abort clear stuck runs`
  - Test commit: [`8e3bc693`](https://github.com/xz-dev/pi/commit/8e3bc693172b0eb12142b3cfbbdd9d13167fb6cc) `fix(agent): cover stuck stream abort`

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
