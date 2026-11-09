#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
"""VM verdict policy checks; execute with the full-system guest tooling."""
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("vm_guest", Path(__file__).with_name("vm-guest.py"))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
OK = "test result: ok. 1 passed; 0 failed;"


class VerdictPolicy(unittest.TestCase):
    def verdict(self, mode="cgroup", output=OK, **kwargs):
        return guest.classify(mode, 0, output, True, kwargs.get("rescue", False),
                              kwargs.get("leftovers", []), kwargs.get("oom_delta", 0))

    def test_ordinary_oom_is_not_product_cleanup(self):
        self.assertEqual(self.verdict(oom_delta=1), "fail")
        self.assertEqual(self.verdict(), "pass")

    def test_missing_cgroup_gate_is_not_an_inapplicable_cgroup_pass(self):
        output = OK + "\nCGROUP-NOT-RUN: missing prerequisite"
        self.assertEqual(self.verdict(output=output), "fail")
        self.assertEqual(self.verdict(mode="fallback", output=output), "not-applicable")

    def test_rescue_and_leftovers_override_not_applicable(self):
        output = OK + "\nBOUNDARY-NOT-RUN: unsupported fixture"
        self.assertEqual(self.verdict(output=output, rescue=True), "fail")
        self.assertEqual(self.verdict(output=output, leftovers=["owned"]), "fail")
        self.assertEqual(self.verdict(output=output + "\nHARNESS RESCUE"), "fail")

    def test_oom_counter_is_observed_not_assumed_zero(self):
        with patch("builtins.open", return_value=io.StringIO("other 2\noom_kill 7\n")):
            self.assertEqual(guest.oom_kills(), 7)
        with patch("builtins.open", return_value=io.StringIO("other 2\n")):
            with self.assertRaises(RuntimeError):
                guest.oom_kills()

    def test_missing_membership_is_not_success(self):
        self.assertEqual(guest.classify("cgroup", 0, OK, False, False, []), "fail")


class RescueDiagnostics(unittest.TestCase):
    def test_snapshot_includes_adopted_zombie_missing_from_cgroup_procs(self):
        def source(path, mode="r"):
            if path.endswith("/children"):
                return io.StringIO("42")
            if path.endswith("/cgroup.procs"):
                return io.StringIO("43")
            if path == "/proc/43/stat":
                raise FileNotFoundError("exited during snapshot")
            return io.BytesIO(b"42 (procward) Z" if path.endswith("/stat")
                              else b"anchor\0owner")

        with patch("builtins.open", side_effect=source), patch.object(guest.os, "listdir", return_value=[]):
            snapshot = guest.rescue_processes("/group")
        self.assertEqual([record["pid"] for record in snapshot], [42, 43])
        self.assertEqual(snapshot[0]["stat"], "42 (procward) Z")
        self.assertEqual(snapshot[0]["cmdline"], "anchor owner")
        self.assertIn("exited during snapshot", snapshot[1]["stat"])

    def test_snapshot_is_bounded(self):
        def source(path, mode="r"):
            if path.endswith("/children"):
                return io.StringIO("")
            if path.endswith("/cgroup.procs"):
                return io.StringIO(" ".join(str(pid) for pid in range(1, 100)))
            return io.BytesIO(b"x" * 2048)

        with patch("builtins.open", side_effect=source):
            snapshot = guest.rescue_processes("/group")
        self.assertEqual(len(snapshot), 64)
        self.assertEqual(len(snapshot[-1]["cmdline"]), 1024)


if __name__ == "__main__":
    unittest.main()
