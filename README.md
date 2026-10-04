# xz-dev/pi

This is a downstream distribution fork of [earendil-works/pi](https://github.com/earendil-works/pi).

Release platforms (one `pi-<target>.zip` each, see [Installation](#installation)):

| OS | Release assets |
| --- | --- |
| Linux glibc | `linux-x64-gnu-baseline`, `linux-x64-gnu-modern`, `linux-arm64-gnu` |
| Linux musl | `linux-x64-musl-baseline`, `linux-x64-musl-modern`, `linux-arm64-musl` |
| macOS | `darwin-x64-baseline`, `darwin-x64-modern`, `darwin-arm64` |
| Windows | `windows-x64-baseline`, `windows-x64-modern`, `windows-arm64` |
| FreeBSD 14.3+ | `freebsd-x64`, `freebsd-arm64` |

> [!NOTE]
> 🌟 Star this fork to show your support for its direction and encourage change in upstream Pi.

It tracks upstream `main` with a minimal downstream patch stack, using [downstream-fork-maintain-skill](https://github.com/xz-dev/downstream-fork-maintain-skill) as the blueprint for ongoing maintenance.

> [!WARNING]
> This fork relies heavily on vibe coding. Logic changes are manually reviewed, and tests are also written by AI under human direction before the full test gate is run.
>
> Almost none of the code in this fork is handwritten by xz-dev. Do not use this distribution if you are uncomfortable with AI-assisted development.

## Downstream changes

### Features

- Let extensions inspect and clear a Codex session's sticky SSE fallback through `getOpenAICodexWebSocketDebugStatsLazy(sessionId)` and `resetOpenAICodexWebSocketDebugStatsLazy(sessionId?)` from `@earendil-works/pi-ai/compat` (also exposed by the extension runtime's `pi-ai` alias).
  - Use case: An extension can re-enable WebSocket attempts after a transient socket or proxy failure without restarting the Pi session.
  - Limits: Recovery is opt-in and extension-controlled. Pi adds no automatic retry or cooldown; reset also clears debug counters, and omitting the session ID resets all sessions.
  - Patch branch: [`patch/codex-websocket-recovery`](https://github.com/xz-dev/pi/tree/patch/codex-websocket-recovery)

- Run the native FreeBSD amd64 and arm64 executables with CLI, TUI, extension loading, self-update, and cleanup of obsolete backup copies.
  - Use case: Use Pi on FreeBSD without a Linux compatibility layer or a separately installed JavaScript runtime.
  - Limits: FreeBSD 14.3 or newer. The arm64 ZIP is accepted in an emulated (QEMU TCG) guest because GitHub has no arm64 KVM host. Install `fd-find` and `ripgrep` for find/grep tools. X11 clipboard reads require `libxcb`; Wayland uses `wl-clipboard`, and SSH/headless copy uses OSC 52.
  - Patch branches: [`patch/freebsd-support`](https://github.com/xz-dev/pi/tree/patch/freebsd-support), [`patch/single-executable`](https://github.com/xz-dev/pi/tree/patch/single-executable)
- Detach eligible long-running AI tool calls into session-owned managed executions, with `tool_task` controls for status, bounded waits, and cancellation requests while preserving exactly one result for each original tool call.
  - Use case: Let Pi continue reasoning while opted-in shell or extension work runs, without turning untrusted tool output into a steering message or losing cancellation/lifecycle ownership.
  - Patch branch: [`patch/managed-tool-executions`](https://github.com/xz-dev/pi/tree/patch/managed-tool-executions)
- Continue from the nearest protocol-safe conversation boundary with `/retry` or RPC `retry`, preserving superseded history as an append-only sibling branch, retaining completed tool results, and synthesizing explicit unknown-outcome errors only for missing results without replaying old tool calls.
  - Use case: Resume after Pi or its provider was interrupted, without replaying completed tool calls.
  - Patch branch: [`patch/manual-retry`](https://github.com/xz-dev/pi/tree/patch/manual-retry)
- Keep input in the editor until interactive startup has bound the session and rendered its history. An early Enter shows `Startup is still in progress`; press Enter again after startup to submit `/retry` or an ordinary prompt. Custom editors receive the same submit handler.
  - Use case: Press `/retry` immediately after `pi -c` without losing the native Working indication when the resumed response streams.
  - Patch branch: [`patch/startup-submit-readiness`](https://github.com/xz-dev/pi/tree/patch/startup-submit-readiness)
- Support per-package Skill visibility overrides through `skillOverrides.<name>.disableModelInvocation`, retaining manual `/skill:<name>` invocation and project-over-global precedence.
  - Use case: Keep a skill available to `/skill:<name>` while preventing automatic model invocation.
  - Patch branch: [`patch/skill-overrides`](https://github.com/xz-dev/pi/tree/patch/skill-overrides)
- Allow `settings.retry.nonRetryableErrorPatterns` to fail-fast on gateway-specific terminal quota/limit error messages without expanding the built-in retry classifier.
  - Use case: Stop retrying when a gateway returns a known terminal quota or limit message.
  - Patch branch: [`patch/retry-non-retryable-patterns`](https://github.com/xz-dev/pi/tree/patch/retry-non-retryable-patterns)
- Show awaited extension handlers exceeding `slowSyncHookThresholdMs` (plain-value handlers) or `slowAsyncHookThresholdMs` (promise-returning handlers) only in interactive TUI, with synchronous handlers in warning yellow and asynchronous handlers in default gray. During shutdown, show the current handler while waiting, clear fast handlers, and keep slow handlers on the terminal without writing timing diagnostics to session history, model context, RPC/print events, or disk. Both thresholds default to `-1` (disabled); set a value `>= 0` in `settings.json` to opt in.
  - Use case: Diagnose slow extension hooks without persisting diagnostic records.
  - Patch branch: [`patch/slow-hook-tui-only`](https://github.com/xz-dev/pi/tree/patch/slow-hook-tui-only)
- Hide `[Skill conflicts]` / `[Prompt conflicts]` / `[Extension issues]` / `[Theme conflicts]` startup diagnostic blocks by default; enable them with `showStartupDiagnostics: true` in `settings.json`.
  - Use case: Keep the startup screen clean unless actively debugging resource conflicts or extension loading issues.
  - Patch branch: [`patch/slow-hook-tui-only`](https://github.com/xz-dev/pi/tree/patch/slow-hook-tui-only)
- Set `LC_ALL=C.UTF-8`, `LANG=C.UTF-8`, `LANGUAGE=en` at startup so tools, MCP servers, and extension subprocesses run with an English locale while Pi's own UI locale stays unchanged. Override with global `envOverrides` (`KEY=VALUE` list, replaces the default); `[]` disables.
  - Use case: Keep tool output the model reads in English on a non-English desktop.
  - Patch branch: [`patch/env-overrides`](https://github.com/xz-dev/pi/tree/patch/env-overrides)
- In fullscreen mode, the input toggle and automatic dock collapse follow the same scrollback state as `Jump to latest message`. Each visit starts collapsed: the standard editor retains one editable draft line between its borders, while completion menus, selectors, and custom panels such as ask are hidden without resetting their state. Use `Expand input` / `Collapse input` beside Jump to change the layout without leaving scrollback. On narrow terminals the toggle appears above Jump. Resizing and incoming output retain the choice; returning to latest restores the full dock.
  - Use case: Read history while an ask questionnaire is open, then expand it or return to latest to continue with the saved answers.
  - Limits: Hidden panels do not receive typing, Enter, or right-click paste. Stacked controls need at least two terminal rows; short layouts may clip editor borders to keep both controls visible.
  - Patch branch: [`patch/compact-input-dock`](https://github.com/xz-dev/pi/tree/patch/compact-input-dock)
- List models with a configured override first in `/settings` -> Default thinking level per model, with configured and unconfigured models each sorted by `provider/model-id`; the current model is preselected instead of pinned to the top.
  - Use case: See and edit saved per-model thinking levels without scanning the whole model list.
  - Patch branch: [`patch/model-thinking-sort`](https://github.com/xz-dev/pi/tree/patch/model-thinking-sort)

### Fixes

- Defer automatic threshold and successful-response overflow compaction until another model request needs the context. Completed idle replies do not generate an unused summary; tool-loop compaction, extension/queued continuations, manual `/compact`, and immediate overflow/length retry recovery remain supported. No new setting is required.
  - Use case: Stop after an answer without paying for a summary that would only be useful if the session continued.
  - Details: [Automatic compaction](packages/coding-agent/docs/compaction.md#when-it-triggers)
  - Patch branch: [`patch/defer-threshold-compaction`](https://github.com/xz-dev/pi/tree/patch/defer-threshold-compaction)

- Fix standalone extension installation and updates failing when an external package manager is unavailable by using the Bun embedded in the xz-dev bundle. Explicit `npmCommand` settings take precedence; otherwise package operations spawn the running Pi executable itself, so they work when Pi is launched by absolute path without `pi` on `PATH`, and without separately installing Node.js, npm, or Bun.
  - Use case: Install a Git extension with runtime dependencies on a machine that only has Pi and Git. Managed npm updates retain version selectors and exact pins. If metadata lookup fails, Pi warns about possible downgrade and continues; successful queries still skip equal or older targets.
  - Limits: Official Bun 1.4.2 requires a project manifest for metadata queries. Registry configuration, lockfiles, dependency scripts, and native modules are not guaranteed to behave like npm; Pi does not broaden script trust or install native build tools automatically.
  - Details: [Package-manager selection](packages/coding-agent/docs/packages.md#package-manager-selection)
  - Patch branch: [`patch/single-executable`](https://github.com/xz-dev/pi/tree/patch/single-executable)
- Send the full request instead of a cached OpenAI Codex Responses WebSocket continuation when the input delta is empty.
  - Use case: Retry an unchanged request without reusing a stale continuation that contains no new input.
  - Patch branch: [`patch/ws-cached-empty-delta`](https://github.com/xz-dev/pi/tree/patch/ws-cached-empty-delta)
- Wait for extension-provider registration refreshes before startup resolves configured models, while preserving synchronous registration and caller-owned cancellation.
  - Use case: Start with models an extension registered asynchronously instead of resolving a stale catalog.
  - Patch branch: [`patch/model-refresh`](https://github.com/xz-dev/pi/tree/patch/model-refresh)
- Rebind active and scoped sessions to refreshed same-ID model metadata so context percentages and automatic compaction use the current context window.
  - Use case: Keep context percentages and compaction limits correct after a provider refreshes model metadata.
  - Patch branch: [`patch/model-refresh-session-rebind`](https://github.com/xz-dev/pi/tree/patch/model-refresh-session-rebind)
- Add `--refresh` to `pi --list-models` so the command loads extension providers, force-refreshes every loaded catalog, then prints refreshed models while preserving cached entries for failed providers. Keep `pi update --models` extension-free for Pi-managed catalog maintenance.
  - Use case: Refresh and inspect a third-party provider's latest model list from one non-interactive CLI command.
  - Patch branch: [`patch/model-refresh`](https://github.com/xz-dev/pi/tree/patch/model-refresh)
- [earendil-works/pi#6234](https://github.com/earendil-works/pi/issues/6234): make Esc abort recover from lifecycle hooks, extension hooks, provider setup, provider streams, or listener dispatch that never settle.
  - Use case: Recover control when Esc is pressed during a hook, provider setup, stream, or listener that does not settle.
  - Patch branch: [`patch/esc-abort`](https://github.com/xz-dev/pi/tree/patch/esc-abort)
- Refuse `pi update --self` for channel-managed installations. A package manager marks its install by writing an empty `.<channel>.managed.lock` file next to the executable; `pi update --self` detects any `*.managed.lock` marker before any release lookup, refuses to replace the binary offline, and points the user at the owning channel.
  - Use case: Stop Scoop or a Gentoo ebuild install from fighting the package manager's own upgrades, while keeping the direct-download Release executable channel-neutral.
  - Patch branch: [`patch/single-executable`](https://github.com/xz-dev/pi/tree/patch/single-executable)
- Preserve the `/model` picker's highlighted row when a background model catalog refresh completes while the picker is open. The selection is restored by provider and model id after the list rebuild; a removed model falls back to the existing current-model highlight. Mirrors the scoped-models selector behavior.
  - Use case: Browse the model list and press refresh-in-progress without the cursor snapping back to the first row mid-selection.
  - Patch branch: [`patch/model-selector-refresh-selection`](https://github.com/xz-dev/pi/tree/patch/model-selector-refresh-selection)
- Drop user and assistant messages whose content is empty or whitespace-only in `transformMessages`, the choke point shared by every provider converter. Tool results, assistant messages with tool calls, and blocks carrying thinking/text signatures are always kept.
  - Use case: Extension-injected custom messages (for example watchdog inquiry fold markers) become empty user messages that some providers reject, e.g. Gemini `contents.parts must not be empty`.
  - Patch branch: [`patch/ai-drop-empty-messages`](https://github.com/xz-dev/pi/tree/patch/ai-drop-empty-messages)

The Esc and manual-retry patches share [`patch/agent-run-failure-seam`](https://github.com/xz-dev/pi/tree/patch/agent-run-failure-seam). Managed tool executions are integrated before those two patches, and `patch/esc-abort` carries the managed-execution abort drain. See [downstream maintenance](MAINTAIN.md) for the current integration rules.

### Temporarily disabled

- `patch/tui-synchronized-cursor-fleet` is temporarily retired from generated `main`. Its synchronized-output implementation can emit excessive terminal data and now conflicts with upstream's bounded main-screen writer. The source branch remains retained for a corrected design and independent validation; do not mask the product conflict with a CI resolver.

### Removed patches

- Provider-transparent Responses remote compaction and its dependent pre-provider compaction patch have been removed, and both source branches have been permanently deleted. Classic compaction remains the default path. A third-party extension such as [`@ogulcancelik/pi-codex-compaction`](https://github.com/ogulcancelik/pi-extensions) can provide Codex-native remote compaction without adding provider-specific behavior to core.
- The remote-client run-end wait patch has been retired: upstream now waits on `run_end`/`run_suspend` operation boundaries before resolving an accepted prompt response (`operationBoundaries`/`boundaryWaiters` in `packages/coding-agent/src/experimental/client.ts`), which covers the same transcript-lifecycle guarantee without a timeout heuristic. The source branch is kept as `retired/remote-client-run-end-wait`.

### Maintenance

- Keep the fork/pre-release changelog baseline, display, and version handling correct across downstream release cycles.
  - Use case: Keep downstream prerelease display and changelog lookup correct when package and release versions differ.
  - Patch branch: [`patch/single-executable`](https://github.com/xz-dev/pi/tree/patch/single-executable)
- Remove old executable backups with `pi update --clean`. Only regular files named exactly `pi-<distribution version>` (`.exe` on Windows) next to the running executable are deleted; the running executable, symlinks, directories, and other files are left alone, and files that cannot be deleted (for example a still-running backup on Windows) are kept and reported.
  - Use case: Free disk after several `pi update --self` cycles.
  - Patch branch: [`patch/single-executable`](https://github.com/xz-dev/pi/tree/patch/single-executable)

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

### Update

An installed executable updates itself from the matching `pi-<target>.zip`:

```bash
pi update --self
```

Extension updates are separate:

```bash
pi update --extensions
```

Standalone extension operations spawn the running executable itself, so public `pi` on `PATH` is not required. Git sources also require Git. See [package-manager selection](packages/coding-agent/docs/packages.md#package-manager-selection) for overrides and compatibility limits.

On update, the running executable moves itself to a strict-version backup `pi-<old-version>` (`pi-<old-version>.exe` on Windows), downloads and sha256-verifies the new ZIP, extracts and verifies the executable inside it, then atomically replaces the public path. A stale backup is refreshed by downloading the matching old asset on the next update. `pi update --clean` removes only `pi-<version>` backups whose names match an exact semver; any other file next to the executable is left untouched.

Installations from releases up to `xz-v1.0.0-xz.253` (raw `pi-<target>` downloads) cannot self-update onto ZIP releases: their updater only knows the raw asset and reports an invalid manifest. Reinstall once by downloading and extracting the current `pi-<target>.zip` over the old `pi`; later updates work with `pi update --self` again. Older ZIP bundle installations (`pi` + `pi-native` + loose assets) need the same one-time reinstall and should delete the old extracted directory.

### Building without the native X11 helper

For package-manager builds such as Gentoo `USE=-X`, pass `--without-x11` to `scripts/build-binaries.sh`. Linux and FreeBSD executables then omit the native X11 clipboard helper; musl builds also no longer need `--clipboard-musl-dir`. The default build and macOS/Windows native helpers are unchanged. This option does not disable command-line clipboard fallbacks such as `wl-paste` or `xclip`.

```bash
bash scripts/build-binaries.sh --platform linux-x64-gnu-baseline --without-x11
```

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
