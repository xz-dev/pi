#!/usr/bin/env python3
from pathlib import Path
import re
import subprocess

expected = {
    Path("packages/coding-agent/src/core/session-manager.ts"),
    Path("packages/coding-agent/test/suite/harness.ts"),
}
conflicts = {
    Path(path)
    for path in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if conflicts != expected:
    raise SystemExit(f"unexpected conflicts: {sorted(map(str, conflicts))}")

marker = r"[^\n]* \(feat\(coding-agent\): splice session tree entries\)"

manager_path = Path("packages/coding-agent/src/core/session-manager.ts")
manager = manager_path.read_text()
manager_pattern = re.compile(
    rf"<<<<<<< HEAD\n\trmSync,\n=======\n>>>>>>> {marker}"
)
manager, manager_count = manager_pattern.subn("\trmSync,", manager)
if manager_count != 1:
    raise SystemExit("unexpected SessionManager splice conflict shape")
manager_path.write_text(manager)

harness_path = Path("packages/coding-agent/test/suite/harness.ts")
harness = harness_path.read_text()
option_pattern = re.compile(
    rf"<<<<<<< HEAD\n"
    rf"\tsessionManagerFactory\?: \(tempDir: string\) => SessionManager;\n"
    rf"=======\n"
    rf"\tpersist\?: boolean;\n"
    rf">>>>>>> {marker}"
)
option_resolution = '''\tsessionManagerFactory?: (tempDir: string) => SessionManager;
\tpersist?: boolean;'''
factory_pattern = re.compile(
    rf"<<<<<<< HEAD\n"
    rf"\tconst sessionManager = options\.sessionManagerFactory\?\.\(tempDir\) \?\? SessionManager\.inMemory\(\);\n"
    rf"=======\n"
    rf"\tconst sessionManager = options\.persist\n"
    rf"\t\t\? SessionManager\.create\(tempDir, join\(tempDir, \"sessions\"\)\)\n"
    rf"\t\t: SessionManager\.inMemory\(\);\n"
    rf">>>>>>> {marker}"
)
factory_resolution = '''\tconst sessionManager =
\t\toptions.sessionManagerFactory?.(tempDir) ??
\t\t(options.persist ? SessionManager.create(tempDir, join(tempDir, "sessions")) : SessionManager.inMemory());'''
harness, option_count = option_pattern.subn(option_resolution, harness)
harness, factory_count = factory_pattern.subn(factory_resolution, harness)
if option_count != 1 or factory_count != 1:
    raise SystemExit("unexpected harness splice conflict shape")
harness_path.write_text(harness)

subprocess.run(["git", "add", *map(str, sorted(expected))], check=True)
