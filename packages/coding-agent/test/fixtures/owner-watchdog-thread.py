#!/usr/bin/env python3
"""Manual Node+Bun worker test, gated to Linux/FreeBSD/Darwin; no provider or tty.

Usage: python3 packages/coding-agent/test/fixtures/owner-watchdog-thread.py [node|bun]
Parent remains healthy >7s while JS is blocked, then dies. Real ownCliProcesses
worker must SIGKILL within8s without main-loop callbacks. Linux subreaper also
checks exact SIGKILL status; other targets require init/launchd to reap the child.
This isolates the thread seam, not the native kernel/observer wake contract.
"""
import ctypes
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = pathlib.Path(__file__).resolve().parents[4]
FIXTURE = pathlib.Path(__file__).with_suffix(".ts")


def birth(pid):
    out = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], text=True, capture_output=True)
    return out.stdout.strip()


def hold(runtime, root):
    env = dict(os.environ, PI_PROCESS_OWNER_PID=str(os.getpid()), REVIEW_ROOT=str(root))
    for key in ("PI_NO_PROCESS_OWNERSHIP", "PI_PROCESS_OWNER_PENDING", "PI_PROCESS_OWNER_CONTROL_FD"):
        env.pop(key, None)
    command = [shutil.which(runtime)]
    if runtime == "node":
        command += ["--disable-warning=ExperimentalWarning", "--import", str(REPO / "packages/coding-agent/src/experimental/source-resolver.ts")]
    command += [str(FIXTURE)]
    with (root / "stderr").open("w") as stderr:
        child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=stderr)
        (root / "child").write_text(str(child.pid))
        child.wait()


def run(runtime):
    root = pathlib.Path(tempfile.mkdtemp(prefix="pi-watchdog-thread-"))
    holder = subprocess.Popen([sys.executable, __file__, "--hold", runtime, str(root)])
    pid = None
    try:
        deadline = time.monotonic() + 10
        while not (root / "thread-ready").exists():
            assert holder.poll() is None, (root / "stderr").read_text()
            assert time.monotonic() < deadline, "worker bootstrap did not become ready"
            time.sleep(.02)
        ready = json.loads((root / "thread-ready").read_text())
        pid = ready["pid"]
        assert ready["ppid"] == holder.pid
        identity = birth(pid)
        assert identity
        time.sleep(7.5)
        assert holder.poll() is None and birth(pid) == identity, "healthy blocked process killed"
        start = time.monotonic()
        holder.kill()  # Held, unreaped direct ChildProcess, never a guessed PID.
        holder.wait()
        status = None
        while time.monotonic() - start < 8:
            if sys.platform == "linux":
                got, observed = os.waitpid(pid, os.WNOHANG)
                if got == pid:
                    status = observed
                    break
            elif birth(pid) != identity:
                break
            time.sleep(.02)
        elapsed = time.monotonic() - start
        assert elapsed < 8 and birth(pid) != identity, "blocked main outlasted hard deadline or was not reaped"
        if sys.platform == "linux":
            assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL
        print(json.dumps({"runtime": runtime, "platform": sys.platform, "root": str(root), "pid": pid,
                          "pinned_parent": holder.pid, "healthy_block_seconds": 7.5,
                          "loss_to_reap_seconds": round(elapsed, 3), "wait_status": status, "pass": True}), flush=True)
    finally:
        if holder.poll() is None:
            holder.kill()
        holder.wait()
        # If broken, bounded Atomics.wait exits by itself; never signal an adopted numeric PID.


if __name__ == "__main__":
    assert sys.platform.startswith(("linux", "freebsd")) or sys.platform == "darwin", "Unix-gated test"
    if len(sys.argv) > 1 and sys.argv[1] == "--hold":
        hold(sys.argv[2], pathlib.Path(sys.argv[3]))
    else:
        if sys.platform == "linux":
            assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0, "test subreaper must be available"
        for runtime in sys.argv[1:] or ("node", "bun"):
            run(runtime)
