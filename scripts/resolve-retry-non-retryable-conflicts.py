#!/usr/bin/env python3
"""Union resolve for retry-non-retryable-patterns squash conflicts.

The patch adds retry.nonRetryableErrorPatterns docs + settings-manager code
adjacent to other downstream additions (model-refresh-timeout adds models.*,
slow-hook adds slowHookThresholdMs, skill-overrides adds skillOverrides).
All sides are independent insertions — keep both.
"""
from pathlib import Path
import subprocess

HEAD = "<<<<<<< HEAD\n"
SEP = "=======\n"
END = ">>>>>>> "

CONFLICT_FILES = {
    "packages/coding-agent/docs/settings.md",
    "packages/coding-agent/src/core/settings-manager.ts",
    "packages/coding-agent/src/core/agent-session.ts",
    "packages/coding-agent/src/core/extensions/runner.ts",
}


def union_resolve(text: str) -> str:
    """Replace every conflict block with ours+theirs concatenated."""
    while True:
        head_idx = text.find(HEAD)
        if head_idx == -1:
            break
        sep_idx = text.find(SEP, head_idx)
        end_idx = text.find(END, sep_idx)
        if sep_idx == -1 or end_idx == -1:
            raise SystemExit("Malformed conflict block")
        end_line_end = text.find("\n", end_idx) + 1
        ours = text[head_idx + len(HEAD) : sep_idx]
        theirs = text[sep_idx + len(SEP) : end_idx]
        # Union: keep both sides' new content (ours first for stability)
        text = text[:head_idx] + ours + theirs + text[end_line_end:]
    return text


def main():
    conflicts = set(
        subprocess.check_output(
            ["git", "diff", "--name-only", "--diff-filter=U"], text=True
        ).splitlines()
    )
    unexpected = conflicts - CONFLICT_FILES
    if unexpected:
        raise SystemExit(f"Unexpected conflict files: {unexpected}")

    for rel in conflicts:
        path = Path(rel)
        text = path.read_text()
        resolved = union_resolve(text)
        if any(
            line.startswith(("<<<<<<< ", "=======", ">>>>>>> "))
            for line in resolved.splitlines()
        ):
            raise SystemExit(f"Markers remain in {rel}")
        path.write_text(resolved)
        subprocess.run(["git", "add", rel], check=True)


if __name__ == "__main__":
    main()
