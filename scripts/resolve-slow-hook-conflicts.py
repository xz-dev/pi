#!/usr/bin/env python3
"""Resolve slow-hook-tui-only compat-range doc conflicts onto upstream's
rewritten docs: TUI-only slow-hook diagnostics note in extensions.md and the
slowHookThresholdMs row in settings.md's Network-and-retries table."""
from pathlib import Path
import subprocess

expected = {
    Path("packages/coding-agent/docs/extensions.md"),
    Path("packages/coding-agent/docs/settings.md"),
}
conflicts = {
    Path(p)
    for p in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if conflicts != expected:
    raise SystemExit(f"unexpected slow-hook conflicts: {sorted(map(str, conflicts))}")

ext_path = Path("packages/coding-agent/docs/extensions.md")
subprocess.run(["git", "checkout", "--ours", "--", str(ext_path)], check=True)
e = ext_path.read_text()
anchor = "Release resources in `session_shutdown` even when normal operation attempted cleanup.\n"
addition = "\nIn interactive TUI, Pi shows slow extension handlers as transient notices. Timing diagnostics are not saved to the session, model context, RPC/print events, or disk. During shutdown, the current handler is shown while Pi waits; fast handlers are cleared and only slow handlers remain on the terminal. Outside interactive TUI, these diagnostics are dropped.\n"
if e.count(anchor) != 1:
    raise SystemExit("unexpected extensions.md shutdown anchor")
e = e.replace(anchor, anchor + addition, 1)
ext_path.write_text(e)
subprocess.run(["git", "add", str(ext_path)], check=True)

settings_path = Path("packages/coding-agent/docs/settings.md")
subprocess.run(["git", "checkout", "--ours", "--", str(settings_path)], check=True)
s = settings_path.read_text()
s_anchor = "| `models.refreshTimeoutMs` | number | `60000` | Timeout in milliseconds for model-catalog refresh operations (startup, `--refresh`, `/model`, post-login, `pi update --models`). Set to `0` to disable. |\n"
s_addition = "| `slowHookThresholdMs` | number | `100` | In interactive TUI, show a transient reminder for each registered extension hook taking longer than this many milliseconds. Timing diagnostics are not persisted. |\n"
if s.count(s_anchor) != 1:
    raise SystemExit("unexpected settings.md refreshTimeoutMs anchor")
s = s.replace(s_anchor, s_anchor + s_addition, 1)
settings_path.write_text(s)
subprocess.run(["git", "add", str(settings_path)], check=True)
