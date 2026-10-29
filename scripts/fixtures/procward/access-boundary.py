"""Windows access-boundary child: deny every other opener through an empty process DACL; Job containment must still hold."""
import ctypes
import os
import pathlib
import subprocess
import sys
import time
from ctypes import wintypes as w

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
advapi = ctypes.WinDLL("advapi32", use_last_error=True)
kernel.GetCurrentProcess.restype = w.HANDLE
kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
kernel.OpenProcess.restype = w.HANDLE
kernel.CloseHandle.argtypes = [w.HANDLE]
advapi.InitializeAcl.argtypes = [ctypes.c_void_p, w.DWORD, w.DWORD]
advapi.SetSecurityInfo.argtypes = [w.HANDLE, ctypes.c_int, w.DWORD, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
advapi.SetSecurityInfo.restype = w.DWORD
advapi.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
advapi.LookupPrivilegeValueW.argtypes = [w.LPCWSTR, w.LPCWSTR, ctypes.c_void_p]
advapi.AdjustTokenPrivileges.argtypes = [w.HANDLE, w.BOOL, ctypes.c_void_p, w.DWORD, ctypes.c_void_p, ctypes.c_void_p]


def deny_everyone():
    acl = ctypes.create_string_buffer(64)
    if not advapi.InitializeAcl(acl, len(acl), 2): raise ctypes.WinError(ctypes.get_last_error())
    # SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION; an empty DACL grants no access to anyone.
    status = advapi.SetSecurityInfo(kernel.GetCurrentProcess(), 6, 4, None, None, acl, None)
    if status: raise ctypes.WinError(status)


def drop_debug_privilege():
    # Hosted runners hand descendants an admin token whose SeDebugPrivilege bypasses process DACLs.
    # Remove it from this token; children (procward, Pi, the checker) inherit the reduced copy.
    class Privileges(ctypes.Structure):
        _fields_ = [("count", w.DWORD), ("luid", w.DWORD * 2), ("attributes", w.DWORD)]  # TOKEN_PRIVILEGES, one LUID_AND_ATTRIBUTES
    token = w.HANDLE()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x28, ctypes.byref(token)): raise ctypes.WinError(ctypes.get_last_error())
    try:
        privileges = Privileges(1, (w.DWORD * 2)(), 4)  # SE_PRIVILEGE_REMOVED
        if not advapi.LookupPrivilegeValueW(None, "SeDebugPrivilege", ctypes.byref(privileges, Privileges.luid.offset)): raise ctypes.WinError(ctypes.get_last_error())
        if not advapi.AdjustTokenPrivileges(token, False, ctypes.byref(privileges), 0, None, None): raise ctypes.WinError(ctypes.get_last_error())
        error = ctypes.get_last_error()
        if error not in (0, 1300): raise ctypes.WinError(error)  # 1300: the token never held it
    finally: kernel.CloseHandle(token)


mode = sys.argv[1]
if mode == "launch":
    drop_debug_privilege()
    sys.exit(subprocess.run(sys.argv[2:]).returncode)
if mode == "exit":
    deny_everyone()
    sys.exit(int(sys.argv[2]))
if mode == "linger":
    deny_everyone()
    pathlib.Path(sys.argv[2]).write_text(f"{os.getpid()}\n")
    while True: time.sleep(60)
if mode == "check":
    drop_debug_privilege()
    # PROCESS_QUERY_LIMITED_INFORMATION must be refused with ERROR_ACCESS_DENIED.
    handle = kernel.OpenProcess(0x1000, False, int(sys.argv[2]))
    error = ctypes.get_last_error()
    if handle:
        kernel.CloseHandle(handle)
        sys.exit("controller can still open the access-boundary child")
    sys.exit(0 if error == 5 else f"OpenProcess failed with {error}, not ERROR_ACCESS_DENIED")
sys.exit(f"unknown mode {mode}")
