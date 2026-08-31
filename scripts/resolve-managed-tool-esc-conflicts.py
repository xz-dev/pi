#!/usr/bin/env python3
from pathlib import Path
import re
import subprocess

expected = {Path("packages/agent/src/agent-loop.ts")}
conflicts = {
    Path(path)
    for path in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if conflicts != expected:
    raise SystemExit(f"unexpected managed-tool/Esc conflicts: {sorted(map(str, conflicts))}")

path = next(iter(expected))
text = path.read_text()


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if source.count(old) != 1:
        raise SystemExit(f"unexpected {label} shape")
    return source.replace(old, new)


def resolve_conflict(
    source: str, ours: str, theirs: str, resolution: str, label: str
) -> str:
    pattern = re.compile(
        re.escape("<<<<<<< HEAD\n" + ours + "=======\n" + theirs)
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
esc_parallel = '''\t\t\tconst executed = await executePreparedToolCall(preparation, signal, emit);
\t\t\tconst finalized = await finalizeExecutedToolCall(
\t\t\t\tcurrentContext,
\t\t\t\tassistantMessage,
\t\t\t\tpreparation,
\t\t\t\texecuted,
\t\t\t\tconfig,
\t\t\t\tsignal,
\t\t\t);
\t\t\tawait emitToolExecutionEnd(finalized, emit, signal);
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

if any(marker in text for marker in ("<<<<<<<", "=======", ">>>>>>>")):
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
subprocess.run(["git", "add", str(path)], check=True)
