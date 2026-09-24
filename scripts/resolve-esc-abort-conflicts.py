#!/usr/bin/env python3
"""Resolve the esc-abort compat-range docs/extensions.md conflict onto
upstream's rewritten extensions doc by re-appending the uninterruptible
message_end paragraph where message lifecycle semantics live."""
from pathlib import Path
import subprocess

expected = {Path("packages/coding-agent/docs/extensions.md")}
conflicts = {
    Path(p)
    for p in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if conflicts != expected:
    raise SystemExit(f"unexpected esc-abort conflicts: {sorted(map(str, conflicts))}")

path = next(iter(expected))
subprocess.run(["git", "checkout", "--ours", "--", str(path)], check=True)
text = path.read_text()
anchor = "`message_end` can replace a finalized message while preserving its role. `tool_call` can mutate input or block execution. `tool_result` handlers compose, with each handler seeing prior changes.\n"
addition = "\nRegister a `message_end` handler with `{ uninterruptible: true }` only for bounded synchronous terminal cleanup that must still run after abort, such as redacting private finalized content. These handlers run separately from ordinary `message_end` handlers; TypeScript rejects async handlers for this registration.\n\n```typescript\npi.on(\"message_end\", (event) => {\n  if (event.message.role !== \"assistant\" || !isPrivateRun(event.message)) return;\n  return { message: { ...event.message, content: [] } };\n}, { uninterruptible: true });\n```\n"
if text.count(anchor) != 1:
    raise SystemExit("unexpected extensions.md message_end anchor")
text = text.replace(anchor, anchor + addition, 1)
path.write_text(text)
subprocess.run(["git", "add", str(path)], check=True)
