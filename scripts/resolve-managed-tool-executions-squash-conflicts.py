#!/usr/bin/env python3
"""Preserve upstream prompt behavior when integrating managed tool execution."""
from pathlib import Path
import re
import subprocess


EXPECTED = [
    "packages/coding-agent/src/core/extensions/wrapper.ts",
    "packages/coding-agent/test/suite/regressions/3592-no-builtin-tools-keeps-extension-tools.test.ts",
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


def main():
    conflicts = subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
    if conflicts != EXPECTED:
        raise SystemExit(f"Unexpected managed-tool conflicts: {conflicts}")

    wrapper_path = Path(EXPECTED[0])
    wrapper = wrapper_path.read_text()
    ours_wrapper = "\treturn wrapToolDefinition(registeredTool.definition, () => runner.createContext());\n"
    theirs_wrapper = '''\tconst tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
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
    wrapper = resolve_conflict(wrapper, ours_wrapper, theirs_wrapper, theirs_wrapper, "wrapper")
    wrapper_path.write_text(wrapper)

    test_path = Path(EXPECTED[1])
    test = test_path.read_text()
    ours_test = (
        '\t\texpect(session.getActiveToolNames()).toEqual([]);\n'
        + "\t\t"
        + r'expect(session.systemPrompt).toContain("<tools>\n(none)\n");'
        + "\n"
    )
    theirs_test = (
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
    test = resolve_conflict(test, ours_test, theirs_test, resolution, "regression test")
    test_path.write_text(test)

    for path in (wrapper_path, test_path):
        if any(marker in path.read_text() for marker in ("<<<<<<<", "=======", ">>>>>>>")):
            raise SystemExit(f"Conflict markers remain in {path}")
    subprocess.run(["git", "add", *EXPECTED], check=True)


if __name__ == "__main__":
    main()
