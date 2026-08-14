# Shutdown screen log

## Behavior

Actor: interactive Pi user.

Need: see which `session_shutdown` extension handler is blocking exit, then retain only slow handlers in terminal scrollback.

Value: distinguish a requested-but-blocked shutdown from ignored Ctrl-D without opening JSONL logs.

## Acceptance

1. After interactive TUI stops, each `session_shutdown` handler immediately appears as current shutdown work.
2. A handler taking more than `slowHookThresholdMs` remains above the shell prompt with extension identity, handler index, and elapsed time.
3. Fast handlers are cleared from terminal but remain in `extension-lifecycle.jsonl`.
4. Handler errors expose no error message, payload, stack, token, or environment data.
5. Attached interactive post-TUI terminal diagnostics are session-free and never enter model context. Absent a listener (reload, signal, print/RPC/headless), baseline `pi.extension_hook_slow` session entries remain and stay context-excluded.
6. Existing serial handler order and interactive `drainInput -> stop -> dispose` order remain unchanged.
7. Signal shutdown keeps existing cleanup-before-terminal-stop behavior and does not use the interactive terminal sink.

## Implementation seam

Add host-only structured shutdown progress records to `ExtensionRunner`. `InteractiveMode` enables a direct stdout sink only after interactive TUI stop and disables it after runtime disposal. Reuse existing slow-hook threshold and metadata sanitization.

Implemented files: `packages/coding-agent/src/core/extensions/runner.ts`, `packages/coding-agent/src/modes/interactive/shutdown-progress.ts`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts`. Compact identity is the sanitized basename plus handler index. Only an attached interactive post-TUI listener replaces the session entry; other paths keep the legacy context-excluded custom entry.

## Branch

Runtime behavior: `patch/shutdown-screen-log`, directly based on `patch/slow-hook-execution-kind`.

If persisted, `ci` must fetch this dependent branch and apply only `patch/slow-hook-execution-kind..patch/shutdown-screen-log` after slow-hook integration.
