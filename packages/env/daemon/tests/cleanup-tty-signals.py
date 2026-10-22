"""Linux/Darwin PTY regression for cleanup-only native job-control signal handling.

Run: TMPDIR=/run/user/1000 python3 packages/env/daemon/tests/cleanup-tty-signals.py <pi-env>
Uses real background tcsetattr/read, identity-bound faults, and no post-fault rescue CONT.
"""
import ctypes
import errno
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


if sys.platform == "darwin":
    # libc 0.2.190 proc_bsdinfo/PROC_PIDTBSDINFO, also used by the native inventory.
    class BsdInfo(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint32) for name in (
            "flags status xstatus pid ppid uid gid ruid rgid svuid svgid reserved"
        ).split()] + [
            ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32),
            *[(name, ctypes.c_uint32) for name in "nfiles pgid pjobc tdev tpgid".split()],
            ("nice", ctypes.c_int32), ("seconds", ctypes.c_uint64), ("micros", ctypes.c_uint64),
        ]
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidinfo.restype = ctypes.c_int


def bsd_info(pid):
    record = BsdInfo()
    ctypes.set_errno(0)
    got = libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(record), ctypes.sizeof(record))
    if got == 0 and ctypes.get_errno() == errno.ESRCH:
        return None
    assert got == ctypes.sizeof(record) and record.pid == pid, "incomplete libproc identity"
    return record


def state(pid):
    if sys.platform == "darwin":
        record = bsd_info(pid)
        return {2: "R", 3: "S", 4: "T", 5: "Z"}.get(record.status, "?") if record else ""
    try:
        return pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[0]
    except (FileNotFoundError, ProcessLookupError):
        return ""


def parent(pid):
    if sys.platform == "darwin":
        return bsd_info(pid).ppid
    return int(pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[1])


def pin(pid):
    if sys.platform == "linux":
        return os.pidfd_open(pid)
    record = bsd_info(pid)
    assert record is not None
    return (pid, record.seconds, record.micros, record.uid)


def send(held, sig):
    if sys.platform == "linux":
        signal.pidfd_send_signal(held, sig)
    else:
        pid, seconds, micros, uid = held
        record = bsd_info(pid)
        if record and (record.seconds, record.micros, record.uid) == (seconds, micros, uid):
            os.kill(pid, sig)  # Darwin's same birth/UID check-use boundary as native inventory.


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
    if sys.platform == "linux":
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
        if sys.platform == "linux":
            extra = parent(guardian)
            assert parent(extra) == child.pid
            extra_role = "anchor"
        else:
            assert parent(guardian) == child.pid
            listing = subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True)
            siblings = [int(fields[0]) for line in listing.splitlines()
                        if len(fields := line.split()) == 2 and int(fields[1]) == child.pid]
            assert len(siblings) == 2 and guardian in siblings
            extra = next(pid for pid in siblings if pid != guardian)
            extra_role = "observer"
        pids = {"outer": child.pid, extra_role: extra, "guardian": guardian, "primary": pi}
        pins = {role: pin(pid) for role, pid in pids.items()}
        if sys.platform == "linux":
            tty_bits = sum(1 << (sig - 1) for sig in (signal.SIGTTOU, signal.SIGTTIN))
            for role in ("outer", "guardian"):
                status = pathlib.Path(f"/proc/{pids[role]}/status").read_text().splitlines()
                caught = int(next(line.split()[1] for line in status if line.startswith("SigCgt:")), 16)
                assert not caught & tty_bits, "healthy controller catches tty job signals"
        os.killpg(child.pid, signal.SIGTSTP)  # Held direct child anchors this test group.
        wait_for(lambda: state(child.pid) == "T" and state(pi) == "T", "job paused")
        assert state(guardian) in ("R", "S") and state(extra) in ("R", "S")
        os.tcsetpgrp(0, os.getpgrp())
        if operation == "healthy":
            send(pins["primary"], signal.SIGCONT)
            wait_for(lambda: state(guardian) == "T", "healthy background tcsetattr must stop job")
            assert state(child.pid) == "T"
            row.update(healthy_ttou_stops_job=True)
            row["pass"] = True
        else:
            start = time.monotonic()
            send(pins[extra_role], signal.SIGKILL)
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
                send(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if sys.platform == "linux":
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
    assert sys.platform in ("linux", "darwin"), "Linux/Darwin PTY regression"
    if sys.argv[1] == "--primary":
        primary(pathlib.Path(sys.argv[2]), sys.argv[3])
    elif sys.argv[1] == "--driver":
        driver(sys.argv[2], pathlib.Path(sys.argv[3]), sys.argv[4])
    else:
        run(str(pathlib.Path(sys.argv[1]).resolve()))
