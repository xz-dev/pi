#!/usr/bin/env python3
"""Resolve the model-refresh-timeout cherry-pick conflict in main.ts.

The patch sits on patch/model-startup-refresh-barrier and applies after
model-catalog-extension-refresh in sync order. Conflicts arise because
intermediate patches (use-embedded-bun, git-package-storage) changed main.ts
regions we touch: the timeout parameter name and the --refresh block.

Known conflict shapes:
1. modelRuntimeTimeoutMs vs modelRuntimeSignal: startup-refresh-barrier
   renamed the parameter. Ours has `modelRuntimeTimeoutMs: 15_000`, theirs
   has `modelRuntimeSignal: AbortSignal.timeout(...)`. Keep timeoutMs param
   with configurable value.
2. signal timeout on resolveModelScope/refresh calls: ours has
   `signal: AbortSignal.timeout(15_000)`, theirs has getModelRefreshTimeoutMs.
3. --refresh block missing in ours: git-package-storage dropped it, ours
   has plain listModels exit, theirs has full --refresh block. Keep theirs.
"""
from pathlib import Path
import subprocess

FILENAME = "packages/coding-agent/src/main.ts"

HEAD = "<<<<<<< HEAD\n"
SEP = "=======\n"
END = ">>>>>>> "


def extract_conflict(text: str, start: int):
    """Extract ours/theirs from conflict at start. Returns (ours, theirs, end_pos)."""
    sep_idx = text.find(SEP, start)
    end_idx = text.find(END, sep_idx)
    if sep_idx == -1 or end_idx == -1:
        raise SystemExit("Malformed conflict block")
    end_line_end = text.find("\n", end_idx) + 1
    ours = text[start + len(HEAD) : sep_idx]
    theirs = text[sep_idx + len(SEP) : end_idx]
    return ours, theirs, end_line_end


def main():
    conflicts = subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
    if conflicts != [FILENAME]:
        raise SystemExit(f"Unexpected model-refresh-timeout conflicts: {conflicts}")

    path = Path(FILENAME)
    text = path.read_text()

    while True:
        head_idx = text.find(HEAD)
        if head_idx == -1:
            break
        ours, theirs, end_pos = extract_conflict(text, head_idx)

        if "modelRuntimeTimeoutMs" in ours and "modelRuntimeSignal" in theirs:
            # Parameter renamed by startup-refresh-barrier; keep timeoutMs with our value
            if "15_000" not in ours or "getModelRefreshTimeoutMs" not in theirs:
                raise SystemExit("Unexpected timeout param conflict")
            resolution = ours.replace(
                "15_000", "runtimeSettingsManager.getModelRefreshTimeoutMs()"
            )
            text = text[:head_idx] + resolution + text[end_pos:]
        elif "signal: AbortSignal.timeout(15_000)" in ours and "getModelRefreshTimeoutMs" in theirs:
            # Timeout replacement on a signal-using call
            resolution = ours.replace(
                "15_000", "settingsManager.getModelRefreshTimeoutMs()"
            )
            text = text[:head_idx] + resolution + text[end_pos:]
        elif "AbortSignal.timeout(15_000)" in ours and "getModelRefreshTimeoutMs" in theirs:
            # listModels and similar direct-timeout calls
            resolution = ours.replace(
                "15_000", "settingsManager.getModelRefreshTimeoutMs()"
            )
            text = text[:head_idx] + resolution + text[end_pos:]
        elif "refreshFailed" in theirs and "getModelRefreshTimeoutMs" in theirs:
            # --refresh block exists only in theirs; keep it
            text = text[:head_idx] + theirs + text[end_pos:]
        else:
            raise SystemExit(
                f"Unknown conflict shape:\nours={ours[:200]!r}\ntheirs={theirs[:200]!r}"
            )

    if any(
        line.startswith(("<<<<<<< ", "=======", ">>>>>>> "))
        for line in text.splitlines()
    ):
        raise SystemExit("Conflict markers remain in main.ts")

    if "getModelRefreshTimeoutMs()" not in text:
        raise SystemExit("Missing getModelRefreshTimeoutMs")

    path.write_text(text)
    subprocess.run(["git", "add", FILENAME], check=True)
    # Clear cherry-pick state so subsequent merges see a clean sequencer
    subprocess.run(["git", "cherry-pick", "--quit"], check=True)


if __name__ == "__main__":
    main()
