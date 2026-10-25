"""Build the default release helper and prove test fault variables have no effect.

Run: RUSTUP_TOOLCHAIN=1.96.0 python3 packages/env/daemon/tests/default_release_parent_death.py
Requires Unix shell and locally cached Cargo dependencies; no ptrace/preload/provider.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile


def run():
    assert sys.platform.startswith(("linux", "freebsd")) or sys.platform == "darwin", "Unix regression"
    daemon = pathlib.Path(__file__).resolve().parents[1]
    target = daemon / "target"
    subprocess.run([
        "cargo", "build", "--release", "--locked", "--offline",
        "--manifest-path", str(daemon / "Cargo.toml"), "--target-dir", str(target),
    ], check=True, timeout=180)
    helper = target / "release/pi-env"
    rows = []
    with tempfile.TemporaryDirectory(prefix="pi-default-release-parent-death-") as temporary:
        root = pathlib.Path(temporary)
        for index, value in enumerate((None, "1", "0", "")):
            path = root / str(index)
            env = dict(os.environ, PI_PROCESS_OWNER_PENDING="1")
            env.pop("PI_PROCESS_OWNER_TEST_PDEATHSIG_FAIL", None)
            if value is not None:
                env["PI_PROCESS_OWNER_TEST_PDEATHSIG_FAIL"] = value
            result = subprocess.run([
                str(helper), "supervise", "--", "/bin/sh", "-c",
                'printf executed > "$1"', "sh", str(path),
            ], env=env, text=True, capture_output=True, timeout=8)
            rows.append({"value": value, "status": result.returncode,
                         "payload_executed": path.exists(), "stderr": result.stderr})
    contents = helper.read_bytes()
    print(json.dumps({"helper": str(helper), "sha256": hashlib.sha256(contents).hexdigest(),
                      "rows": rows}, indent=2), flush=True)
    assert all(row["status"] == 0 and row["payload_executed"] and not row["stderr"] for row in rows), "test variable changed default release behavior"
    assert b"PI_PROCESS_OWNER_TEST_PDEATHSIG_FAIL" not in contents, "fault switch compiled into default release"


if __name__ == "__main__":
    run()
