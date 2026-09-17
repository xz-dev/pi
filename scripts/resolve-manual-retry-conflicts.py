#!/usr/bin/env python3
"""Preserve system-message persistence while integrating manual retry commits."""
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
ours = '''\t\t\t\tevent.message.role === "system" ||
\t\t\t\tevent.message.role === "user" ||
\t\t\t\tevent.message.role === "assistant" ||
\t\t\t\tevent.message.role === "toolResult"
'''
theirs = '''\t\t\t\t!committedFirstRetryAssistant &&
\t\t\t\t!(
\t\t\t\t\tevent.message.role === "assistant" &&
\t\t\t\t\tthis._manualRetryCommit?.runFailedBeforeCommit &&
\t\t\t\t\t!this._manualRetryCommit.committed
\t\t\t\t) &&
\t\t\t\t(event.message.role === "user" || event.message.role === "assistant" || event.message.role === "toolResult")
'''
resolution = '''\t\t\t\t!committedFirstRetryAssistant &&
\t\t\t\t!(
\t\t\t\t\tevent.message.role === "assistant" &&
\t\t\t\t\tthis._manualRetryCommit?.runFailedBeforeCommit &&
\t\t\t\t\t!this._manualRetryCommit.committed
\t\t\t\t) &&
\t\t\t\t(event.message.role === "system" ||
\t\t\t\t\tevent.message.role === "user" ||
\t\t\t\t\tevent.message.role === "assistant" ||
\t\t\t\t\tevent.message.role === "toolResult")
'''
pattern = re.compile(
    re.escape("<<<<<<< HEAD\n" + ours + "=======\n" + theirs)
    + r">>>>>>> [^\n]+\n"
)
text, count = pattern.subn(lambda _: resolution, text)
if count != 1:
    raise SystemExit("Unexpected manual-retry persistence conflict shape")
if any(line.startswith(("<<<<<<< ", "=======", ">>>>>>> ")) for line in text.splitlines()):
    raise SystemExit("Manual-retry conflict markers remain")
path.write_text(text)
subprocess.run(["git", "add", filename], check=True)
