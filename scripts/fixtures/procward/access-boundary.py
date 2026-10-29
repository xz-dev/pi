"""Windows access-boundary child: deny every other opener through an empty process DACL; Job containment must still hold."""
import ctypes
import pathlib
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


def deny_everyone():
    acl = ctypes.create_string_buffer(64)
    if not advapi.InitializeAcl(acl, len(acl), 2): raise ctypes.WinError(ctypes.get_last_error())
    # SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION; an empty DACL grants no access to anyone.
    status = advapi.SetSecurityInfo(kernel.GetCurrentProcess(), 6, 4, None, None, acl, None)
    if status: raise ctypes.WinError(status)


mode = sys.argv[1]
if mode == "exit":
    deny_everyone()
    sys.exit(int(sys.argv[2]))
if mode == "linger":
    deny_everyone()
    pathlib.Path(sys.argv[2]).write_text("ready\n")
    while True: time.sleep(60)
if mode == "check":
    # PROCESS_QUERY_LIMITED_INFORMATION must be refused with ERROR_ACCESS_DENIED.
    handle = kernel.OpenProcess(0x1000, False, int(sys.argv[2]))
    error = ctypes.get_last_error()
    if handle:
        kernel.CloseHandle(handle)
        sys.exit("controller can still open the access-boundary child")
    sys.exit(0 if error == 5 else f"OpenProcess failed with {error}, not ERROR_ACCESS_DENIED")
sys.exit(f"unknown mode {mode}")
