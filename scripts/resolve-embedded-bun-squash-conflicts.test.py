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

CONFIG = "packages/coding-agent/src/config.ts"
SETTINGS = "packages/coding-agent/docs/settings.md"
PACKAGES = "packages/coding-agent/docs/packages.md"
PM = "packages/coding-agent/src/core/package-manager.ts"
PM_TEST = "packages/coding-agent/test/package-manager.test.ts"
ALL = f"{PACKAGES}\n{SETTINGS}\n{CONFIG}\n{PM}\n{PM_TEST}\n"

SETTINGS_TEXT = (
    "| `shellPath` | string | - | custom |\n"
    "| `npmCommand` | `string[]` | `npm` | Command and arguments used for npm package lookup and installation. |\n"
    "| `other` | string | - | x |\n"
)
PACKAGES_TEXT = (
    "# Pi Packages\n\nintro\n\n## Choose a source\n\nsrc body\n\n## Create a package\n"
)
CONFIG_TEXT = (
    "\t\tdistribution?: string;\n"
    "<<<<<<< HEAD\n\t\treleaseTarget?: string;\n=======\n"
    ">>>>>>> origin/patch/use-embedded-bun-package-manager\n"
    "export const DISTRIBUTION: string | undefined = pkg.piConfig?.distribution;\n"
    "<<<<<<< HEAD\n"
    "export const RELEASE_TARGET: string | undefined = pkg.piConfig?.releaseTarget;\n"
    "=======\n>>>>>>> origin/patch/use-embedded-bun-package-manager\n"
    "// ===== metadata =====\n"
)


def fake_resolver_path(files):
    real_path = Path

    def _path(arg):
        return files.get(arg, real_path(arg))

    return _path


class ResolverTests(unittest.TestCase):
    def test_resolves_all_three_conflicts(self):
        with tempfile.TemporaryDirectory() as directory:
            files = {
                SETTINGS: Path(directory) / "settings.md",
                PACKAGES: Path(directory) / "packages.md",
                CONFIG: Path(directory) / "config.ts",
                PM: Path(directory) / "package-manager.ts",
                PM_TEST: Path(directory) / "package-manager.test.ts",
            }
            files[SETTINGS].write_text(SETTINGS_TEXT)
            files[PACKAGES].write_text(PACKAGES_TEXT)
            files[CONFIG].write_text(CONFIG_TEXT)
            files[PM].write_text(
                "<<<<<<< HEAD\n"
                "\t\tif (npmCommand.embeddedBun) return \"bun\";\n"
                "=======\n"
                "\t\treturn \"bun\";\n"
                ">>>>>>> origin/patch/use-embedded-bun-package-manager\n"
            )
            files[PM_TEST].write_text(
                "<<<<<<< HEAD\n"
                "\tgetPackageManagerName(): string;\n"
                "=======\n"
                "\tgetNpmCommand(): { command: string; args: string[]; embeddedBun?: boolean };\n"
                ">>>>>>> origin/patch/use-embedded-bun-package-manager\n"
            )

            staged = []

            def fake_run(cmd, check=False):
                staged.append(cmd)
                return None

            with patch.object(resolver, "Path", side_effect=fake_resolver_path(files)), patch.object(
                resolver.subprocess, "check_output", return_value=ALL
            ), patch.object(resolver.subprocess, "run", side_effect=fake_run):
                resolver.main()

            settings = files[SETTINGS].read_text()
            self.assertIn("embedded Bun default", settings)
            self.assertIn("BUN_BE_BUN=1", settings)

            packages = files[PACKAGES].read_text()
            self.assertIn("## Package-manager selection", packages)
            self.assertLess(packages.index("Package-manager selection"), packages.index("Choose a source"))

            config = files[CONFIG].read_text()
            self.assertNotIn("<<<<<<<", config)
            self.assertIn("releaseTarget?: string;", config)
            self.assertEqual(config.count("export const DISTRIBUTION:"), 1)

            checkouts = [c for c in staged if c[:3] == ["git", "checkout", "--ours"]]
            self.assertEqual(len(checkouts), 2)
            adds = [c for c in staged if c[:2] == ["git", "add"]]
            self.assertEqual(len(adds), 5)

    def test_rejects_unexpected_conflict_files(self):
        with patch.object(resolver.subprocess, "check_output", return_value="other.ts\n"):
            with self.assertRaisesRegex(SystemExit, "Unexpected embedded-Bun conflicts"):
                resolver.main()

    def test_rejects_unexpected_config_shape_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            files = {
                SETTINGS: Path(directory) / "settings.md",
                PACKAGES: Path(directory) / "packages.md",
                CONFIG: Path(directory) / "config.ts",
                PM: Path(directory) / "package-manager.ts",
                PM_TEST: Path(directory) / "package-manager.test.ts",
            }
            files[SETTINGS].write_text(SETTINGS_TEXT)
            files[PACKAGES].write_text(PACKAGES_TEXT)
            files[CONFIG].write_text("unexpected content\n")
            files[PM].write_text("pm\n")
            files[PM_TEST].write_text("pmtest\n")

            with patch.object(resolver, "Path", side_effect=fake_resolver_path(files)), patch.object(
                resolver.subprocess, "check_output", return_value=ALL
            ), patch.object(resolver.subprocess, "run"):
                with self.assertRaisesRegex(SystemExit, "conflict shape"):
                    resolver.main()
            self.assertEqual(files[CONFIG].read_text(), "unexpected content\n")


if __name__ == "__main__":
    unittest.main()
