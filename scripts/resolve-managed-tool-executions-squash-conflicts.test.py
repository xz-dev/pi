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


class ResolverTests(unittest.TestCase):
    def test_combines_managed_tools_with_upstream_prompt_format(self):
        wrapper = """<<<<<<< HEAD
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
        test = """<<<<<<< HEAD
\t\texpect(session.getActiveToolNames()).toEqual([]);
\t\texpect(session.systemPrompt).toContain("<tools>\\n(none)\\n");
=======
\t\texpect(session.getActiveToolNames()).toEqual(["tool_task"]);
\t\texpect(session.systemPrompt).toContain("Available tools:\\n(none)");
>>>>>>> origin/patch/managed-tool-executions
"""
        with tempfile.TemporaryDirectory() as directory:
            wrapper_path = Path(directory) / "wrapper.ts"
            test_path = Path(directory) / "test.ts"
            wrapper_path.write_text(wrapper)
            test_path.write_text(test)
            paths = iter([wrapper_path, test_path])
            with patch.object(resolver, "Path", side_effect=lambda _: next(paths)), patch.object(
                resolver.subprocess, "check_output", return_value="\n".join(resolver.EXPECTED) + "\n"
            ), patch.object(resolver.subprocess, "run") as stage:
                resolver.main()

            self.assertIn("captureActiveToolChanges", wrapper_path.read_text())
            self.assertIn('getActiveToolNames()).toEqual(["tool_task"])', test_path.read_text())
            self.assertIn('<tools>\\n(none)\\n', test_path.read_text())
            stage.assert_called_once_with(["git", "add", *resolver.EXPECTED], check=True)

    def test_rejects_unexpected_conflict_files(self):
        with patch.object(resolver.subprocess, "check_output", return_value="other.ts\n"):
            with self.assertRaisesRegex(SystemExit, "Unexpected managed-tool conflicts"):
                resolver.main()


if __name__ == "__main__":
    unittest.main()
