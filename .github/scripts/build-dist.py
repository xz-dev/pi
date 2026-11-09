# SPDX-License-Identifier: BSD-3-Clause
"""Build size-first distributions; measure startup without making it a gate."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import statistics
import subprocess
import sys
import time
import zipfile


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def startup(binary, runner):
    if sys.platform.startswith('linux'):
        run(sys.executable, 'ci/linux-test-guard.py', '--check-only')
    command = shlex.split(runner) + [str(binary.resolve()), "--version"]
    samples = []
    for index in range(24):
        start = time.perf_counter_ns()
        run(*command, stdout=subprocess.DEVNULL)
        if index >= 3:
            samples.append((time.perf_counter_ns() - start) / 1_000_000)
    return statistics.median(samples)


def dependencies(binary, target):
    if "windows" in target:
        vswhere = Path(os.environ["ProgramFiles(x86)"]) / "Microsoft Visual Studio/Installer/vswhere.exe"
        install = subprocess.check_output([str(vswhere), "-latest", "-products", "*", "-property", "installationPath"], text=True).strip()
        tools = sorted(Path(install).glob("VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe"))
        if not tools:
            tools = sorted(Path(install).glob("VC/Tools/MSVC/*/bin/Hostarm64/arm64/dumpbin.exe"))
        text = subprocess.check_output([str(tools[-1]), "/DEPENDENTS", str(binary)], text=True)
        if re.search(r"(?:vcruntime|msvcp|ucrtbase|api-ms-win-crt)[^\s]*\.dll", text, re.I):
            raise RuntimeError(f"dynamic CRT dependency in {binary}:\n{text}")
    elif "darwin" in target:
        text = subprocess.check_output(["otool", "-L", str(binary)], text=True)
        for line in text.splitlines()[1:]:
            if not line.strip().startswith(("/usr/lib/", "/System/Library/")):
                raise RuntimeError(f"non-system dependency in {binary}: {line}")
    else:
        text = subprocess.check_output(["readelf", "-l", "-d", str(binary)], text=True)
        if "musl" in target:
            if "NEEDED" in text or "INTERP" in text:
                raise RuntimeError(f"musl binary is not fully static: {binary}\n{text}")
        else:
            allowed = {"libc.so.6", "libgcc_s.so.1", "libm.so.6", "libpthread.so.0", "libdl.so.2", "librt.so.1", "libutil.so.7", "libthr.so.3", "libc.so.7", "ld-linux-x86-64.so.2", "ld-linux-aarch64.so.1", "ld-linux-riscv64-lp64d.so.1"}
            needed = re.findall(r"\(NEEDED\).*\[([^]]+)\]", text)
            if set(needed) - allowed:
                raise RuntimeError(f"unexpected dynamic dependency in {binary}: {needed}")
    print(f"Dependencies: {binary}\n{text}", flush=True)
    return text


def debug_symbols(binary, target):
    if "windows" in target:
        symbols = binary.with_suffix(".pdb")
        if not symbols.is_file() or symbols.stat().st_size < 1024:
            raise RuntimeError(f"missing or empty debug PDB: {symbols}")
        print(f"Debug PDB: {symbols}, {symbols.stat().st_size} bytes")
    elif "darwin" in target:
        symbols = binary.with_name(binary.name + ".dSYM")
        uuid = subprocess.check_output(["dwarfdump", "--uuid", str(binary)], text=True).split()[1]
        if not symbols.exists():
            # Cargo can leave packed symbols beside the hashed executable in deps/.
            for candidate in sorted((binary.parent / "deps").glob("procward-*.dSYM")):
                candidate_uuid = subprocess.check_output(["dwarfdump", "--uuid", str(candidate)], text=True).split()[1]
                if candidate_uuid == uuid:
                    shutil.copytree(candidate, symbols)
                    break
        dwarf_files = list((symbols / "Contents/Resources/DWARF").glob("*"))
        if not dwarf_files or not any(path.stat().st_size >= 1024 for path in dwarf_files):
            raise RuntimeError(f"missing debug dSYM for UUID {uuid}: {symbols}; candidates={list(binary.parent.rglob('*.dSYM'))}")
        if subprocess.check_output(["dwarfdump", "--uuid", str(symbols)], text=True).split()[1] != uuid:
            raise RuntimeError(f"debug dSYM UUID differs from executable: {symbols}")
        run("dwarfdump", "--verify", str(symbols))
    else:
        symbols = None
        sections = subprocess.check_output(["readelf", "-S", str(binary)], text=True)
        if ".debug_info" not in sections or ".debug_line" not in sections:
            raise RuntimeError(f"missing embedded debug DWARF: {binary}")
    return symbols


def package(binary, target, debug, output):
    suffix = "-debug" if debug else ""
    frozen = output / ("procward" + suffix + binary.suffix)
    shutil.copy2(binary, frozen)
    symbols = None
    if debug and ("windows" in target or "darwin" in target):
        source = binary.with_suffix(".pdb") if "windows" in target else binary.with_name(binary.name + ".dSYM")
        symbols = output / source.name
        if source.is_dir():
            shutil.copytree(source, symbols, dirs_exist_ok=True)
        else:
            shutil.copy2(source, symbols)
    archive = output / f"procward-{target}{suffix}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        bundle.write(frozen, binary.name)
        if symbols:
            for path in sorted(symbols.rglob("*")) if symbols.is_dir() else [symbols]:
                if path.is_file():
                    bundle.write(path, path.relative_to(output))
        for source, name in [("LICENSE", "LICENSE"), ("README.md", "README.md"), ("docs/third-party-licenses.md", "third-party-licenses.md")]:
            bundle.write(source, name)
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None or bundle.read(binary.name) != frozen.read_bytes():
            raise RuntimeError(f"zip round trip failed: {archive}")
    print(f"{archive}: {archive.stat().st_size} bytes", flush=True)
    return archive.stat().st_size


def tested_measurement(binary, output):
    report = json.loads((output / "measurements.json").read_text())
    if hashlib.sha256(binary.read_bytes()).hexdigest() != report["dist_sha256"]:
        raise RuntimeError("dist binary changed between measurement, fixtures and packaging")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--measure", action="store_true", help="compare opt-level 2/3/s/z, then rebuild smallest")
    mode.add_argument("--package", action="store_true", help="package previously measured binary after fixtures pass")
    parser.add_argument("--runner", default="")
    args = parser.parse_args()
    target = args.target
    extension = ".exe" if "windows" in target else ""
    root = Path("target") / target
    binary = root / "dist" / ("procward" + extension)
    env = os.environ.copy()
    output = Path("artifacts") / target
    output.mkdir(parents=True, exist_ok=True)
    if args.package:
        report = tested_measurement(binary, output)
        rows = report["measurements"]
        chosen = report["selected_opt_level"]
        env["CARGO_PROFILE_DIST_OPT_LEVEL"] = chosen
    else:
        candidates = ["2", "3", "s", "z"] if args.measure else [env.get("CARGO_PROFILE_DIST_OPT_LEVEL", "z")]
        rows = []
        for level in candidates:
            env["CARGO_PROFILE_DIST_OPT_LEVEL"] = level
            run("cargo", "build", "--locked", "--profile", "dist", "--target", target, "--bin", "procward", env=env)
            rows.append({"opt_level": level, "bytes": binary.stat().st_size, "startup_median_ms": round(startup(binary, args.runner), 3)})
        chosen = min(rows, key=lambda row: row["bytes"])["opt_level"]
        env["CARGO_PROFILE_DIST_OPT_LEVEL"] = chosen
        run("cargo", "build", "--locked", "--profile", "dist", "--target", target, "--bins", "--examples", env=env)
        report = {"target": target, "selected_opt_level": chosen, "measurements": rows, "dist_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "startup": "21 warm-cache --version process launches after 3 warmups; informational"}
    dependency_report = dependencies(binary, target)
    if args.package:
        report["release_zip_bytes"] = package(binary, target, False, output)
        debug_env = env.copy()
        if "darwin" in target:
            debug_env["CARGO_PROFILE_DEV_SPLIT_DEBUGINFO"] = "packed"
        run("cargo", "build", "--locked", "--target", target, "--bins", "--examples", env=debug_env)
        debug = root / "debug" / ("procward" + extension)
        debug_symbols(debug, target)
        dependency_report += dependencies(debug, target)
        report["debug_zip_bytes"] = package(debug, target, True, output)
    (output / "dependencies.txt").write_text(dependency_report)
    (output / "measurements.json").write_text(json.dumps(report, indent=2) + "\n")
    summary = f"## {target} — dist\n\n| opt-level | binary bytes | startup median ms |\n| --- | ---: | ---: |\n"
    summary += "".join(f"| {row['opt_level']} | {row['bytes']} | {row['startup_median_ms']} |\n" for row in rows)
    summary += f"\nSelected **{chosen}** by smallest binary, never by startup. {report['startup']}.\n"
    if args.runner:
        summary += "\nEmulated (qemu-user), including container launch overhead; host-kernel semantics, timings not representative.\n"
    if args.package:
        summary += f"\nZip bytes: release **{report['release_zip_bytes']}**, debug **{report['debug_zip_bytes']}**.\n"
    (output / "summary.md").write_text(summary)
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write(summary)
    if os.environ.get("GITHUB_ENV"):
        with open(os.environ["GITHUB_ENV"], "a") as stream:
            stream.write(f"CARGO_PROFILE_DIST_OPT_LEVEL={chosen}\n")
    # The caller's full-suite command must retain this opt-level after measurement.
    (output / "opt-level").write_text(chosen)


if __name__ == "__main__":
    main()
