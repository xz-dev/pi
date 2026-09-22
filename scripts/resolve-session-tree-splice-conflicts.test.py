import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("resolve-session-tree-splice-conflicts.py")

MANAGER_REL = "packages/coding-agent/src/core/session-manager.ts"
HARNESS_REL = "packages/coding-agent/test/suite/harness.ts"

# git apply --3way emits "ours"/"theirs" labels.
MANAGER_BLOCK = (
    "<<<<<<< ours\n"
    "\trmSync,\n"
    "=======\n"
    ">>>>>>> theirs\n"
)

HARNESS_OPTION_BLOCK = (
    "<<<<<<< ours\n"
    "\tsessionManagerFactory?: (tempDir: string) => SessionManager;\n"
    "=======\n"
    "\tpersist?: boolean;\n"
    ">>>>>>> theirs\n"
)

HARNESS_CONSTRUCT_BLOCK = (
    "<<<<<<< ours\n"
    "\tconst sessionManager = options.sessionManagerFactory?.(tempDir) ?? SessionManager.inMemory();\n"
    "=======\n"
    "\tconst sessionManager = options.persist\n"
    '\t\t? SessionManager.create(tempDir, join(tempDir, "sessions"))\n'
    "\t\t: SessionManager.inMemory();\n"
    ">>>>>>> theirs\n"
)


def manager_source(block: str = MANAGER_BLOCK) -> str:
    return (
        'import {\n\tcloseSync,\n\texistsSync,\n\tfsyncSync,\n\treaddirSync,\n\treadFileSync,\n\treadSync,\n\trenameSync,\n'
        + block
        + '\ttype Stats,\n\tstatSync,\n\tunlinkSync,\n\twriteFileSync,\n} from "fs";\n\nexport class SessionManager {}\n'
    )


def harness_source(
    option_block: str = HARNESS_OPTION_BLOCK,
    construct_block: str = HARNESS_CONSTRUCT_BLOCK,
) -> str:
    return (
        "export interface HarnessOptions {\n\tmodelsJson?: Record<string, unknown>;\n"
        + option_block
        + "}\n\nexport async function createHarness(options: HarnessOptions = {}): Promise<void> {\n\tconst tempDir = createTempDir();\n\n"
        + construct_block
        + "\tconst settingsManager = SettingsManager.inMemory(options.settings);\n}\n"
    )


def stage_unmerged(directory: Path, paths: list[str]) -> None:
    """Create real unmerged (stage 1/2/3) index entries for the given paths."""
    lines = []
    for rel in paths:
        content = (directory / rel).read_text()

        def blob(data: str) -> str:
            return subprocess.run(
                ["git", "hash-object", "-w", "--stdin"],
                input=data, capture_output=True, text=True, check=True, cwd=directory,
            ).stdout.strip()

        lines.append(f"100644 {blob('base:' + rel)} 1\t{rel}")
        lines.append(f"100644 {blob(content)} 2\t{rel}")
        lines.append(f"100644 {blob('theirs:' + rel)} 3\t{rel}")
    subprocess.run(
        ["git", "update-index", "--index-info"],
        input="\n".join(lines) + "\n",
        cwd=directory, check=True, capture_output=True, text=True,
    )


def index_state(directory: Path) -> str:
    return subprocess.run(
        ["git", "ls-files", "-s"], cwd=directory, capture_output=True, text=True, check=True
    ).stdout


