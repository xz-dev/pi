#!/usr/bin/env python3
"""Union resolve for retry-non-retryable-patterns squash conflicts.

The patch adds retry.nonRetryableErrorPatterns docs + settings-manager code.
Conflicts with other downstream patches that insert adjacent content:
- model-refresh-timeout: models.refreshTimeoutMs (settings.md row + methods)
- slow-hook-tui-only: slowHookThresholdMs (settings.md row + getter)
- skill-overrides: skillOverrides (settings-manager field + methods)

Resolution strategy: settings.md is a table — union both rows.
settings-manager.ts: conflicts are adjacent method insertions — keep both
sides' complete methods (ours first, then theirs, preserving order).
"""
from pathlib import Path
import subprocess

HEAD = "<<<<<<< HEAD\n"
SEP = "=======\n"
END = ">>>>>>> "


def union_resolve_table(text: str) -> str:
    """For markdown table files: union both sides' rows."""
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
        text = text[:head_idx] + ours + theirs + text[end_line_end:]
    return text


def union_resolve_methods(text: str) -> str:
    """For TS files: union both sides' complete method blocks."""
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
        # If both sides define the same method, theirs wins (patch intent)
        if "getRetrySettings" in ours and "getRetrySettings" in theirs:
            text = text[:head_idx] + theirs + text[end_line_end:]
        else:
            # Keep both complete blocks; ours first, then theirs
            text = text[:head_idx] + ours + theirs + text[end_line_end:]
    return text


def main():
    conflicts = set(
        subprocess.check_output(
            ["git", "diff", "--name-only", "--diff-filter=U"], text=True
        ).splitlines()
    )
    allowed = {
        "packages/coding-agent/docs/settings.md",
        "packages/coding-agent/src/core/settings-manager.ts",
    }
    unexpected = conflicts - allowed
    if unexpected:
        raise SystemExit(f"Unexpected conflict files: {unexpected}")

    for rel in conflicts:
        path = Path(rel)
        text = path.read_text()
        if rel.endswith(".md"):
            resolved = union_resolve_table(text)
        else:
            resolved = union_resolve_methods(text)
        if any(
            line.startswith(("<<<<<<< ", "=======", ">>>>>>> "))
            for line in resolved.splitlines()
        ):
            raise SystemExit(f"Markers remain in {rel}")
        path.write_text(resolved)
        subprocess.run(["git", "add", rel], check=True)


if __name__ == "__main__":
    main()
