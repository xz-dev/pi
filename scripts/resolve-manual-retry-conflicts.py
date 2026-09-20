#!/usr/bin/env python3
"""Preserve system-message persistence while integrating manual retry commits.

The manual-retry apply-3way produces conflicts in agent-session.ts whose exact
shape depends on what prior patches (mte, esc) already installed. Two known
sites:

1. The persistence role filter — keep the manual-retry guard clause but restore
   the system/user/assistant/toolResult role list.
2. Run-state field initialization — theirs adds _agentRunAbortRequested and
   continuationAnchorId/continuationBranchLeafId lines; union both sides.

Any other block falls back to union-with-dedup, which is safe here because the
conflicts are always "both sides add adjacent wiring lines" rather than true
content forks.
"""
from pathlib import Path
import re
import subprocess

filename = "packages/coding-agent/src/core/agent-session.ts"
conflicts = subprocess.check_output(
    ["git", "diff", "--name-only", "--diff-filter=U"], text=True
).splitlines()
if conflicts != [filename]:
    raise SystemExit(f"Unexpected manual-retry conflicts: {conflicts}")

path = Path(filename)
text = path.read_text()

pattern = re.compile(
    r"<<<<<<< (?:HEAD|ours)\n(.*?)=======\n(.*?)>>>>>>> [^\n]+\n", re.S
)


def union_block(ours: str, theirs: str) -> str:
    ours_lines = set(ours.splitlines())
    theirs_extra = "".join(
        line + "\n" for line in theirs.splitlines() if line not in ours_lines
    )
    return ours + theirs_extra


def resolve_block(m: re.Match) -> str:
    ours, theirs = m.group(1), m.group(2)

    # Persistence role-filter site: theirs carries the committedFirstRetryAssistant
    # guard plus a user/assistant/toolResult role list; ours carries the same list
    # with system included. Keep the guard and restore the four-role list.
    if "committedFirstRetryAssistant" in theirs:
        indent = "\t" * 4
        roles = (
            '(event.message.role === "system" ||\n'
            f"{indent}\tevent.message.role === \"user\" ||\n"
            f"{indent}\tevent.message.role === \"assistant\" ||\n"
            f"{indent}\tevent.message.role === \"toolResult\")"
        )
        # theirs ends with the role condition; replace it with the full list.
        guard_head = theirs[: theirs.index("(event.message.role")]
        return guard_head + roles + "\n"

    # Run-state field init: union (theirs adds mr fields; ours may add others).
    return union_block(ours, theirs)


text, count = pattern.subn(resolve_block, text)
if count < 1:
    raise SystemExit("No conflict blocks found in agent-session.ts")
if any(line.startswith(("<<<<<<< ", "=======", ">>>>>>> ")) for line in text.splitlines()):
    raise SystemExit("Manual-retry conflict markers remain")
path.write_text(text)
subprocess.run(["git", "add", filename], check=True)
