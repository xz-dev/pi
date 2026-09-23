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

    # Docs: upstream's refresh rewrote both files. The patch's docs additions
    # describe real downstream behavior (embedded Bun as default package
    # manager), so re-append the section to upstream's structure instead of
    # reverting to the patch's pre-rewrite text.
    settings_path = Path("packages/coding-agent/docs/settings.md")
    subprocess.run(["git", "checkout", "--ours", "--", str(settings_path)], check=True)
    settings = settings_path.read_text()
    settings_anchor = "| `npmCommand` | `string[]` | `npm` | Command and arguments used for npm package lookup and installation. |"
    settings_replacement = "| `npmCommand` | `string[]` | `npm` (distribution default) | Command argv for extension package-manager operations (e.g., `[\"mise\", \"exec\", \"node@20\", \"--\", \"npm\"]`); takes precedence over the embedded Bun default in xz-dev Bun-compiled standalone builds. |"
    settings_addition = "\nWith `npmCommand` unset or `[]`, only xz-dev Bun-compiled standalone Pi defaults to embedded Bun via public `pi` on `PATH`, even if npm is available. `BUN_BE_BUN=1` is added only to those package-manager children, never to explicit overrides. Other installations default to npm. Set `\"npmCommand\": [\"npm\"]` to use external npm; `[\"\"]` is invalid. This does not change Pi self-update. See [Pi Packages](packages.md) for PATH requirements and Bun's registry, lockfile, script, and native-dependency compatibility limits.\n"
    if settings.count(settings_anchor) != 1:
        raise SystemExit("unexpected settings.md npmCommand anchor")
    settings = settings.replace(settings_anchor, settings_replacement + settings_addition, 1)
    settings_path.write_text(settings)
    subprocess.run(["git", "add", str(settings_path)], check=True)

    packages_path = Path("packages/coding-agent/docs/packages.md")
    subprocess.run(["git", "checkout", "--ours", "--", str(packages_path)], check=True)
    packages = packages_path.read_text()
    section_anchor = "## Choose a source\n"
    section = """## Package-manager selection

A non-empty `npmCommand` array overrides the package manager, preserving executable and wrapper arguments. An empty array selects the default; `[""]` is invalid.

Only the **xz-dev Bun-compiled standalone distribution** defaults to its embedded Bun. It invokes public `pi` through inherited `PATH`, adding `BUN_BE_BUN=1` only to package-manager child processes. This default applies even when npm is installed. Other distributions and source/npm installations retain npm, including source runs under Bun. This selection does not change Pi self-update.

Keep a compatible public `pi` on `PATH`. The first matching wrapper or installation wins, even if it differs from the one that launched the session. Launching Pi by absolute path does not bypass this requirement. A missing or failing entry produces an error; Pi does not fall back to npm or invoke `pi-native` directly.

To use an installed external manager instead:

```json
{ "npmCommand": ["npm"] }
```

Explicit `npmCommand` commands receive no injected embedded-Bun flag. Wrappers remain supported, for example `["mise", "exec", "node@20", "--", "npm"]`. Recognized Bun commands use `info` for version queries instead of npm's `view`. The embedded default uses `bun update` for managed npm updates so compatible newer versions are resolved instead of retaining the installed lockfile version; configured source selectors remain unchanged. If a configured package is missing from the managed npm project's dependency declarations, Pi first installs that package with its configured selector, then updates the batch. This repairs settings/manifest drift instead of asking Bun to update an undeclared package.

User, trusted-project, and temporary package locations are unchanged. Git remains separately required for Git sources. Bun compatibility is not npm equivalence: registry/`.npmrc` handling, lockfiles, lifecycle scripts, and native dependencies can differ. Pi does not add blanket script trust or install missing native build tools. Use an explicit compatible `npmCommand` when needed; switching managers does not undo lockfile or dependency changes.

For npm v2/v3 lockfile migration, the embedded default temporarily omits npm packing integrity values only for Git dependencies whose `resolved` URL pins a full 40-character commit. Bun downloads a different Git archive and cannot use those packing hashes. Pi restores the original `package-lock.json` bytes after success or failure and serializes these temporary edits. Registry and HTTP tarball integrity checks remain enabled; Pi never adds `--no-verify`. Existing `bun.lock`/`bun.lockb`, npm shrinkwrap files, unpinned Git entries, and explicit package-manager overrides are unchanged. The compatibility path relies on the Git commit pin rather than the npm tarball hash. Forced process termination can interrupt restoration.

Official Bun 1.4.2 rejects metadata queries from a working directory without `package.json`. If the embedded default cannot verify an installed package's target version, Pi prints the lookup error and warns that continuing with Bun may downgrade the package, then attempts the requested update. Successful version queries still skip equal or older targets, and exact pins remain pinned. Availability checks omit failed lookups. Pi does not create a project manifest, change the query directory, or switch managers. Explicit overrides and other installations retain their existing lookup-error policy.

"""
    if packages.count(section_anchor) != 1:
        raise SystemExit("unexpected packages.md section anchor")
    packages = packages.replace(section_anchor, section + section_anchor, 1)
    packages_path.write_text(packages)
    subprocess.run(["git", "add", str(packages_path)], check=True)

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


if __name__ == "__main__":
    main()
