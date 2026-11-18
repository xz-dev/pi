# SPDX-License-Identifier: BSD-3-Clause
"""List explicit runtime-probed emulator exceptions, never hide fixture failure."""
import os
import sys
from pathlib import Path


def unsupported(text):
    marker = "EMULATOR-UNSUPPORTED:"
    return sorted({line.partition(marker)[2].strip() for line in text.splitlines() if marker in line})


assert unsupported("unrelated\ntest x ... EMULATOR-UNSUPPORTED: x: reason\nEMULATOR-UNSUPPORTED: x: reason") == ["x: reason"]
assert unsupported("test x ... ok") == []

target, outcome, log = sys.argv[1:]
path = Path(log)
rows = unsupported(path.read_text(errors="replace") if path.exists() else "")
summary = f"## {target} — qemu-user\n\nFixture step: **{outcome}**.\n\nEMULATOR-UNSUPPORTED: **{len(rows)}** (not product passes):\n"
summary += "".join(f"- {row}\n" for row in rows) if rows else "- None reported; fixture outcome above remains authoritative.\n"
summary += "\nHost-kernel semantic checks only; timings are not representative. Full-system riscv64 VM coverage remains a follow-up for unsupported cases.\n"
with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
    output.write(summary)
print(summary)
