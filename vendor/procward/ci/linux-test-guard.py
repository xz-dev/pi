#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
"""Refuse Cargo's Linux runtime entrypoint outside the disposable test VM."""
import json
import os
import sys


def main():
    try:
        with open("/run/procward-vm/manifest.json") as handle:
            manifest = json.load(handle)
        with open("/proc/sys/kernel/random/boot_id") as handle:
            boot = handle.read().strip()
        if not manifest.get("host_boot_id") or boot == manifest["host_boot_id"]:
            raise ValueError("the test executor must have a separate kernel")
    except (OSError, ValueError, KeyError) as error:
        print("Linux runtime tests require the full-system VM: "
              "python3 ci/vm-test.py --kernel <installed-kernel>. "
              f"Refused host/container/qemu-user execution: {error}", file=sys.stderr)
        return 125
    if sys.argv[1:] == ["--check-only"]:
        return 0
    if len(sys.argv) < 2:
        print("missing test executable", file=sys.stderr)
        return 125
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
