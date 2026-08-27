#!/usr/bin/env python3
from pathlib import Path
import subprocess

expected = {Path("packages/coding-agent/README.md")}
conflicts = {
    Path(path)
    for path in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if conflicts != expected:
    raise SystemExit(f"unexpected model-catalog conflicts: {sorted(map(str, conflicts))}")

path = next(iter(expected))
text = path.read_text()
start = "<" * 7
middle = "=" * 7
end = ">" * 7
conflict = f'''{start} HEAD
For each built-in provider, pi maintains a list of tool-capable models. Configured provider catalogs refresh automatically; run `pi update --models` to force an immediate refresh. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L). Press Ctrl+S in the model picker to save the highlighted model as the startup default.
{middle}
For each built-in provider, pi maintains a list of tool-capable models. Configured built-in catalogs refresh automatically; run `pi update --models` to force the Pi-managed catalogs available without loading extensions to refresh. To load extension providers, refresh every loaded provider, and print the resulting list, run `pi --list-models --refresh`. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).
{end} origin/patch/model-catalog-extension-refresh'''
resolution = '''For each built-in provider, pi maintains a list of tool-capable models. Configured built-in catalogs refresh automatically; run `pi update --models` to force the Pi-managed catalogs available without loading extensions to refresh. To load extension providers, refresh every loaded provider, and print the resulting list, run `pi --list-models --refresh`. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L). Press Ctrl+S in the model picker to save the highlighted model as the startup default.'''
if text.count(conflict) != 1:
    raise SystemExit("unexpected model-catalog README conflict shape")
path.write_text(text.replace(conflict, resolution))
subprocess.run(["git", "add", str(path)], check=True)
