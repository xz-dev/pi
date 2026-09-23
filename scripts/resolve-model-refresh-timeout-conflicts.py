#!/usr/bin/env python3
from pathlib import Path
import subprocess

# The model-refresh-timeout compat range carries a single docs/settings.md row
# anchored under `websocketConnectTimeoutMs`. Upstream's doc refresh rewrote
# settings.md wholesale and moved network knobs into a "Network and retries"
# table, so git apply --3way leaves a conflicted hunk. Resolution: append the
# models.refreshTimeoutMs row to upstream's Network-and-retries table (after
# websocketConnectTimeoutMs), preserving upstream wording.
expected = {Path("packages/coding-agent/docs/settings.md")}
conflicts = {
    Path(path)
    for path in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if conflicts != expected:
    raise SystemExit(f"unexpected model-refresh-timeout conflicts: {sorted(map(str, conflicts))}")

path = next(iter(expected))
text = path.read_text()
row = "| `models.refreshTimeoutMs` | number | `60000` | Timeout in milliseconds for model-catalog refresh operations (startup, `--refresh`, `/model`, post-login, `pi update --models`). Set to `0` to disable. |"
anchor = "| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connection timeout in milliseconds. Set to `0` to disable. |"
if row in text:
    raise SystemExit("models.refreshTimeoutMs row already present")
if text.count(anchor) != 1:
    raise SystemExit("unexpected settings.md anchor count")
text = text.replace(anchor, anchor + "\n" + row, 1)
if any(line.startswith(("<", "=", ">")) for line in text.splitlines()):
    raise SystemExit("unexpected residual conflict markers in settings.md")
path.write_text(text)
subprocess.run(["git", "add", str(path)], check=True)
