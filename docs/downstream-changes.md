# Downstream changes

Complete reference for every patch branch integrated into this fork, grouped by topic. Each entry lists its use case, limits, and patch branch. For a short highlight list see the [README](../README.md#downstream-changes). For branch ownership and rebuild rules see [MAINTAIN.md](../MAINTAIN.md).

## Distribution and self-update

The single-executable bundle, update verification, and packaging fixes.

- Single-file executable with embedded Bun runtime (JIT); the extracted `pi` is the complete product, no Node.js, npm, or companion binary required.
  - Use case: Run Pi by downloading and extracting one ZIP, on a machine with no JavaScript tooling.
  - Patch branch: [`patch/single-executable`](https://github.com/xz-dev/pi/tree/patch/single-executable)
- Run the native FreeBSD amd64 and arm64 executables with CLI, TUI, extension loading, self-update, and cleanup of obsolete backup copies.
  - Use case: Use Pi on FreeBSD without a Linux compatibility layer or a separately installed JavaScript runtime.
  - Limits: FreeBSD 14.3 or newer. The arm64 ZIP is accepted in an emulated (QEMU TCG) guest because GitHub has no arm64 KVM host. Install `fd-find` and `ripgrep` for find/grep tools. X11 clipboard reads require `libxcb`; Wayland uses `wl-clipboard`, and SSH/headless copy uses OSC 52.
  - Patch branches: [`patch/freebsd-support`](https://github.com/xz-dev/pi/tree/patch/freebsd-support), [`patch/single-executable`](https://github.com/xz-dev/pi/tree/patch/single-executable)
- Keep the fork/pre-release changelog baseline, display, and version handling correct across downstream release cycles.
  - Use case: Keep downstream prerelease display and changelog lookup correct when package and release versions differ.
  - Patch branch: [`patch/single-executable`](https://github.com/xz-dev/pi/tree/patch/single-executable)
- Refuse `pi update --self` for channel-managed installations. A package manager marks its install by writing an empty `.<channel>.managed.lock` file next to the executable; `pi update --self` detects any `*.managed.lock` marker before any release lookup, refuses to replace the binary offline, and points the user at the owning channel.
  - Use case: Stop Scoop or a Gentoo ebuild install from fighting the package manager's own upgrades, while keeping the direct-download Release executable channel-neutral.
  - Patch branch: [`patch/single-executable`](https://github.com/xz-dev/pi/tree/patch/single-executable)
- Remove old executable backups with `pi update --clean`. Only regular files named exactly `pi-<distribution version>` (`.exe` on Windows) next to the running executable are deleted; the running executable, symlinks, directories, and other files are left alone, and files that cannot be deleted (for example a still-running backup on Windows) are kept and reported.
  - Use case: Free disk after several `pi update --self` cycles.
  - Patch branch: [`patch/single-executable`](https://github.com/xz-dev/pi/tree/patch/single-executable)
- Fix standalone extension installation and updates failing when an external package manager is unavailable by using the Bun embedded in the xz-dev bundle. Explicit `npmCommand` settings take precedence; otherwise package operations spawn the running Pi executable itself, so they work when Pi is launched by absolute path without `pi` on `PATH`, and without separately installing Node.js, npm, or Bun.
  - Use case: Install a Git extension with runtime dependencies on a machine that only has Pi and Git. Managed npm updates retain version selectors and exact pins. If metadata lookup fails, Pi warns about possible downgrade and continues; successful queries still skip equal or older targets.
  - Limits: Official Bun 1.4.2 requires a project manifest for metadata queries. Registry configuration, lockfiles, dependency scripts, and native modules are not guaranteed to behave like npm; Pi does not broaden script trust or install native build tools automatically.
  - Details: [Package-manager selection](../packages/coding-agent/docs/packages.md#package-manager-selection)
  - Patch branch: [`patch/single-executable`](https://github.com/xz-dev/pi/tree/patch/single-executable)

## Retry and recovery

Manual and automatic retry of interrupted work, plus transport-level recovery.

- Continue from the nearest protocol-safe conversation boundary with `/retry` or RPC `retry`, preserving superseded history as an append-only sibling branch, retaining completed tool results, and synthesizing explicit unknown-outcome errors only for missing results without replaying old tool calls.
  - Use case: Resume after Pi or its provider was interrupted, without replaying completed tool calls.
  - Patch branch: [`patch/manual-retry`](https://github.com/xz-dev/pi/tree/patch/manual-retry)
- Recover once on interactive cold startup, such as `pi -c` or `pi --session`, when the current conversation tail has a safe retry boundary and no new input takes priority. Old sessions and exhausted-error tails can recover without a `started` record. Pending recovery shows `This session will automatically run /retry shortly.`; otherwise idle retryable sessions show a dim `/retry` hint, clickable in fullscreen with `(click to run)`.
  - Use case: Continue interrupted work after restarting Pi, or click the hint to retry manually without losing an editor draft.
  - Limits: Explicit user cancellation, natural completion, and output-limit endings do not auto-recover; in-process `/resume` does not trigger recovery. New input takes priority, including during authentication. Esc or Ctrl+C cancels pending recovery durably, and startup navigation cannot redirect it to another branch. Runtime error-retry limits and backoff are unchanged. Concurrent writers to one session file and exactly-once external tool effects are not guaranteed.
  - Details: [Interrupted work](../packages/coding-agent/docs/sessions.md#retry-interrupted-work)
  - Patch branch: [`patch/cold-start-retry`](https://github.com/xz-dev/pi/tree/patch/cold-start-retry)
- Keep input in the editor until interactive startup has bound the session and rendered its history. An early Enter shows `Startup is still in progress`; press Enter again after startup to submit `/retry` or an ordinary prompt. Custom editors receive the same submit handler.
  - Use case: Press `/retry` immediately after `pi -c` without losing the native Working indication when the resumed response streams.
  - Patch branch: [`patch/startup-submit-readiness`](https://github.com/xz-dev/pi/tree/patch/startup-submit-readiness)
- Recover Codex WebSocket transport after transient failures, then resume incremental context instead of leaving the session permanently on SSE.
  - `auto`: Make an initial WS attempt plus three fixed retries using Pi's global backoff (2, 4, and 8 seconds by default), even when ordinary retry is disabled. If these fail, use SSE with a fresh full global retry budget.
  - Recovery: After five minutes on SSE, the next real request starts one logical WS probe. Transport failure renews the cooldown; success sends full context once on a fresh socket, then later requests can use deltas again. Probes never run in the background.
  - Explicit `websocket` and `websocket-cached` never downgrade; they follow the global retry settings. Failed partial output is kept in history but omitted from automatic retry context.
  - Use case: Recover from a socket or proxy interruption without restarting Pi or repeatedly sending full context after WebSocket recovery.
  - Limits: Logical attempts may include existing bounded protocol repairs before output. SDK callers need a stable `sessionId` and an outer retry owner for the same policy; sessionless SDK calls retain their prior behavior.
  - Extensions can still inspect/reset session recovery state through `getOpenAICodexWebSocketDebugStatsLazy(sessionId)` and `resetOpenAICodexWebSocketDebugStatsLazy(sessionId?)` from `@earendil-works/pi-ai/compat` (or `pi-ai` in the extension runtime). Reset also clears counters; omitting the ID resets all sessions.
  - Details: [Network and retries](../packages/coding-agent/docs/settings.md#network-and-retries)
  - Patch branch: [`patch/codex-websocket-recovery`](https://github.com/xz-dev/pi/tree/patch/codex-websocket-recovery)
- Allow `settings.retry.nonRetryableErrorPatterns` to fail-fast on gateway-specific terminal quota/limit error messages without expanding the built-in retry classifier.
  - Use case: Stop retrying when a gateway returns a known terminal quota or limit message.
  - Patch branch: [`patch/retry-non-retryable-patterns`](https://github.com/xz-dev/pi/tree/patch/retry-non-retryable-patterns)
- Send the full request instead of a cached OpenAI Codex Responses WebSocket continuation when the input delta is empty.
  - Use case: Retry an unchanged request without reusing a stale continuation that contains no new input.
  - Patch branch: [`patch/ws-cached-empty-delta`](https://github.com/xz-dev/pi/tree/patch/ws-cached-empty-delta)
- Show transient assistant connection failures as recovery attempts while Pi's global retry policy runs, instead of copying the same provider error into every unexecuted tool preview. A successful retry continues normally; exhausted retries, non-retryable errors, and cancellation remain visible without pretending the previewed tools executed.
  - Use case: Recover from a Responses WebSocket disconnect after tool calls have started streaming without seeing a separate false failure for each tool. Cancelling during retry backoff remains visible after transcript redraw or session resume; its saved display record never enters model context.
  - Limits: This changes interactive error presentation, not retry classification, attempt limits, backoff, transport fallback, or real tool execution results.
  - Patch branch: [`patch/retry-error-presentation`](https://github.com/xz-dev/pi/tree/patch/retry-error-presentation)
- [earendil-works/pi#6234](https://github.com/earendil-works/pi/issues/6234): make Esc abort recover from lifecycle hooks, extension hooks, provider setup, provider streams, or listener dispatch that never settle.
  - Use case: Recover control when Esc is pressed during a hook, provider setup, stream, or listener that does not settle.
  - Patch branch: [`patch/esc-abort`](https://github.com/xz-dev/pi/tree/patch/esc-abort)

## TUI and display

Presentation-only changes: layout, selectors, thinking display, startup screen.

- Preview thinking in one scrolling line by default, following the newest text without growing the transcript. Preview rows render Markdown styles and retain the same tail when thinking ends. When earlier content is hidden, `… (N chars)` reports the omitted visible characters; narrow terminals can reduce the hint to `…`. `Ctrl+T` cycles preview, full text, and static-folded styles; `Ctrl+O` also expands or folds thinking with tool output.
  - Use case: Keep the latest reasoning next to the following tool call or answer, and open the full reasoning only when needed.
  - Limits: Fullscreen mouse clicks toggle individual thinking blocks during or after streaming, and their state survives completion. A later global display action reapplies its state. Regular terminal mode uses keyboard controls and leaves mouse selection to the terminal. This changes presentation, not the model's thinking effort or saved reasoning.
  - Details: [Thinking display settings](../packages/coding-agent/docs/settings.md#model-and-thinking), [Keybindings](../packages/coding-agent/docs/keybindings.md#models-and-thinking)
  - Patch branch: [`patch/thinking-preview`](https://github.com/xz-dev/pi/tree/patch/thinking-preview)
- In fullscreen mode, the input toggle and automatic dock collapse follow the same scrollback state as `Jump to latest message`. Each visit starts collapsed: the standard editor retains one editable draft line between its borders, while completion menus, selectors, and custom panels such as ask are hidden without resetting their state. Use `Expand input` / `Collapse input` beside Jump to change the layout without leaving scrollback. On narrow terminals the toggle appears above Jump. Resizing and incoming output retain the choice; returning to latest restores the full dock.
  - Use case: Read history while an ask questionnaire is open, then expand it or return to latest to continue with the saved answers.
  - Limits: Hidden panels do not receive typing, Enter, or right-click paste. Stacked controls need at least two terminal rows; short layouts may clip editor borders to keep both controls visible.
  - Patch branch: [`patch/compact-input-dock`](https://github.com/xz-dev/pi/tree/patch/compact-input-dock)
- Size built-in selection panels to their allocated terminal rows in fullscreen and regular mode. Search and the highlighted choice stay visible as the software keyboard opens or closes; Enter confirms that highlighted choice. This covers model/scoped-model, OAuth, extension selection, fork, settings/theme, session, tree and resource configuration, including CLI `--resume` and `pi config`.
  - Use case: Open `/model` on a phone with the software keyboard shown, browse the list, and confirm the choice that is visibly highlighted without hiding the keyboard.
  - Limits: Custom components retain their existing rendering unless they opt in. Extremely small viewports cannot show every detail; resize notices mark omitted details, and extension choices cannot be confirmed while their explanation does not fit. Fullscreen PageUp/PageDown still scroll the transcript; selector page shortcuts can be rebound. Scrollback continues to hide panels without losing their state.
  - Patch branch: [`patch/responsive-selectors`](https://github.com/xz-dev/pi/tree/patch/responsive-selectors)
- Hide `[Skill conflicts]` / `[Prompt conflicts]` / `[Extension issues]` / `[Theme conflicts]` startup diagnostic blocks by default; enable them with `showStartupDiagnostics: true` in `settings.json`.
  - Use case: Keep the startup screen clean unless actively debugging resource conflicts or extension loading issues.
  - Patch branch: [`patch/slow-hook-tui-only`](https://github.com/xz-dev/pi/tree/patch/slow-hook-tui-only)
- Show a `Model: old → new` indicator in the message list after switching models, keeping it visible at the bottom until the first response from the new model arrives.
  - Use case: See that a model switch is deferred to the next request instead of wondering why the footer already shows the new model while the old one is still answering.
  - Patch branch: [`patch/pending-model-switch-indicator`](https://github.com/xz-dev/pi/tree/patch/pending-model-switch-indicator)

## Models and providers

Model catalog refresh, selection, and provider-facing fixes.

- Wait for extension-provider registration refreshes before startup resolves configured models, while preserving synchronous registration and caller-owned cancellation.
  - Use case: Start with models an extension registered asynchronously instead of resolving a stale catalog.
  - Patch branch: [`patch/model-refresh`](https://github.com/xz-dev/pi/tree/patch/model-refresh)
- Rebind active and scoped sessions to refreshed same-ID model metadata so context percentages and automatic compaction use the current context window.
  - Use case: Keep context percentages and compaction limits correct after a provider refreshes model metadata.
  - Patch branch: [`patch/model-refresh-session-rebind`](https://github.com/xz-dev/pi/tree/patch/model-refresh-session-rebind)
- Add `--refresh` to `pi --list-models` so the command loads extension providers, force-refreshes every loaded catalog, then prints refreshed models while preserving cached entries for failed providers. Keep `pi update --models` extension-free for Pi-managed catalog maintenance.
  - Use case: Refresh and inspect a third-party provider's latest model list from one non-interactive CLI command.
  - Patch branch: [`patch/model-refresh`](https://github.com/xz-dev/pi/tree/patch/model-refresh)
- List models with a configured override first in `/settings` -> Default thinking level per model, with configured and unconfigured models each sorted by `provider/model-id`; the current model is preselected instead of pinned to the top.
  - Use case: See and edit saved per-model thinking levels without scanning the whole model list.
  - Patch branch: [`patch/model-thinking-sort`](https://github.com/xz-dev/pi/tree/patch/model-thinking-sort)
- Preserve the `/model` picker's highlighted row when a background model catalog refresh completes while the picker is open. The selection is restored by provider and model id after the list rebuild; a removed model falls back to the existing current-model highlight. Mirrors the scoped-models selector behavior.
  - Use case: Browse the model list and press refresh-in-progress without the cursor snapping back to the first row mid-selection.
  - Patch branch: [`patch/model-selector-refresh-selection`](https://github.com/xz-dev/pi/tree/patch/model-selector-refresh-selection)
- Drop user and assistant messages whose content is empty or whitespace-only in `transformMessages`, the choke point shared by every provider converter. Tool results, assistant messages with tool calls, and blocks carrying thinking/text signatures are always kept.
  - Use case: Extension-injected custom messages (for example watchdog inquiry fold markers) become empty user messages that some providers reject, e.g. Gemini `contents.parts must not be empty`.
  - Patch branch: [`patch/ai-drop-empty-messages`](https://github.com/xz-dev/pi/tree/patch/ai-drop-empty-messages)
- Defer automatic threshold and successful-response overflow compaction until another model request needs the context. Completed idle replies do not generate an unused summary; tool-loop compaction, extension/queued continuations, manual `/compact`, and immediate overflow/length retry recovery remain supported. No new setting is required.
  - Use case: Stop after an answer without paying for a summary that would only be useful if the session continued.
  - Details: [Automatic compaction](../packages/coding-agent/docs/compaction.md#when-it-triggers)
  - Patch branch: [`patch/defer-threshold-compaction`](https://github.com/xz-dev/pi/tree/patch/defer-threshold-compaction)

## Extensions and environment

Extension tooling, skills, and subprocess environment.

- Detach eligible long-running AI tool calls into session-owned managed executions, with `tool_task` controls for status, bounded waits, and cancellation requests while preserving exactly one result for each original tool call.
  - Use case: Let Pi continue reasoning while opted-in shell or extension work runs, without turning untrusted tool output into a steering message or losing cancellation/lifecycle ownership.
  - Patch branch: [`patch/managed-tool-executions`](https://github.com/xz-dev/pi/tree/patch/managed-tool-executions)
- Record where each message came from — interactive terminal input, an extension, RPC, the SDK, or command-line arguments — as an optional `origin` field persisted in session history. Extensions read the structured origin through input and message events and history; identical text from different senders stays distinct for plugins, queue matching, and resume. Extension `pi.sendUserMessage()`/`pi.sendMessage()` calls and custom messages returned by hooks are attributed automatically to the calling extension without any per-extension change, and the model sees a deterministic source annotation on nonhuman entries while provider protocol roles stay unchanged. Nonhuman transcript entries render with a source heading and the same gray tool-style body used for tool output.
  - Use case: Two extensions and a human can each send the literal text `continue`; plugin code can tell which extension produced a message, and the model sees that an instruction came from extension `foo` rather than from interactive input. Display-hidden injected context still surfaces as a folded source heading in the transcript, so it stays inspectable.
  - Limits: Origin is provenance metadata, not a security boundary. It does not authenticate a remote or human sender, does not infer authorship of older unrecorded messages, does not stop a plugin or a raw PTY key injection from supplying input, and does not audit arbitrary context or provider-payload transformations. An extension message is not a system/developer instruction and grants no new authorization. Display-hidden nonempty messages render as a folded source heading; empty control markers stay invisible and keep empty model content. Legacy messages show an unrecorded-source heading rather than claiming human authorship. Per-item click toggles only in supported fullscreen mouse mode, and the existing global `Ctrl+O` expansion state supersedes item overrides.
  - Details: [Extensions](../packages/coding-agent/docs/extensions.md), [Message types](../packages/coding-agent/docs/message-types.md), [Session file format](../packages/coding-agent/docs/session-format.md)
  - Patch branch: [`patch/message-origin`](https://github.com/xz-dev/pi/tree/patch/message-origin)
- Support per-package Skill visibility overrides through `skillOverrides.<name>.disableModelInvocation`, retaining manual `/skill:<name>` invocation and project-over-global precedence.
  - Use case: Keep a skill available to `/skill:<name>` while preventing automatic model invocation.
  - Patch branch: [`patch/skill-overrides`](https://github.com/xz-dev/pi/tree/patch/skill-overrides)
- Show awaited extension handlers exceeding `slowSyncHookThresholdMs` (plain-value handlers) or `slowAsyncHookThresholdMs` (promise-returning handlers) only in interactive TUI, with synchronous handlers in warning yellow and asynchronous handlers in default gray. During shutdown, show the current handler while waiting, clear fast handlers, and keep slow handlers on the terminal without writing timing diagnostics to session history, model context, RPC/print events, or disk. Both thresholds default to `-1` (disabled); set a value `>= 0` in `settings.json` to opt in.
  - Use case: Diagnose slow extension hooks without persisting diagnostic records.
  - Patch branch: [`patch/slow-hook-tui-only`](https://github.com/xz-dev/pi/tree/patch/slow-hook-tui-only)
- Set `LC_ALL=C.UTF-8`, `LANG=C.UTF-8`, `LANGUAGE=en` at startup so tools, MCP servers, and extension subprocesses run with an English locale while Pi's own UI locale stays unchanged. Override with global `envOverrides` (`KEY=VALUE` list, replaces the default); `[]` disables.
  - Use case: Keep tool output the model reads in English on a non-English desktop.
  - Patch branch: [`patch/env-overrides`](https://github.com/xz-dev/pi/tree/patch/env-overrides)

## Internal and CI-only

Patches with no direct user-facing surface: test stability, fork CI plumbing, benchmark bounds.

- Make the coalesced-reload auth-storage test deterministic by writing a different-size payload, so mtime-tick collisions cannot make the reader take the stale cached path.
  - Patch branch: [`patch/quarantine-auth-storage-flake`](https://github.com/xz-dev/pi/tree/patch/quarantine-auth-storage-flake)
- Bound and report startup benchmarks: emit synchronous startup stage/completion markers, exit benchmark runs without waiting on arbitrary handles, and bound fd/rg version probes.
  - Patch branch: [`patch/startup-benchmark-exit`](https://github.com/xz-dev/pi/tree/patch/startup-benchmark-exit)

The Esc and manual-retry patches share [`patch/agent-run-failure-seam`](https://github.com/xz-dev/pi/tree/patch/agent-run-failure-seam). Managed tool executions are integrated before those two patches, and `patch/esc-abort` carries the managed-execution abort drain. See [downstream maintenance](../MAINTAIN.md) for the current integration rules.

## Temporarily disabled

- `patch/tui-synchronized-cursor-fleet` is temporarily retired from generated `main`. Its synchronized-output implementation can emit excessive terminal data and now conflicts with upstream's bounded main-screen writer. The source branch remains retained for a corrected design and independent validation; do not mask the product conflict with a CI resolver.

## Removed patches

- Provider-transparent Responses remote compaction and its dependent pre-provider compaction patch have been removed, and both source branches have been permanently deleted. Classic compaction remains the default path. A third-party extension such as [`@ogulcancelik/pi-codex-compaction`](https://github.com/ogulcancelik/pi-extensions) can provide Codex-native remote compaction without adding provider-specific behavior to core.
- The remote-client run-end wait patch has been retired: upstream now waits on `run_end`/`run_suspend` operation boundaries before resolving an accepted prompt response (`operationBoundaries`/`boundaryWaiters` in `packages/coding-agent/src/experimental/client.ts`), which covers the same transcript-lifecycle guarantee without a timeout heuristic. The source branch is kept as `retired/remote-client-run-end-wait`.
