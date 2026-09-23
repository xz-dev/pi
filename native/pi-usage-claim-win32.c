// Pi bundle usage-claim module (Windows).
//
// Session claims: CreateFileW(guard, GENERIC_READ,
//   FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE, not inheritable) +
//   LockFileEx(offset 1, length 1, LOCKFILE_FAIL_IMMEDIATELY, shared), held
//   natively for the whole process lifetime.
// Retirement claims: same handle parameters with an exclusive lock, returned
//   as a scoped external handle with an explicit releaseScoped().
//
// The locked byte range starts at offset 1, beyond the one-byte immutable
// guard payload, so integrity readers of byte 0 through other handles are
// unaffected (design.md D1). Delete sharing allows an authorized retiring
// process to quarantine while holding its lock; per design.md D4 the
// guard-last finalization sequence owns removal of the guard itself.
//
// The module is self-contained: NAPI types are declared locally and resolved
// from the host process through GetModuleHandleA/GetProcAddress at load
// time, and no CRT functions are used (heap via GetProcessHeap, static
// error strings), matching native/pi-filesystem-snapshot.c so the final
// link needs only KERNEL32.

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>

#define NAPI_AUTO_LENGTH ((SIZE_T)-1)

typedef void *napi_env;
typedef void *napi_value;
typedef void *napi_callback_info;
typedef napi_value(__cdecl *napi_callback)(napi_env, napi_callback_info);
typedef int(__cdecl *napi_create_external_fn)(napi_env, void *, void (__cdecl *)(napi_env, void *, void *), void *, napi_value *);
typedef int(__cdecl *napi_create_function_fn)(napi_env, const char *, SIZE_T, napi_callback, void *, napi_value *);
typedef int(__cdecl *napi_create_string_utf8_fn)(napi_env, const char *, SIZE_T, napi_value *);
typedef int(__cdecl *napi_get_boolean_fn)(napi_env, unsigned char, napi_value *);
typedef int(__cdecl *napi_get_cb_info_fn)(napi_env, napi_callback_info, SIZE_T *, napi_value *, napi_value *, void **);
typedef int(__cdecl *napi_get_value_external_fn)(napi_env, napi_value, void **);
typedef int(__cdecl *napi_get_value_string_utf8_fn)(napi_env, napi_value, char *, SIZE_T, SIZE_T *);
typedef int(__cdecl *napi_set_named_property_fn)(napi_env, napi_value, const char *, napi_value);
typedef int(__cdecl *napi_throw_error_fn)(napi_env, const char *, const char *);

typedef struct {
	HANDLE handle;
} scoped_claim;

static HANDLE g_session_handle = NULL;

static void *node_symbol(const char *name) {
	HMODULE module = GetModuleHandleA(0);
	void *symbol = module ? (void *)GetProcAddress(module, name) : 0;
	if (symbol) return symbol;
	module = GetModuleHandleA("node.dll");
	return module ? (void *)GetProcAddress(module, name) : 0;
}

#define NAPI_FN(type, name) ((type)node_symbol(#name))

static napi_value make_string(napi_env env, const char *text) {
	napi_create_string_utf8_fn create = NAPI_FN(napi_create_string_utf8_fn, napi_create_string_utf8);
	if (!create) return NULL;
	napi_value value = NULL;
	create(env, text, NAPI_AUTO_LENGTH, &value);
	return value;
}

static napi_value throw_usage(napi_env env, const char *code, const char *message) {
	napi_throw_error_fn throw_error = NAPI_FN(napi_throw_error_fn, napi_throw_error);
	if (throw_error) throw_error(env, code, message);
	return NULL;
}

// Lock offset 1, length 1 (beyond the one-byte payload).
static BOOL lock_claim_range(HANDLE handle, BOOL exclusive) {
	OVERLAPPED overlapped;
	ZeroMemory(&overlapped, sizeof overlapped);
	overlapped.Offset = 1;
	overlapped.OffsetHigh = 0;
	DWORD flags = LOCKFILE_FAIL_IMMEDIATELY | (exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0);
	return LockFileEx(handle, flags, 0, 1, 0, &overlapped);
}

