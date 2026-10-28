"""Live-parent consumer fixture. Actions advance only after observed readiness."""
import ctypes
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time

runtime, resolver, probe, mode = sys.argv[1:]
read_fd, write_fd = os.pipe()
os.set_inheritable(read_fd, True)
owner = os.getpid()
launch = "a" * 32
identity = "parent"
env = dict(os.environ)
for key in list(env):
    if key.startswith("PROCWARD_") or key.startswith("PI_PROCESS_OWNER_"):
        del env[key]
if os.name == "nt":
    import msvcrt
    class Filetime(ctypes.Structure):
        _fields_ = [("low", ctypes.c_ulong), ("high", ctypes.c_ulong)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    kernel.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(Filetime)] * 4
    times = [Filetime() for _ in range(4)]
    if not kernel.GetProcessTimes(kernel.GetCurrentProcess(), *[ctypes.byref(x) for x in times]):
        raise ctypes.WinError(ctypes.get_last_error())
    identity = f"{(times[0].high << 32) | times[0].low:016x}"
    env["PROCWARD_LIFECYCLE_HANDLE"] = str(msvcrt.get_osfhandle(read_fd))
    options = {"close_fds": False}
else:
    env["PROCWARD_LIFECYCLE_FD"] = str(read_fd)
    options = {"pass_fds": (read_fd,)}
env.update(PROCWARD_PROTOCOL="1", PROCWARD_OWNER_PID=str(owner), PROCWARD_CONTRACT_ID=launch,
           PI_CONTRACT_MODE=mode, PROCWARD_PRIMARY_PID="obsolete-must-be-scrubbed", PI_CONTRACT_BLOCK="1" if mode == "blocked" else "0")
started = time.monotonic()
child = subprocess.Popen([runtime, "--disable-warning=ExperimentalWarning", "--import", resolver, probe],
                         env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)
os.close(read_fd)
try:
    record = f"PROCWARD/1 READY {owner} {child.pid} {identity} {launch}\n"
    if mode == "wrong-primary": record = record.replace(f" {child.pid} ", f" {child.pid + 1} ")
    if mode == "wrong-owner": record = record.replace(f" {owner} ", f" {owner + 1} ")
    if mode == "wrong-launch": record = record.replace(launch, "b" * 32)
    if mode == "wrong-version": record = record.replace("PROCWARD/1", "PROCWARD/2")
    if mode == "wrong-identity": record = record.replace(identity, "0000000000000000" if os.name == "nt" else "not-parent")
    if mode == "extra-field": record = record.rstrip() + " extra\n"
    if mode == "oversized": record = "x" * 257
    if mode == "partial": record = record[:10]
    if mode == "silence": record = ""
    if mode == "non-ascii": record = "\u00ff\n"
    if mode != "eof-before": os.write(write_fd, record.encode())
    if mode == "eof-before": os.close(write_fd); write_fd = None
    output = []
    if mode in ("notice", "invalid-notice", "eof-after", "blocked", "startup-term", "print-notice", "rpc-notice"):
        ready = queue.Queue()
        threading.Thread(target=lambda: ready.put(child.stdout.readline()), daemon=True).start()
        line = ready.get(timeout=5)
        output.append(line.decode())
        if not json.loads(line).get("ready"): raise RuntimeError("consumer did not become ready")
        if mode == "startup-term": os.kill(child.pid, signal.SIGTERM)
        elif mode == "eof-after": os.close(write_fd); write_fd = None
        else: os.write(write_fd, (f"PROCWARD/1 OWNER-LOSS {launch}\n" if mode != "invalid-notice" else "invalid\n").encode())
    stdout, stderr = child.communicate(timeout=12)
    print(json.dumps({"code": child.returncode, "seconds": time.monotonic() - started,
                      "stdout": "".join(output) + stdout.decode(), "stderr": stderr.decode(), "parentAlive": True}))
finally:
    if write_fd is not None: os.close(write_fd)
    if child.poll() is None: child.kill(); child.wait(timeout=5)
