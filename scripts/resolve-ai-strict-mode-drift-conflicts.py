#!/usr/bin/env python3
"""Resolve ai-strict-mode-test-drift squash conflict in cache-retention.test.ts.

Upstream 8bfef4de8 fixed the strict-mode expectations itself (toBeUndefined),
which collides with our patch's toBeFalsy. Upstream's version is authoritative —
the patch is now redundant and should resolve to upstream's content.
"""
from pathlib import Path
import subprocess

FILENAME = "packages/ai/test/cache-retention.test.ts"
HEAD = "<<<<<<< HEAD\n"
SEP = "=======\n"
END = ">>>>>>> "


def main():
    conflicts = subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
    if conflicts != [FILENAME]:
        raise SystemExit(f"Unexpected strict-mode-drift conflicts: {conflicts}")

    path = Path(FILENAME)
    text = path.read_text()

    head_idx = text.find(HEAD)
    if head_idx == -1:
        raise SystemExit("No conflict markers")

    sep_idx = text.find(SEP, head_idx)
    end_idx = text.find(END, sep_idx)
    if sep_idx == -1 or end_idx == -1:
        raise SystemExit("Malformed conflict block")
    end_line_end = text.find("\n", end_idx) + 1

    ours = text[head_idx + len(HEAD) : sep_idx]
    theirs = text[sep_idx + len(SEP) : end_idx]

    # Upstream (ours) must be the authoritative resolution — it already
    # contains the fixed expectation. Verify ours has toBeUndefined.
    if "toBeUndefined" not in ours:
        raise SystemExit(f"Ours missing toBeUndefined: {ours[:200]!r}")
    # Theirs should be the patch's version (toBeFalsy with comment)
    if "toBeFalsy" not in theirs:
        raise SystemExit(f"Theirs missing toBeFalsy: {theirs[:200]!r}")

    # Keep ours (upstream's fixed version) — patch is redundant
    resolved = text[:head_idx] + ours + text[end_line_end:]

    if any(
        line.startswith(("<<<<<<< ", "=======", ">>>>>>> "))
        for line in resolved.splitlines()
    ):
        raise SystemExit("Markers remain")

    path.write_text(resolved)
    subprocess.run(["git", "add", FILENAME], check=True)


if __name__ == "__main__":
    main()
