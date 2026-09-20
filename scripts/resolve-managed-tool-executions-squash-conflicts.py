#!/usr/bin/env python3
"""Resolve managed-tool-executions squash conflicts after the mte rebase.

On a tree that already carries the Esc patch, the merge produces conflicts in
agent-loop.ts (Esc's dual AbortController rework versus mte's single controller)
and agent-session.ts (installAgentForcedPromptProjection versus
syncManagedToolExecutions). Resolution: keep the Esc dual-controller shape for
agent-loop (the Esc patch owns that code), and union both install lines in
agent-session.
"""
from pathlib import Path
import re
import subprocess


EXPECTED = [
    "packages/agent/src/agent-loop.ts",
    "packages/coding-agent/src/core/agent-session.ts",
]


def resolve_conflict(text: str, ours: str, theirs: str, resolution: str, label: str) -> str:
    pattern = re.compile(
        re.escape("<<<<<<< HEAD\n" + ours + "=======\n" + theirs)
        + r">>>>>>> [^\n]+\n"
    )
    resolved, count = pattern.subn(lambda _: resolution, text)
    if count != 1:
        raise SystemExit(f"Unexpected managed-tool {label} conflict shape")
    return resolved


def check_markers(path: Path) -> None:
    for line in path.read_text().splitlines():
        if line.startswith(("<<<<<<<", "=======", ">>>>>>>")):
            raise SystemExit(f"Conflict markers remain in {path}")


def resolve_agent_loop(path: Path) -> None:
    """Keep ours (Esc patch dual-controller) for every agent-loop hunk."""
    loop = path.read_text()
    # h1: abortable import — keep ours
    loop = resolve_conflict(
        loop,
        'import { abortable, callAbortable, throwIfAborted } from "./abort.ts";\n',
        "",
        'import { abortable, callAbortable, throwIfAborted } from "./abort.ts";\n',
        "abort import",
    )
    # h2: emitToolExecutionEnd signal arg — keep ours
    loop = resolve_conflict(
        loop,
        "\t\t\tawait emitToolExecutionEnd(finalized, emit, signal);\n",
        "\t\t\tawait emitToolExecutionEnd(finalized, emit);\n",
        "\t\t\tawait emitToolExecutionEnd(finalized, emit, signal);\n",
        "emitToolExecutionEnd",
    )
    # h3: dual-controller vs single-controller — keep ours
    loop = resolve_conflict(
        loop,
        "\tconst toolController = new AbortController();\n"
        "\tconst interruptController = new AbortController();\n"
        "\tconst forwardAbort = () => {\n"
        "\t\ttoolController.abort();\n"
        "\t\tinterruptController.abort();\n"
        "\t};\n"
        "\tif (signal) {\n"
        "\t\tif (signal.aborted) forwardAbort();\n",
        "\tconst controller = new AbortController();\n"
        "\tconst forwardAbort = () => controller.abort();\n"
        "\tif (signal) {\n"
        "\t\tif (signal.aborted) controller.abort();\n",
        "\tconst toolController = new AbortController();\n"
        "\tconst interruptController = new AbortController();\n"
        "\tconst forwardAbort = () => {\n"
        "\t\ttoolController.abort();\n"
        "\t\tinterruptController.abort();\n"
        "\t};\n"
        "\tif (signal) {\n"
        "\t\tif (signal.aborted) forwardAbort();\n",
        "abort controllers",
    )
    # h4: executePreparedToolCall call shape — keep ours
    loop = resolve_conflict(
        loop,
        "\tconst completion = executePreparedToolCall(\n"
        "\t\tprepared,\n"
        "\t\ttoolController.signal,\n"
        "\t\t(event) => {\n"
        "\t\t\tif (detached) return;\n"
        "\t\t\treturn emit(event);\n"
        "\t\t},\n"
        "\t\tinterruptController.signal,\n"
        "\t)\n"
        "\t\t.then((executed) =>\n"
        "\t\t\tfinalizeExecutedToolCall(\n"
        "\t\t\t\tcurrentContext,\n"
        "\t\t\t\tassistantMessage,\n"
        "\t\t\t\tprepared,\n"
        "\t\t\t\texecuted,\n"
        "\t\t\t\tconfig,\n"
        "\t\t\t\ttoolController.signal,\n"
        "\t\t\t\tinterruptController.signal,\n"
        "\t\t\t),\n",
        "\tconst completion = executePreparedToolCall(prepared, controller.signal, (event) => {\n"
        "\t\tif (detached) return;\n"
        "\t\treturn emit(event);\n"
        "\t})\n"
        "\t\t.then((executed) =>\n"
        "\t\t\tfinalizeExecutedToolCall(currentContext, assistantMessage, prepared, executed, config, controller.signal),\n",
        "\tconst completion = executePreparedToolCall(\n"
        "\t\tprepared,\n"
        "\t\ttoolController.signal,\n"
        "\t\t(event) => {\n"
        "\t\t\tif (detached) return;\n"
        "\t\t\treturn emit(event);\n"
        "\t\t},\n"
        "\t\tinterruptController.signal,\n"
        "\t)\n"
        "\t\t.then((executed) =>\n"
        "\t\t\tfinalizeExecutedToolCall(\n"
        "\t\t\t\tcurrentContext,\n"
        "\t\t\t\tassistantMessage,\n"
        "\t\t\t\tprepared,\n"
        "\t\t\t\texecuted,\n"
        "\t\t\t\tconfig,\n"
        "\t\t\t\ttoolController.signal,\n"
        "\t\t\t\tinterruptController.signal,\n"
        "\t\t\t),\n",
        "executePreparedToolCall",
    )
    # h5: controller property — keep ours
    loop = resolve_conflict(
        loop,
        "\t\tcontroller: toolController,\n",
        "\t\tcontroller,\n",
        "\t\tcontroller: toolController,\n",
        "controller property",
    )
    path.write_text(loop)
    check_markers(path)


def resolve_agent_session(path: Path) -> None:
    session = path.read_text()
    # The rebased mte no longer adds _syncManagedToolExecutions here — it already
    # exists from the esc/mr chain. The only conflict is mte removing
    # _installAgentForcedPromptProjection which we keep.
    ours = "\t\tthis._installAgentForcedPromptProjection();\n"
    theirs = ""
    session = resolve_conflict(session, ours, theirs, ours, "agent session")
    path.write_text(session)
    check_markers(path)


RESOLVERS = {
    EXPECTED[0]: resolve_agent_loop,
    EXPECTED[1]: resolve_agent_session,
}


def main():
    conflicts = subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
    if not conflicts or not set(conflicts) <= set(EXPECTED):
        raise SystemExit(f"Unexpected managed-tool conflicts: {conflicts}")
    for conflict in conflicts:
        RESOLVERS[conflict](Path(conflict))
    subprocess.run(["git", "add", *conflicts], check=True)


if __name__ == "__main__":
    main()