class SpliceResolverTests(unittest.TestCase):
    def run_with_conflicts(self, files: dict[str, str]):
        """Set up a scratch repo with the given conflict files and run the resolver."""
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            subprocess.run(["git", "init", "-q"], cwd=directory, check=True, capture_output=True)
            for rel, content in files.items():
                target = directory / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            stage_unmerged(directory, list(files))
            index_before = index_state(directory)
            index_bytes = (directory / ".git/index").read_bytes()
            result = subprocess.run(
                [sys.executable, str(SCRIPT)],
                cwd=directory, capture_output=True, text=True,
            )
            if result.returncode != 0:
                self.assertEqual(index_state(directory), index_before)
                self.assertEqual((directory / ".git/index").read_bytes(), index_bytes)
                for rel, content in files.items():
                    self.assertEqual((directory / rel).read_text(), content,
                                     f"rejection changed {rel}")
            yield directory, result, index_before

    def test_resolves_apply_conflict_set(self):
        for directory, result, _ in self.run_with_conflicts(
            {
                MANAGER_REL: manager_source(),
                HARNESS_REL: harness_source(),
            }
        ):
            self.assertEqual(result.returncode, 0, result.stderr)

            manager_out = (directory / MANAGER_REL).read_text()
            self.assertIn("\trenameSync,\n\trmSync,\n\ttype Stats,", manager_out)
            self.assertNotIn("<<<<<<<", manager_out)

            harness_out = (directory / HARNESS_REL).read_text()
            self.assertIn(
                "\tsessionManagerFactory?: (tempDir: string) => SessionManager;\n\tpersist?: boolean;",
                harness_out,
            )
            self.assertIn(
                "\tconst sessionManager =\n"
                "\t\toptions.sessionManagerFactory?.(tempDir) ??\n"
                '\t\t(options.persist ? SessionManager.create(tempDir, join(tempDir, "sessions")) : SessionManager.inMemory());',
                harness_out,
            )
            self.assertNotIn("<<<<<<<", harness_out)
            # Both files staged; no unmerged entries remain.
            self.assertNotIn(" U ", index_state(directory))
            ls = index_state(directory)
            self.assertNotIn("\t1\t", ls.replace(" 1\t", "\t1\t"))
            for line in ls.splitlines():
                self.assertTrue(line.endswith(f" 0\t{MANAGER_REL}") or line.endswith(f" 0\t{HARNESS_REL}") or " 0\t" in line)

    def test_rejects_extra_conflict_file(self):
        stray = "packages/coding-agent/src/core/agent-session.ts"
        for directory, result, index_before in self.run_with_conflicts(
            {
                MANAGER_REL: manager_source(),
                HARNESS_REL: harness_source(),
                stray: "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n",
            }
        ):
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unexpected session-tree-splice conflicts", result.stderr)
            self.assertIn("<<<<<<<", (directory / MANAGER_REL).read_text())
            self.assertEqual(index_state(directory), index_before)

    def test_rejects_altered_ours_content(self):
        altered_option = HARNESS_OPTION_BLOCK.replace(
            "sessionManagerFactory?: (tempDir: string) => SessionManager;",
            "sessionManagerFactory?: (dir: string) => SessionManager;",
        )
        for directory, result, index_before in self.run_with_conflicts(
            {
                MANAGER_REL: manager_source(),
                HARNESS_REL: harness_source(option_block=altered_option),
            }
        ):
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unexpected harness options conflict shape", result.stderr)
            # Rejection must preserve both files and the complete index;
            # run_with_conflicts checks this for every failure case.
            self.assertIn("<<<<<<<", (directory / HARNESS_REL).read_text())
            self.assertIn(f"3\t{HARNESS_REL}", index_state(directory))

    def test_rejects_function_body_in_theirs(self):
        sneaky = HARNESS_CONSTRUCT_BLOCK.replace(
            "\t\t: SessionManager.inMemory();\n",
            "\t\t: SessionManager.inMemory();\n\texfiltrate();\n",
        )
        for directory, result, index_before in self.run_with_conflicts(
            {
                MANAGER_REL: manager_source(),
                HARNESS_REL: harness_source(construct_block=sneaky),
            }
        ):
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unexpected harness construction conflict shape", result.stderr)
            self.assertIn("<<<<<<<", (directory / HARNESS_REL).read_text())
            self.assertIn(f"3\t{HARNESS_REL}", index_state(directory))

    def test_rejects_extra_block_in_harness(self):
        extra = "<<<<<<< ours\n\tx?: number;\n=======\n\ty?: number;\n>>>>>>> theirs\n"
        for directory, result, index_before in self.run_with_conflicts(
            {
                MANAGER_REL: manager_source(),
                HARNESS_REL: harness_source() + extra,
            }
        ):
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unexpected harness conflict count", result.stderr)
            self.assertIn(f"3\t{HARNESS_REL}", index_state(directory))

    def test_rejects_extra_block_in_manager(self):
        extra = "<<<<<<< ours\n\tfooSync,\n=======\n>>>>>>> theirs\n"
        for directory, result, index_before in self.run_with_conflicts(
            {
                MANAGER_REL: manager_source(
                    block=MANAGER_BLOCK + "\tbarSync,\n" + extra
                ),
                HARNESS_REL: harness_source(),
            }
        ):
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unexpected session-manager conflict count", result.stderr)
            self.assertIn("<<<<<<<", (directory / MANAGER_REL).read_text())
            self.assertEqual(index_state(directory), index_before)

    def test_rejects_missing_rmSync(self):
        wrong = MANAGER_BLOCK.replace("\trmSync,\n", "\tfooSync,\n")
        for directory, result, index_before in self.run_with_conflicts(
            {
                MANAGER_REL: manager_source(block=wrong),
                HARNESS_REL: harness_source(),
            }
        ):
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unexpected session-manager import conflict shape", result.stderr)
            self.assertIn("<<<<<<<", (directory / MANAGER_REL).read_text())
            self.assertEqual(index_state(directory), index_before)

    def test_rejects_extra_import(self):
        sneaky_manager = MANAGER_BLOCK.replace(
            "\trmSync,\n", "\trmSync,\n\tbackdoorSync,\n"
        )
        for directory, result, index_before in self.run_with_conflicts(
            {
                MANAGER_REL: manager_source(block=sneaky_manager),
                HARNESS_REL: harness_source(),
            }
        ):
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unexpected session-manager import conflict shape", result.stderr)
            self.assertEqual(index_state(directory), index_before)

    def test_rejects_malformed_separator(self):
        malformed = MANAGER_BLOCK.replace("=======\n", "======= unknown content\n")
        for _, result, _ in self.run_with_conflicts(
            {MANAGER_REL: manager_source(block=malformed), HARNESS_REL: harness_source()}
        ):
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
