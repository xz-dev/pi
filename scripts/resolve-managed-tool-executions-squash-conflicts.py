#!/usr/bin/env python3
"""Preserve upstream prompt behavior when integrating managed tool execution."""
from pathlib import Path
import re
import subprocess


EXPECTED = [
    "packages/coding-agent/src/core/extensions/wrapper.ts",
    "packages/coding-agent/test/suite/regressions/3592-no-builtin-tools-keeps-extension-tools.test.ts",
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


def resolve_wrapper(path: Path) -> None:
    wrapper = path.read_text()
    ours = "\treturn wrapToolDefinition(registeredTool.definition, () => runner.createContext());\n"
    theirs = '''\tconst tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
\tconst execute = tool.execute;
\treturn {
\t\t...tool,
\t\texecute: async (toolCallId, params, signal, onUpdate) => {
\t\t\tconst activeBefore = runner.getActiveTools();
\t\t\tconst activeToolChanges = runner.captureActiveToolChanges();
\t\t\tlet result: Awaited<ReturnType<typeof execute>>;
\t\t\ttry {
\t\t\t\tresult = await execute(toolCallId, params, signal, onUpdate);
\t\t\t} finally {
\t\t\t\tactiveToolChanges.stop();
\t\t\t}
\t\t\tconst activeAfter = activeToolChanges.getLatest() ?? activeBefore;
\t\t\tif (!activeBefore.every((name) => activeAfter.includes(name))) return result;

\t\t\tconst beforeNames = new Set(activeBefore);
\t\t\tconst addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
\t\t\tif (addedToolNames.length === 0) return result;
\t\t\treturn {
\t\t\t\t...result,
\t\t\t\taddedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
\t\t\t};
\t\t},
\t};
'''
    wrapper = resolve_conflict(wrapper, ours, theirs, theirs, "wrapper")
    path.write_text(wrapper)
    check_markers(path)


def resolve_regression_test(path: Path) -> None:
    test = path.read_text()
    ours = (
        '\t\texpect(session.getActiveToolNames()).toEqual([]);\n'
        + "\t\t"
        + r'expect(session.systemPrompt).toContain("<tools>\n(none)\n");'
        + "\n"
    )
    theirs = (
        '\t\texpect(session.getActiveToolNames()).toEqual(["tool_task"]);\n'
        + "\t\t"
        + r'expect(session.systemPrompt).toContain("Available tools:\n(none)");'
        + "\n"
    )
    resolution = (
        '\t\texpect(session.getActiveToolNames()).toEqual(["tool_task"]);\n'
        + "\t\t"
        + r'expect(session.systemPrompt).toContain("<tools>\n(none)\n");'
        + "\n"
    )
    test = resolve_conflict(test, ours, theirs, resolution, "regression test")
    path.write_text(test)
    check_markers(path)


def resolve_agent_session(path: Path) -> None:
    session = path.read_text()
    ours = "\t\tthis._installAgentForcedPromptProjection();\n"
    theirs = "\t\tthis._syncManagedToolExecutions();\n"
    session = resolve_conflict(session, ours, theirs, ours + theirs, "agent session")
    path.write_text(session)
    check_markers(path)


RESOLVERS = {
    EXPECTED[0]: resolve_wrapper,
    EXPECTED[1]: resolve_regression_test,
    EXPECTED[2]: resolve_agent_session,
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