static void unlock_claim_range(HANDLE handle) {
	OVERLAPPED overlapped;
	ZeroMemory(&overlapped, sizeof overlapped);
	overlapped.Offset = 1;
	overlapped.OffsetHigh = 0;
	UnlockFileEx(handle, 0, 1, 0, &overlapped);
}

static void finalize_scoped(napi_env env, void *data, void *hint) {
	(void)env;
	(void)hint;
	scoped_claim *claim = (scoped_claim *)data;
	if (claim == NULL) return;
	if (claim->handle != NULL) {
		unlock_claim_range(claim->handle);
		CloseHandle(claim->handle);
		claim->handle = NULL;
	}
	HeapFree(GetProcessHeap(), 0, claim);
}

// acquire(path, mode, scope) -> "acquired" | "busy" | external handle
static napi_value acquire(napi_env env, napi_callback_info info) {
	napi_get_cb_info_fn get_cb_info = NAPI_FN(napi_get_cb_info_fn, napi_get_cb_info);
	napi_get_value_string_utf8_fn get_string = NAPI_FN(napi_get_value_string_utf8_fn, napi_get_value_string_utf8);
	napi_create_external_fn create_external = NAPI_FN(napi_create_external_fn, napi_create_external);
	if (!get_cb_info || !get_string || !create_external) {
		return throw_usage(env, "PI_USAGE_EHOST", "host Node-API symbols are unavailable");
	}
	SIZE_T argc = 3;
	napi_value args[3] = {0};
	if (get_cb_info(env, info, &argc, args, NULL, NULL) != 0 || argc != 3) {
		return throw_usage(env, "PI_USAGE_EARG", "acquire(path, mode, scope) required");
	}
	char path[4096] = {0};
	char mode[16] = {0};
	char scope[16] = {0};
	SIZE_T length = 0;
	if (get_string(env, args[0], path, sizeof path, &length) != 0 || get_string(env, args[1], mode, sizeof mode, &length) != 0 ||
		get_string(env, args[2], scope, sizeof scope, &length) != 0) {
		return throw_usage(env, "PI_USAGE_EARG", "acquire requires string arguments");
	}
	int exclusive = lstrcmpA(mode, "exclusive") == 0;
	if (!exclusive && lstrcmpA(mode, "shared") != 0) {
		return throw_usage(env, "PI_USAGE_EARG", "mode must be \"shared\" or \"exclusive\"");
	}
	int session_scope = lstrcmpA(scope, "session") == 0;
	if (!session_scope && lstrcmpA(scope, "scoped") != 0) {
		return throw_usage(env, "PI_USAGE_EARG", "scope must be \"session\" or \"scoped\"");
	}

	WCHAR wide_path[8192] = {0};
	if (MultiByteToWideChar(CP_UTF8, 0, path, -1, wide_path, 8192) == 0) {
		return throw_usage(env, "PI_USAGE_EOS", "Pi usage claim path conversion failed");
	}
	SECURITY_ATTRIBUTES security;
	security.nLength = sizeof security;
	security.lpSecurityDescriptor = NULL;
	security.bInheritHandle = FALSE;
	HANDLE handle = CreateFileW(
		wide_path,
		GENERIC_READ,
		FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
		&security,
		OPEN_EXISTING,
		FILE_ATTRIBUTE_NORMAL,
		NULL);
	if (handle == INVALID_HANDLE_VALUE) {
		return throw_usage(env, "PI_USAGE_EOS", "Pi usage claim CreateFileW failed");
	}
	if (!lock_claim_range(handle, exclusive)) {
		DWORD err = GetLastError();
		CloseHandle(handle);
		if (err == ERROR_LOCK_VIOLATION) return make_string(env, "busy");
		return throw_usage(env, "PI_USAGE_EOS", "Pi usage claim LockFileEx failed");
	}

	if (session_scope) {
		if (g_session_handle != NULL) {
			unlock_claim_range(handle);
			CloseHandle(handle);
			return throw_usage(env, "PI_USAGE_EDUP", "session usage claim already held");
		}
		g_session_handle = handle;
		return make_string(env, "acquired");
	}

	scoped_claim *claim = (scoped_claim *)HeapAlloc(GetProcessHeap(), 0, sizeof(scoped_claim));
	if (!claim) {
		unlock_claim_range(handle);
		CloseHandle(handle);
		return throw_usage(env, "PI_USAGE_EOS", "Pi usage claim allocation failed");
	}
	claim->handle = handle;
	napi_value external = NULL;
	if (create_external(env, claim, finalize_scoped, NULL, &external) != 0) {
		unlock_claim_range(handle);
		CloseHandle(handle);
		claim->handle = NULL;
		HeapFree(GetProcessHeap(), 0, claim);
		return throw_usage(env, "PI_USAGE_EOS", "Pi usage claim handle creation failed");
	}
	return external;
}

