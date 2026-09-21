#!/usr/bin/env python3
"""Union the cache-warmer and models-changed hooks when integrating the
model-refresh-session-rebind patch onto the model-startup-refresh-barrier patch.

Both patches insert adjacent private fields/constructor wiring/dispose cleanup
in AgentSession. The textual hunks collide but the semantics compose: keep both
sides. The refresh call sites in bindCore are intentionally removed by the
rebind patch (it replaces manual refresh calls with an onModelsChanged
subscription), so this resolver must NOT resurrect them.
"""
from pathlib import Path
import re
import subprocess

FILENAME = "packages/coding-agent/src/core/agent-session.ts"

# (ours_from_barrier, theirs_from_rebind, union_resolution)
HUNKS = [
    (
        '\tprivate _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;\n',
        "\tprivate _unsubscribeModelsChanged: () => void;\n",
        '\tprivate _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;\n'
        "\tprivate _unsubscribeModelsChanged: () => void;\n",
    ),
    (
        "\t\tthis._cacheWarmer = config.cacheWarmer;\n"
        "\t\tif (this._cacheWarmer) {\n"
        '\t\t\tthis._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });\n'
        "\t\t}\n",
        "\t\tthis._unsubscribeModelsChanged = this._modelRuntime.onModelsChanged(() => this._refreshModelsFromRuntime());\n",
        "\t\tthis._cacheWarmer = config.cacheWarmer;\n"
        "\t\tif (this._cacheWarmer) {\n"
        '\t\t\tthis._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });\n'
        "\t\t}\n"
        "\t\tthis._unsubscribeModelsChanged = this._modelRuntime.onModelsChanged(() => this._refreshModelsFromRuntime());\n",
    ),
]


def resolve_conflict(text: str, ours: str, theirs: str, resolution: str, label: str) -> str:
    pattern = re.compile(
        re.escape("<<<<<<< HEAD\n" + ours + "=======\n" + theirs)
        + r">>>>>>> [^\n]+\n"
    )
    resolved, count = pattern.subn(lambda _: resolution, text)
    if count != 1:
        raise SystemExit(f"Unexpected rebind {label} conflict shape")
    return resolved


def main():
    conflicts = subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
    if conflicts != [FILENAME]:
        raise SystemExit(f"Unexpected rebind conflicts: {conflicts}")

    path = Path(FILENAME)
    text = path.read_text()
    for ours, theirs, resolution in HUNKS:
        text = resolve_conflict(text, ours, theirs, resolution, "agent-session")

    if any(
        line.startswith(("<<<<<<< ", "=======", ">>>>>>> "))
        for line in text.splitlines()
    ):
        raise SystemExit("Conflict markers remain in agent-session.ts")

    # Invariants: both hooks present exactly once; the legacy manual-refresh
    # name must be fully gone (rebind replaced it with onModelsChanged).
    for required in (
        "private _cacheWarmer?:",
        "private _unsubscribeModelsChanged: () => void;",
        "this._modelRuntime.onModelsChanged(() => this._refreshModelsFromRuntime())",
        "private _refreshModelsFromRuntime(): void",
    ):
        if text.count(required) < 1:
            raise SystemExit(f"Missing expected rebind content: {required!r}")
    if "_refreshCurrentModelFromRegistry" in text:
        raise SystemExit("Stale _refreshCurrentModelFromRegistry reference remains")

    path.write_text(text)
    subprocess.run(["git", "add", FILENAME], check=True)


if __name__ == "__main__":
    main()
