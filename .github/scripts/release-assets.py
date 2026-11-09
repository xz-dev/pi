# SPDX-License-Identifier: BSD-3-Clause
"""Validate release eligibility and frozen bytes, without publication credentials."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib
import zipfile

TARGETS = (
    "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl",
    "riscv64gc-unknown-linux-gnu", "riscv64gc-unknown-linux-musl",
    "x86_64-unknown-freebsd", "aarch64-unknown-freebsd",
    "x86_64-apple-darwin", "aarch64-apple-darwin",
    "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc",
)


def eligible(event, ref, version):
    if event == "workflow_dispatch":
        return False
    if event != "push" or not re.fullmatch(r"refs/tags/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", ref):
        raise ValueError("publication requires an exact stable vX.Y.Z tag push")
    if ref != f"refs/tags/v{version}":
        raise ValueError("tag does not match Cargo.toml package version")
    return True


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assets(root):
    expected = {f"procward-{target}{flavour}.zip" for target in TARGETS for flavour in ("", "-debug")}
    found = {path.name: path for path in root.glob("*/*.zip")}
    if set(found) != expected or len(list(root.glob("*/*.zip"))) != len(expected):
        raise ValueError(f"missing, duplicate or unexpected packages: {expected ^ set(found)}")
    for target in TARGETS:
        extension = ".exe" if "windows" in target else ""
        for flavour in ("", "-debug"):
            path = found[f"procward-{target}{flavour}.zip"]
            binary = root / target / f"procward{flavour}{extension}"
            with zipfile.ZipFile(path) as bundle:
                symbols = []
                if flavour and "windows" in target:
                    symbols = [root / target / "procward.pdb"]
                elif flavour and "darwin" in target:
                    symbols = sorted(path for path in (root / target / "procward.dSYM").rglob("*") if path.is_file())
                    if not symbols:
                        raise ValueError(f"missing debug dSYM: {target}")
                expected_files = {f"procward{extension}", "LICENSE", "README.md", "third-party-licenses.md"}
                expected_files.update(str(path.relative_to(root / target)).replace("\\", "/") for path in symbols)
                if set(bundle.namelist()) != expected_files or len(bundle.namelist()) != len(expected_files) or bundle.testzip():
                    raise ValueError(f"invalid package contents: {path}")
                for symbol in symbols:
                    name = str(symbol.relative_to(root / target)).replace("\\", "/")
                    if bundle.read(name) != symbol.read_bytes():
                        raise ValueError(f"packaged debug symbols differ: {symbol}")
                if bundle.read(f"procward{extension}") != binary.read_bytes():
                    raise ValueError(f"packaged binary differs from provenance subject: {path}")
                for source, name in [("LICENSE", "LICENSE"), ("README.md", "README.md"), ("docs/third-party-licenses.md", "third-party-licenses.md")]:
                    if bundle.read(name) != Path(source).read_bytes():
                        raise ValueError(f"wrong distribution document: {path}/{name}")
    return found


def manifest(root, write=False):
    found = assets(root)
    expected = "".join(f"{digest(found[name])}  {name}\n" for name in sorted(found))
    checksum = root / "SHA256SUMS"
    if write:
        checksum.write_text(expected)
    elif checksum.read_text() != expected:
        raise ValueError("SHA256SUMS mismatch: frozen assets changed")
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("event", "manifest", "verify"))
    parser.add_argument("--root", type=Path, default=Path("artifacts"))
    args = parser.parse_args()
    if args.command == "event":
        version = tomllib.loads(Path("Cargo.toml").read_text())["package"]["version"]
        publish = eligible(os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REF"], version)
        if publish:
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
            tag = subprocess.check_output(["git", "rev-parse", os.environ["GITHUB_REF"] + "^{commit}"], text=True).strip()
            if head != tag or head != os.environ["GITHUB_SHA"]:
                raise ValueError("checkout, tag commit and event SHA differ")
        print(f"publish={str(publish).lower()}; version={version}")
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"publish={str(publish).lower()}\nversion={version}\n")
    else:
        found = manifest(args.root, write=args.command == "manifest")
        print(f"Verified {len(found)} packages and their exact embedded binary/licence/readme bytes")
        if args.command == "manifest":
            summary = "## Frozen release assets\n\n| Target | Release zip bytes | Debug zip bytes |\n| --- | ---: | ---: |\n"
            for target in TARGETS:
                summary += f"| {target} | {found[f'procward-{target}.zip'].stat().st_size} | {found[f'procward-{target}-debug.zip'].stat().st_size} |\n"
            print(summary)
            if os.environ.get("GITHUB_STEP_SUMMARY"):
                with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
                    output.write(summary)


if __name__ == "__main__":
    main()
