#!/usr/bin/env python3
"""Cooperative Windows notice contract in a retained ConPTY; no Job fault matrix."""
import ctypes as c
from ctypes import wintypes as w
import json
import os
import pathlib
import subprocess
import sys
import threading
import time

command, extension, directory, blocked, scale = sys.argv[1:]
root = pathlib.Path(directory)
root.mkdir(parents=True)
k = c.WinDLL("kernel32", use_last_error=True)
HANDLE = w.HANDLE
class Security(c.Structure):
    _fields_ = [("length", w.DWORD), ("descriptor", c.c_void_p), ("inherit", w.BOOL)]
class Coord(c.Structure):
    _fields_ = [("X", c.c_short), ("Y", c.c_short)]
class Startup(c.Structure):
    _fields_ = [("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR), ("title", w.LPWSTR),
                ("x", w.DWORD), ("y", w.DWORD), ("width", w.DWORD), ("height", w.DWORD),
                ("xchars", w.DWORD), ("ychars", w.DWORD), ("fill", w.DWORD), ("flags", w.DWORD),
                ("show", w.WORD), ("reserved_size", w.WORD), ("reserved_bytes", c.c_void_p),
                ("input", HANDLE), ("output", HANDLE), ("error", HANDLE)]
class StartupEx(c.Structure):
    _fields_ = [("startup", Startup), ("attributes", c.c_void_p)]
class Process(c.Structure):
    _fields_ = [("process", HANDLE), ("thread", HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]
class Filetime(c.Structure):
    _fields_ = [("low", w.DWORD), ("high", w.DWORD)]

k.CreatePipe.argtypes = [c.POINTER(HANDLE), c.POINTER(HANDLE), c.POINTER(Security), w.DWORD]
k.CloseHandle.argtypes = [HANDLE]
k.SetHandleInformation.argtypes = [HANDLE, w.DWORD, w.DWORD]
k.CreatePseudoConsole.argtypes = [Coord, HANDLE, HANDLE, w.DWORD, c.POINTER(HANDLE)]
k.CreatePseudoConsole.restype = c.c_long
k.ClosePseudoConsole.argtypes = [HANDLE]
k.InitializeProcThreadAttributeList.argtypes = [c.c_void_p, w.DWORD, w.DWORD, c.POINTER(c.c_size_t)]
k.UpdateProcThreadAttribute.argtypes = [c.c_void_p, w.DWORD, c.c_size_t, c.c_void_p, c.c_size_t, c.c_void_p, c.c_void_p]
k.DeleteProcThreadAttributeList.argtypes = [c.c_void_p]
k.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD, c.c_void_p, w.LPCWSTR, c.c_void_p, c.POINTER(Process)]
k.WaitForSingleObject.argtypes = [HANDLE, w.DWORD]
k.WaitForSingleObject.restype = w.DWORD
k.GetExitCodeProcess.argtypes = [HANDLE, c.POINTER(w.DWORD)]
k.TerminateProcess.argtypes = [HANDLE, w.UINT]
k.GetCurrentProcess.restype = HANDLE
k.GetProcessTimes.argtypes = [HANDLE] + [c.POINTER(Filetime)] * 4
k.ReadFile.argtypes = [HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p]
k.WriteFile.argtypes = [HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p]

def check(ok):
    if not ok: raise c.WinError(c.get_last_error())

def pipe():
    read, write = HANDLE(), HANDLE()
    security = Security(c.sizeof(Security), None, False)
    check(k.CreatePipe(c.byref(read), c.byref(write), c.byref(security), 0))
    return read, write

def write(handle, data):
    count = w.DWORD()
    check(k.WriteFile(handle, data, len(data), c.byref(count), None))
    if count.value != len(data): raise RuntimeError("short pipe write")

input_read, input_write = pipe()
output_read, output_write = pipe()
console = HANDLE()
if k.CreatePseudoConsole(Coord(100, 24), input_read, output_write, 0, c.byref(console)) != 0:
    raise RuntimeError("CreatePseudoConsole failed")
k.CloseHandle(input_read)
k.CloseHandle(output_write)
output = bytearray()

def drain():
    buffer = c.create_string_buffer(65536)
    count = w.DWORD()
    while k.ReadFile(output_read, buffer, len(buffer), c.byref(count), None) and count.value:
        chunk = buffer.raw[:count.value]
        output.extend(chunk)
        if b"\x1b[6n" in chunk:
            try: write(input_write, b"\x1b[1;1R")
            except OSError: return

reader = threading.Thread(target=drain, daemon=True)
reader.start()
base_env = {key: value for key, value in os.environ.items() if not key.startswith(("PROCWARD_", "PI_PROCESS_OWNER_"))}
base_env.update(PI_OFFLINE="1", PI_TELEMETRY="0", TERM="xterm-256color")
children = []

def launch(args, env, inherited=None):
    size = c.c_size_t()
    count = 2 if inherited else 1
    k.InitializeProcThreadAttributeList(None, count, 0, c.byref(size))
    storage = c.create_string_buffer(size.value)
    attributes = c.cast(storage, c.c_void_p)
    check(k.InitializeProcThreadAttributeList(attributes, count, 0, c.byref(size)))
    try:
        check(k.UpdateProcThreadAttribute(attributes, 0, 0x20016, console, c.sizeof(HANDLE), None, None))
        if inherited:
            handles = (HANDLE * 1)(inherited.value)
            check(k.UpdateProcThreadAttribute(attributes, 0, 0x20002, c.cast(handles, c.c_void_p), c.sizeof(handles), None, None))
        startup = StartupEx()
        startup.startup.cb = c.sizeof(startup)
        # Null standard handles: the pseudoconsole supplies them. Otherwise a child of a redirected parent
        # (CI) copies the parent's pipe handle values, which are invalid in the child (ERROR_INVALID_HANDLE).
        startup.startup.flags = 0x100  # STARTF_USESTDHANDLES
        startup.attributes = attributes
        info = Process()
        environment = c.create_unicode_buffer("\0".join(f"{key}={value}" for key, value in sorted(env.items(), key=lambda item: item[0].upper())) + "\0\0")
        cmdline = c.create_unicode_buffer(subprocess.list2cmdline(args))
        check(k.CreateProcessW(args[0], cmdline, None, None, bool(inherited), 0x80000 | 0x400, environment, str(root), c.byref(startup), c.byref(info)))
        k.CloseHandle(info.thread)
        children.append(info.process)
        return info
    finally: k.DeleteProcThreadAttributeList(attributes)

def wait(info, seconds):
    if k.WaitForSingleObject(info.process, round(seconds * 1000)) != 0: raise TimeoutError("ConPTY child deadline")
    code = w.DWORD()
    check(k.GetExitCodeProcess(info.process, c.byref(code)))
    if code.value != 0: raise RuntimeError(f"ConPTY child failed {code.value}: {output[-5000:]!r}")

def modes(name):
    path = root / name
    script = """import ctypes as c, json, pathlib, sys
from ctypes import wintypes as w
k=c.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,c.c_void_p,w.DWORD,w.DWORD,w.HANDLE]; k.CreateFileW.restype=w.HANDLE
k.GetConsoleMode.argtypes=[w.HANDLE,c.POINTER(w.DWORD)]
values=[]
# The console's own input and active screen buffers, independent of inherited standard handles.
for name in ('CONIN$','CONOUT$'):
    handle=k.CreateFileW(name,0xC0000000,3,None,3,0,None)
    value=w.DWORD()
    if handle in (None,w.HANDLE(-1).value) or not k.GetConsoleMode(handle,c.byref(value)): raise c.WinError(c.get_last_error())
    values.append(value.value)
pathlib.Path(sys.argv[1]).write_text(json.dumps(values)+'\\n')
"""
    wait(launch([sys.executable, "-c", script, str(path)], base_env), 10 * float(scale))
    return json.loads(path.read_text())

read_notice = write_notice = None
try:
    before = modes("console-before.json")
    read_notice, write_notice = pipe()
    check(k.SetHandleInformation(read_notice, 1, 1))
    times = [Filetime() for _ in range(4)]
    check(k.GetProcessTimes(k.GetCurrentProcess(), *[c.byref(value) for value in times]))
    identity = f"{(times[0].high << 32) | times[0].low:016x}"
    launch_id = "a" * 32
    env = dict(base_env, PROCWARD_PROTOCOL="1", PROCWARD_OWNER_PID=str(os.getpid()),
               PROCWARD_CONTRACT_ID=launch_id, PROCWARD_LIFECYCLE_HANDLE=str(read_notice.value),
               PI_PROCWARD_BOOTSTRAP_NONCE=launch_id,
               PI_PROCWARD_CONTRACT_DIRECTORY=str(root), PI_PROCWARD_CONTRACT_BLOCKED=blocked,
               PI_CODING_AGENT_DIR=str(root / "agent"))
    child = launch(json.loads(command) + ["--offline", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "anthropic", "--model", "claude-sonnet-4-5", "--api-key", "fixture-never-used", "-e", extension], env, read_notice)
    k.CloseHandle(read_notice)
    read_notice = None
    write(write_notice, f"PROCWARD/1 READY {os.getpid()} {child.pid} {identity} {launch_id}\n".encode())
    deadline = time.monotonic() + 30 * float(scale)
    ready = root / "ready.json"
    while not (ready.exists() and ready.read_bytes().endswith(b"\n")):
        if k.WaitForSingleObject(child.process, 20) == 0: raise RuntimeError(f"Pi exited before readiness: {output[-5000:]!r}")
        if time.monotonic() >= deadline: raise TimeoutError(f"Pi readiness deadline: {output[-5000:]!r}")
    started = time.monotonic()
    write(write_notice, f"PROCWARD/1 OWNER-LOSS {launch_id}\n".encode())
    k.CloseHandle(write_notice)
    write_notice = None
    wait(child, 9 * float(scale))
    elapsed = time.monotonic() - started
    if not (root / "hook.json").exists(): raise RuntimeError("notice did not run shutdown hook")
    after = modes("console-after.json")
    if before != after: raise RuntimeError(f"console modes not restored: {before} != {after}")
    if blocked == "1" and not (4.5 <= elapsed < 6.5 * float(scale)): raise RuntimeError(f"5s hook bound not observed: {elapsed}")
    print(json.dumps({"noticeOnly": True, "parentAlive": True, "hookRan": True, "terminalRestored": True,
                      "terminalBefore": before, "terminalAfter": after, "elapsedMs": round(elapsed * 1000),
                      "blockedHook": blocked == "1", "scope": "cooperative notice only; Job close can preempt hooks"}))
finally:
    for handle in (read_notice, write_notice):
        if handle: k.CloseHandle(handle)
    for handle in children:
        if k.WaitForSingleObject(handle, 0) != 0: k.TerminateProcess(handle, 125); k.WaitForSingleObject(handle, 5000)
        k.CloseHandle(handle)
    k.ClosePseudoConsole(console)
    reader.join(timeout=5)
    k.CloseHandle(input_write)
    k.CloseHandle(output_read)
    (root / "terminal-output.bin").write_bytes(output)
