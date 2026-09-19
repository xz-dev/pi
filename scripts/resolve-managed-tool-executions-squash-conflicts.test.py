import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "resolver", Path(__file__).with_name("resolve-managed-tool-executions-squash-conflicts.py")
)
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)

WRAPPER_CONFLICT = """<<<<<<< HEAD
\treturn wrapToolDefinition(registeredTool.definition, () => runner.createContext());
=======
\tconst tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
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
>>>>>>> origin/patch/managed-tool-executions
"""

TEST_CONFLICT = """<<<<<<< HEAD
\t\texpect(session.getActiveToolNames()).toEqual([]);
\t\texpect(session.systemPrompt).toContain("<tools>\\n(none)\\n");
=======
\t\texpect(session.getActiveToolNames()).toEqual(["tool_task"]);
\t\texpect(session.systemPrompt).toContain("Available tools:\\n(none)");
>>>>>>> origin/patch/managed-tool-executions
"""

SESSION_CONFLICT = """<<<<<<< HEAD
\t\tthis._installAgentForcedPromptProjection();
=======
\t\tthis._syncManagedToolExecutions();
>>>>>>> origin/patch/managed-tool-executions
"""


class ResolverTests(unittest.TestCase):
    def run_resolver(self, conflicts, contents):
        paths_iter = iter(conflicts)
        with tempfile.TemporaryDirectory() as directory:
            paths = {}
            for name, content in contents.items():
                target = Path(directory) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
                paths[name] = target
            with patch.object(resolver, "Path", side_effect=lambda _: Path(directory) / next(paths_iter)), patch.object(
                resolver.subprocess, "check_output",
                return_value="\n".join(conflicts) + "\n",
            ), patch.object(resolver.subprocess, "run") as stage:
                resolver.main()
            staged = stage.call_args[0][0]
            contents_after = {name: path.read_text() for name, path in paths.items()}
            return contents_after, staged

    def test_combines_managed_tools_with_upstream_prompt_format(self):
        contents, staged = self.run_resolver(
            list(resolver.EXPECTED),
            {
                resolver.EXPECTED[0]: WRAPPER_CONFLICT,
                resolver.EXPECTED[1]: TEST_CONFLICT,
                resolver.EXPECTED[2]: SESSION_CONFLICT,
            },
        )
        self.assertIn("captureActiveToolChanges", contents[resolver.EXPECTED[0]])
        test = contents[resolver.EXPECTED[1]]
        self.assertIn('getActiveToolNames()).toEqual(["tool_task"])', test)
        self.assertIn('<tools>\\n(none)\\n', test)
        session = contents[resolver.EXPECTED[2]]
        self.assertIn(
            "_installAgentForcedPromptProjection();\n\t\tthis._syncManagedToolExecutions();",
            session,
        )
        self.assertEqual(staged, ["git", "add", *resolver.EXPECTED])

    def test_resolves_session_only_conflict_from_failed_sync_run(self):
        # Failed run 35332039448 reported only agent-session.ts conflicting.
        session_only = [resolver.EXPECTED[2]]
        contents, staged = self.run_resolver(
            session_only, {resolver.EXPECTED[2]: SESSION_CONFLICT}
        )
        session = contents[resolver.EXPECTED[2]]
        self.assertIn(
            "_installAgentForcedPromptProjection();\n\t\tthis._syncManagedToolExecutions();",
            session,
        )
        self.assertEqual(staged, ["git", "add", *session_only])

    def test_rejects_unexpected_conflict_files(self):
        with patch.object(resolver.subprocess, "check_output", return_value="other.ts\n"):
            with self.assertRaisesRegex(SystemExit, "Unexpected managed-tool conflicts"):
                resolver.main()

    def test_rejects_empty_conflict_set(self):
        with patch.object(resolver.subprocess, "check_output", return_value="\n"):
            with self.assertRaisesRegex(SystemExit, "Unexpected managed-tool conflicts"):
                resolver.main()


if __name__ == "__main__":
    unittest.main()
