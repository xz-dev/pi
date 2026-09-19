#!/usr/bin/env python3
from pathlib import Path
import re
import subprocess

agent_loop_path = Path("packages/agent/src/agent-loop.ts")
agent_file = Path("packages/agent/src/agent.ts")
extensions_test_path = Path("packages/coding-agent/test/extensions-runner.test.ts")
loader_path = Path("packages/coding-agent/src/core/extensions/loader.ts")
types_path = Path("packages/coding-agent/src/core/extensions/types.ts")
allowed_conflicts = {
    frozenset({agent_loop_path}),
    frozenset({agent_loop_path, extensions_test_path}),
    frozenset({agent_loop_path, loader_path, types_path}),
    frozenset({loader_path, types_path}),
    frozenset({agent_file}),
    frozenset({agent_file, agent_loop_path, loader_path, types_path}),
}
conflicts = {
    Path(path)
    for path in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if frozenset(conflicts) not in allowed_conflicts:
    raise SystemExit(f"unexpected managed-tool/Esc conflicts: {sorted(map(str, conflicts))}")

def replace_once(source: str, old: str, new: str, label: str) -> str:
    if source.count(old) != 1:
        raise SystemExit(f"unexpected {label} shape")
    return source.replace(old, new)


def resolve_conflict(
    source: str, ours: str, theirs: str, resolution: str, label: str
) -> str:
    pattern = re.compile(
        r"<<<<<<< (?:HEAD|ours)\n"
        + re.escape(ours + "=======\n" + theirs)
        + r">>>>>>> [^\n]+\n"
    )
    resolved, count = pattern.subn(resolution, source)
    if count != 1:
        raise SystemExit(f"unexpected {label} conflict shape")
    return resolved


def rewrite_section(
    source: str, start: str, end: str, rewrite: callable, label: str
) -> str:
    start_index = source.find(start)
    end_index = source.find(end, start_index)
    if start_index < 0 or end_index < 0:
        raise SystemExit(f"missing {label} section")
    section = source[start_index:end_index]
    rewritten = rewrite(section)
    if rewritten == section:
        raise SystemExit(f"{label} section was not rewritten")
    return source[:start_index] + rewritten + source[end_index:]




def resolve_agent_loop() -> None:
	"""Apply managed-tool + Esc combined agent-loop resolution."""
	path = agent_loop_path
	text = path.read_text()


	managed_import = '''import {
\tcreateManagedExecutionOutcome,
\tgetManagedExecutionReplayError,
\ttype ManagedExecutionOutcome,
} from "./managed-executions.ts";
'''
	abort_import = 'import { abortable, callAbortable, throwIfAborted } from "./abort.ts";\n'
	text = resolve_conflict(
	    text,
	    managed_import,
	    abort_import,
	    abort_import + managed_import,
	    "managed-tool/Esc import",
	)

	managed_parallel = '''\t\t\tconst finalized = await awaitPreparedToolExecution(preparation, execution, config);
\t\t\tawait emitToolExecutionEnd(finalized, emit);
'''
	esc_parallel = '''\t\t\tawait emitToolExecutionEnd(finalized, emit, signal);
'''
	combined_parallel = '''\t\t\tconst finalized = await awaitPreparedToolExecution(preparation, execution, config);
\t\t\tawait emitToolExecutionEnd(finalized, emit, signal);
'''
	text = resolve_conflict(
	    text,
	    managed_parallel,
	    esc_parallel,
	    combined_parallel,
	    "managed-tool/Esc parallel execution",
	)

	upstream_initial_messages = '''\tawait emit({ type: "agent_start" });
\tawait emit({ type: "turn_start" });
\tfor (const message of initialMessages) {
\t\tawait emit({ type: "message_start", message });
\t\tawait emit({ type: "message_end", message });
'''
	esc_initial_messages = '''\tawait emitAbortable(emit, { type: "agent_start" }, signal);
\tawait emitAbortable(emit, { type: "turn_start" }, signal);
\tfor (const prompt of prompts) {
\t\tawait emitAbortable(emit, { type: "message_start", message: prompt }, signal);
\t\tawait emitAbortable(emit, { type: "message_end", message: prompt }, signal);
'''
	combined_initial_messages = '''\tawait emitAbortable(emit, { type: "agent_start" }, signal);
\tawait emitAbortable(emit, { type: "turn_start" }, signal);
\tfor (const message of initialMessages) {
\t\tawait emitAbortable(emit, { type: "message_start", message }, signal);
\t\tawait emitAbortable(emit, { type: "message_end", message }, signal);
'''
	initial_conflict_prefixes = (
	    "<<<<<<< HEAD\n" + upstream_initial_messages + "=======\n" + esc_initial_messages,
	    "<<<<<<< ours\n" + upstream_initial_messages + "=======\n" + esc_initial_messages,
	)
	if any(prefix in text for prefix in initial_conflict_prefixes):
	    text = resolve_conflict(
	        text,
	        upstream_initial_messages,
	        esc_initial_messages,
	        combined_initial_messages,
	        "upstream tool declarations/Esc initial messages",
	    )

	upstream_pending_messages = '''\t\t\t// Process prepared and queued messages before the next assistant response.
\t\t\tfor (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {
\t\t\t\tawait emit({ type: "message_start", message });
\t\t\t\tawait emit({ type: "message_end", message });
\t\t\t\tcurrentContext.messages.push(message);
\t\t\t\tnewMessages.push(message);
'''
	esc_pending_messages = '''\t\t\t// Process pending messages (inject before next assistant response)
\t\t\tif (pendingMessages.length > 0) {
\t\t\t\tfor (const message of pendingMessages) {
\t\t\t\t\tawait emitAbortable(emit, { type: "message_start", message }, signal);
\t\t\t\t\tawait emitAbortable(emit, { type: "message_end", message }, signal);
\t\t\t\t\tcurrentContext.messages.push(message);
\t\t\t\t\tnewMessages.push(message);
\t\t\t\t}
\t\t\t\tpendingMessages = [];
'''
	combined_pending_messages = '''\t\t\t// Process prepared and queued messages before the next assistant response.
\t\t\tfor (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {
\t\t\t\tawait emitAbortable(emit, { type: "message_start", message }, signal);
\t\t\t\tawait emitAbortable(emit, { type: "message_end", message }, signal);
\t\t\t\tcurrentContext.messages.push(message);
\t\t\t\tnewMessages.push(message);
'''
	pending_conflict_prefixes = (
	    "<<<<<<< HEAD\n" + upstream_pending_messages + "=======\n" + esc_pending_messages,
	    "<<<<<<< ours\n" + upstream_pending_messages + "=======\n" + esc_pending_messages,
	)
	if any(prefix in text for prefix in pending_conflict_prefixes):
	    text = resolve_conflict(
	        text,
	        upstream_pending_messages,
	        esc_pending_messages,
	        combined_pending_messages,
	        "upstream tool declarations/Esc pending messages",
	    )


	def split_execution_signals(section: str) -> str:
	    section = replace_once(
	        section,
	        '''\tconst controller = new AbortController();
\tconst forwardAbort = () => controller.abort();
''',
	        '''\tconst toolController = new AbortController();
\tconst interruptController = new AbortController();
\tconst forwardAbort = () => {
\t\ttoolController.abort();
\t\tinterruptController.abort();
\t};
''',
	        "prepared execution controllers",
	    )
	    section = replace_once(
	        section,
	        "\t\tif (signal.aborted) controller.abort();\n",
	        "\t\tif (signal.aborted) forwardAbort();\n",
	        "parent abort forwarding",
	    )
	    section = replace_once(
	        section,
	        '''\tconst completion = executePreparedToolCall(prepared, controller.signal, (event) => {
\t\tif (detached) return;
\t\treturn emit(event);
\t})
''',
	        '''\tconst completion = executePreparedToolCall(
\t\tprepared,
\t\ttoolController.signal,
\t\t(event) => {
\t\t\tif (detached) return;
\t\t\treturn emit(event);
\t\t},
\t\tinterruptController.signal,
\t)
''',
	        "prepared tool execution call",
	    )
	    section = replace_once(
	        section,
	        '''\t\t.then((executed) =>
\t\t\tfinalizeExecutedToolCall(currentContext, assistantMessage, prepared, executed, config, controller.signal),
\t\t)
''',
	        '''\t\t.then((executed) =>
\t\t\tfinalizeExecutedToolCall(
\t\t\t\tcurrentContext,
\t\t\t\tassistantMessage,
\t\t\t\tprepared,
\t\t\t\texecuted,
\t\t\t\tconfig,
\t\t\t\ttoolController.signal,
\t\t\t\tinterruptController.signal,
\t\t\t),
\t\t)
''',
	        "prepared finalizer call",
	    )
	    return replace_once(
	        section,
	        "\t\tcontroller,\n",
	        "\t\tcontroller: toolController,\n",
	        "registry tool controller",
	    )


	text = rewrite_section(
	    text,
	    "function createPreparedToolExecution(",
	    "async function awaitPreparedToolExecution(",
	    split_execution_signals,
	    "prepared execution",
	)


	def split_tool_call_signals(section: str) -> str:
	    section = replace_once(
	        section,
	        '''async function executePreparedToolCall(
\tprepared: PreparedToolCall,
\tsignal: AbortSignal | undefined,
\temit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
''',
	        '''async function executePreparedToolCall(
\tprepared: PreparedToolCall,
\ttoolSignal: AbortSignal | undefined,
\temit: AgentEventSink,
\tinterruptSignal: AbortSignal | undefined,
): Promise<ExecutedToolCallOutcome> {
''',
	        "tool execution signature",
	    )
	    section = replace_once(
	        section,
	        "prepared.args as never, signal, (partialResult)",
	        "prepared.args as never, toolSignal, (partialResult)",
	        "tool cancellation signal",
	    )
	    section = replace_once(
	        section,
	        '''\t\t\t\t\t\t\tsignal,
\t\t\t\t\t\t),
''',
	        '''\t\t\t\t\t\t\tinterruptSignal,
\t\t\t\t\t\t),
''',
	        "tool update interrupt signal",
	    )
	    section = replace_once(
	        section,
	        "\t\t\tsignal,\n\t\t);\n",
	        "\t\t\tinterruptSignal,\n\t\t);\n",
	        "tool wait interrupt signal",
	    )
	    if section.count("await abortable(Promise.all(updateEvents), signal);") != 2:
	        raise SystemExit("unexpected tool update wait shape")
	    section = section.replace(
	        "await abortable(Promise.all(updateEvents), signal);",
	        "await abortable(Promise.all(updateEvents), interruptSignal);",
	    )
	    return replace_once(
	        section,
	        "\t\tif (signal?.aborted) {\n",
	        "\t\tif (interruptSignal?.aborted) {\n",
	        "aborted update drain signal",
	    )


	text = rewrite_section(
	    text,
	    "async function executePreparedToolCall(",
	    "async function finalizeExecutedToolCall(",
	    split_tool_call_signals,
	    "tool execution",
	)


	def split_finalizer_signals(section: str) -> str:
	    section = replace_once(
	        section,
	        '''\tconfig: AgentLoopConfig,
\tsignal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
''',
	        '''\tconfig: AgentLoopConfig,
\ttoolSignal: AbortSignal | undefined,
\tinterruptSignal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
''',
	        "tool finalizer signature",
	    )
	    section = replace_once(
	        section,
	        "\t\t\t\t\t\tsignal,\n\t\t\t\t\t),\n",
	        "\t\t\t\t\t\ttoolSignal,\n\t\t\t\t\t),\n",
	        "afterToolCall cancellation signal",
	    )
	    return replace_once(
	        section,
	        "\t\t\t\tsignal,\n\t\t\t);\n",
	        "\t\t\t\tinterruptSignal,\n\t\t\t);\n",
	        "afterToolCall interrupt signal",
	    )


	text = rewrite_section(
	    text,
	    "async function finalizeExecutedToolCall(",
	    "function createErrorToolResult(",
	    split_finalizer_signals,
	    "tool finalizer",
	)

	if any(line.startswith(("<<<<<<< ", "=======", ">>>>>>> ")) for line in text.splitlines()):
	    raise SystemExit("conflict markers remain after managed-tool/Esc resolution")

	required = (
	    "const toolController = new AbortController();",
	    "const interruptController = new AbortController();",
	    "controller: toolController,",
	    "await awaitPreparedToolExecution(preparation, execution, config);",
	    "await emitToolExecutionEnd(finalized, emit, signal);",
	    "prepared.args as never, toolSignal,",
	    "const replayError = getManagedExecutionReplayError(result);",
	)
	for source in required:
	    if source not in text:
	        raise SystemExit(f"missing combined invariant: {source}")

	path.write_text(text)


if agent_loop_path in conflicts:
	resolve_agent_loop()

staged_paths = []
if agent_loop_path in conflicts:
	staged_paths.append(agent_loop_path)


def resolve_loader() -> None:
    """Merge upstream unsubscribe returns with Esc uninterruptible registration."""
    loader = loader_path.read_text()
    ours_sig = "\t\ton(event: string, handler: HandlerFn): () => void {\n"
    theirs_sig = "\t\ton(event: string, handler: HandlerFn, options?: { uninterruptible?: boolean }): void {\n"
    merged_sig = "\t\ton(event: string, handler: HandlerFn, options?: { uninterruptible?: boolean }): () => void {\n"
    loader = resolve_conflict(loader, ours_sig, theirs_sig, merged_sig, "loader on() signature")

    ours_reg = "\t\t\tlist.push(registeredHandler);\n"
    theirs_reg = '''\t\t\tif (event === "message_end" && options?.uninterruptible === true) {
\t\t\t\tconst terminalHandler: HandlerFn = (...args) => handler(...args);
\t\t\t\tlist.push(terminalHandler);
\t\t\t\textension.uninterruptibleHandlers?.add(terminalHandler);
\t\t\t} else {
\t\t\t\tlist.push(handler);
\t\t\t}
'''
    # Single registeredHandler wrapper serves both paths so the unsubscribe
    # closure removes the same object that was pushed.
    merged_reg = '''\t\t\tif (event === "message_end" && options?.uninterruptible === true) {
\t\t\t\textension.uninterruptibleHandlers?.add(registeredHandler);
\t\t\t}
\t\t\tlist.push(registeredHandler);
'''
    loader = resolve_conflict(loader, ours_reg, theirs_reg, merged_reg, "loader registration")
    if any(line.startswith(("<<<<<<< ", "=======", ">>>>>>> ")) for line in loader.splitlines()):
        raise SystemExit("conflict markers remain after Esc loader resolution")
    invariants = (
        "extension.uninterruptibleHandlers?.add(registeredHandler);",
        "const handlerIndex = handlers.indexOf(registeredHandler);",
    )
    for source in invariants:
        if source not in loader:
            raise SystemExit(f"missing Esc loader invariant: {source}")
    loader_path.write_text(loader)
    staged_paths.append(loader_path)


def resolve_types() -> None:
    """Keep Esc overloads, upgrade signatures to upstream unsubscribe returns."""
    types = types_path.read_text()
    match = re.search(
        r"<<<<<<< (?:HEAD|ours)\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", types, re.DOTALL
    )
    if not match:
        raise SystemExit("missing Esc types conflict block")
    merged = match.group(2).replace("): void;", "): () => void;")
    merged = merged.replace(
        "\t\toptions: UninterruptibleMessageEndHandlerOptions,\n\t): () => void;",
        "\t\toptions: UninterruptibleMessageEndHandlerOptions,\n\t): void;",
    )

    # Fold on() signature lines that grew past the biome line width when the
    # return type gained "() => "; the sync's check step would otherwise flag
    # the file as unformatted.
    def fold_long_on(line: str) -> str:
        if len(line) <= 120 or not line.startswith("\ton(event: "):
            return line
        m2 = re.match(
            r"\ton\(event: (\"[^\"]+\"), handler: (.*?)\): \(\) => void;\n$", line
        )
        if not m2:
            raise SystemExit("unexpected Esc types on() line shape")
        return (
            "\ton(\n"
            f"\t\tevent: {m2.group(1)},\n"
            f"\t\thandler: {m2.group(2)},\n"
            "\t): () => void;\n"
        )

    merged = "".join(fold_long_on(l) for l in merged.splitlines(keepends=True))
    types = types[: match.start()] + merged + types[match.end():]
    if any(line.startswith(("<<<<<<< ", "=======", ">>>>>>> ")) for line in types.splitlines()):
        raise SystemExit("conflict markers remain after Esc types resolution")
    if "UninterruptibleMessageEndHandlerOptions,\n\t): void;" not in types:
        raise SystemExit("missing Esc types overload invariant")
    types_path.write_text(types)
    staged_paths.append(types_path)


if loader_path in conflicts:
    resolve_loader()
if types_path in conflicts:
    resolve_types()
if agent_file in conflicts:
    # Esc-abort terminalization replaces the unconditional failure sequence.
    agent_text = agent_file.read_text()
    agent_resolved, agent_count = re.subn(
        r"<<<<<<< (?:HEAD|ours)\n(.*?)=======\n(.*?)>>>[^\n]*\n",
        lambda m: m.group(2),
        agent_text,
        flags=re.DOTALL,
    )
    if agent_count == 0:
        raise SystemExit("no Esc agent conflicts found")
    if "runTerminalization" not in agent_resolved:
        raise SystemExit("missing Esc agent terminalization invariant")
    if any(
        line.startswith(("<<<<<<< ", "=======", ">>>>>>> "))
        for line in agent_resolved.splitlines()
    ):
        raise SystemExit("conflict markers remain after Esc agent resolution")
    agent_file.write_text(agent_resolved)
    staged_paths.append(agent_file)

if extensions_test_path in conflicts:
    test_text = extensions_test_path.read_text()
    test_text = resolve_conflict(
        test_text,
        'import { buildSystemPrompt } from "../src/core/system-prompt.ts";\n',
        'import { createTestExtensionsResult } from "./utilities.ts";\n',
        'import { buildSystemPrompt } from "../src/core/system-prompt.ts";\n'
        'import { createTestExtensionsResult } from "./utilities.ts";\n',
        "extension runner test imports",
    )
    if any(line.startswith(("<<<<<<< ", "=======", ">>>>>>> ")) for line in test_text.splitlines()):
        raise SystemExit("conflict markers remain in extension runner tests")
    extensions_test_path.write_text(test_text)
    staged_paths.append(extensions_test_path)
subprocess.run(["git", "add", *map(str, staged_paths)], check=True)
