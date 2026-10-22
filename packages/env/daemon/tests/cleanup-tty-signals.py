"""Linux PTY regression for cleanup-only native job-control signal handling.

Run: TMPDIR=/run/user/1000 python3 packages/env/daemon/tests/cleanup-tty-signals.py <pi-env>
Uses real background tcsetattr/read, pidfd faults, and no post-fault rescue CONT.
"""
import ctypes
import fcntl
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import termios
import time


def state(pid):
    try:
        return pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[0]
    except (FileNotFoundError, ProcessLookupError):
        return ""


def parent(pid):
    return int(pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[1])


def wait_for(predicate, label, seconds=5):
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, label
        time.sleep(.005)


def primary(root, operation):
    def continued(_signal, _frame):
        (root / "background-io").write_text(operation)
        if operation == "read":
            os.read(0, 1)
        else:
            termios.tcsetattr(0, termios.TCSANOW, termios.tcgetattr(0))
    signal.signal(signal.SIGTERM, lambda *_: None)
    signal.signal(signal.SIGCONT, continued)
    (root / "primary").write_text(str(os.getpid()))
    while True:
        signal.pause()


def driver(helper, root, operation):
    # Act as a shell: own the controlling tty, retain orphans, and permit tcsetpgrp.
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
    for sig in (signal.SIGTTOU, signal.SIGTTIN):
        signal.signal(sig, signal.SIG_IGN)
    def child_signals():
        for sig in (signal.SIGTTOU, signal.SIGTTIN):
            signal.signal(sig, signal.SIG_DFL)
    child = subprocess.Popen(
        [helper, "supervise", "--", sys.executable, __file__, "--primary", str(root), operation],
        env=dict(os.environ, PI_PROCESS_OWNER_PENDING="1"), process_group=0,
        preexec_fn=child_signals, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    pins = {}
    row = {"operation": operation, "no_rescue_cont": True}
    try:
        os.tcsetpgrp(0, child.pid)
        wait_for(lambda: (root / "primary").exists(), "primary ready")
        pi = int((root / "primary").read_text())
        guardian = parent(pi)
        anchor = parent(guardian)
        assert parent(anchor) == child.pid
        pids = {"outer": child.pid, "anchor": anchor, "guardian": guardian, "primary": pi}
        pins = {role: os.pidfd_open(pid) for role, pid in pids.items()}
        tty_bits = sum(1 << (sig - 1) for sig in (signal.SIGTTOU, signal.SIGTTIN))
        for role in ("outer", "guardian"):
            status = pathlib.Path(f"/proc/{pids[role]}/status").read_text().splitlines()
            caught = int(next(line.split()[1] for line in status if line.startswith("SigCgt:")), 16)
            assert not caught & tty_bits, "healthy controller catches tty job signals"
        os.killpg(child.pid, signal.SIGTSTP)  # Held direct child anchors this test group.
        wait_for(lambda: state(child.pid) == "T" and state(pi) == "T", "job paused")
        assert state(guardian) in ("R", "S") and state(anchor) in ("R", "S")
        os.tcsetpgrp(0, os.getpgrp())
        if operation == "healthy":
            signal.pidfd_send_signal(pins["primary"], signal.SIGCONT)
            wait_for(lambda: state(guardian) == "T", "healthy background tcsetattr must stop job")
            assert state(child.pid) == "T"
            row.update(healthy_ttou_stops_job=True)
            row["pass"] = True
        else:
            start = time.monotonic()
            signal.pidfd_send_signal(pins["anchor"], signal.SIGKILL)
            wait_for(lambda: (root / "background-io").exists(), "background IO reached")
            stopped = set()
            while time.monotonic() - start < 8:
                child.poll()  # Reap the outer; every other role must be reaped by native owners.
                stopped.update(role for role in ("outer", "guardian") if state(pids[role]) == "T")
                if not any(state(pid) for pid in pids.values()):
                    break
                time.sleep(.005)
            row.update(elapsed=round(time.monotonic() - start, 3), stopped_controllers=sorted(stopped),
                       final={role: state(pid) for role, pid in pids.items()})
            assert not stopped, f"cleanup controllers stopped on background {operation}: {row}"
            assert not any(row["final"].values()) and row["elapsed"] < 8, row
            row["pass"] = True
    finally:
        print(json.dumps(row), flush=True)
        # No CONT, including failed-test cleanup. The shell reaper owns any survivors.
        for fd in reversed(list(pins.values())):
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(fd)
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=2)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    time.sleep(.005)
            except ChildProcessError:
                break


def run(helper):
    failures = []
    for operation in ("control", "read", "healthy"):
        with tempfile.TemporaryDirectory(prefix="pi-cleanup-tty-") as temporary:
            master, slave = os.openpty()
            try:
                result = subprocess.run(
                    [sys.executable, __file__, "--driver", helper, temporary, operation],
                    stdin=slave, start_new_session=True, capture_output=True, text=True, timeout=20,
                )
                print(result.stdout, end="", flush=True)
                if result.returncode != 0:
                    failures.append(f"{operation}: {result.stderr}")
            finally:
                os.close(slave)
                os.close(master)
    assert not failures, "\n".join(failures)


if __name__ == "__main__":
    assert sys.platform == "linux", "Linux pidfd regression"
    if sys.argv[1] == "--primary":
        primary(pathlib.Path(sys.argv[2]), sys.argv[3])
    elif sys.argv[1] == "--driver":
        driver(sys.argv[2], pathlib.Path(sys.argv[3]), sys.argv[4])
    else:
        run(str(pathlib.Path(sys.argv[1]).resolve()))
