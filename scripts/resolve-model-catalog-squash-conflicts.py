#!/usr/bin/env python3
from pathlib import Path
import subprocess

# Upstream's documentation refresh (25cc5c7bf, v0.87.1) rewrote README.md,
# docs/packages.md, and docs/usage.md wholesale, so all three conflict against
# this patch's doc hunks. The patch only carried wording tweaks whose intent
# upstream now expresses elsewhere (docs/models.md, docs/cli.md); keeping
# upstream's side preserves the new doc structure without losing the feature,
# which lives in code (src/cli/args.ts, src/main.ts, package-manager-cli.ts).
expected = {
    Path("packages/coding-agent/README.md"),
    Path("packages/coding-agent/docs/packages.md"),
    Path("packages/coding-agent/docs/usage.md"),
}
conflicts = {
    Path(path)
    for path in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if conflicts != expected:
    raise SystemExit(f"unexpected model-catalog conflicts: {sorted(map(str, conflicts))}")

for doc in sorted(expected):
    subprocess.run(["git", "checkout", "--ours", "--", str(doc)], check=True)
    subprocess.run(["git", "add", str(doc)], check=True)
