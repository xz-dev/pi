#!/usr/bin/env python3
"""Preserve release metadata when integrating the independent embedded-Bun patch,
and append its package-manager docs to upstream's refreshed doc structure."""
from pathlib import Path
import subprocess


def main():
    conflicts = {
        Path(p)
        for p in subprocess.check_output(
            ["git", "diff", "--name-only", "--diff-filter=U"], text=True
        ).splitlines()
    }
    expected = {
        Path("packages/coding-agent/docs/packages.md"),
        Path("packages/coding-agent/docs/settings.md"),
        Path("packages/coding-agent/src/config.ts"),
    }
    if conflicts != expected:
        raise SystemExit(f"Unexpected embedded-Bun conflicts: {sorted(map(str, conflicts))}")

    # Docs: upstream's refresh rewrote both files, and the patch now carries
    # the downstream docs text already. Keep the patch side verbatim.
    for doc in (
        "packages/coding-agent/docs/settings.md",
        "packages/coding-agent/docs/packages.md",
    ):
        subprocess.run(["git", "checkout", "--theirs", "--", doc], check=True)
        subprocess.run(["git", "add", doc], check=True)

    # config.ts: unchanged from the original resolver — keep releaseTarget,
    # accept distribution from the patch.
    path = Path("packages/coding-agent/src/config.ts")
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
    subprocess.run(["git", "add", str(path)], check=True)

    # package-manager.ts: upstream's rewritten getPackageManagerName is now
    # textually compatible with the patch, so this file merges cleanly on the
    # current upstream tip. If it ever conflicts again, merge upstream's
    # wrapper-aware body plus the patch's embeddedBun short-circuit.
    pm = Path("packages/coding-agent/src/core/package-manager.ts")
    pm_text = pm.read_text()
    marker = "<<<<<<< HEAD\n"
    end_marker = ">>>>>>> origin/patch/use-embedded-bun-package-manager\n"
    if marker in pm_text:
        start = pm_text.index(marker)
        end = pm_text.index(end_marker, start) + len(end_marker)
        upstream_body = (
            "\t\tif (npmCommand.embeddedBun) return \"bun\";\n"
            "\t\tconst normalizeCommandName = (command: string): string => basename(command).replace(/\\.(cmd|exe)$/i, \"\");\n"
            "\t\tconst supportedPackageManagers = new Set([\"npm\", \"pnpm\", \"bun\"]);\n"
            "\t\tconst directCommand = normalizeCommandName(npmCommand.command);\n"
            "\t\tconst separatorIndex = npmCommand.args.lastIndexOf(\"--\");\n"
            "\t\tif (separatorIndex >= 0) {\n"
            "\t\t\tconst wrappedCommand = npmCommand.args[separatorIndex + 1];\n"
            "\t\t\treturn wrappedCommand ? normalizeCommandName(wrappedCommand) : directCommand;\n"
            "\t\t}\n"
            "\t\tif (supportedPackageManagers.has(directCommand)) return directCommand;\n"
            "\n"
            "\t\tconst wrappedPackageManagers = [\n"
            "\t\t\t...new Set(\n"
            "\t\t\t\tnpmCommand.args.map(normalizeCommandName).filter((command) => supportedPackageManagers.has(command)),\n"
            "\t\t\t),\n"
            "\t\t];\n"
            "\t\tif (wrappedPackageManagers.length > 1) {\n"
            "\t\t\tthrow new Error(`Ambiguous npmCommand package managers: ${wrappedPackageManagers.join(\", \")}`);\n"
            "\t\t}\n"
            "\t\treturn wrappedPackageManagers[0] ?? directCommand;\n"
        )
        pm_text = pm_text[:start] + upstream_body + pm_text[end:]
        if pm_text.count(marker) or pm_text.count(end_marker):
            raise SystemExit("package-manager.ts conflict markers remain")
        pm.write_text(pm_text)
        subprocess.run(["git", "add", str(pm)], check=True)

    # package-manager.test.ts: only rewrite the interface declaration if the
    # merge left conflict markers; on current upstream it merges cleanly.
    test_path = Path("packages/coding-agent/test/package-manager.test.ts")
    test_text = test_path.read_text()
    if marker in test_text:
        start = test_text.index(marker)
        end = test_text.index(end_marker, start) + len(end_marker)
        merged_iface = (
            "\tgetPackageManagerName(): string;\n"
            "\tgetGitDependencyInstallArgs(): string[];\n"
            "\tgetNpmCommand(): { command: string; args: string[]; embeddedBun?: boolean };\n"
            "\tgetGlobalNpmRoot(): string;\n"
            "\tgetLatestNpmVersion(packageSpec: string, range?: string): Promise<string>;\n"
            "\trunNpmCommand(args: string[], options?: { cwd?: string }): Promise<void>;\n"
            "\trunNpmCommandSync(args: string[]): string;\n"
            "\trunCommandSync(command: string, args: string[], env?: Record<string, string>): string;\n"
            "\trunCommand(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<void>;\n"
        )
        test_text = test_text[:start] + merged_iface + test_text[end:]
        if test_text.count(marker) or test_text.count(end_marker):
            raise SystemExit("package-manager.test.ts conflict markers remain")
        test_path.write_text(test_text)
        subprocess.run(["git", "add", str(test_path)], check=True)


if __name__ == "__main__":
    main()
