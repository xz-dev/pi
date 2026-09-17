#!/usr/bin/env python3
"""Preserve upstream pi-ai imports when integrating run-failure events."""
from pathlib import Path
import subprocess


def main():
    filename = "packages/agent/src/agent.ts"
    conflicts = subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
    if conflicts != [filename]:
        raise SystemExit(f"Unexpected agent run-failure seam conflicts: {conflicts}")

    subprocess.run(["git", "checkout", "--ours", "--", filename], check=True)
    path = Path(filename)
    text = path.read_text()
    old = (
        '\t\t} satisfies AgentMessage;\n'
        '\t\tawait this.processEvents({ type: "message_start", message: failureMessage });\n'
    )
    new = (
        '\t\t} satisfies AssistantMessage;\n'
        '\t\tawait this.processEvents({ type: "run_failure", message: failureMessage });\n'
        '\t\tawait this.processEvents({ type: "message_start", message: failureMessage });\n'
    )
    if text.count(old) != 1:
        raise SystemExit("Unexpected agent run-failure seam shape")
    text = text.replace(old, new, 1)
    path.write_text(text)
    subprocess.run(["git", "add", filename], check=True)


if __name__ == "__main__":
    main()
