#!/usr/bin/env python3
"""Resolve session-tree-splice apply conflicts.

The workflow applies the recorded slow-hook-tui-only..session-tree-splice
delta with git apply --3way. That apply conflicts only in session-manager.ts
(the patch's import hunk lands next to the pre-image's rmSync line) and
suite/harness.ts (the patch's persist option collides with the pre-image's
sessionManagerFactory option). Resolve only these fixed import and test-harness
additions; validate both complete files before writing either result.
"""
from pathlib import Path
import subprocess

MANAGER_PATH = "packages/coding-agent/src/core/session-manager.ts"
HARNESS_PATH = "packages/coding-agent/test/suite/harness.ts"
EXTENSIONS_PATH = "packages/coding-agent/docs/extensions.md"
SESSION_FORMAT_PATH = "packages/coding-agent/docs/session-format.md"
EXPECTED = frozenset(
    {MANAGER_PATH, HARNESS_PATH, EXTENSIONS_PATH, SESSION_FORMAT_PATH}
)


def list_conflicts() -> frozenset:
    return frozenset(
        subprocess.check_output(
            ["git", "diff", "--name-only", "--diff-filter=U"], text=True
        ).splitlines()
    )


def blocks(text: str, path: str) -> list[list[list[str]]]:
    """Split text into conflict blocks; fail on stray markers or bad structure."""
    lines = text.splitlines(keepends=True)
    parsed, i = [], 0
    while i < len(lines):
        if lines[i].startswith("<<<<<<< "):
            j = i + 1
            while j < len(lines) and lines[j] != "=======\n":
                j += 1
            if j == len(lines):
                raise SystemExit(f"unterminated ours section in {path}")
            k = j + 1
            while k < len(lines) and not lines[k].startswith(">>>>>>> "):
                k += 1
            if k == len(lines):
                raise SystemExit(f"unterminated conflict block in {path}")
            parsed.append([lines[i + 1 : j], lines[j + 1 : k]])
            i = k + 1
        elif lines[i].startswith(("=======", ">>>>>>> ")):
            raise SystemExit(f"stray conflict marker in {path}")
        else:
            i += 1
    return parsed


def resolve(text: str, path: str, resolutions: list[list[str]]) -> str:
    """Replace each conflict block with its exact accepted resolution."""
    out, bi, i = [], 0, 0
    lines = text.splitlines(keepends=True)
    while i < len(lines):
        if lines[i].startswith("<<<<<<< "):
            j = i + 1
            while lines[j] != "=======\n":
                j += 1
            k = j + 1
            while not lines[k].startswith(">>>>>>> "):
                k += 1
            out.extend(resolutions[bi])
            bi += 1
            i = k + 1
        else:
            out.append(lines[i])
            i += 1
    return "".join(out)


# Exact conflict shapes produced by applying slow-hook-tui-only..
# session-tree-splice (5406b6060) onto the recorded pre-image.
MANAGER_OURS = ["\trmSync,\n"]
MANAGER_THEIRS = []

HARNESS_OPTION_OURS = ["\tsessionManagerFactory?: (tempDir: string) => SessionManager;\n"]
HARNESS_OPTION_THEIRS = ["\tpersist?: boolean;\n"]
HARNESS_OPTION_MERGED = HARNESS_OPTION_OURS + HARNESS_OPTION_THEIRS

HARNESS_CONSTRUCT_OURS = [
    "\tconst sessionManager = options.sessionManagerFactory?.(tempDir) ?? SessionManager.inMemory();\n"
]
HARNESS_CONSTRUCT_THEIRS = [
    "\tconst sessionManager = options.persist\n",
    '\t\t? SessionManager.create(tempDir, join(tempDir, "sessions"))\n',
    "\t\t: SessionManager.inMemory();\n",
]
HARNESS_CONSTRUCT_MERGED = [
    "\tconst sessionManager =\n",
    "\t\toptions.sessionManagerFactory?.(tempDir) ??\n",
    '\t\t(options.persist ? SessionManager.create(tempDir, join(tempDir, "sessions")) : SessionManager.inMemory());\n',
]


