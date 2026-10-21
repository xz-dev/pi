# Settings Reference

This reference lists user-configurable settings, their types, defaults, and purposes. Project settings override agent-directory settings. Resource lists are combined. See [Configuration](configuration.md) for file locations and trust behavior.

Add `"$schema": "https://pi.dev/schemas/settings.schema.json"` to `settings.json` for editor validation and completion.

## Model and thinking

<a id="model-cycling"></a>

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultProvider` | string | Automatic | Startup AI provider. |
| `defaultModel` | string | Automatic | Startup model ID. |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"medium"` | Startup thinking level. |
| `modelThinkingLevels` | object | None | Per-model startup thinking levels keyed by exact `provider/modelId`. |
| `thinkingBudgets` | object | Built-in budgets | Token budgets for `minimal`, `low`, `medium`, and `high` thinking levels. |
| `enabledModels` | `string[]` | All available models | Model patterns used for startup selection and model cycling. Uses the same format as `--models`. |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in the transcript. |
| `showCacheMissNotices` | boolean | `false` | Show notices for significant cache misses, successful cache warming, compaction usage, and provider recovery. |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"streaming"` | Keep eligible provider prompt caches warm during active runs or, with `"idle"`, between runs. Global setting only. |

Cache warming runs only when the model declares a cache lifetime and Pi estimates at least $0.05 in avoided cache-miss cost. Refresh usage counts toward session totals but does not enter model context. `/session` shows the next decision; extensions can override it with `cache_warming_decision`. See [Prompt Cache Lifetimes](models.md#prompt-cache-lifetimes).

See [Choose a Model](models.md) for model selection and thinking controls.

## Interaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `steeringMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | How queued steering messages are delivered. |
| `followUpMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | How queued follow-up messages are delivered. |
| `externalEditor` | string | `$VISUAL`, `$EDITOR`, then platform default | Command opened by the external-editor keybinding. |
| `doubleEscapeAction` | `"tree" \| "fork" \| "none"` | `"tree"` | Action for double Escape with an empty editor. |
| `treeFilterMode` | `"default" \| "no-tools" \| "user-only" \| "labeled-only" \| "all"` | `"default"` | Initial filter used by `/tree`. |
| `defaultProjectTrust` | `"ask" \| "always" \| "never"` | `"ask"` | Fallback project-trust behavior. **Can only be set in agent-directory settings.** |
| `showStartupDiagnostics` | boolean | `false` | Show extension/resource diagnostic blocks at startup or `/reload`; suppressed by `quietStartup`. |

## Tools

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultTools` | `string[]` | `read`, `bash`, `edit`, `write` | Tools enabled at startup. Plain names replace the defaults; `+name` adds a tool and `-name` removes one. An empty array disables all built-in tools but not extension or SDK tools. |
| `backgroundToolCalls` | object | `{}` | Per-tool managed execution rules. An empty rule uses a 600-second detach threshold. |
| `codemode.mode` | `"on"` \| `"only"` | `"on"` | How the `codemode` tool presents tools while it is active. `on`: declared tools get a note on calling them from scripts appended to their description, and `codemode` lists only tools that are not declared. `only`: `codemode` lists every tool scripts can call, and active built-in and extension tools are hidden from the model, so it reaches them through `codemode`. |
| `codemode.inlineBudget` | number | `3000` | Estimated tokens (characters / 4) the `codemode` tool's description may spend on tool declarations. Tools that do not fit are left out and found with `searchTools()`. `0` lists only namespaces. |

Available built-in tools are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. `defaultTools` can also name `codemode` and `tool_search`, which built-in extensions register inactive, and other extension tools registered inactive.

A list of only `+name` and `-name` entries changes the inherited selection instead of replacing it. For example, this enables `codemode` next to the default tools:

```json
{
  "defaultTools": ["+codemode"]
}
```

This replaces `bash` with `powershell` and enables `grep`: `["-bash", "+powershell", "+grep"]`. Project settings apply on top of user settings: a project list with only `+name` and `-name` entries changes the user's selection, and a project list with a plain name replaces it. In one list, plain names form the selection, and `+name` and `-name` then apply in order.

`/reload` enables tools newly added to `defaultTools`. It does not disable tools removed from it or re-enable unchanged tools you turned off. `--tools` with plain names, `--no-tools`, and `--no-builtin-tools` override `defaultTools`, also on reload.

The `tool_task` management tool remains available even with an empty `defaultTools` array; when using `--tools` with plain names, include `tool_task` explicitly when needed.

