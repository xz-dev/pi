#!/usr/bin/env python3
from pathlib import Path
import subprocess

required_conflicts = {
    Path("packages/coding-agent/src/core/agent-session.ts"),
    Path("packages/coding-agent/src/core/extensions/runner.ts"),
}
interactive_path = Path("packages/coding-agent/src/modes/interactive/interactive-mode.ts")
settings_path = Path("packages/coding-agent/docs/settings.md")
settings_manager_path = Path("packages/coding-agent/src/core/settings-manager.ts")
allowed_conflicts = {
    frozenset(required_conflicts),
    frozenset({*required_conflicts, interactive_path}),
    frozenset({*required_conflicts, interactive_path, settings_path, settings_manager_path}),
    frozenset({*required_conflicts, settings_path, settings_manager_path}),
}
conflicts = {
    Path(path)
    for path in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if frozenset(conflicts) not in allowed_conflicts:
    raise SystemExit(f"unexpected conflicts: {sorted(map(str, conflicts))}")

marker_start = "<" * 7
marker_middle = "=" * 7
marker_end = ">" * 7

session_path = Path("packages/coding-agent/src/core/agent-session.ts")
session = session_path.read_text()
session_conflict = (
    marker_start
    + ''' HEAD
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { planContinuation } from "./manual-retry.ts";
import type { BashExecutionMessage, CustomMessage, ManualRetryRecoveryMessage } from "./messages.ts";
'''
    + marker_middle
    + '''
import { type ExtensionShutdownProgressListener, emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
'''
    + marker_end
    + " origin/patch/slow-hook-tui-only"
)
session_resolution = '''import { type ExtensionShutdownProgressListener, emitSessionShutdownEvent } from "./extensions/runner.ts";
import { planContinuation } from "./manual-retry.ts";
import type { BashExecutionMessage, CustomMessage, ManualRetryRecoveryMessage } from "./messages.ts";'''
if session.count(session_conflict) != 1:
    raise SystemExit("unexpected AgentSession slow-hook conflict shape")
session_path.write_text(session.replace(session_conflict, session_resolution))

runner_path = Path("packages/coding-agent/src/core/extensions/runner.ts")
runner = runner_path.read_text()


def replace_conflict(text: str, ours: str, theirs: str, resolution: str, label: str) -> str:
    conflict = (
        marker_start
        + " HEAD\n"
        + ours
        + marker_middle
        + "\n"
        + theirs
        + marker_end
        + " origin/patch/slow-hook-tui-only\n"
    )
    if text.count(conflict) != 1:
        raise SystemExit(f"unexpected {label} slow-hook conflict shape")
    return text.replace(conflict, resolution)


def try_replace_conflict(text: str, ours: str, theirs: str, resolution: str, label: str = "") -> str:
    """Resolve a conflict hunk if present; return the text unchanged otherwise.

    Rebased slow-hook tips already fold the snapshotEventHandlers outer loops
    into the patch, so the only surviving conflict on a tree that also carries
    the Esc patch is the emitMessageEnd uninterruptible guard versus the
    indexed handler loop. Older shapes stay supported below.
    """
    conflict = (
        marker_start
        + " HEAD\n"
        + ours
        + marker_middle
        + "\n"
        + theirs
        + marker_end
        + " origin/patch/slow-hook-tui-only\n"
    )
    return text.replace(conflict, resolution)


# Upstream snapshots handler lists per extension (snapshotEventHandlers); the
# slow-hook patch still iterates ext.handlers.get per extension. Keep the
# upstream snapshot loop and adopt the slow-hook indexed inner loop so
# runHandler diagnostics keep their handlerIndex.
indexed_inner = "\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {\n"

# Rebased-tip shape: the only surviving runner conflict is emitMessageEnd's
# uninterruptible guard (added by the Esc patch already merged into the tree)
# colliding with the slow-hook indexed inner loop. Union both.
runner = try_replace_conflict(
    runner,
    "\t\t\tfor (const handler of handlers) {\n\t\t\t\tif (ext.uninterruptibleHandlers?.has(handler) === true) continue;\n",
    "\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {\n\n",
    "\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {\n\t\t\t\tif (ext.uninterruptibleHandlers?.has(handler) === true) continue;\n\n",
)

# b1: project_trust standalone inner loop (ours already inside snapshot loop)
runner = try_replace_conflict(
    runner,
    "\t\tfor (const handler of handlers) {\n",
    '''\t\tconst handlers = ext.handlers.get("project_trust");
\t\tif (!handlers || handlers.length === 0) continue;

\t\tfor (const [handlerIndex, handler] of handlers.entries()) {
\t\t\tconst startedAt = performance.now();
\t\t\tlet executionKind: SlowExtensionHookEntry["executionKind"] = "sync";
''',
    '''\t\tfor (const [handlerIndex, handler] of handlers.entries()) {
\t\t\tconst startedAt = performance.now();
\t\t\tlet executionKind: SlowExtensionHookEntry["executionKind"] = "sync";
''',
    "project_trust loop",
)

# b2: generic emit loop
runner = try_replace_conflict(
    runner,
    '\t\tfor (const { ext, handlers } of snapshotEventHandlers(this.extensions, event.type)) {\n\t\t\tfor (const handler of handlers) {\n',
    '''\t\tfor (const ext of this.extensions) {
\t\t\tconst handlers = ext.handlers.get(event.type);
\t\t\tif (!handlers || handlers.length === 0) continue;

\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {
''',
    '\t\tfor (const { ext, handlers } of snapshotEventHandlers(this.extensions, event.type)) {\n' + indexed_inner,
    "generic emit loop",
)

# b3: message_end methods. Ours holds the sync emitUninterruptibleMessageEnd
# body start plus the async emitMessageEnd start; the shared tail after the
# conflict is the slow-hook async body (runHandler + handlerIndex). Keep the
# sync method on plain for-of (no runHandler, handlerIndex unused otherwise)
# and start the async method indexed so the tail's handlerIndex binds.
b3_ours = """			for (const handler of handlers) {
				if (ext.uninterruptibleHandlers?.has(handler) !== true) continue;
				try {
					const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
					const handlerResult = handler(currentEvent, ctx) as MessageEndEventResult | undefined;
					if (!handlerResult?.message) continue;

					if (handlerResult.message.role !== currentMessage.role) {
						this.emitError({
							extensionPath: ext.path,
							event: "message_end",
							error: "message_end handlers must return a message with the same role",
						});
						continue;
					}

					currentMessage = handlerResult.message;
					modified = true;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "message_end",
						error: message,
						stack,
					});
				}
			}
		}

		return modified ? currentMessage : undefined;
	}

	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		const ctx = this.createContext();
		let currentMessage = event.message;
		let modified = false;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "message_end")) {
			for (const handler of handlers) {
				if (ext.uninterruptibleHandlers?.has(handler) === true) continue;
"""
# Ours ends with the async method's plain loop + guard lines; those must be
# replaced by the indexed loop (the shared tail binds handlerIndex), so strip
# them from the ours block and re-append the indexed variant.
b3_ours_async_tail = (
    "\t\tfor (const { ext, handlers } of snapshotEventHandlers(this.extensions, \"message_end\")) {\n"
    "\t\t\tfor (const handler of handlers) {\n"
    "\t\t\t\tif (ext.uninterruptibleHandlers?.has(handler) === true) continue;\n"
)
# The endswith check only applies when the old-shape b3 conflict is present.
b3_sync = b3_ours[: -len(b3_ours_async_tail)]
b3_async_head = (
    "\t\tfor (const { ext, handlers } of snapshotEventHandlers(this.extensions, \"message_end\")) {\n"
    "\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {\n"
    "\t\t\t\tif (ext.uninterruptibleHandlers?.has(handler) === true) continue;\n"
)
runner = try_replace_conflict(
    runner,
    b3_ours,
    "\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {\n",
    b3_sync + b3_async_head,
    "message_end methods",
)

# b4..b11: per-event snapshot loops (tool_result, user_bash, context,
# before_provider_request/headers, before_agent_start, resources_discover)
for event_name in (
    "tool_result",
    "user_bash",
    "context",
    "before_provider_request",
    "before_provider_headers",
    "before_agent_start",
    "resources_discover",
):
    runner = try_replace_conflict(
        runner,
        f'\t\tfor (const {{ ext, handlers }} of snapshotEventHandlers(this.extensions, "{event_name}")) {{\n\t\t\tfor (const handler of handlers) {{\n',
        f'''\t\tfor (const ext of this.extensions) {{
\t\t\tconst handlers = ext.handlers.get("{event_name}");
\t\t\tif (!handlers || handlers.length === 0) continue;

\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {{
''',
        f'\t\tfor (const {{ ext, handlers }} of snapshotEventHandlers(this.extensions, "{event_name}")) {{\n' + indexed_inner,
        f"{event_name} loop",
    )

# b5: tool_call loses its runHandler call line below the conflict; re-add it
runner = try_replace_conflict(
    runner,
    '\t\tfor (const { handlers } of snapshotEventHandlers(this.extensions, "tool_call")) {\n\t\t\tfor (const handler of handlers) {\n\t\t\t\tconst handlerResult = await handler(event, ctx);\n',
    '''\t\tfor (const ext of this.extensions) {
\t\t\tconst handlers = ext.handlers.get("tool_call");
\t\t\tif (!handlers || handlers.length === 0) continue;

\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {
\t\t\t\tconst handlerResult = await this.runHandler("tool_call", ext, handlerIndex, () => handler(event, ctx));
''',
    '''\t\tfor (const { ext, handlers } of snapshotEventHandlers(this.extensions, "tool_call")) {
\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {
\t\t\t\tconst handlerResult = await this.runHandler("tool_call", ext, handlerIndex, () => handler(event, ctx));
''',
    "tool_call loop",
)

# b12: input loop (different theirs shape, no get-guard)
runner = try_replace_conflict(
    runner,
    '\t\tfor (const { ext, handlers } of snapshotEventHandlers(this.extensions, "input")) {\n\t\t\tfor (const handler of handlers) {\n',
    '''\t\tfor (const ext of this.extensions) {
\t\t\tfor (const [handlerIndex, handler] of (ext.handlers.get("input") ?? []).entries()) {
''',
    '\t\tfor (const { ext, handlers } of snapshotEventHandlers(this.extensions, "input")) {\n\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {\n',
    "input loop",
)

runner_resolution = '''\t\t\tfor (const [handlerIndex, handler] of handlers.entries()) {
\t\t\t\tif (ext.uninterruptibleHandlers?.has(handler) === true) continue;'''

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
if user_bash_conflict in runner:
    runner = runner.replace(user_bash_conflict, user_bash_resolution)
if any(line.startswith((marker_start, marker_middle, marker_end)) for line in runner.splitlines()):
    raise SystemExit("conflict markers remain in runner.ts after slow-hook resolution")
runner_path.write_text(runner)

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
if interactive_path in conflicts:
    interactive = interactive_path.read_text()
    if interactive.count(interactive_conflict) != 1:
        raise SystemExit("unexpected interactive mode slow-hook conflict shape")
    interactive_path.write_text(interactive.replace(interactive_conflict, interactive_resolution))

# settings.md and settings-manager.ts: resolve by keeping ours (accumulated
# main already has the other patches' additions) and inserting only the
# theirs-side lines that are genuinely new (slowHookThresholdMs row/method).
def union_settings(text: str, new_marker: str) -> str:
    while True:
        head_idx = text.find(marker_start + " HEAD\n")
        if head_idx == -1:
            break
        sep_idx = text.find(marker_middle + "\n", head_idx)
        end_idx = text.find(marker_end, sep_idx)
        if sep_idx == -1 or end_idx == -1:
            raise SystemExit("malformed conflict")
        end_line = text.find("\n", end_idx) + 1
        ours = text[head_idx + len(marker_start + " HEAD\n") : sep_idx]
        theirs = text[sep_idx + len(marker_middle + "\n") : end_idx]
        # Keep ours, plus any theirs lines containing the new marker
        extra = "".join(
            line for line in theirs.splitlines(keepends=True) if new_marker in line
        )
        text = text[:head_idx] + ours + extra + text[end_line:]
    return text

if settings_path in conflicts:
    resolved = union_settings(settings_path.read_text(), "slowHookThresholdMs")
    settings_path.write_text(resolved)
if settings_manager_path in conflicts:
    text = settings_manager_path.read_text()
    # Resolve by keeping ours and appending the getSlowHookThresholdMs method
    # block from theirs (it's a contiguous method definition).
    while True:
        head_idx = text.find(marker_start + " HEAD\n")
        if head_idx == -1:
            break
        sep_idx = text.find(marker_middle + "\n", head_idx)
        end_idx = text.find(marker_end, sep_idx)
        if sep_idx == -1 or end_idx == -1:
            raise SystemExit("malformed conflict")
        end_line = text.find("\n", end_idx) + 1
        ours = text[head_idx + len(marker_start + " HEAD\n") : sep_idx]
        theirs = text[sep_idx + len(marker_middle + "\n") : end_idx]
        # If theirs contains the slow-hook method and ours doesn't, keep ours
        # plus the complete method block from theirs.
        if "getSlowHookThresholdMs" in theirs and "getSlowHookThresholdMs" not in ours:
            # Extract the complete method from theirs
            method_start = theirs.find("\tgetSlowHookThresholdMs()")
            if method_start == -1:
                raise SystemExit("getSlowHookThresholdMs method not found in theirs")
            # Method ends at the next \t} followed by blank line or end of theirs
            method_end = theirs.find("\n\t}\n", method_start)
            if method_end == -1:
                raise SystemExit("getSlowHookThresholdMs method end not found")
            method_block = theirs[method_start : method_end + len("\n\t}\n")]
            text = text[:head_idx] + ours + method_block + "\n" + text[end_line:]
        else:
            text = text[:head_idx] + ours + text[end_line:]
    if any(
        line.startswith((marker_start, marker_middle, marker_end))
        for line in text.splitlines()
    ):
        raise SystemExit("markers remain in settings-manager.ts")
    settings_manager_path.write_text(text)

subprocess.run(["git", "add", *map(str, sorted(conflicts))], check=True)
