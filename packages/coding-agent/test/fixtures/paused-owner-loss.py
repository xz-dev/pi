"""Linux real-CLI regression: run after installing the built helper; requires tmux.
Usage: python3 packages/coding-agent/test/fixtures/paused-owner-loss.py [node|bun]
No network/provider calls. No rescue CONT, including fixture cleanup.
"""
import hashlib
import json
import os
import pathlib
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import termios
import time

REPO = pathlib.Path(__file__).resolve().parents[4]


def call(*args):
    return subprocess.check_output(args, text=True).strip()


def state(pid):
    try:
        return pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[0]
    except FileNotFoundError:
        return ""


def children(pid):
    try:
        return [int(value) for value in pathlib.Path(f"/proc/{pid}/task/{pid}/children").read_text().split()]
    except FileNotFoundError:
        return []


def wait_for(predicate, label):
    end = time.monotonic() + 20
    while not predicate():
        assert time.monotonic() < end, label
        time.sleep(.02)


def run(runtime):
    root = pathlib.Path(tempfile.mkdtemp(prefix="pi-owner-loss-shutdown-"))
    session = f"pi-owner-loss-shutdown-{os.getpid()}-{runtime}"
    pins = {}
    result = {"runtime": runtime, "root": str(root)}
    tty_fd = None
    try:
        call("tmux", "new-session", "-d", "-s", session, "-c", str(root), "-x", "140", "-y", "35", "bash --noprofile --norc")
        shell = int(call("tmux", "display-message", "-p", "-t", session, "#{pane_pid}"))
        tty_fd = os.open(call("tmux", "display-message", "-p", "-t", session, "#{pane_tty}"), os.O_RDONLY | os.O_NOCTTY)
        args = ["env", "-i", f"PATH={os.environ['PATH']}", f"HOME={root}", f"TMPDIR={tempfile.gettempdir()}", f"PI_CODING_AGENT_DIR={root / 'agent'}", "PI_OFFLINE=1", f"REVIEW_ROOT={root}", runtime, *(["--import", str(REPO / "packages/coding-agent/src/experimental/source-resolver.ts")] if runtime == "node" else []), str(REPO / "packages/coding-agent/src/cli.ts"), "--no-extensions", "-e", str(pathlib.Path(__file__).with_name("owner-loss-shutdown.ts")), "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-session", "--offline", "--no-approve"]
        call("tmux", "send-keys", "-t", session, shlex.join(args), "Enter")
        wait_for(lambda: (root / "extension-ready").exists(), "extension initialization")
        outer = children(shell)[0]
        guardian = children(outer)[0]
        primary = children(guardian)[0]
        pids = {"outer": outer, "guardian": guardian, "pi": primary}
        for role, pid in pids.items():
            pins[role] = os.pidfd_open(pid)
        result["helper_sha256"] = hashlib.sha256(pathlib.Path(f"/proc/{outer}/exe").read_bytes()).hexdigest()
        result["pi_exe"] = str(pathlib.Path(f"/proc/{primary}/exe").readlink())
        wait_for(lambda: not termios.tcgetattr(tty_fd)[3] & termios.ICANON, "raw input ready")
        # Initial raw mode precedes interactive key-handler installation.
        time.sleep(.7)
        tick_file = root / "tick"
        call("tmux", "send-keys", "-t", session, f"!while :; do date +%s%N > {tick_file}; sleep .02; done", "Enter")
        wait_for(lambda: tick_file.exists() and children(primary), "heartbeat ready")
        task = children(primary)[0]
        wait_for(lambda: children(task) and children(children(task)[0]), "task controllers ready")
        pids.update(task_outer=task, task_guardian=children(task)[0], payload=children(children(task)[0])[0])
        for role in ("task_outer", "task_guardian", "payload"):
            pins[role] = os.pidfd_open(pids[role])
        call("tmux", "send-keys", "-t", session, "C-z")
        wait_for(lambda: all(state(pids[role]) == "T" for role in ("outer", "pi", "payload")), "actual paused session")
        tick = tick_file.read_text()
        time.sleep(.15)
        assert tick_file.read_text() == tick, "heartbeat did not freeze"
        start = time.monotonic()
        signal.pidfd_send_signal(pins["guardian"], signal.SIGKILL)
        signal.pidfd_send_signal(pins["outer"], signal.SIGKILL)
        deadline = start + 8
        tty_output = root / "tty-state"
        # Query in an executing shell command, not during readline's own raw prompt.
        call("tmux", "send-keys", "-t", session, f"stty -a > {tty_output}", "Enter")
        while time.monotonic() < deadline and (any(state(pid) for pid in pids.values()) or not tty_output.exists()):
            time.sleep(.02)
        result.update(pids=pids, final={role: state(pid) for role, pid in pids.items()}, elapsed=round(time.monotonic() - start, 3), shutdown_started=(root / "shutdown-started").exists(), heartbeat_changed=tick_file.read_text() != tick, no_rescue_cont=True)
        flags = set(re.split(r"[;\s]+", tty_output.read_text())) if tty_output.exists() else set()
        result["cooked"] = {"isig", "icanon", "echo"} <= flags
        result["pass"] = not any(result["final"].values()) and result["shutdown_started"] and not result["heartbeat_changed"] and result["cooked"] and time.monotonic() <= deadline
        assert result["pass"], "paused owner loss exceeded 8 seconds or resumed work"
    finally:
        print(json.dumps(result), flush=True)
        # Assertions already completed. Kill only pinned fixture processes; never rescue CONT.
        for fd in pins.values():
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(fd)
        if tty_fd is not None:
            os.close(tty_fd)
        subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    assert sys.platform == "linux", "this regression requires Linux pidfds"
    for runtime in sys.argv[1:] or ("node", "bun"):
        run(runtime)
