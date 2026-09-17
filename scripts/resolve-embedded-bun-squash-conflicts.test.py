import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "resolver", Path(__file__).with_name("resolve-embedded-bun-squash-conflicts.py")
)
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)


class ResolverTests(unittest.TestCase):
    def test_preserves_release_and_distribution_metadata(self):
        original = (
            "\t\tdistribution?: string;\n"
            "<<<<<<< HEAD\n\t\treleaseTarget?: string;\n=======\n"
            ">>>>>>> origin/patch/use-embedded-bun-package-manager\n"
            "export const DISTRIBUTION: string | undefined = pkg.piConfig?.distribution;\n"
            "<<<<<<< HEAD\n"
            "export const RELEASE_TARGET: string | undefined = pkg.piConfig?.releaseTarget;\n"
            "=======\n>>>>>>> origin/patch/use-embedded-bun-package-manager\n"
            "// ===== metadata =====\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "config.ts"
            target.write_text(original)
            with patch.object(resolver, "Path", return_value=target), patch.object(
                resolver.subprocess, "check_output", return_value="packages/coding-agent/src/config.ts\n"
            ), patch.object(resolver.subprocess, "run") as stage:
                resolver.main()
            result = target.read_text()
            self.assertNotIn("<<<<<<<", result)
            self.assertIn("releaseTarget?: string;", result)
            self.assertIn("export const RELEASE_TARGET:", result)
            self.assertEqual(result.count("export const DISTRIBUTION:"), 1)
            stage.assert_called_once_with(["git", "add", "packages/coding-agent/src/config.ts"], check=True)

    def test_rejects_unexpected_conflict_files(self):
        with patch.object(resolver.subprocess, "check_output", return_value="other.ts\n"):
            with self.assertRaisesRegex(SystemExit, "Unexpected embedded-Bun conflicts"):
                resolver.main()

    def test_rejects_unexpected_shape_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "config.ts"
            target.write_text("unexpected content\n")
            with patch.object(resolver, "Path", return_value=target), patch.object(
                resolver.subprocess, "check_output", return_value="packages/coding-agent/src/config.ts\n"
            ):
                with self.assertRaisesRegex(SystemExit, "conflict shape"):
                    resolver.main()
            self.assertEqual(target.read_text(), "unexpected content\n")


if __name__ == "__main__":
    unittest.main()
