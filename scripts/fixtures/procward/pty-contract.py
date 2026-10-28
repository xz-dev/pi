#!/usr/bin/env python3
"""Pi-only notice/hook/terminal contract. No procward tree-lifecycle matrix."""
import errno
import fcntl
import json
import os
import pathlib
import pty
import select
import subprocess
import sys
import termios
import time

command, extension, directory, blocked, scale = sys.argv[1:]
root = pathlib.Path(directory)
root.mkdir(parents=True)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, b"\x18\0\x64\0\0\0\0\0")
before = termios.tcgetattr(slave)
read_fd, write_fd = os.pipe()
launch = "a" * 32
env = {k: v for k, v in os.environ.items() if not k.startswith(("PROCWARD_", "PI_PROCESS_OWNER_"))}
env.update(PROCWARD_PROTOCOL="1", PROCWARD_OWNER_PID=str(os.getpid()), PROCWARD_CONTRACT_ID=launch,
           PROCWARD_LIFECYCLE_FD=str(read_fd), PI_PROCWARD_BOOTSTRAP_NONCE=launch,
           PI_PROCWARD_CONTRACT_DIRECTORY=str(root),
           PI_PROCWARD_CONTRACT_BLOCKED=blocked, PI_CODING_AGENT_DIR=str(root / "agent"),
           PI_OFFLINE="1", PI_TELEMETRY="0", TERM="xterm-256color")

def session():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

child = subprocess.Popen(json.loads(command) + ["--offline", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "anthropic", "--model", "claude-sonnet-4-5", "--api-key", "fixture-never-used", "-e", extension],
                         env=env, cwd=root, stdin=slave, stdout=slave, stderr=slave,
                         pass_fds=(read_fd,), preexec_fn=session)
os.close(read_fd)
os.write(write_fd, f"PROCWARD/1 READY {os.getpid()} {child.pid} parent {launch}\n".encode())
output = bytearray()

def drain(timeout):
    if not select.select([master], [], [], timeout)[0]: return
    try: chunk = os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO: return
        raise
    output.extend(chunk)
    if b"\x1b[6n" in chunk: os.write(master, b"\x1b[1;1R")

def event(name):
    path = root / name
    return path.exists() and path.read_bytes().endswith(b"\n")

try:
    deadline = time.monotonic() + 30 * float(scale)
    while not event("ready.json"):
        drain(.02)
        if child.poll() is not None: raise RuntimeError(f"Pi exited before readiness ({child.returncode}): {output[-5000:]!r}")
        if time.monotonic() >= deadline: raise TimeoutError(f"Pi readiness deadline: {output[-5000:]!r}")
    started = time.monotonic()
    os.write(write_fd, f"PROCWARD/1 OWNER-LOSS {launch}\n".encode())
    os.close(write_fd)
    write_fd = None
    deadline = started + 9 * float(scale)
    while child.poll() is None:
        drain(.02)
        if time.monotonic() >= deadline: raise TimeoutError("Pi notice shutdown deadline")
    drain(0)
    elapsed = time.monotonic() - started
    if child.returncode != 0 or not event("hook.json"): raise RuntimeError(f"notice did not run shutdown hook: {output[-5000:]!r}")
    after = termios.tcgetattr(slave)
    if before != after: raise RuntimeError(f"full terminal settings not restored: {before!r} != {after!r}")
    if blocked == "1" and not (4.5 <= elapsed < 6.5 * float(scale)): raise RuntimeError(f"5s hook bound not observed: {elapsed}")
    print(json.dumps({"noticeOnly": True, "parentAlive": True, "hookRan": True, "terminalRestored": True,
                      "terminalBefore": before, "terminalAfter": after, "elapsedMs": round(elapsed * 1000),
                      "blockedHook": blocked == "1"}, default=lambda value: value.hex()))
finally:
    if write_fd is not None: os.close(write_fd)
    if child.poll() is None: child.kill()
    child.wait(timeout=5)
    (root / "terminal-output.bin").write_bytes(output)
    os.close(master)
    os.close(slave)
