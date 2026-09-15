#!/usr/bin/env python3
"""Preserve release metadata when integrating the independent embedded-Bun patch."""
from pathlib import Path
import subprocess


def main():
    conflicts = subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
    filename = "packages/coding-agent/src/config.ts"
    if conflicts != [filename]:
        raise SystemExit(f"Unexpected embedded-Bun conflicts: {conflicts}")
    path = Path(filename)
    text = path.read_text()
    suffix = "=======\n>>>>>>> origin/patch/use-embedded-bun-package-manager\n"
    for retained in (
        "\t\treleaseTarget?: string;\n",
        "export const RELEASE_TARGET: string | undefined = pkg.piConfig?.releaseTarget;\n",
    ):
        block = "<<<<<<< HEAD\n" + retained + suffix
        if text.count(block) != 1:
            raise SystemExit("Unexpected embedded-Bun metadata conflict shape")
        text = text.replace(block, retained, 1)
    if any(line.startswith(("<<<<<<< ", "=======", ">>>>>>> ")) for line in text.splitlines()):
        raise SystemExit("Unresolved conflict markers remain")
    for required in (
        "\t\tdistribution?: string;",
        "export const DISTRIBUTION: string | undefined = pkg.piConfig?.distribution;",
    ):
        if text.count(required) != 1:
            raise SystemExit("Distribution metadata must exist exactly once")
    path.write_text(text)
    subprocess.run(["git", "add", filename], check=True)


if __name__ == "__main__":
    main()
