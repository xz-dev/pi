"""Finite x86_64 Linux OS-seam harness. Exact daemon bytes and clocks stay unchanged."""
import ctypes
import errno
import glob
import json
import os
import select
import signal
import subprocess
import sys
import time

signal.alarm(7)
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.restype = ctypes.c_long


class Regs(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                "r15 r14 r13 r12 rbp rbx r11 r10 r9 r8 rax rcx rdx rsi rdi orig_rax rip cs eflags rsp ss fs_base gs_base ds es fs gs".split()]


def ptrace(request, tid, address=0, data=0):
    ctypes.set_errno(0)
    result = libc.ptrace(request, tid, ctypes.c_void_p(address),
                         ctypes.c_void_p(data) if isinstance(data, int) else data)
    if result == -1 and ctypes.get_errno():
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return result


def registers(tid):
    value = Regs()
    ptrace(12, tid, 0, ctypes.byref(value))
    return value


def memory(tid, address, size):
    result = bytearray()
    for offset in range(0, size, 8):
        result.extend((ptrace(2, tid, address + offset) & ((1 << 64) - 1)).to_bytes(8, "little"))
    return bytes(result[:size])


def write_memory(tid, address, data):
    for offset in range(0, len(data), 8):
        part = data[offset:offset + 8]
        if len(part) < 8:
            part += memory(tid, address + offset + len(part), 8 - len(part))
        ptrace(5, tid, address + offset, int.from_bytes(part, "little"))


def publish(path, value):
    with open(path + ".tmp", "w", encoding="ascii") as stream:
        json.dump(value, stream)
    os.replace(path + ".tmp", path)


def resume(tid, sig=0):
    try:
        ptrace(24, tid, 0, sig)
    except ProcessLookupError:
        pass


def fd_path(tid, fd):
    try:
        return os.readlink(f"/proc/{tid}/fd/{fd}")
    except FileNotFoundError:
        return ""


def altered_control(mode, original):
    lines = original.splitlines(keepends=True)
    assert len(lines) == 3 and lines[0].startswith(b'S{') and lines[1].startswith(b'X{') and lines[2] == b'C\n', original
    start, status, complete = lines
    assert json.loads(status[1:])["code"] == (125 if mode == 'control-missing-c-125' else 7)
    return {
        'control-valid': original,
        'control-missing-c': start + status,
        'control-missing-c-125': start + status,
        'control-c-only': complete,
        'control-malformed': b'S{"pid":"invalid"}\n' + status + complete,
        'control-order': status + start + complete,
        'control-oversize': b'x' * 4097,
        'control-partial': start + status + b'C',
        'control-status-mismatch': start + b'X{"code":8,"signal":null}\n' + complete,
    }[mode]


assert os.uname().machine == "x86_64", "OS-seam fixture requires qualified x86_64 artifact"
daemon, ready_path, mode, *args = sys.argv[1:]
assert mode in ('timeout', 'stop-setup', 'stop-publication', 'stop-replace', 'observe', 'spill-control') or mode.startswith('control-')
command_fd = os.open(ready_path + ".arm", os.O_RDONLY | os.O_NONBLOCK)
child = subprocess.Popen([daemon, *args])
events = []
tasks = {}
held = None
fired = False
control_complete = False
fault_done = False
spill_failed = False
pending_errno = {}
current = {}
specs = {}
memfds = 0
detach = set()


def record():
    publish(ready_path + ".trace", dict(mode=mode, daemon=child.pid, events=events,
            releasedAfterReady=any(event['event'] == 'release-after-ready' for event in events)))


def hold(tid, point):
    global held, fired
    assert held is None
    held = tid
    fired = True
    events.append(dict(event='held', tid=tid, point=point, scope=memfds))
    publish(ready_path + ".held", dict(tid=tid, point=point, scope=memfds))
    record()


