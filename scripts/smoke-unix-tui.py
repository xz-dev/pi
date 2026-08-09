#!/usr/bin/env python3
"""Standard-library PTY harness: observe terminal output, then interrupt/exit cleanly."""
import json, os, pty, select, signal, sys, time
STARTUP_SETTLE_SECONDS = 1.0
if len(sys.argv) != 2: raise SystemExit("usage: smoke-unix-tui.py <executable>")
pid, fd = pty.fork()
if pid == 0:
    os.execve(sys.argv[1], [sys.argv[1]], os.environ)
output = bytearray(); started = time.monotonic(); deadline = started + 7; first_output_at = None; interrupt_sent_at = None; exit_sent = False
try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([fd], [], [], 0.1)
        if readable:
            try:
                output.extend(os.read(fd, 65536))
                if first_output_at is None: first_output_at = time.monotonic()
            except OSError: pass
        # Allow terminal-mode negotiation and startup initialization to settle after the first output.
        # Ctrl-C cancels any startup prompt/error state; Ctrl-D then exits the empty editor.
        if first_output_at is not None and time.monotonic() - first_output_at >= STARTUP_SETTLE_SECONDS and interrupt_sent_at is None:
            os.write(fd, b"\x03"); interrupt_sent_at = time.monotonic()
        if interrupt_sent_at is not None and time.monotonic() - interrupt_sent_at >= 0.5 and not exit_sent:
            os.write(fd, b"\x04"); exit_sent = True
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            clean = os.waitstatus_to_exitcode(status) == 0
            if not output or not exit_sent or not clean: raise SystemExit("TUI PTY acceptance failed")
            print(json.dumps({"harness":"Python standard-library PTY","elapsedMs":round((time.monotonic()-started)*1000),"outputBytes":len(output),"input":"ctrl-c,ctrl-d","childExitCode":0,"observedOutput":True,"exitSent":True,"cleanExit":True}))
            raise SystemExit(0)
    raise SystemExit("TUI PTY timeout")
finally:
    try: os.close(fd)
    except OSError: pass
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
