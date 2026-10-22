"""Linux real-CLI regression: run after installing the built helper; requires tmux.
Usage: python3 packages/coding-agent/test/fixtures/paused-owner-loss.py [--blocking|--preblocked|--running-blocked] [node|bun]
`--preblocked` blocks JS before a kernel job stop; `--blocking` blocks inside shutdown.
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
    except (FileNotFoundError, ProcessLookupError):
        return ""


def children(pid):
    try:
        return [int(value) for value in pathlib.Path(f"/proc/{pid}/task/{pid}/children").read_text().split()]
    except (FileNotFoundError, ProcessLookupError):
        return []


def wait_for(predicate, label):
    end = time.monotonic() + 20
    while not predicate():
        assert time.monotonic() < end, label
        time.sleep(.02)


def run(runtime, mode="unresolved"):
    root = pathlib.Path(tempfile.mkdtemp(prefix="pi-owner-loss-shutdown-"))
    session = f"pi-owner-loss-shutdown-{os.getpid()}-{runtime}"
    pins = {}
    result = {"runtime": runtime, "mode": mode, "root": str(root)}
    tty_fd = None
    try:
        entry = "bash --noprofile --norc"
        if mode != "unresolved":
            helper = REPO / "packages/coding-agent/dist/native/process-owner/pi-env"
            entry = f"{helper} supervise -- bash --noprofile --norc"
        call("tmux", "new-session", "-d", "-s", session, "-c", str(root), "-x", "140", "-y", "35", entry)
        shell = int(call("tmux", "display-message", "-p", "-t", session, "#{pane_pid}"))
        if mode != "unresolved":
            wait_for(lambda: children(shell) and children(children(shell)[0]), "ancestor caller ready")
            shell = children(children(shell)[0])[0]
        tty_fd = os.open(call("tmux", "display-message", "-p", "-t", session, "#{pane_tty}"), os.O_RDONLY | os.O_NOCTTY)
        args = ["env", "-i", f"PATH={os.environ['PATH']}", f"HOME={root}", f"TMPDIR={tempfile.gettempdir()}", f"PI_CODING_AGENT_DIR={root / 'agent'}", "PI_OFFLINE=1", f"REVIEW_ROOT={root}", runtime, *(["--import", str(REPO / "packages/coding-agent/src/experimental/source-resolver.ts")] if runtime == "node" else []), str(REPO / "packages/coding-agent/src/cli.ts"), "--no-extensions", "-e", str(pathlib.Path(__file__).with_name("owner-loss-shutdown.ts" if mode == "unresolved" else "blocking-owner-loss-shutdown.ts")), "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-session", "--offline", "--no-approve"]
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
        if mode == "preblocked":
            signal.pidfd_send_signal(pins["pi"], signal.SIGUSR2)
            wait_for(lambda: (root / "preblocked").exists(), "main JS already blocked before pause")
            os.killpg(outer, signal.SIGTSTP)  # Held, unreaped outer anchors this test-only group.
            wait_for(lambda: all(state(pids[role]) == "T" for role in ("outer", "pi", "payload")), "kernel pause with blocked main")
        elif mode == "running-blocked":
            signal.pidfd_send_signal(pins["pi"], signal.SIGTERM)
            wait_for(lambda: (root / "shutdown-started").exists(), "JS entered blocking shutdown")
            wait_for(lambda: all(state(pids[role]) in ("", "Z") for role in ("task_outer", "task_guardian", "payload")), "running task cancelled before owner loss")
            time.sleep(.1)
        else:
            call("tmux", "send-keys", "-t", session, "C-z")
            wait_for(lambda: all(state(pids[role]) == "T" for role in ("outer", "pi", "payload")), "actual paused session")
        tick = tick_file.read_text()
        time.sleep(.15)
        assert tick_file.read_text() == tick, "heartbeat did not freeze"
        if mode != "unresolved":
            # Keep the surviving ancestor in the same SID: no orphan-group HUP/CONT wake.
            ancestor = int(pathlib.Path(f"/proc/{shell}/stat").read_text().rsplit(") ", 1)[1].split()[1])
            result["surviving_ancestor"] = ancestor
            parent_stat = pathlib.Path(f"/proc/{ancestor}/stat").read_text().rsplit(") ", 1)[1].split()
            primary_stat = pathlib.Path(f"/proc/{primary}/stat").read_text().rsplit(") ", 1)[1].split()
            assert parent_stat[3] == primary_stat[3] and parent_stat[2] != primary_stat[2], "ancestor must prevent orphan-group signals"
            result["non_orphaned_group"] = True
            if mode == "running-blocked":
                result["raw_before_owner_loss"] = not termios.tcgetattr(tty_fd)[3] & termios.ICANON
                assert result["raw_before_owner_loss"], "running fixture must exercise raw tty hard exit"
            signal.pidfd_send_signal(pins["guardian"], signal.SIGSTOP)
            wait_for(lambda: state(guardian) == "T", "guardian held before fault")
        start = time.monotonic()
        for role in (("guardian", "outer") if mode == "unresolved" else ("outer", "guardian")):
            signal.pidfd_send_signal(pins[role], signal.SIGKILL)
        deadline = start + 8
        tty_output = root / "tty-state"
        # Query in an executing shell command, not during readline's own raw prompt.
        call("tmux", "send-keys", "-t", session, f"stty -a > {tty_output}", "Enter")
        cooked_observed_while_pi_alive = False
        while time.monotonic() < deadline and (any(state(pid) for pid in pids.values()) or not tty_output.exists()):
            if tty_output.exists() and state(primary) not in ("", "Z"):
                flags = set(re.split(r"[;\s]+", tty_output.read_text()))
                cooked_observed_while_pi_alive |= {"isig", "icanon", "echo"} <= flags
            time.sleep(.02)
        result["shell_restored_while_pi_alive"] = cooked_observed_while_pi_alive
        result.update(pids=pids, final={role: state(pid) for role, pid in pids.items()}, elapsed=round(time.monotonic() - start, 3), shutdown_started=(root / "shutdown-started").exists(), heartbeat_changed=tick_file.read_text() != tick, no_rescue_cont=True)
        flags = set(re.split(r"[;\s]+", tty_output.read_text())) if tty_output.exists() else set()
        result["cooked"] = {"isig", "icanon", "echo"} <= flags
        result["death_wake"] = (root / "death-wake").exists()
        if result["death_wake"]:
            result["ppid_at_death_wake"] = int((root / "death-wake").read_text())
        result["blocked_hook_completed"] = (root / "shutdown-done").exists()
        if mode == "blocking":
            assert result["death_wake"], "kernel CONT did not reach Pi before JS blocked"
            assert result["ppid_at_death_wake"] == result["surviving_ancestor"]
            assert not result["blocked_hook_completed"], "blocked hook completed before hard exit"
        if mode == "running-blocked":
            assert result["shell_restored_while_pi_alive"], "shell must restore cooked tty without Pi cleanup"
            assert not result["blocked_hook_completed"], "main-thread block outlasted enforcement"
        entered = (root / "preblocked").exists() and not result["shutdown_started"] if mode == "preblocked" else result["shutdown_started"]
        result["pass"] = not any(result["final"].values()) and entered and not result["heartbeat_changed"] and result["cooked"] and time.monotonic() <= deadline
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
    mode = "unresolved"
    runtimes = []
    for arg in sys.argv[1:]:
        if arg in ("--blocking", "--preblocked", "--running-blocked"):
            mode = arg[2:]
        else:
            runtimes.append(arg)
    for runtime in runtimes or ("node", "bun"):
        run(runtime, mode)
