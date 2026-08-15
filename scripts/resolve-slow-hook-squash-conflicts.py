#!/usr/bin/env python3
from pathlib import Path
import subprocess

expected = {
    Path("packages/coding-agent/src/core/agent-session.ts"),
    Path("packages/coding-agent/src/core/extensions/runner.ts"),
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
runner_path.write_text(runner.replace(runner_conflict, runner_resolution))

subprocess.run(["git", "add", *map(str, sorted(expected))], check=True)
