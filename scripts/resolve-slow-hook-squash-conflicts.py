#!/usr/bin/env python3
from pathlib import Path
import subprocess

expected = {
    Path("packages/coding-agent/src/core/agent-session.ts"),
    Path("packages/coding-agent/src/core/extensions/runner.ts"),
    Path("packages/coding-agent/src/modes/interactive/interactive-mode.ts"),
}
conflicts = {
    Path(path)
    for path in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if conflicts != expected:
    raise SystemExit(f"unexpected conflicts: {sorted(map(str, conflicts))}")

session_path = Path("packages/coding-agent/src/core/agent-session.ts")
session = session_path.read_text()
session_conflict = '''<<<<<<< HEAD
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { planContinuation } from "./manual-retry.ts";
import type { BashExecutionMessage, CustomMessage, ManualRetryRecoveryMessage } from "./messages.ts";
=======
import { type ExtensionShutdownProgressListener, emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
>>>>>>> origin/patch/slow-hook-tui-only'''
session_resolution = '''import { type ExtensionShutdownProgressListener, emitSessionShutdownEvent } from "./extensions/runner.ts";
import { planContinuation } from "./manual-retry.ts";
import type { BashExecutionMessage, CustomMessage, ManualRetryRecoveryMessage } from "./messages.ts";'''
if session.count(session_conflict) != 1:
    raise SystemExit("unexpected AgentSession slow-hook conflict shape")
session_path.write_text(session.replace(session_conflict, session_resolution))

runner_path = Path("packages/coding-agent/src/core/extensions/runner.ts")
runner = runner_path.read_text()
runner_conflict = '''<<<<<<< HEAD
\t\t\tfor (const handler of handlers) {
\t\t\t\tif (ext.uninterruptibleHandlers?.has(handler) === true) continue;
=======
\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {
>>>>>>> origin/patch/slow-hook-tui-only'''
runner_resolution = '''\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {
\t\t\t\tif (ext.uninterruptibleHandlers?.has(handler) === true) continue;'''
if runner.count(runner_conflict) != 1:
    raise SystemExit("unexpected ExtensionRunner slow-hook conflict shape")
runner = runner.replace(runner_conflict, runner_resolution)
marker_start = "<" * 7
marker_middle = "=" * 7
marker_end = ">" * 7
user_bash_conflict = (
    marker_start
    + ''' HEAD
\t\t\t\t\tconst handlerResult = await handler(event, ctx);
\t\t\t\t\tif (handlerResult === undefined) continue;
\t\t\t\t\tif (!isUserBashEventResult(handlerResult)) {
\t\t\t\t\t\tthrow new Error(
\t\t\t\t\t\t\t"Invalid user_bash handler result: return undefined for local execution or exactly one valid { operations } or { result } object",
\t\t\t\t\t\t);
'''
    + marker_middle
    + '''
\t\t\t\t\tconst handlerResult = await this.runHandler("user_bash", ext, handlerIndex, () => handler(event, ctx));
\t\t\t\t\tif (handlerResult) {
\t\t\t\t\t\treturn handlerResult as UserBashEventResult;
'''
    + marker_end
    + ''' origin/patch/slow-hook-tui-only
\t\t\t\t\t}'''
)
user_bash_resolution = '''\t\t\t\t\tconst handlerResult = await this.runHandler("user_bash", ext, handlerIndex, () => handler(event, ctx));
\t\t\t\t\tif (handlerResult === undefined) continue;
\t\t\t\t\tif (!isUserBashEventResult(handlerResult)) {
\t\t\t\t\t\tthrow new Error(
\t\t\t\t\t\t\t"Invalid user_bash handler result: return undefined for local execution or exactly one valid { operations } or { result } object",
\t\t\t\t\t\t);
\t\t\t\t\t}'''
if runner.count(user_bash_conflict) != 1:
    raise SystemExit("unexpected ExtensionRunner user_bash slow-hook conflict shape")
runner_path.write_text(runner.replace(user_bash_conflict, user_bash_resolution))

interactive_path = Path("packages/coding-agent/src/modes/interactive/interactive-mode.ts")
interactive = interactive_path.read_text()
interactive_conflict = (
    marker_start
    + ''' HEAD
\tUserBashEventResult,
'''
    + marker_middle
    + '''
\tSlowExtensionHookEntry,
'''
    + marker_end
    + " origin/patch/slow-hook-tui-only"
)
interactive_resolution = '''\tSlowExtensionHookEntry,
\tUserBashEventResult,'''
if interactive.count(interactive_conflict) != 1:
    raise SystemExit("unexpected interactive mode slow-hook conflict shape")
interactive_path.write_text(interactive.replace(interactive_conflict, interactive_resolution))

subprocess.run(["git", "add", *map(str, sorted(expected))], check=True)
