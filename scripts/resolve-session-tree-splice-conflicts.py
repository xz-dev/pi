#!/usr/bin/env python3
from pathlib import Path
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

manager_path = Path("packages/coding-agent/src/core/session-manager.ts")
manager = manager_path.read_text()
manager_conflict = '''<<<<<<< HEAD
\trmSync,
=======
>>>>>>> d5b9e629f (feat(coding-agent): splice session tree entries)'''
if manager.count(manager_conflict) != 1:
    raise SystemExit("unexpected SessionManager splice conflict shape")
manager_path.write_text(manager.replace(manager_conflict, "\trmSync,"))

harness_path = Path("packages/coding-agent/test/suite/harness.ts")
harness = harness_path.read_text()
option_conflict = '''<<<<<<< HEAD
\tsessionManagerFactory?: (tempDir: string) => SessionManager;
=======
\tpersist?: boolean;
>>>>>>> d5b9e629f (feat(coding-agent): splice session tree entries)'''
option_resolution = '''\tsessionManagerFactory?: (tempDir: string) => SessionManager;
\tpersist?: boolean;'''
factory_conflict = '''<<<<<<< HEAD
\tconst sessionManager = options.sessionManagerFactory?.(tempDir) ?? SessionManager.inMemory();
=======
\tconst sessionManager = options.persist
\t\t? SessionManager.create(tempDir, join(tempDir, "sessions"))
\t\t: SessionManager.inMemory();
>>>>>>> d5b9e629f (feat(coding-agent): splice session tree entries)'''
factory_resolution = '''\tconst sessionManager =
\t\toptions.sessionManagerFactory?.(tempDir) ??
\t\t(options.persist ? SessionManager.create(tempDir, join(tempDir, "sessions")) : SessionManager.inMemory());'''
if harness.count(option_conflict) != 1 or harness.count(factory_conflict) != 1:
    raise SystemExit("unexpected harness splice conflict shape")
harness = harness.replace(option_conflict, option_resolution).replace(factory_conflict, factory_resolution)
harness_path.write_text(harness)

subprocess.run(["git", "add", *map(str, sorted(expected))], check=True)
