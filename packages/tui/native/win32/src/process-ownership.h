#ifndef PI_WINDOWS_PROCESS_OWNERSHIP_H
#define PI_WINDOWS_PROCESS_OWNERSHIP_H

#include <tlhelp32.h>

typedef int (PI_NAPI_CALL *napi_create_uint32_fn)(napi_env, uint32_t, napi_value*);

static HANDLE ownership_pipe(napi_env env, napi_callback_info info, bool private_read) {
    napi_get_cb_info_fn get_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_value_string_utf8_fn get_string = (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    size_t argc = 1, length = 0;
    napi_value argument = 0;
    if (!get_info || !get_string || get_info(env, info, &argc, &argument, 0, 0) != 0 || argc != 1 ||
        get_string(env, argument, 0, 0, &length) != 0 || length == 0 || length > 20) return 0;
    char text[21] = {0};
    size_t copied = 0;
    if (get_string(env, argument, text, sizeof(text), &copied) != 0 || copied != length || text[0] == '0') return 0;
    uint64_t raw = 0;
    for (size_t i = 0; i < length; i++) {
        if (text[i] < '0' || text[i] > '9') return 0;
        uint64_t digit = (uint64_t)(text[i] - '0');
        if (raw > (UINT64_MAX - digit) / 10) return 0;
        raw = raw * 10 + digit;
    }
    if (raw > UINTPTR_MAX) return 0;
    HANDLE handle = (HANDLE)(uintptr_t)raw;
    DWORD flags = 0;
    if (!handle || handle == INVALID_HANDLE_VALUE ||
        handle == GetStdHandle(STD_INPUT_HANDLE) || handle == GetStdHandle(STD_OUTPUT_HANDLE) ||
        handle == GetStdHandle(STD_ERROR_HANDLE) || !GetHandleInformation(handle, &flags) ||
        GetFileType(handle) != FILE_TYPE_PIPE || (private_read && (flags & HANDLE_FLAG_INHERIT))) return 0;
    return handle;
}

static napi_value PI_NAPI_CALL prepare_ownership_pipe(napi_env env, napi_callback_info info) {
    HANDLE handle = ownership_pipe(env, info, false);
    DWORD available = 0;
    if (!handle || !PeekNamedPipe(handle, 0, 0, 0, &available, 0) ||
        !SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0)) {
        return fail(env, "Could not accept non-inheritable procward lifecycle pipe");
    }
    return undefined_value(env);
}

static napi_value PI_NAPI_CALL read_ownership_pipe(napi_env env, napi_callback_info info) {
    HANDLE handle = ownership_pipe(env, info, true);
    if (!handle) return fail(env, "Invalid procward lifecycle HANDLE");
    DWORD available = 0;
    if (!PeekNamedPipe(handle, 0, 0, 0, &available, 0)) {
        if (GetLastError() == ERROR_BROKEN_PIPE) return null_value(env);
        return fail(env, "Could not inspect procward lifecycle pipe");
    }
    if (!available) return undefined_value(env);
    uint8_t bytes[256];
    DWORD read = 0;
    // The lifecycle worker is the only reader; read no more than is available.
    if (!ReadFile(handle, bytes, (DWORD)(available < sizeof(bytes) ? available : sizeof(bytes)), &read, 0)) {
        if (GetLastError() == ERROR_BROKEN_PIPE) return null_value(env);
        return fail(env, "Could not read procward lifecycle pipe");
    }
    if (!read) return null_value(env);
    napi_create_buffer_copy_fn create_buffer = (napi_create_buffer_copy_fn)node_symbol("napi_create_buffer_copy");
    napi_value result = 0;
    if (!create_buffer || create_buffer(env, read, bytes, 0, &result) != 0) return fail(env, "Could not copy lifecycle record");
    return result;
}

static napi_value PI_NAPI_CALL close_ownership_pipe(napi_env env, napi_callback_info info) {
    HANDLE handle = ownership_pipe(env, info, false);
    if (!handle || !CloseHandle(handle)) return fail(env, "Could not close procward lifecycle pipe");
    return undefined_value(env);
}

static napi_value PI_NAPI_CALL ownership_parent_identity(napi_env env, napi_callback_info info) {
    (void)info;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return fail(env, "Could not query native parent process");
    PROCESSENTRY32W entry;
    entry.dwSize = (DWORD)sizeof(entry);
    DWORD self = GetCurrentProcessId(), parent = 0;
    if (Process32FirstW(snapshot, &entry)) {
        do {
            if (entry.th32ProcessID == self) { parent = entry.th32ParentProcessID; break; }
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    if (!parent) return fail(env, "Native parent process missing");
    HANDLE owner = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, parent);
    if (!owner) return fail(env, "Could not open native parent process");
    FILETIME created = {0}, exited = {0}, kernel = {0}, user = {0};
    bool valid = GetProcessTimes(owner, &created, &exited, &kernel, &user) != 0;
    DWORD state = WaitForSingleObject(owner, 0);
    CloseHandle(owner);
    if (!valid || state != WAIT_TIMEOUT) return fail(env, "Native parent is not live");
    // Never round the 64-bit FILETIME through a JavaScript Number.
    uint64_t time = ((uint64_t)created.dwHighDateTime << 32) | created.dwLowDateTime;
    char identity[17] = {0};
    for (size_t i = 0; i < 16; i++) identity[15 - i] = "0123456789abcdef"[(time >> (i * 4)) & 15];
    napi_get_value_fn create_object = (napi_get_value_fn)node_symbol("napi_create_object");
    napi_create_uint32_fn create_pid = (napi_create_uint32_fn)node_symbol("napi_create_uint32");
    napi_create_string_utf8_fn create_string = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    napi_set_named_property_fn set = (napi_set_named_property_fn)node_symbol("napi_set_named_property");
    napi_value result = 0, pid = 0, token = 0;
    if (!create_object || !create_pid || !create_string || !set || create_object(env, &result) != 0 ||
        create_pid(env, parent, &pid) != 0 || create_string(env, identity, 16, &token) != 0 ||
        set(env, result, "pid", pid) != 0 || set(env, result, "creationTime", token) != 0) {
        return fail(env, "Could not return native parent identity");
    }
    return result;
}

#endif
