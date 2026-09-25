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

# The rebased managed-tool-executions branch conflicts with the Esc seam on
# agent-loop.ts (dual-controller vs single-controller) and with ci/seam
# wiring on agent-session.ts (adjacent install calls).

LOOP_CONFLICT = """<<<<<<< HEAD
import { abortable, callAbortable, throwIfAborted } from "./abort.ts";
=======
>>>>>>> origin/patch/managed-tool-executions
"""

LOOP_DUAL_CONFLICT = """<<<<<<< HEAD
	const toolController = new AbortController();
	const interruptController = new AbortController();
	const forwardAbort = () => {
		toolController.abort();
		interruptController.abort();
	};
	if (signal) {
		if (signal.aborted) forwardAbort();
=======
	const controller = new AbortController();
	const forwardAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
>>>>>>> origin/patch/managed-tool-executions
"""

LOOP_EMIT_CONFLICT = """<<<<<<< HEAD
			await emitToolExecutionEnd(finalized, emit, signal);
=======
			await emitToolExecutionEnd(finalized, emit);
>>>>>>> origin/patch/managed-tool-executions
"""

LOOP_CALL_CONFLICT = """<<<<<<< HEAD
	const completion = executePreparedToolCall(
		prepared,
		toolController.signal,
		(event) => {
			if (detached) return;
			return emit(event);
		},
		interruptController.signal,
	)
		.then((executed) =>
			finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				prepared,
				executed,
				config,
				toolController.signal,
				interruptController.signal,
			),
=======
	const completion = executePreparedToolCall(prepared, controller.signal, (event) => {
		if (detached) return;
		return emit(event);
	})
		.then((executed) =>
			finalizeExecutedToolCall(currentContext, assistantMessage, prepared, executed, config, controller.signal),
>>>>>>> origin/patch/managed-tool-executions
"""

LOOP_PROP_CONFLICT = """<<<<<<< HEAD
		controller: toolController,
=======
		controller,
>>>>>>> origin/patch/managed-tool-executions
"""

SESSION_CONFLICT = """<<<<<<< HEAD
		this._installAgentForcedPromptProjection();
=======
		this._syncManagedToolExecutions();
>>>>>>> origin/patch/managed-tool-executions
"""

SESSION_CONFLICT_TWO = """<<<<<<< HEAD
		this._syncManagedToolExecutions();
=======
		this._installAgentForcedPromptProjection();
		this._wireModelRefresh();
>>>>>>> origin/patch/managed-tool-executions
"""


def loop_source():
    return (
        "// header\n"
        + LOOP_CONFLICT
        + "// middle\n"
        + LOOP_EMIT_CONFLICT
        + "// middle2\n"
        + LOOP_DUAL_CONFLICT
        + "// middle3\n"
        + LOOP_CALL_CONFLICT
        + "// tail\n"
        + LOOP_PROP_CONFLICT
        + "// end\n"
    )


def session_source():
    return (
        "class AgentSession {\n\tinit() {\n"
        + SESSION_CONFLICT
        + "\t}\n\n\tlate() {\n"
        + SESSION_CONFLICT_TWO
        + "\t}\n}\n"
    )


class ResolverTests(unittest.TestCase):
    def run_resolver(self, conflicts, contents):
        with tempfile.TemporaryDirectory() as directory:
            for name, content in contents.items():
                target = Path(directory) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            with patch.object(
                resolver.subprocess, "check_output",
                return_value="\n".join(conflicts) + "\n",
            ), patch.object(resolver.subprocess, "run") as stage:
                cwd = Path.cwd()
                import os
                os.chdir(directory)
                try:
                    resolver.main()
                finally:
                    os.chdir(cwd)
            staged = stage.call_args[0][0]
            contents_after = {
                name: (Path(directory) / name).read_text() for name in contents
            }
            return contents_after, staged

    def test_agent_loop_keeps_esc_dual_controller(self):
        path = resolver.EXPECTED[0]
        contents, staged = self.run_resolver([path], {path: loop_source()})
        resolved = contents[path]
        self.assertIn('import { abortable, callAbortable, throwIfAborted } from "./abort.ts";', resolved)
        self.assertIn("const toolController = new AbortController();", resolved)
        self.assertIn("const interruptController = new AbortController();", resolved)
        self.assertIn("emitToolExecutionEnd(finalized, emit, signal)", resolved)
        self.assertIn("controller: toolController,", resolved)
        self.assertNotIn("const controller = new AbortController();", resolved)
        self.assertNotIn("<<<<<<<", resolved)
        self.assertEqual(staged, ["git", "add", path])

    def test_agent_session_unions_install_calls(self):
        path = resolver.EXPECTED[1]
        contents, staged = self.run_resolver([path], {path: session_source()})
        resolved = contents[path]
        # Both install calls survive, in ours-then-theirs order per block.
        self.assertIn(
            "_installAgentForcedPromptProjection();\n\t\tthis._syncManagedToolExecutions();",
            resolved,
        )
        self.assertIn(
            "_syncManagedToolExecutions();\n\t\tthis._installAgentForcedPromptProjection();\n\t\tthis._wireModelRefresh();",
            resolved,
        )
        self.assertNotIn("<<<<<<<", resolved)
        self.assertEqual(staged, ["git", "add", path])

    def test_both_conflicts_together(self):
        loop_path, session_path = resolver.EXPECTED
        contents, staged = self.run_resolver(
            list(resolver.EXPECTED),
            {loop_path: loop_source(), session_path: session_source()},
        )
        self.assertIn("const interruptController = new AbortController();", contents[loop_path])
        self.assertIn("_syncManagedToolExecutions();", contents[session_path])
        self.assertEqual(staged, ["git", "add", *resolver.EXPECTED])

    def test_unexpected_conflict_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(
                resolver.subprocess, "check_output",
                return_value="packages/other/file.ts\n",
            ):
                import os
                cwd = Path.cwd()
                os.chdir(directory)
                try:
                    with self.assertRaises(SystemExit):
                        resolver.main()
                finally:
                    os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
