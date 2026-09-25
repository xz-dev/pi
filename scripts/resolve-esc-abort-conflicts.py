#!/usr/bin/env python3
"""Resolve esc-abort compat-range conflicts.

Known conflict shapes (any non-empty subset):

1. docs/extensions.md — upstream rewrote the extensions doc; re-append the
   uninterruptible message_end paragraph where message lifecycle semantics
   live (takes --ours = the current tree, then re-appends).

2. test/agent-session-concurrent.test.ts — upstream rewrote the concurrent
   prompt-guard tests (steer/followUp now return "queued") while esc-abort
   carries abort-semantics adaptations of the same tests. The accumulated
   compat tip already contains the hand-merged three-way result, so take
   --theirs (the patch postimage) and sanity-check its content.
"""
from pathlib import Path
import subprocess

EXTENSIONS_DOC = Path("packages/coding-agent/docs/extensions.md")
CONCURRENT_TEST = Path("packages/coding-agent/test/agent-session-concurrent.test.ts")
ALLOWED = {EXTENSIONS_DOC, CONCURRENT_TEST}

conflicts = {
    Path(p)
    for p in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if not conflicts or not conflicts <= ALLOWED:
    raise SystemExit(f"unexpected esc-abort conflicts: {sorted(map(str, conflicts))}")


def resolve_extensions_doc() -> None:
    subprocess.run(["git", "checkout", "--ours", "--", str(EXTENSIONS_DOC)], check=True)
    text = EXTENSIONS_DOC.read_text()
    anchor = "`message_end` can replace a finalized message while preserving its role. `tool_call` can mutate input or block execution. `tool_result` handlers compose, with each handler seeing prior changes.\n"
    addition = "\nRegister a `message_end` handler with `{ uninterruptible: true }` only for bounded synchronous terminal cleanup that must still run after abort, such as redacting private finalized content. These handlers run separately from ordinary `message_end` handlers; TypeScript rejects async handlers for this registration.\n\n```typescript\npi.on(\"message_end\", (event) => {\n  if (event.message.role !== \"assistant\" || !isPrivateRun(event.message)) return;\n  return { message: { ...event.message, content: [] } };\n}, { uninterruptible: true });\n```\n"
    if text.count(anchor) != 1:
        raise SystemExit("unexpected extensions.md message_end anchor")
    text = text.replace(anchor, anchor + addition, 1)
    EXTENSIONS_DOC.write_text(text)
    subprocess.run(["git", "add", str(EXTENSIONS_DOC)], check=True)


def resolve_concurrent_test() -> None:
    # The compat tip's postimage is the hand-merged three-way result: upstream's
    # rewrite (steer/followUp resolve to "queued") plus esc-abort's abort-drain
    # adaptations (releaseFirst) and esc-abort's own abort tests.
    subprocess.run(["git", "checkout", "--theirs", "--", str(CONCURRENT_TEST)], check=True)
    text = CONCURRENT_TEST.read_text()
    if any(marker in text for marker in ("<<<<<<<", "=======\n", ">>>>>>>")):
        raise SystemExit("agent-session-concurrent.test.ts postimage still has conflict markers")
    for required in ('resolves.toBe("queued")', "releaseFirst", "uninterruptible"):
        if required not in text:
            raise SystemExit(f"agent-session-concurrent.test.ts postimage missing {required!r}")
    subprocess.run(["git", "add", str(CONCURRENT_TEST)], check=True)


for path in sorted(conflicts):
    if path == EXTENSIONS_DOC:
        resolve_extensions_doc()
    else:
        resolve_concurrent_test()