// releaseScoped(handle) -> "released"
static napi_value release_scoped(napi_env env, napi_callback_info info) {
	napi_get_cb_info_fn get_cb_info = NAPI_FN(napi_get_cb_info_fn, napi_get_cb_info);
	napi_get_value_external_fn get_external = NAPI_FN(napi_get_value_external_fn, napi_get_value_external);
	if (!get_cb_info || !get_external) {
		return throw_usage(env, "PI_USAGE_EHOST", "host Node-API symbols are unavailable");
	}
	SIZE_T argc = 1;
	napi_value args[1] = {0};
	if (get_cb_info(env, info, &argc, args, NULL, NULL) != 0 || argc != 1) {
		return throw_usage(env, "PI_USAGE_EARG", "releaseScoped(handle) required");
	}
	scoped_claim *claim = NULL;
	if (get_external(env, args[0], (void **)&claim) != 0 || claim == NULL || claim->handle == NULL) {
		return throw_usage(env, "PI_USAGE_EARG", "invalid scoped usage claim handle");
	}
	unlock_claim_range(claim->handle);
	CloseHandle(claim->handle);
	claim->handle = NULL;
	// The allocation stays owned by the napi external finalizer, which frees
	// it at GC; freeing here would double-free.
	return make_string(env, "released");
}

// sessionHeld() -> boolean
static napi_value session_held(napi_env env, napi_callback_info info) {
	(void)info;
	napi_get_boolean_fn get_boolean = NAPI_FN(napi_get_boolean_fn, napi_get_boolean);
	if (!get_boolean) return NULL;
	napi_value value = NULL;
	get_boolean(env, g_session_handle != NULL, &value);
	return value;
}

BOOL WINAPI _DllMainCRTStartup(HINSTANCE instance, DWORD reason, LPVOID reserved) {
	(void)instance;
	(void)reason;
	(void)reserved;
	return TRUE;
}

__declspec(dllexport) napi_value __cdecl napi_register_module_v1(napi_env env, napi_value exports) {
	napi_create_function_fn create_function = NAPI_FN(napi_create_function_fn, napi_create_function);
	napi_set_named_property_fn set_property = NAPI_FN(napi_set_named_property_fn, napi_set_named_property);
	if (!create_function || !set_property) {
		return make_string(env, "Pi usage claim host lacks required Node-API symbols");
	}
	napi_value fn = NULL;
	create_function(env, "acquire", NAPI_AUTO_LENGTH, acquire, NULL, &fn);
	set_property(env, exports, "acquire", fn);
	create_function(env, "releaseScoped", NAPI_AUTO_LENGTH, release_scoped, NULL, &fn);
	set_property(env, exports, "releaseScoped", fn);
	create_function(env, "sessionHeld", NAPI_AUTO_LENGTH, session_held, NULL, &fn);
	set_property(env, exports, "sessionHeld", fn);
	return exports;
}
