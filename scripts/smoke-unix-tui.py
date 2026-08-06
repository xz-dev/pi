#!/usr/bin/env python3
"""Standard-library PTY harness: observe terminal output, then send /exit."""
import json, os, pty, select, signal, sys, time
if len(sys.argv) != 2: raise SystemExit("usage: smoke-unix-tui.py <executable>")
pid, fd = pty.fork()
if pid == 0:
    os.execve(sys.argv[1], [sys.argv[1]], os.environ)
output = bytearray(); started = time.monotonic(); deadline = started + 7; exit_sent = False
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try: output.extend(os.read(fd, 65536))
            except OSError: break
        if output and not exit_sent:
            os.write(fd, b"/exit\r"); exit_sent = True
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            clean = os.waitstatus_to_exitcode(status) == 0
            if not output or not exit_sent or not clean: raise SystemExit("TUI PTY acceptance failed")
            print(json.dumps({"harness":"Python standard-library PTY","elapsedMs":round((time.monotonic()-started)*1000),"outputBytes":len(output),"input":"/exit\\r","childExitCode":0,"observedOutput":True,"exitSent":True,"cleanExit":True}))
            raise SystemExit(0)
    raise SystemExit("TUI PTY timeout")
finally:
    try: os.close(fd)
    except OSError: pass
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