def expect(block: list[list[str]], ours: list[str], theirs: list[str], label: str) -> None:
    if block[0] != ours or block[1] != theirs:
        raise SystemExit(f"unexpected {label} conflict shape")


def resolve_docs() -> None:
    """Re-append spliceEntry docs onto upstream's rewritten doc structure."""
    subprocess.run(["git", "checkout", "--ours", "--", EXTENSIONS_PATH], check=True)
    text = Path(EXTENSIONS_PATH).read_text()
    anchor = "Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`.\n"
    addition = """`pi.spliceEntry(entryId)` deletes exactly one existing non-root session entry and reparents its direct children to that entry's parent. Descendants stay. If the deleted entry is the current leaf, the parent becomes the leaf. Persisted JSONL is rewritten so a later reload keeps the same topology, and the live agent context is rebuilt. Call this only while the agent is idle; root, missing, and unsafe metadata references (label targets, compaction `firstKeptEntryId`, branch-summary `fromId`, missing parent) throw.
"""
    if text.count(anchor) != 1:
        raise SystemExit("unexpected extensions.md session-state anchor")
    Path(EXTENSIONS_PATH).write_text(text.replace(anchor, anchor + addition, 1))

    subprocess.run(["git", "checkout", "--ours", "--", SESSION_FORMAT_PATH], check=True)
    text = Path(SESSION_FORMAT_PATH).read_text()
    fmt_anchor = "- Calling `resetLeaf()` or `branchWithSummary(null, ...)` allows a later entry to become another root\n"
    fmt_addition = "- `spliceEntry(entryId)` removes one non-root entry and reparents its children\n"
    if text.count(fmt_anchor) != 1:
        raise SystemExit("unexpected session-format.md tree anchor")
    Path(SESSION_FORMAT_PATH).write_text(text.replace(fmt_anchor, fmt_anchor + fmt_addition, 1))


def main() -> None:
    conflicts = list_conflicts()
    if conflicts != EXPECTED:
        raise SystemExit(f"unexpected session-tree-splice conflicts: {sorted(conflicts)}")

    manager_text = Path(MANAGER_PATH).read_text()
    manager_blocks = blocks(manager_text, MANAGER_PATH)
    if len(manager_blocks) != 1:
        raise SystemExit(f"unexpected session-manager conflict count: {len(manager_blocks)}")
    expect(manager_blocks[0], MANAGER_OURS, MANAGER_THEIRS, "session-manager import")
    manager_resolved = resolve(manager_text, MANAGER_PATH, [MANAGER_OURS])

    harness_text = Path(HARNESS_PATH).read_text()
    harness_blocks = blocks(harness_text, HARNESS_PATH)
    if len(harness_blocks) != 2:
        raise SystemExit(f"unexpected harness conflict count: {len(harness_blocks)}")
    expect(
        harness_blocks[0], HARNESS_OPTION_OURS, HARNESS_OPTION_THEIRS, "harness options"
    )
    expect(
        harness_blocks[1],
        HARNESS_CONSTRUCT_OURS,
        HARNESS_CONSTRUCT_THEIRS,
        "harness construction",
    )
    harness_resolved = resolve(
        harness_text,
        HARNESS_PATH,
        [HARNESS_OPTION_MERGED, HARNESS_CONSTRUCT_MERGED],
    )

    resolve_docs()

    Path(MANAGER_PATH).write_text(manager_resolved)
    Path(HARNESS_PATH).write_text(harness_resolved)
    subprocess.run(
        ["git", "add", MANAGER_PATH, HARNESS_PATH, EXTENSIONS_PATH, SESSION_FORMAT_PATH],
        check=True,
    )


if __name__ == "__main__":
    main()
