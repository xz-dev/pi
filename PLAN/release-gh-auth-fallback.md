# GitHub CLI authentication fallback for Release updates

## Story

- Actor: an xz-dev Pi user running `pi update`.
- Need: query the public GitHub Release API without exhausting the low anonymous rate limit when GitHub CLI is already logged in.
- Value: routine updates work without manually exporting a token or placing credentials in npm configuration.

## Accepted behavior

1. `GH_TOKEN` takes precedence, followed by `GITHUB_TOKEN`.
2. If neither variable is set, Pi asks the installed GitHub CLI for the active `github.com` token using `gh auth token --hostname github.com` with `shell: false`.
3. The discovered token is used only in the GitHub API `Authorization` request header. It is not written to disk, logged, or exported to Pi child processes.
4. If `gh` is missing, logged out, or cannot return a token, Release discovery falls back to the existing anonymous request.
5. Release asset downloads remain unauthenticated and retain existing exact-tag/CDN checks.

## Acceptance evidence

- Focused tests cover environment-token precedence, GitHub CLI fallback, and anonymous fallback.
- The existing exact Release manifest, inventory, installer hash, shell-free self-update, and rate-limit error tests remain green.
- After downstream integration and immutable publication, local and remote managed installs update once using their currently installed updater, then a plain `pi update` succeeds using `gh` automatically.