`backgroundToolCalls` opts named extension or SDK tools into managed execution. A rule such as `"long_report": { "detachAfterSeconds": 900 }` must use a positive finite threshold; invalid rules are diagnosed and ignored. Unlisted third-party tools stay foreground-only. AI-called `bash` and `powershell` use a 600-second default detach threshold when their timeout is omitted or greater than 1200 seconds. User-entered `!` and `!!` commands are not managed, and `tool_task` itself is never auto-backgrounded. See [Manage long-running tool calls](usage.md#manage-long-running-tool-calls) for lifecycle and cancellation details.

CLI tool options override this setting for one invocation. `--tools` with only `+name` and `-name` entries changes the resolved `defaultTools` selection instead, for example `pi --tools +codemode`. On `/reload`, these entries apply to the reloaded setting too, so a tool removed with `-name` stays removed. See [Command Line](cli.md#tools).

## Sessions and context

| Setting | Type | Default | Description |
|---|---|---|---|
| `sessionDir` | string | Agent session directory | Session storage directory. Relative paths resolve from the working directory. `PI_CODING_AGENT_SESSION_DIR` and `--session-dir` override this setting. |
| `sessionShareDestination` | `"auto" \| "gist" \| "radius"` | `"auto"` | Destination used by `/share`. `auto` uses Radius when authenticated and otherwise creates a GitHub gist. `gist` always uses a gist. `radius` requires Radius authentication and never falls back to a gist. |

### Compaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `compaction.enabled` | boolean | `true` | Enable automatic compaction. |
| `compaction.reserveTokens` | number | `16384` | Free context tokens below which automatic compaction starts. |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens retained without summarization. |
| `compaction.modelOverrides` | object | None | Per-model token settings keyed by exact `provider/modelId`. |

<a id="per-model-compaction-overrides"></a>

Compaction token values must be non-negative safe integers. Each value resolves independently from the matching model override, then the ordinary compaction setting, then the built-in default. Project and user objects merge before model lookup.

See [Compaction Reference](compaction.md) for trigger, summarization, and validation behavior.

### Branch summaries

| Setting | Type | Default | Description |
|---|---|---|---|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when summarizing branch history. |
| `branchSummary.skipPrompt` | boolean | `false` | Skip the branch-summary prompt and default to no summary. |

## Terminal and display

| Setting | Type | Default | Description |
|---|---|---|---|
| `theme` | string | `"system"` | Built-in or custom theme name. `system` derives colors from the terminal theme. |
| `quietStartup` | boolean \| `"header"` | `false` | `true` hides the startup header and loaded-resource listing. `"header"` keeps the header (version and key hints) but hides the model scope line and loaded-resource listing. |
| `tuiMode` | `"regular" \| "fullscreen"` | `"fullscreen"` | Interactive terminal UI mode. |
| `fullscreenExitOutput` | `"transcript" \| "resume-hint"` | `"transcript"` | Output printed when fullscreen mode exits. |
| `fullscreenScrollbar` | `"auto" \| "always" \| "hidden"` | `"auto"` | Fullscreen transcript scrollbar behavior. |
| `fullscreenCopyOnSelect` | boolean | `true` | Copy selected text automatically in fullscreen mode. |
| `fullscreenWheelScrollLines` | `"auto"` \| number | `"auto"` | Lines per mouse-wheel event in fullscreen mode, from 1 to 100. `"auto"` moves one line per event in local macOS terminals, which already accelerate wheel and trackpad input; elsewhere, and over SSH, it speeds up fast wheel spins to at most 6 lines per event. Alt+wheel moves five times as far. |
| `editorPaddingX` | number | `0` | Horizontal editor padding from 0 to 3 cells. |
| `outputPad` | `0 \| 1` | `1` | Horizontal transcript padding for messages, tool output, `!` command output, and summary blocks. |
| `autocompleteMaxVisible` | number | `5` | Visible autocomplete entries, from 3 to 20. |
| `showHardwareCursor` | boolean | `false` | Use the terminal cursor instead of Pi's drawn cursor. Pi still positions it for input methods. |
| `terminal.showImages` | boolean | `true` | Display inline images when supported. |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells. |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when rendered content shrinks. |
| `terminal.showTerminalProgress` | boolean | `false` | Show OSC 9;4 progress in the terminal tab. |
| `terminal.hyperlinks` | `boolean \| "auto"` | `"auto"` | Override OSC 8 hyperlink detection. |
| `terminal.images` | `"kitty" \| "iterm2" \| "auto" \| false` | `"auto"` | Override inline-image protocol detection. |
| `terminal.trueColor` | `boolean \| "auto"` | `"auto"` | Override true-color detection. |
| `images.autoResize` | boolean | `true` | Resize images to at most 2000 by 2000 pixels before sending them to a model. |
| `images.blockImages` | boolean | `false` | Prevent images from being sent to models. |
| `markdown.codeBlockIndent` | string | `"  "` | Prefix used to indent rendered code blocks. |
| `markdown.mermaid` | `"off" \| "final" \| "streaming"` | `"streaming"` | Mermaid rendering mode. |

See [Themes](themes.md) and [Terminal Setup](terminal-setup.md) for format and platform details.

## Network and retries

| Setting | Type | Default | Description |
|---|---|---|---|
| `transport` | `"auto" \| "sse" \| "websocket" \| "websocket-cached"` | `"auto"` | Preferred transport for AI providers that support multiple transports. |
| `responseCheckpointMode` | `"always" \| "auto" \| "declared"` | `"always"` | How eagerly durable Responses checkpoints (`store: true`) are requested. `always` tries regardless of the declared capability; `auto` skips an explicit `compat.supportsResponseCheckpoints: false`; `declared` requires declared capability or the official OpenAI service. |
| `responseCheckpointExclude` | `string[]` | `[]` | Exclusions for durable Responses checkpoints. Missing and `[]` both enable eligible targets; `minimatch` entries exclude matching provider/model targets. |
| `httpProxy` | string | None | Proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY` for Pi-managed HTTP clients. **Can only be set in agent-directory settings.** |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header and body idle timeout in milliseconds. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connection timeout in milliseconds. Set to `0` to disable. |
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry for transient failures. |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts. |
| `retry.baseDelayMs` | number | `2000` | Initial exponential-backoff delay in milliseconds. |
| `retry.maxAgentDelayMs` | number | `60000` | Maximum agent-level retry delay in milliseconds. |
| `retry.nonRetryableErrorPatterns` | string[] | - | Extra case-insensitive `errorMessage` substrings that skip auto-retry (in addition to built-in quota/billing patterns) |
| `retry.provider.timeoutMs` | number | `httpIdleTimeoutMs` | Provider request timeout in milliseconds. |
| `models.refreshTimeoutMs` | number | `60000` | Timeout in milliseconds for model-catalog refresh operations (startup, `--refresh`, `/model`, post-login, `pi update --models`). Negative values disable the timeout; `0` aborts immediately. |
| `retry.provider.maxRetries` | number | `0` | Provider-level retry attempts. |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Maximum server-requested delay in milliseconds. Set to `0` to disable the limit. |

### Request compression

Buffered JSON uploads in the OpenAI Responses, Chat Completions, Azure Responses, Anthropic Messages, and Codex HTTP adapters use lossless request compression. Unknown endpoints are actively tried with zstd level 3 without requiring an `Accept-Encoding` response header; `api.anthropic.com` starts with gzip level 4. Explicit encoding refusals can step down through gzip, deflate, Brotli, then uncompressed JSON. A payload that would grow after compression is sent unchanged.

Until a target accepts a codec, any other failed compressed request (for example a gateway 403/502, a body the backend cannot parse, or a reset connection) is resent once uncompressed. If that resend succeeds, the target stays uncompressed; if it also fails, its error is returned and the next request probes again. Authentication, payload-size, rate-limit, overload, and cancellation failures are never resent. Only one unverified compressed request per target is in flight at a time; concurrent requests wait for its verdict, so probing never multiplies concurrent load. After a target accepts a codec, later failures are returned directly. While a target is unverified, the working indicator shows each attempt as `SSE try Zstd`, `SSE try gzip`, or `SSE try plain` (the uncompressed resend); a verified upload shows the plain label, such as `SSE gzip`.

Codec state stays in process memory, isolated by request target and credentials. It is not saved to settings or sessions and never automatically upgrades after a rejection.

Node/Bun Responses WebSockets independently negotiate `permessage-deflate`; they do not use HTTP gzip/zstd bodies. A declined extension remains disabled for that target and credential scope until process exit. Compression changes neither JSON/image bytes nor token usage, and is separate from context compaction and transport/checkpoint cooldowns.

SDK callers that supply custom `fetch` own its encoding (Codex preserves its existing encoded custom-fetch contract). Codec-bridge plugins should apply the public `createRequestCompressionFetch` helper only at their final HTTP sender; they can share `getWebSocketCompressionPolicy` for WS negotiation. There is no new compression setting.

### Response checkpoints

Durable Responses checkpoints are requested by default (`responseCheckpointMode: "always"`): eligible `auto`/`websocket-cached` requests ask the service to store state (`store: true`) so the next turn sends only `previous_response_id` plus the delta. Set `"responseCheckpointMode": "declared"` to require `compat.supportsResponseCheckpoints: true` (or the official OpenAI service), or `"auto"` to skip endpoints that explicitly declare `supportsResponseCheckpoints: false`. SSE, uncached `websocket`, Codex/ChatGPT modes, any `chatgpt.com` base URL,
`cacheRetention: "none"`, and payload-hook `store: false` stay unchanged in
every mode. A verified `previous_response_id`/store rejection repairs the turn once with full history, then cools the endpoint for the session for two minutes. Each failed recovery probe increases that storage cooldown to three, four, then five minutes (capped at five); only a valid usable checkpoint resets it to two minutes. Successful store-disabled requests and successful WebSocket transport alone do not reset storage progression. Checkpoints stay off until one probe request re-verifies storage. See [checkpoint policy and privacy](../../ai/README.md#response-checkpoints).

```json
{
  "transport": "auto",
  "responseCheckpointMode": "always",
  "responseCheckpointExclude": []
}
```

`["*"]` excludes every target, including slash-containing IDs. Other entries use minimatch 10.2.6 with `{ nocase: true }` against provider ID, model ID, and `provider/model`, not display names; any match excludes that target. This is an unordered exclusion list, not an ordered exception list. For example, `["openai/**", "gpt-[45]*"]` excludes the OpenAI provider's models and matching model IDs. Lists replace rather than concatenate: trusted project settings override agent-directory settings, including an explicit empty list. Untrusted project settings are ignored.

Missing stays unconfigured in saved settings and forwarded stream options; the request owner applies the `always`/`[]` defaults (the independent [OpenAI API plugin](https://github.com/xz-dev/openai-api-pi-extension) reads the same keys). Malformed values are forwarded unchanged so the request owner can disable checkpoints rather than accidentally enable them. Saving another setting does not create these keys. Declaring `supportsResponseCheckpoints` is still useful in `auto`/`declared` modes; see [verified endpoint capability](models.md#response-checkpoint-capability).

Full conversation history remains canonical in session JSONL; checkpoints are optional bounded v1 metadata on assistant messages, alongside the existing response ID. Restore and branch rollback require an exact active-branch prefix, envelope, and scope match; invalid metadata sends full history. There is no side database, universal TTL, answer cache, or KV-cache guarantee. [SettingsManager](../src/core/settings-manager.ts) reads the raw effective values; [session request wiring](../src/core/sdk.ts) reads them on each request, including after settings reload or a project-trust change.

### Transport recovery

For Codex Responses, explicit `websocket` and `websocket-cached` never fall back to SSE. Their transient failures follow the global `retry` settings, including `enabled`, `maxRetries`, delay limits, and non-retryable error patterns.

In `auto`, Pi makes an initial WebSocket attempt plus up to three retries for transport failures. This fixed retry count is independent of `retry.enabled` and `retry.maxRetries`; delays use `retry.baseDelayMs` and `retry.maxAgentDelayMs` (2, 4, and 8 seconds by default). After exhausting these attempts, Pi switches to SSE with a fresh full global retry budget. With `retry.enabled: false`, the three WebSocket retries still run, but a failed SSE attempt is not retried.

Downgrade starts a two-minute SSE cooldown. The next real request after expiry starts one logical WebSocket probe; each failed probe increases the next cooldown to three, four, then five minutes (capped at five). A completed successful WebSocket response resets progression to two minutes; successful SSE fallbacks do not reset it or move the deadline. Auto probe success restores WebSocket and subsequent incremental-context requests. Late failures from already in-flight requests renew the current cooldown without increasing its step. Each logical WS attempt, including a recovery probe, retains the existing bounded protocol repairs for a missing cached response or an expired server connection. These repairs can open replacement sockets before output, so one logical probe is not a limit of one physical WS send. They do not add global retry budget. Probes never run in the background. Recovery sends full context on a fresh socket, without a stale response ID. Only one recovery request runs per session at a time; overlapping requests use SSE. Explicit WebSocket requests ignore, but do not clear, an auto cooldown; successful responses reset only its progression, not its current deadline.

Pi conversations and summaries supply a stable session ID. SDK callers need a stable `sessionId` across attempts and an outer retry owner such as `retryAssistantCall` with the desired policy to get the same fixed allowance and cooldown behavior. Sessionless SDK calls retain their previous behavior: a before-start failure can fall back immediately; with ordinary retry disabled, an after-start failure returns an error rather than using the fixed recovery allowance. They do not retain cooldown state.

Cancellation and non-transport errors, including provider content-filter outcomes, do not count as transport failures. If a provider response has already started, Pi ends that failed attempt before switching to SSE; it never replays SSE inside the same started provider stream. Internal protocol repair stops once assistant content exists, so failed output cannot mix into a replacement WS response either. Failed partial output remains in session history but is omitted from the context sent by an automatic retry. Session cleanup clears transport recovery state.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are required. Provider retries can delay Pi from handling quota and usage-limit errors itself.

`retry.nonRetryableErrorPatterns` is useful when a gateway returns a terminal quota/limit error that still looks retryable (for example a plain HTTP 429 whose body is not covered by the built-in patterns).

## Shell

| Setting | Type | Default | Description |
|---|---|---|---|
| `slowSyncHookThresholdMs` | number | `-1` | Interactive TUI only: show a transient reminder for synchronous extension handlers taking longer than this many milliseconds. Negative values disable it; `0` reports every such handler. Timing diagnostics are not persisted. |
| `slowAsyncHookThresholdMs` | number | `-1` | Same as `slowSyncHookThresholdMs`, for handlers that return a promise. |
| `shellPath` | string | Platform default | Custom shell executable path. Supports a leading `~`. |
| `shellCommandPrefix` | string | None | Prefix prepended to every shell command. |
| `npmCommand` | `string[]` | `npm` | Command and arguments used for npm package lookup and installation. |
| `envOverrides` | `string[]` | `["LC_ALL=C.UTF-8", "LANG=C.UTF-8", "LANGUAGE=en"]` | `KEY=VALUE` entries written to the environment at startup, before extensions load, so tools, MCP servers, and extension subprocesses inherit them. A set list replaces the default entirely; `[]` disables. Pi's own UI locale is unaffected. **Can only be set in agent-directory settings.** |

See [Shell aliases](shell-aliases.md) for shell setup and [Pi Packages](packages.md) for package-manager behavior.

## Resources

Resource paths in user settings resolve from the agent directory. Paths in project settings resolve from the project `.pi` directory. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---|---|---|---|
| `packages` | array | `[]` | npm, git, or local Pi package sources. See [Pi Packages](packages.md). |
| `extensions` | `string[]` | `[]` | Extension files or directories. |
| `skills` | `string[]` | `[]` | Skill files or directories. |
| `prompts` | `string[]` | `[]` | Prompt-template files or directories. |
| `themes` | `string[]` | `[]` | Theme files or directories. |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands. |

Resource arrays support glob exclusions with `!pattern`, exact inclusion with `+path`, and exact exclusion with `-path`. Pi loads resources listed in both user-level and project settings.

The built-in extensions are named `builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode`, and `builtin:tool-search` in `extensions`. They load by default; `-builtin:mcp` disables one. A `+builtin:<name>` or `-builtin:<name>` entry in project settings overrides the user setting. `pi config` lists them under Built-in. `--no-extensions` disables them too, and `-e builtin:<name>` loads one explicitly.

## Updates, telemetry, and warnings

| Setting | Type | Default | Description |
|---|---|---|---|
| `updateMirrors` | `string[]` | None | Ordered URL bases replacing `https://github.com` for xz-dev Release downloads and version checks. One URL is a one-element chain; absent or empty uses GitHub directly. **Agent-directory settings only.** |
| `collapseChangelog` | boolean | `false` | Show a condensed changelog after an update. |
| `enableInstallTelemetry` | boolean | `true` | Enable anonymous install/update reporting and selected provider attribution headers. Does not control update checks. |
| `enableAnalytics` | boolean | `false` | Opt in to analytics data sharing. Currently used only by the experimental first-run setup. |
| `warnings.anthropicExtraUsage` | boolean | `true` | Warn when Anthropic subscription authentication may use paid extra usage. |

Use `pi update --mirror --permanent` to save the current GH-Proxy → GHFast → GitHub list, repeat `--mirror-url <url>` with `--permanent` to save a custom ordered chain, or use `pi update --no-mirror --permanent` to clear it. These commands only change settings; they do not update or contact mirrors. Values are used verbatim, with no URL prevalidation. Custom chains do not implicitly append other sources. Mirrors do not affect extension, npm, or model-catalog downloads. See [mirror installation and updates](../../../README.md#install-through-a-github-mirror).

```json
{
  "updateMirrors": [
    "http://localhost:8080",
    "https://ghfast.top/https://github.com",
    "https://github.com"
  ]
}
```
