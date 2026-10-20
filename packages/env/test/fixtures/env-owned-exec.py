"""Finite Linux fixtures. Seven-second guards are failure bounds, never success evidence."""

import json
import os
import signal
import sys
import time

signal.alarm(7)


def identity():
    with open("/proc/self/status", encoding="ascii") as stream:
        caps = {
            key: value.strip()
            for key, value in (line.split(":", 1) for line in stream)
            if key in ("CapInh", "CapPrm", "CapEff", "CapAmb")
        }
    fds = {}
    for fd in os.listdir("/proc/self/fd"):
        try:
            fds[fd] = os.readlink("/proc/self/fd/" + fd)
        except FileNotFoundError:
            pass
    return dict(pid=os.getpid(), sid=os.getsid(0), pgrp=os.getpgrp(),
                uid=os.getuid(), euid=os.geteuid(), gid=os.getgid(), egid=os.getegid(),
                caps=caps, fds=fds)


def emit(value):
    print(json.dumps(value), flush=True)


def escape():
    read_fd, write_fd = os.pipe()
    intermediate = os.fork()
    if intermediate == 0:
        os.close(read_fd)
        os.setsid()
        if os.fork() != 0:
            os._exit(0)
        signal.alarm(7)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        os.close(0)
        os.close(1)
        os.close(2)
        os.write(write_fd, json.dumps(identity()).encode("ascii"))
        os.close(write_fd)
        while True:
            signal.pause()
    os.close(write_fd)
    with os.fdopen(read_fd, "rb") as stream:
        leaf = json.load(stream)
    assert os.waitpid(intermediate, 0)[1] == 0
    return leaf


mode = sys.argv[1]
if mode == "bash":
    # Fixed [which, bash] discovery, gated by FIFO so cancel cannot race a polling interval.
    report = os.environ["PI_ENV_C_LOOKUP_REPORT"]
    gate = os.environ["PI_ENV_C_LOOKUP_GATE"]
    leaf = escape()
    record = dict(primary=identity(), leaf=leaf, env=dict(os.environ))
    with open(report + ".tmp", "w", encoding="ascii") as stream:
        json.dump(record, stream)
    os.replace(report + ".tmp", report)
    with open(gate, "rb") as stream:
        assert stream.read(1) == b"G"
    print("/bin/sh", flush=True)
elif mode == "contain":
    record = dict(primary=identity(), leaf=escape())
    emit(record)
    ready_path = os.environ.get("PI_ENV_C_READY_FILE")
    if ready_path:
        with open(ready_path + ".tmp", "w", encoding="ascii") as stream:
            json.dump(record, stream)
        os.replace(ready_path + ".tmp", ready_path)
    if sys.argv[2] == "wait":
        while True:
            signal.pause()
    sys.exit(int(sys.argv[2]))
elif mode in ("peer", "wait"):
    emit(identity())
    if mode == "peer":
        # Independent peer's exact stdin lease allows teardown without PID-file kills.
        while os.read(0, 1024):
            pass
    else:
        while True:
            signal.pause()
elif mode == "context":
    emit(dict(primary=identity(), argv=sys.argv[2:], cwd=os.getcwd(), env=dict(os.environ)))
elif mode == "touch":
    with open(sys.argv[2], "x", encoding="ascii") as stream:
        stream.write("started")
    sys.exit(7)
elif mode == "output":
    os.write(1, b"\xe2")
    time.sleep(0.15)
    os.write(1, b"\x82\xac")
    for _ in range(80):
        data = memoryview(b"x" * 65536)
        while data:
            data = data[os.write(1, data):]
    os.write(1, b"\nEND\n")
else:
    raise ValueError(mode)
