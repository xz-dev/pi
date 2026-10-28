"""Observe ownership layers for Pi integration; never infer containment from names."""
import ctypes
import json
import os
import subprocess
import sys

pid = int(sys.argv[1]) if len(sys.argv) > 1 else os.getpid()
stop = int(os.environ["PI_PROCWARD_CONTRACT_HARNESS_PID"])
processes = {}
if os.name == "nt":
    from ctypes import wintypes as w
    class Entry(ctypes.Structure):
        _fields_ = [("dwSize", w.DWORD), ("cntUsage", w.DWORD), ("th32ProcessID", w.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", w.DWORD),
                    ("cntThreads", w.DWORD), ("th32ParentProcessID", w.DWORD),
                    ("pcPriClassBase", w.LONG), ("dwFlags", w.DWORD), ("szExeFile", w.WCHAR * 260)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = w.HANDLE
    kernel.Process32FirstW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
    kernel.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
    try:
        entry = Entry()
        entry.dwSize = ctypes.sizeof(entry)
        ok = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            processes[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile)
            ok = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally: kernel.CloseHandle(snapshot)
else:
    for line in subprocess.check_output(["ps", "-A", "-o", "pid=,ppid=,comm="], text=True).splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3: processes[int(fields[0])] = (int(fields[1]), os.path.basename(fields[2]))
chain = []
seen = set()
while pid != stop:
    if pid <= 1 or pid in seen or pid not in processes: raise RuntimeError("harness is not a live ancestor")
    seen.add(pid)
    parent, name = processes[pid]
    chain.append({"pid": pid, "parent": parent, "name": name})
    pid = parent
print(json.dumps({"chain": chain, "ownerLayers": sum(row["name"] in ("procward", "procward.exe") for row in chain)}))
