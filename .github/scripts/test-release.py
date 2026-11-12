# SPDX-License-Identifier: BSD-3-Clause
"""External release boundaries: tag eligibility, missing targets, tampered bytes."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load("release-assets")
dist = load("build-dist")


class ReleaseTests(unittest.TestCase):
    def test_only_matching_stable_tag_push_can_publish(self):
        self.assertTrue(release.eligible("push", "refs/tags/v0.1.0", "0.1.0"))
        for ref in ("refs/heads/main", "refs/tags/v0.1.1", "refs/tags/v0.1.0-rc.1", "refs/tags/v00.1.0", "refs/tags/v0.1.0/extra"):
            with self.assertRaises(ValueError):
                release.eligible("push", ref, "0.1.0")
        with self.assertRaises(ValueError):
            release.eligible("pull_request", "refs/tags/v0.1.0", "0.1.0")
        # A dispatch on a real release tag still cannot sign or publish.
        self.assertFalse(release.eligible("workflow_dispatch", "refs/tags/v0.1.0", "0.1.0"))

    def test_linux_measurement_refuses_before_any_product_probe(self):
        with (patch.object(dist.sys, 'platform', 'linux'),
              patch.object(dist, 'run', side_effect=RuntimeError('guard refused')) as command):
            with self.assertRaisesRegex(RuntimeError, 'guard refused'):
                dist.startup(Path('/nonexistent/product'), '')
        command.assert_called_once_with(dist.sys.executable, 'ci/linux-test-guard.py', '--check-only')

    def test_dynamic_dependencies_are_read_in_every_readelf_format(self):
        gnu = " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]\n"
        elftc = " 0x0000000000000001 NEEDED               Shared library: [libutil.so.9]\n 0x0000000000000001 NEEDED               Shared library: [libc.so.7]\n"
        self.assertEqual(dist.needed_libraries(gnu), ["libc.so.6"])
        self.assertEqual(dist.needed_libraries(elftc), ["libutil.so.9", "libc.so.7"])
        # libutil's soname differs across supported FreeBSD releases.
        self.assertNotIn("libutil.so.9", dist.ALLOWED_NEEDED)
        self.assertNotIn("libutil.so.7", dist.ALLOWED_NEEDED)

    def test_packaging_requires_unchanged_measured_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            binary = output / "procward"
            binary.write_bytes(b"measured executable")
            report = {"dist_sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}
            (output / "measurements.json").write_text(json.dumps(report))
            self.assertEqual(dist.tested_measurement(binary, output), report)
            binary.write_bytes(b"rebuilt or changed executable")
            with self.assertRaisesRegex(RuntimeError, "binary changed"):
                dist.tested_measurement(binary, output)

    def test_all_targets_and_frozen_embedded_bytes_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for target in release.TARGETS:
                output = root / target
                output.mkdir()
                extension = ".exe" if "windows" in target else ""
                binary = root / ("fixture" + extension)
                binary.write_bytes(b"newly-authored test binary\n")
                # Real packaging function uses the final public binary name.
                binary = binary.rename(root / ("procward" + extension))
                dist.package(binary, target, False, output)
                binary.write_bytes(b"debug fixture with symbols\n")
                if "windows" in target:
                    binary.with_suffix(".pdb").write_bytes(b"test PDB" * 256)
                elif "darwin" in target:
                    dwarf = binary.with_name(binary.name + ".dSYM") / "Contents/Resources/DWARF" / binary.name
                    dwarf.parent.mkdir(parents=True, exist_ok=True)
                    dwarf.write_bytes(b"test DWARF" * 256)
                dist.package(binary, target, True, output)
                binary.unlink()
            release.manifest(root, write=True)
            release.manifest(root)
            archive = root / release.TARGETS[0] / f"procward-{release.TARGETS[0]}.zip"
            original = archive.read_bytes()
            archive.unlink()
            with self.assertRaises(ValueError):
                release.manifest(root)  # A successful subset is not publishable.
            archive.write_bytes(original + b"tampered after attestation")
            with self.assertRaisesRegex(ValueError, "SHA256SUMS mismatch"):
                release.manifest(root)
            archive.write_bytes(original)
            binary = root / release.TARGETS[0] / "procward"
            binary.write_bytes(b"changed extracted binary")
            with self.assertRaisesRegex(ValueError, "binary differs"):
                release.manifest(root)


if __name__ == "__main__":
    unittest.main()
