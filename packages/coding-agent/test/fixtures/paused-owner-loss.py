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


def run(runtime, mode="unresolved", fault="both", busy=False):
    root = pathlib.Path(tempfile.mkdtemp(prefix="pi-owner-loss-shutdown-"))
    session = f"pi-owner-loss-shutdown-{os.getpid()}-{runtime}"
    pins = {}
    result = {"runtime": runtime, "mode": mode, "fault": fault, "busy": busy, "root": str(root)}
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
        args = ["env", "-i", f"PATH={os.environ['PATH']}", f"HOME={root}", f"TMPDIR={tempfile.gettempdir()}", f"PI_CODING_AGENT_DIR={root / 'agent'}", "PI_OFFLINE=1", f"REVIEW_ROOT={root}", f"REVIEW_BUSY={int(busy)}", runtime, *(["--import", str(REPO / "packages/coding-agent/src/experimental/source-resolver.ts")] if runtime == "node" else []), str(REPO / "packages/coding-agent/src/cli.ts"), "--no-extensions", "-e", str(REPO / "packages/coding-agent/test/fixtures" / ("owner-loss-shutdown.ts" if mode == "unresolved" else "blocking-owner-loss-shutdown.ts")), "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-session", "--offline", "--no-approve"]
        call("tmux", "send-keys", "-t", session, shlex.join(args), "Enter")
        wait_for(lambda: (root / "extension-ready").exists(), "extension initialization")
        outer = children(shell)[0]
        anchor = children(outer)[0]
        guardian = children(anchor)[0]
        primary = children(guardian)[0]
        pids = {"outer": outer, "anchor": anchor, "guardian": guardian, "pi": primary}
        for role, pid in pids.items():
            pins[role] = os.pidfd_open(pid)
        result["helper_sha256"] = hashlib.sha256(pathlib.Path(f"/proc/{outer}/exe").read_bytes()).hexdigest()
        result["pi_exe"] = str(pathlib.Path(f"/proc/{primary}/exe").readlink())
        wait_for(lambda: not termios.tcgetattr(tty_fd)[3] & termios.ICANON, "raw input ready")
        # Initial raw mode precedes interactive key-handler installation.
        time.sleep(.7)
        wait_for(lambda: (root / "descendants-ready").exists(), "raw extension descendants ready")
        direct = int((root / "direct-pid").read_text())
        adopted = int((root / "adopted-pid").read_text())
        spawner = int((root / "orphan-spawner").read_text())
        assert not state(spawner), "orphan spawner must already be reaped"
        assert int(pathlib.Path(f"/proc/{direct}/stat").read_text().rsplit(") ", 1)[1].split()[1]) == primary
        wait_for(lambda: int(pathlib.Path(f"/proc/{adopted}/stat").read_text().rsplit(") ", 1)[1].split()[1]) == guardian, "grandchild adopted by guardian before fault")
        for role, pid in (("extension_child", direct), ("adopted_grandchild", adopted)):
            pids[role] = pid
            pins[role] = os.pidfd_open(pid)
        tick_file = root / "tick"
        call("tmux", "send-keys", "-t", session, f"!while :; do date +%s%N > {tick_file}; sleep .02; done", "Enter")
        wait_for(lambda: tick_file.exists() and any(pid != direct for pid in children(primary)), "heartbeat ready")
        task = next(pid for pid in children(primary) if pid != direct)
        wait_for(lambda: children(task) and children(children(task)[0]), "task controllers ready")
        pids.update(task_outer=task, task_guardian=children(task)[0], payload=children(children(task)[0])[0])
        for role in ("task_outer", "task_guardian", "payload"):
            pins[role] = os.pidfd_open(pids[role])
        raw_before_pause = {name: (root / name).read_text() for name in ("direct-tick", "adopted-tick")}
        wait_for(lambda: all((root / name).read_text() != value for name, value in raw_before_pause.items()), "raw descendants advancing before pause")
        if mode == "preblocked":
            signal.pidfd_send_signal(pins["pi"], signal.SIGUSR2)
            wait_for(lambda: (root / "preblocked").exists(), "main JS already blocked before pause")
            os.killpg(outer, signal.SIGTSTP)  # Held, unreaped outer anchors this test-only group.
            wait_for(lambda: all(state(pids[role]) == "T" for role in ("outer", "pi", "payload")), "kernel pause with blocked main")
        elif mode == "running-blocked":
            # Keep raw descendants stopped while Pi/main/tty remain running; only pinned test targets.
            for role in ("extension_child", "adopted_grandchild"):
                signal.pidfd_send_signal(pins[role], signal.SIGSTOP)
            wait_for(lambda: state(direct) == "T" and state(adopted) == "T", "raw descendants held before running shutdown")
            signal.pidfd_send_signal(pins["pi"], signal.SIGTERM)
            wait_for(lambda: (root / "shutdown-started").exists(), "JS entered blocking shutdown")
            wait_for(lambda: all(state(pids[role]) in ("", "Z") for role in ("task_outer", "task_guardian", "payload")), "running task cancelled before owner loss")
            time.sleep(.1)
        elif mode != "healthy":
            call("tmux", "send-keys", "-t", session, "C-z")
            wait_for(lambda: all(state(pids[role]) == "T" for role in ("outer", "pi", "payload")), "actual paused session")
        if mode not in ("healthy", "running-blocked"):
            wait_for(lambda: state(direct) == "T" and state(adopted) == "T", "raw and adopted descendants frozen")
        assert state(anchor) in ("R", "S"), "anchor must stay runnable"
        anchor_stat = pathlib.Path(f"/proc/{anchor}/stat").read_text().rsplit(") ", 1)[1].split()
        outer_stat = pathlib.Path(f"/proc/{outer}/stat").read_text().rsplit(") ", 1)[1].split()
        assert int(anchor_stat[2]) == anchor and anchor_stat[3] == outer_stat[3], "anchor must own PG in job SID"
        result["anchor_own_pg_same_sid"] = True
        tick = tick_file.read_text()
        raw_ticks = {name: (root / name).read_text() for name in ("direct-tick", "adopted-tick")}
        time.sleep(.15)
        if mode != "healthy":
            assert tick_file.read_text() == tick, "heartbeat did not freeze"
            assert all((root / name).read_text() == value for name, value in raw_ticks.items()), "raw descendant heartbeat did not freeze"
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
            if fault == "both":
                signal.pidfd_send_signal(pins["guardian"], signal.SIGSTOP)
                wait_for(lambda: state(guardian) == "T", "guardian held before fault")
        start = time.monotonic()
        roles = (("guardian", "outer") if mode == "unresolved" else ("outer", "guardian")) if fault == "both" else (fault,)
        for role in roles:
            signal.pidfd_send_signal(pins[role], signal.SIGKILL)
        deadline = start + 8
        tty_output = root / "tty-state"
        # Query in an executing shell command, not during readline's own raw prompt.
        call("tmux", "send-keys", "-t", session, f"stty -a > {tty_output}.tmp && mv {tty_output}.tmp {tty_output}", "Enter")
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
        if mode == "blocking" and fault in ("both", "guardian"):
            assert result["death_wake"], "kernel CONT did not reach Pi before JS blocked"
            assert result["ppid_at_death_wake"] == anchor
            assert not result["blocked_hook_completed"], "blocked hook completed before hard exit"
        if mode == "running-blocked":
            assert result["shell_restored_while_pi_alive"], "shell must restore cooked tty without Pi cleanup"
            assert not result["blocked_hook_completed"], "main-thread block outlasted enforcement"
        entered = (root / "preblocked").exists() and not result["shutdown_started"] if mode == "preblocked" else result["shutdown_started"]
        result["raw_heartbeat_changed"] = any((root / name).read_text() != value for name, value in raw_ticks.items())
        # A live guardian can make outer/anchor-loss CONT look like fg; record hook entry without requiring it for these faults.
        requires_entry = fault not in ("outer", "anchor") or mode in ("preblocked", "running-blocked")
        result["hook_entered"] = result["shutdown_started"]
        result["pass"] = not any(result["final"].values()) and (entered or not requires_entry) and (mode == "healthy" or (not result["heartbeat_changed"] and not result["raw_heartbeat_changed"])) and result["cooked"] and time.monotonic() <= deadline
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
    fault = "both"
    busy = False
    for arg in sys.argv[1:]:
        if arg in ("--blocking", "--preblocked", "--running-blocked", "--healthy"):
            mode = arg[2:]
        elif arg.startswith("--fault="):
            fault = arg.split("=", 1)[1]
            assert fault in ("both", "guardian", "anchor", "outer")
        elif arg == "--busy":
            busy = True
        else:
            runtimes.append(arg)
    for runtime in runtimes or ("node", "bun"):
        run(runtime, mode, fault, busy)
