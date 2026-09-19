#!/usr/bin/env python3
"""Resolve session-tree-splice squash conflicts.

Upstream #9630 snapshot loops (ours) must survive; the splice patch's
per-extension loops and its pre-#9630 shapes do not. Keep ours for runner,
session imports, and session-manager rmSync; adopt the splice-only additions
(SpliceEntryHandler export, lifecycle stub) and union both harness options.
"""
from pathlib import Path
import re
import subprocess

runner_path = Path("packages/coding-agent/src/core/extensions/runner.ts")
session_path = Path("packages/coding-agent/src/core/agent-session.ts")
index_path = Path("packages/coding-agent/src/core/extensions/index.ts")
manager_path = Path("packages/coding-agent/src/core/session-manager.ts")
lifecycle_path = Path("packages/coding-agent/test/lifecycle-diagnostics.test.ts")
harness_path = Path("packages/coding-agent/test/suite/harness.ts")
expected_full = {
    runner_path,
    session_path,
    index_path,
    manager_path,
    lifecycle_path,
    harness_path,
}
# The workflow applies the splice range with git apply --3way on top of the
# slow-hook merge; that shape conflicts only in session-manager and harness.
expected_apply = {manager_path, harness_path}
allowed = {frozenset(expected_full), frozenset(expected_apply)}
conflicts = {
    Path(path)
    for path in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if conflicts not in allowed:
    raise SystemExit(f"unexpected conflicts: {sorted(map(str, conflicts))}")


def check_markers(text: str, label: str) -> None:
    if any(line.startswith(("<<<<<<< ", "=======", ">>>>>>> ")) for line in text.splitlines()):
        raise SystemExit(f"conflict markers remain in {label}")


def resolve_side(path: Path, label: str, side: int) -> None:
    text = path.read_text()
    resolved, count = re.subn(
        r"<<<<<<< (?:HEAD|ours)\n(.*?)=======\n(.*?)>>>[^\n]*\n",
        lambda m: m.group(side),
        text,
        flags=re.DOTALL,
    )
    if count == 0:
        raise SystemExit(f"no {label} conflicts found")
    check_markers(resolved, label)
    path.write_text(resolved)


# runner: upstream snapshotEventHandlers infra stays (merge shape only)
if runner_path in conflicts:
    resolve_side(runner_path, "runner", 1)
# session imports: manual-retry additions are the superset (merge shape only)
if session_path in conflicts:
    resolve_side(session_path, "agent session imports", 1)
# session-manager: rmSync import stays
resolve_side(manager_path, "session manager rmSync", 1)
# index.ts: splice-only SpliceEntryHandler export (merge shape only)
if index_path in conflicts:
    resolve_side(index_path, "extensions index SpliceEntryHandler", 2)
# lifecycle test: splice-only spliceEntry stub (merge shape only)
if lifecycle_path in conflicts:
    resolve_side(lifecycle_path, "lifecycle spliceEntry stub", 2)

# harness: union both options and prefer the factory
harness = harness_path.read_text()
options_pattern = re.compile(
    r"<<<<<<< (?:HEAD|ours)\n"
    + re.escape("\tsessionManagerFactory?: (tempDir: string) => SessionManager;\n")
    + r"=======\n"
    + re.escape("\tpersist?: boolean;\n")
    + r">>>[^\n]*\n"
)
harness, count = options_pattern.subn(
    "\tsessionManagerFactory?: (tempDir: string) => SessionManager;\n\tpersist?: boolean;\n",
    harness,
)
if count != 1:
    raise SystemExit("unexpected harness options conflict shape")

construct_pattern = re.compile(
    r"<<<<<<< (?:HEAD|ours)\n"
    + re.escape(
        "\tconst sessionManager = options.sessionManagerFactory?.(tempDir) ?? SessionManager.inMemory();\n"
    )
    + r"=======\n(.*?)>>>[^\n]*\n",
    re.DOTALL,
)
m2 = construct_pattern.search(harness)
if not m2:
    raise SystemExit("unexpected harness construction conflict shape")
replacement2 = (
    "\tconst sessionManager =\n"
    "\t\toptions.sessionManagerFactory?.(tempDir) ??\n"
    "\t\t(options.persist ? SessionManager.create(tempDir, join(tempDir, \"sessions\")) : SessionManager.inMemory());\n"
)
harness = harness[: m2.start()] + replacement2 + harness[m2.end():]
check_markers(harness, "harness")
harness_path.write_text(harness)

staged = conflicts if conflicts == frozenset(expected_apply) else expected_full
subprocess.run(["git", "add", *map(str, sorted(staged))], check=True)
