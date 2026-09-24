import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "resolver", Path(__file__).with_name("resolve-agent-run-failure-seam-squash-conflicts.py")
)
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)


class ResolverTests(unittest.TestCase):
    def test_preserves_upstream_imports_and_adds_run_failure_event(self):
        original = (
            'import {\n'
            '\tcreateInitialSystemMessage,\n'
            '} from "@earendil-works/pi-ai";\n'
            '\t\t} satisfies AgentMessage;\n'
            '\t\tawait this.processEvents({ type: "message_start", message: failureMessage });\n'
        )
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "agent.ts"
            target.write_text(original)
            with patch.object(resolver, "Path", return_value=target), patch.object(
                resolver.subprocess,
                "check_output",
                return_value="packages/agent/src/agent.ts\n",
            ), patch.object(resolver.subprocess, "run") as run:
                resolver.main()

            result = target.read_text()
            self.assertIn("\ttype AssistantMessage,", result)
            self.assertIn("} satisfies AssistantMessage;", result)
            self.assertIn('type: "run_failure"', result)
            self.assertEqual(run.call_count, 2)

    def test_rejects_unexpected_conflict_files(self):
        with patch.object(resolver.subprocess, "check_output", return_value="other.ts\n"):
            with self.assertRaisesRegex(SystemExit, "Unexpected agent run-failure seam conflicts"):
                resolver.main()

    def test_rejects_unexpected_shape_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "agent.ts"
            target.write_text("unexpected content\n")
            with patch.object(resolver, "Path", return_value=target), patch.object(
                resolver.subprocess,
                "check_output",
                return_value="packages/agent/src/agent.ts\n",
            ), patch.object(resolver.subprocess, "run"):
                with self.assertRaisesRegex(SystemExit, "run-failure seam"):
                    resolver.main()
            self.assertEqual(target.read_text(), "unexpected content\n")


if __name__ == "__main__":
    unittest.main()