try:
    readable, _, _ = select.select([command_fd], [], [], 5)
    assert readable and os.read(command_fd, 1) == b"A", "OS-seam tracer was not armed"
    tasks = {int(path.rsplit("/", 1)[1]): child.pid for path in glob.glob(f"/proc/{child.pid}/task/*")}
    for tid in tasks:
        # SEIZE + syscall/fork/clone events + EXITKILL; exact owned child tree only.
        ptrace(0x4206, tid, 0, 1 | 2 | 4 | 8 | 16 | 0x100000)
    for tid in tasks:
        ptrace(0x4207, tid)
    waiting = set(tasks)
    while waiting:
        tid, status = os.waitpid(-1, 0x40000000)
        assert os.WIFSTOPPED(status)
        waiting.discard(tid)
    for tid in tasks:
        resume(tid)
    publish(ready_path + ".armed", dict(daemon=child.pid, armed=True))
    while child.returncode is None or (mode == 'observe' and tasks):
        try:
            command = os.read(command_fd, 1)
        except BlockingIOError:
            command = b''
        if command == b'K':
            events.append(dict(event='kill-exact-daemon-handle', pid=child.pid))
            child.kill()
        if held is not None:
            if mode == 'timeout' and os.path.exists(ready_path):
                with open(ready_path, encoding='ascii') as stream:
                    ready = json.load(stream)
                assert ready['primary']['pid'] > 0 and ready['leaf']['pid'] > 0
                events.append(dict(event='release-after-ready', tid=held, primary=ready['primary']['pid'], leaf=ready['leaf']['pid']))
                resume(held)
                held = None
                record()
            elif (mode.startswith('control-') or mode == 'spill-control') and control_complete:
                events.append(dict(event='release-control-reader-after-real-C-write', tid=held))
                resume(held)
                held = None
                record()
            elif command == b'R':
                events.append(dict(event='release-after-client-stop-barrier', tid=held))
                resume(held)
                held = None
                record()
        try:
            tid, status = os.waitpid(-1, os.WNOHANG | 0x40000000)
        except ChildProcessError:
            break
        if not tid:
            time.sleep(0.0002)
            continue
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):
            events.append(dict(event='actual-task-exit', tid=tid, tgid=tasks.pop(tid, None), status=status))
            if tid == child.pid:
                child.returncode = os.waitstatus_to_exitcode(status)
            continue
        if tid in detach:
            ptrace(17, tid)
            detach.remove(tid)
            tasks.pop(tid, None)
            continue
        sig = os.WSTOPSIG(status)
        event = status >> 16
        if event in (1, 2, 3):
            new = ctypes.c_ulonglong()
            ptrace(0x4201, tid, 0, ctypes.byref(new))
            with open(f'/proc/{new.value}/status', encoding='ascii') as stream:
                tgid = int(next(line.split()[1] for line in stream if line.startswith('Tgid:')))
            tasks[new.value] = tgid
            if tgid != child.pid:
                events.append(dict(event='process-fork', parent=tid, child=new.value, tgid=tgid, scope=memfds, fromDaemon=tasks.get(tid) == child.pid))
                record()
                if mode == 'timeout':
                    # Only spawning daemon runner is held. Helper/payload continue without tracing.
                    detach.add(new.value)
                    fd = specs.get(tid)
                    if fd is not None and not fired:
                        with open(f'/proc/{child.pid}/fd/{fd}', 'rb') as stream:
                            spec = stream.read(32768)
                        if ('PI_ENV_C_READY_FILE=' + ready_path).encode() in spec:
                            hold(tid, 'committed-helper-fork')
                            continue
            resume(tid)
            continue
        if sig == (signal.SIGTRAP | 0x80):
            info = ctypes.create_string_buffer(128)
            try:
                ptrace(0x420e, tid, 128, info)
                value = registers(tid)
            except ProcessLookupError:
                # Concurrent SIGKILL can remove a stopped tracee before register inspection.
                continue
            if info.raw[0] == 1:
                point = None
                native = tasks.get(tid) == child.pid
                if native and value.orig_rax == 319:
                    memfds += 1
                    point = 'memfd'
                elif native and value.orig_rax == 257 and tid in specs:
                    if memory(tid, value.rsi, 10).split(b'\0', 1)[0] == b'/dev/null':
                        point = 'spawn-stdio'
                elif native and tid not in specs and value.orig_rax in (0, 45) and value.rdi > 2 and fd_path(tid, value.rdi).startswith('socket:'):
                    point = 'control-read'
                elif not native and value.orig_rax == 1 and value.rdi > 2 and value.rdx == 2 and memory(tid, value.rsi, 2) == b'C\n':
                    point = 'C-write'
                elif native and value.orig_rax == 1 and '/pi-output-' in fd_path(tid, value.rdi):
                    point = 'spill-write'
                current[tid] = point
                gate = ((mode == 'stop-setup' and point == 'memfd' and memfds == 1)
                        or (mode == 'stop-replace' and point == 'memfd' and memfds == 2)
                        or (mode == 'stop-publication' and point == 'spawn-stdio' and memfds == 1)
                        or ((mode.startswith('control-') or mode == 'spill-control') and point == 'control-read'))
                if not fired and gate:
                    hold(tid, point)
                    continue
                if mode == 'spill-control' and point == 'spill-write' and not spill_failed:
                    # OS error at actual native spill write, not an RPC/error-category stand-in.
                    value.orig_rax = (1 << 64) - 1
                    ptrace(13, tid, 0, ctypes.byref(value))
                    pending_errno[tid] = errno.EFBIG
            elif info.raw[0] == 2:
                point = current.pop(tid, None)
                if value.orig_rax == 319 and value.rax < (1 << 63):
                    specs[tid] = value.rax
                if point == 'C-write' and value.rax == 2:
                    control_complete = True
                    events.append(dict(event='actual-C-write', tid=tid, tgid=tasks.get(tid)))
                if tid in pending_errno:
                    error = pending_errno.pop(tid)
                    value.rax = (-error) & ((1 << 64) - 1)
                    ptrace(13, tid, 0, ctypes.byref(value))
                    spill_failed = True
                    events.append(dict(event='native-spill-write-EFBIG', tid=tid))
                    record()
                if point == 'control-read' and 0 < value.rax < (1 << 63) and not fault_done and (mode.startswith('control-') or mode == 'spill-control'):
                    original = memory(tid, value.rsi, value.rax)
                    assert control_complete and original.endswith(b'C\n'), original
                    if mode == 'spill-control':
                        assert spill_failed, 'uncertainty must follow native spill failure'
                        value.rax = (-errno.EIO) & ((1 << 64) - 1)
                        events.append(dict(event='native-control-read-EIO', original=original.decode('ascii')))
                    else:
                        changed = altered_control(mode, original)
                        assert len(changed) <= value.rdx
                        write_memory(tid, value.rsi, changed)
                        value.rax = len(changed)
                        events.append(dict(event='native-control-read-substitution', original=original.decode('ascii'), fault=mode, returnedBytes=len(changed)))
                    ptrace(13, tid, 0, ctypes.byref(value))
                    fault_done = True
                    record()
            resume(tid)
        elif event or sig in (signal.SIGSTOP, signal.SIGTRAP):
            resume(tid)
        else:
            resume(tid, sig)
    if mode == 'observe':
        record()
        assert not tasks, 'all traced native descendant exits must be joined before transport closes'
        publish(ready_path + '.done', dict(joined=True, events=events, daemonStatus=child.returncode))
finally:
    os.close(command_fd)
    if child.returncode is None:
        child.kill()
        child.wait(timeout=1)
sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
