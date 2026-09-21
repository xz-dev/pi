#!/usr/bin/env python3
"""Resolve the model-refresh-timeout cherry-pick conflict in main.ts.

The conflict arises because patch/git-package-storage (which precedes us in
the sync order) lacks the --refresh block that patch/model-catalog-extension-refresh
adds. When our commit is cherry-picked onto accumulated main, the merge base
for main.ts is the git-package-storage version (no --refresh), while ours has
the --refresh block with 15_000 and theirs has it with getModelRefreshTimeoutMs().
The resolution keeps the --refresh block with the configurable timeout.
"""
from pathlib import Path
import subprocess

FILENAME = "packages/coding-agent/src/main.ts"

OURS_BLOCK = """\t\tconst searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
\t\tawait listModels(modelRuntime, searchPattern, AbortSignal.timeout(15_000));
\t\tprocess.exit(0);
"""

THEIRS_MARKER_END = ">>>>>>> "


def main():
    conflicts = subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
    if conflicts != [FILENAME]:
        raise SystemExit(f"Unexpected model-refresh-timeout conflicts: {conflicts}")

    path = Path(FILENAME)
    text = path.read_text()

    # Find the conflict block: <<<<<<< HEAD ... ======= ... >>>>>>> <ref>
    head_marker = "<<<<<<< HEAD\n"
    sep_marker = "=======\n"

    head_idx = text.find(head_marker)
    if head_idx == -1:
        raise SystemExit("No conflict markers found")

    sep_idx = text.find(sep_marker, head_idx)
    end_idx = text.find(THEIRS_MARKER_END, sep_idx)
    if end_idx == -1:
        raise SystemExit("Malformed conflict block")

    # end_idx points to start of >>>>>>> line; find its newline
    end_line_end = text.find("\n", end_idx) + 1

    ours = text[head_idx + len(head_marker) : sep_idx]
    theirs = text[sep_idx + len(sep_marker) : end_idx]

    if ours != OURS_BLOCK:
        raise SystemExit(f"Unexpected ours shape:\n{ours!r}")

    if "getModelRefreshTimeoutMs" not in theirs:
        raise SystemExit("Theirs missing getModelRefreshTimeoutMs")
    if "refreshFailed" not in theirs:
        raise SystemExit("Theirs missing refreshFailed")

    # Resolution: keep theirs (has --refresh block + configurable timeout)
    resolved = text[:head_idx] + theirs + text[end_line_end:]

    if any(
        line.startswith(("<<<<<<< ", "=======", ">>>>>>> "))
        for line in resolved.splitlines()
    ):
        raise SystemExit("Conflict markers remain in main.ts")

    for required in (
        "let refreshFailed = false;",
        "getModelRefreshTimeoutMs()",
        "process.exit(refreshFailed ? 1 : 0);",
    ):
        if resolved.count(required) < 1:
            raise SystemExit(f"Missing expected content: {required!r}")

    path.write_text(resolved)
    subprocess.run(["git", "add", FILENAME], check=True)


if __name__ == "__main__":
    main()
