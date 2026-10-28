// Pi's managed-child transport only. Native tree ownership remains in procward.
#include "../../../tui/native/napi.h"
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <tlhelp32.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

static napi_value text(napi_env env, const char *data, size_t length) {
    napi_create_string_utf8_fn create = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    napi_value value = 0;
    if (!create || create(env, data, length, &value)) return fail(env, "procward transport cannot create string");
    return value;
}

static napi_value transport(napi_env env, napi_callback_info info) {
    napi_get_cb_info_fn args = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_value_string_utf8_fn string = (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    napi_value values[3];
    size_t argc = 3, length;
    char operation[16], endpoint[32], identity[32];
    if (!args || !string || args(env, info, &argc, values, 0, 0) || argc < 2 ||
        string(env, values[0], operation, sizeof(operation), &length) || length >= sizeof(operation) ||
        string(env, values[1], endpoint, sizeof(endpoint), &length) || !length || length >= sizeof(endpoint))
        return fail(env, "invalid procward transport arguments");
    for (size_t i = 0; i < length; ++i) if (endpoint[i] < '0' || endpoint[i] > '9') return fail(env, "invalid procward endpoint");
    errno = 0;
    char *end = 0;
    unsigned long long raw = strtoull(endpoint, &end, 10);
    if (errno || !end || *end || raw == 0 || (strcmp(operation, "identity") && raw <= 2)) return fail(env, "invalid procward endpoint");
    if (!strcmp(operation, "identity")) {
        if (argc != 3 || string(env, values[2], identity, sizeof(identity), &length) || length >= sizeof(identity)) return fail(env, "invalid procward owner identity");
#ifdef _WIN32
        if (raw > MAXDWORD) return fail(env, "invalid procward owner PID");
        DWORD parent = 0;
        HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE) return fail(env, "procward native parent query failed");
        PROCESSENTRY32 entry;
        entry.dwSize = sizeof(entry);
        if (Process32First(snapshot, &entry)) do {
            if (entry.th32ProcessID == GetCurrentProcessId()) { parent = entry.th32ParentProcessID; break; }
        } while (Process32Next(snapshot, &entry));
        CloseHandle(snapshot);
        if (parent != (DWORD)raw) return fail(env, "procward native parent mismatch");
        HANDLE owner = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, parent);
        if (!owner) return fail(env, "procward owner unavailable");
        FILETIME creation, exit_time, kernel, user;
        char actual[17];
        BOOL live = GetProcessTimes(owner, &creation, &exit_time, &kernel, &user) && WaitForSingleObject(owner, 0) == WAIT_TIMEOUT;
        if (live) snprintf(actual, sizeof(actual), "%016llx", ((unsigned long long)creation.dwHighDateTime << 32) | creation.dwLowDateTime);
        CloseHandle(owner);
        if (!live || strcmp(actual, identity)) return fail(env, "procward owner creation identity mismatch");
#else
        if (raw > INT_MAX || (unsigned long long)getppid() != raw || strcmp(identity, "parent")) return fail(env, "procward native parent mismatch");
#endif
        return text(env, "", 0);
    }
#ifdef _WIN32
    if (raw > UINTPTR_MAX) return fail(env, "procward HANDLE out of range");
    HANDLE handle = (HANDLE)(uintptr_t)raw;
    if (!strcmp(operation, "prepare")) {
        if (GetFileType(handle) != FILE_TYPE_PIPE || !SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0)) return fail(env, "procward pipe preparation failed");
    } else if (!strcmp(operation, "close")) {
        if (!CloseHandle(handle)) return fail(env, "procward pipe close failed");
    } else if (!strcmp(operation, "read")) {
        DWORD available = 0, count = 0;
        char bytes[256];
        if (!PeekNamedPipe(handle, 0, 0, 0, &available, 0)) {
            if (GetLastError() == ERROR_BROKEN_PIPE) return null_value(env);
            return fail(env, "procward pipe peek failed");
        }
        if (!available) return text(env, "", 0);
        if (!ReadFile(handle, bytes, available < sizeof(bytes) ? available : sizeof(bytes), &count, 0)) return fail(env, "procward pipe read failed");
        for (DWORD i = 0; i < count; ++i) if ((unsigned char)bytes[i] > 127) return fail(env, "invalid procward pipe encoding");
        return text(env, bytes, count);
#else
    if (raw > INT_MAX) return fail(env, "procward fd out of range");
    int fd = (int)raw;
    if (!strcmp(operation, "prepare")) {
        struct stat st;
        int descriptor_flags = fcntl(fd, F_GETFD), flags = fcntl(fd, F_GETFL);
        if (fstat(fd, &st) || !S_ISFIFO(st.st_mode) || descriptor_flags < 0 || flags < 0 ||
            (flags & O_ACCMODE) != O_RDONLY || fcntl(fd, F_SETFD, descriptor_flags | FD_CLOEXEC) ||
            fcntl(fd, F_SETFL, flags | O_NONBLOCK)) return fail(env, "procward pipe preparation failed");
    } else if (!strcmp(operation, "close")) {
        if (close(fd)) return fail(env, "procward pipe close failed");
    } else if (!strcmp(operation, "read")) {
        char bytes[256];
        ssize_t count = read(fd, bytes, sizeof(bytes));
        if (count == 0) return null_value(env);
        if (count < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return text(env, "", 0);
            return fail(env, "procward pipe read failed");
        }
        for (ssize_t i = 0; i < count; ++i) if ((unsigned char)bytes[i] > 127) return fail(env, "invalid procward pipe encoding");
        return text(env, bytes, (size_t)count);
#endif
    } else return fail(env, "unknown procward transport operation");
    return text(env, "", 0);
}

PI_NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "transport", transport);
    return exports;
}
