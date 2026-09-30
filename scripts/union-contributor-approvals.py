#!/usr/bin/env python3
"""Write the additive union of current and patch contributor approvals."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ALLOWED_CAPABILITIES = {"issue", "pr"}


def parse_entries(text: str, *, source: str) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 2 or parts[1] not in ALLOWED_CAPABILITIES:
            raise SystemExit(f"{source}: invalid approval line: {raw!r}")
        normalized_name = parts[0].casefold()
        if normalized_name in seen:
            raise SystemExit(f"{source}: duplicate approval identity: {parts[0]!r}")
        seen.add(normalized_name)
        entries.append((parts[0], parts[1]))
    return entries


def union_text(current_text: str, patch_text: str) -> tuple[str, list[str]]:
    current_entries = parse_entries(current_text, source="current")
    patch_entries = parse_entries(patch_text, source="patch")
    current_by_name = {name.casefold(): capability for name, capability in current_entries}
    extras: list[tuple[str, str]] = []
    for name, capability in patch_entries:
        current_capability = current_by_name.get(name.casefold())
        if current_capability is None:
            extras.append((name, capability))
        elif current_capability != capability:
            raise SystemExit(
                f"approval capability conflict for {name!r}: current={current_capability}, patch={capability}"
            )
    if not extras:
        return current_text, []
    body = current_text if current_text.endswith("\n") else current_text + "\n"
    if not body.endswith("\n\n"):
        body += "\n"
    body += "".join(f"{name} {capability}\n" for name, capability in extras)
    return body, [name for name, _ in extras]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--patch", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    current_text = args.current.read_text()
    patch_text = args.patch.read_text()
    current_names = [name for name, _ in parse_entries(current_text, source="current")]
    merged, extras = union_text(current_text, patch_text)
    merged_names = {name.casefold() for name, _ in parse_entries(merged, source="union")}
    missing = [name for name in current_names if name.casefold() not in merged_names]
    if missing:
        print("deleted upstream approvals:", " ".join(missing), file=sys.stderr)
        return 1
    args.output.write_text(merged)
    print("union extras:", " ".join(extras) if extras else "(none)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
