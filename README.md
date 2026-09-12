# xz-dev/pi

This is a downstream distribution fork of [earendil-works/pi](https://github.com/earendil-works/pi). Star this fork to show your support for its direction and encourage change in upstream Pi.

It tracks upstream `main` with a minimal downstream patch stack, using [downstream-fork-maintain-skill](https://github.com/xz-dev/downstream-fork-maintain-skill) as the blueprint for ongoing maintenance.

> [!WARNING]
> This fork relies heavily on vibe coding. Logic changes are manually reviewed, and tests are also written by AI under human direction before the full test gate is run.
>
> Almost none of the code in this fork is handwritten by xz-dev. Do not use this distribution if you are uncomfortable with AI-assisted development.

## Downstream changes

### Features

- Detach eligible long-running AI tool calls into session-owned managed executions, with `tool_task` controls for status, bounded waits, and cancellation requests while preserving exactly one result for each original tool call.
  - Use case: Let Pi continue reasoning while opted-in shell or extension work runs, without turning untrusted tool output into a steering message or losing cancellation/lifecycle ownership.
  - Patch branch: [`patch/managed-tool-executions`](https://github.com/xz-dev/pi/tree/patch/managed-tool-executions)
- Continue from the nearest protocol-safe conversation boundary with `/retry` or RPC `retry`, preserving superseded history as an append-only sibling branch, retaining completed tool results, and synthesizing explicit unknown-outcome errors only for missing results without replaying old tool calls.
  - Use case: Resume after Pi or its provider was interrupted, without replaying completed tool calls.
  - Patch branch: [`patch/manual-retry`](https://github.com/xz-dev/pi/tree/patch/manual-retry)
- Support per-package Skill visibility overrides through `skillOverrides.<name>.disableModelInvocation`, retaining manual `/skill:<name>` invocation and project-over-global precedence.
  - Use case: Keep a skill available to `/skill:<name>` while preventing automatic model invocation.
  - Patch branch: [`patch/skill-overrides`](https://github.com/xz-dev/pi/tree/patch/skill-overrides)
- Allow `settings.retry.nonRetryableErrorPatterns` to fail-fast on gateway-specific terminal quota/limit error messages without expanding the built-in retry classifier.
  - Use case: Stop retrying when a gateway returns a known terminal quota or limit message.
  - Patch branch: [`patch/retry-non-retryable-patterns`](https://github.com/xz-dev/pi/tree/patch/retry-non-retryable-patterns)
- Show awaited extension handlers exceeding `slowHookThresholdMs` only in interactive TUI, with synchronous handlers in warning yellow and asynchronous handlers in default gray. During shutdown, show the current handler while waiting, clear fast handlers, and keep slow handlers on the terminal without writing timing diagnostics to session history, model context, RPC/print events, or disk.
  - Use case: Diagnose slow extension hooks without persisting diagnostic records.
  - Patch branch: [`patch/slow-hook-tui-only`](https://github.com/xz-dev/pi/tree/patch/slow-hook-tui-only)
- Expose public `pi.spliceEntry(entryId)` so an extension can delete one non-root session-tree node and reparent its children, preserving descendants.
  - Use case: Remove a hidden watchdog decision node from session history without deleting later conversation descendants.
  - Patch branch: [`patch/session-tree-splice`](https://github.com/xz-dev/pi/tree/patch/session-tree-splice)

### Fixes

- Fix standalone extension installation and updates failing when an external package manager is unavailable by using the Bun embedded in the xz-dev bundle. Explicit `npmCommand` settings take precedence; otherwise package operations use public `pi` on `PATH`, without separately installing Node.js, npm, or Bun.
  - Use case: Install a Git extension with runtime dependencies on a machine that only has Pi and Git. Managed npm updates retain version selectors and exact pins. If metadata lookup fails, Pi warns about possible downgrade and continues; successful queries still skip equal or older targets.
  - Limits: Official Bun 1.4.2 requires a project manifest for metadata queries. Registry configuration, lockfiles, dependency scripts, and native modules are not guaranteed to behave like npm; Pi does not broaden script trust or install native build tools automatically.
  - Details: [Package-manager selection](packages/coding-agent/docs/packages.md#package-manager-selection)
  - Patch branch: [`patch/use-embedded-bun-package-manager`](https://github.com/xz-dev/pi/tree/patch/use-embedded-bun-package-manager)
- Send the full request instead of a cached OpenAI Codex Responses WebSocket continuation when the input delta is empty.
  - Use case: Retry an unchanged request without reusing a stale continuation that contains no new input.
  - Patch branch: [`patch/ws-cached-empty-delta`](https://github.com/xz-dev/pi/tree/patch/ws-cached-empty-delta)
- Wait for extension-provider registration refreshes before startup resolves configured models, while preserving synchronous registration and caller-owned cancellation.
  - Use case: Start with models an extension registered asynchronously instead of resolving a stale catalog.
  - Patch branch: [`patch/model-startup-refresh-barrier`](https://github.com/xz-dev/pi/tree/patch/model-startup-refresh-barrier)
- Rebind active and scoped sessions to refreshed same-ID model metadata so context percentages and automatic compaction use the current context window.
  - Use case: Keep context percentages and compaction limits correct after a provider refreshes model metadata.
  - Patch branch: [`patch/model-refresh-session-rebind`](https://github.com/xz-dev/pi/tree/patch/model-refresh-session-rebind)
- Add `--refresh` to `pi --list-models` so the command loads extension providers, force-refreshes every loaded catalog, then prints refreshed models while preserving cached entries for failed providers. Keep `pi update --models` extension-free for Pi-managed catalog maintenance.
  - Use case: Refresh and inspect a third-party provider's latest model list from one non-interactive CLI command.
  - Patch branch: [`patch/model-catalog-extension-refresh`](https://github.com/xz-dev/pi/tree/patch/model-catalog-extension-refresh)
- [earendil-works/pi#6234](https://github.com/earendil-works/pi/issues/6234): make Esc abort recover from lifecycle hooks, extension hooks, provider setup, provider streams, or listener dispatch that never settle.
  - Use case: Recover control when Esc is pressed during a hook, provider setup, stream, or listener that does not settle.
  - Patch branch: [`patch/esc-abort`](https://github.com/xz-dev/pi/tree/patch/esc-abort)
- Refuse `pi update --self` for channel-managed installations. A package manager marks its install by writing an empty `.<channel>.managed.lock` file next to the executable; `pi update --self` detects any `*.managed.lock` marker before any release lookup, refuses to replace the binary offline, and points the user at the owning channel.
  - Use case: Stop Scoop or a Gentoo ebuild install from fighting the package manager's own upgrades, while keeping the direct-download Release zip channel-neutral.
  - Patch branch: [`patch/self-update-managed-by`](https://github.com/xz-dev/pi/tree/patch/self-update-managed-by)
- Keep the Google Generative AI `TOO_MANY_TOOL_CALLS` finish reason mapped to the error stop reason. Upstream [earendil-works/pi#9502](https://github.com/earendil-works/pi/issues/9502) removed the exhaustive-switch case that the `@google/genai` 2.21.0 upgrade added, breaking `mapStopReason` compilation; this patch restores it until upstream fixes its own build.
  - Use case: Keep upstream sync and release builds green when upstream main cannot compile.
  - Temporary: Retire once upstream restores the case; the empty-integration guard then fails the sync and retirement is manual.
  - Patch branch: [`patch/google-toomany-toolcalls`](https://github.com/xz-dev/pi/tree/patch/google-toomany-toolcalls)

The Esc and manual-retry patches share [`patch/agent-run-failure-seam`](https://github.com/xz-dev/pi/tree/patch/agent-run-failure-seam). Managed tool executions are integrated before those two patches; the `ci` overlay owns their narrowly scoped conflict handling. See [downstream maintenance](MAINTAIN.md) for the current integration rules.

### Temporarily disabled

- `patch/tui-synchronized-cursor-fleet` is temporarily retired from generated `main`. Its synchronized-output implementation can emit excessive terminal data and now conflicts with upstream's bounded main-screen writer. The source branch remains retained for a corrected design and independent validation; do not mask the product conflict with a CI resolver.

### Removed patches

- Provider-transparent Responses remote compaction and its dependent pre-provider compaction patch have been removed, and both source branches have been permanently deleted. Classic compaction remains the default path. A third-party extension such as [`@ogulcancelik/pi-codex-compaction`](https://github.com/ogulcancelik/pi-extensions) can provide Codex-native remote compaction without adding provider-specific behavior to core.

### Maintenance

- Keep the fork/pre-release changelog baseline, display, and version handling correct across downstream release cycles.
  - Use case: Keep downstream prerelease display and changelog lookup correct when package and release versions differ.
  - Patch branch: [`patch/changelog-prerelease`](https://github.com/xz-dev/pi/tree/patch/changelog-prerelease)
- Remove old managed binary bundles with `pi update --clean` while keeping the current bundle and `.update-*` staging directories.
  - Use case: Free disk after several `pi update --self` cycles without deleting the active version or an in-progress update.
  - Patch branch: [`patch/update-clean`](https://github.com/xz-dev/pi/tree/patch/update-clean)

## Installation

xz-dev Pi is distributed through immutable [GitHub Releases](https://github.com/xz-dev/pi/releases). Each Release ships 12 ZIP bundles: Darwin x64 baseline/modern and arm64; Linux GNU and musl x64 baseline/modern and arm64; and Windows x64 baseline/modern and arm64. The x64 `baseline` and `modern` names are compatibility aliases for the same runtime-dispatched Bun target; they no longer select separate AVX2 and baseline implementations. On Linux, choose `gnu` for glibc systems and `musl` for musl systems. Each ZIP contains `pi` plus `pi-native` (`.exe` on Windows) and all version-matched runtime assets. No Node.js, Bun, npm, package manager, or generated installer script is required.

Keep the extracted ZIP contents together; the launcher alone is not a single-file distribution. Linux clipboard support follows upstream: the native X11 helper uses the system's `libxcb.so.1` and an available X11 display. Their absence does not prevent basic CLI or TUI startup; clipboard availability and fallback tools depend on the desktop environment.

### Linux and macOS

```bash
# Download the matching pi-<target>.zip from the latest Release, then:
unzip pi-<target>.zip -d pi
chmod +x pi/pi pi/pi-native
./pi/pi --version
```

### Windows Scoop

```powershell
$scoopRoot = (Resolve-Path (Join-Path (scoop prefix scoop) '..\..\..')).Path
$bucket = Join-Path $scoopRoot 'buckets\xz-dev'
git clone --branch scoop --single-branch https://github.com/xz-dev/pi.git $bucket
scoop install xz-dev/pi
```

Scoop installs the x64 `modern` asset, or the native arm64 asset on Windows arm64. The x64 asset uses the same runtime-dispatched Bun target as the `baseline` alias. Update with `scoop update pi`.

The Scoop install writes an empty `.scoop.managed.lock` next to the executable, so `pi update --self` refuses and points at `scoop update pi` instead; scoop owns the upgrade. Direct ZIP downloads carry no lock file and keep self-update enabled.

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

Extension updates are separate:

```bash
pi update --extensions
```

For standalone extension operations, keep public `pi` on `PATH`; launching by absolute path alone does not satisfy this requirement. Git sources also require Git. See [package-manager selection](packages/coding-agent/docs/packages.md#package-manager-selection) for overrides and compatibility limits.

The first update converts the extracted directory into a managed layout: the complete ZIP is staged under `bundles/<version>`, then `current` is atomically replaced. On POSIX, the root wrapper is also atomically refreshed. On Windows, `pi.exe` remains stable, waits for `pi-native.exe`, and returns its exit status without overwriting the running wrapper. A new invocation reads `current` and starts the activated bundle.

`pi update --clean` keeps only `bundles/<current>`, deletes other ordinary bundle directories and the top-level `previous` pointer, and leaves `.update-*` staging directories untouched.

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

Before a lease-protected update of `main`, the workflow installs dependencies, hydrates model data, builds, checks, runs focused integration regressions, validates the exact GitHub Release candidate, audits production and development dependencies, and verifies production dependency signatures. Conflicts, empty integrations, failed blocking gates, or a changed remote lease leave `main` unchanged. Dependency audits and production signature checks are currently advisory (`continue-on-error`); their failure alone does not block the rebuild. A successful push triggers the full [CI](https://github.com/xz-dev/pi/actions/workflows/ci.yml), [Esc Abort Integration](https://github.com/xz-dev/pi/actions/workflows/esc-abort-integration.yml), and [Publish GitHub Release](https://github.com/xz-dev/pi/actions/workflows/publish-github-release.yml) workflows for the rebuilt commit.
