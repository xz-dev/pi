#!/usr/bin/env python3
"""Validate a procward distribution without trusting ZIP paths or metadata."""
import hashlib
import pathlib
import stat
import sys
import zipfile


def extract(archive, destination, binary, expected_zip, expected_binary):
    archive = pathlib.Path(archive)
    destination = pathlib.Path(destination)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_zip:
        raise ValueError("procward ZIP digest mismatch")
    required = {binary, "LICENSE", "README.md", "third-party-licenses.md"}
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) != len(required) or {e.filename for e in entries} != required:
            raise ValueError("unexpected procward ZIP entries")
        for entry in entries:
            mode = entry.external_attr >> 16
            if (stat.S_IFMT(mode) not in (0, stat.S_IFREG)
                    or entry.flag_bits & 1 or entry.file_size > 32 * 1024 * 1024):
                raise ValueError("unsafe procward ZIP entry")
        data = {e.filename: bundle.read(e) for e in entries}
    if hashlib.sha256(data[binary]).hexdigest() != expected_binary:
        raise ValueError("procward executable digest mismatch")
    destination.mkdir(parents=True, exist_ok=False)
    for name, content in data.items():
        # The exact four flat filenames were checked before any output write.
        (destination / name).write_bytes(content)


if __name__ == "__main__":
    extract(*sys.argv[1:])
