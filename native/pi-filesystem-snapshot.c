#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>

#define NAPI_AUTO_LENGTH ((SIZE_T)-1)
#ifndef SNAPSHOT_API_VERSION
#define SNAPSHOT_API_VERSION 1
#endif
#ifndef SNAPSHOT_MALFORMED_RESULTS
#define SNAPSHOT_MALFORMED_RESULTS 0
#endif
#define MAXIMUM_PATH_CHARACTERS 32767
#define MAXIMUM_CONTENT_BYTES (64UL * 1024UL * 1024UL)

typedef void* napi_env;
typedef void* napi_value;
typedef void* napi_callback_info;
typedef napi_value (__cdecl *napi_callback)(napi_env, napi_callback_info);
typedef int (__cdecl *napi_create_buffer_copy_fn)(napi_env, SIZE_T, const void*, void**, napi_value*);
typedef int (__cdecl *napi_create_double_fn)(napi_env, double, napi_value*);
typedef int (__cdecl *napi_create_function_fn)(napi_env, const char*, SIZE_T, napi_callback, void*, napi_value*);
typedef int (__cdecl *napi_create_object_fn)(napi_env, napi_value*);
typedef int (__cdecl *napi_create_string_utf8_fn)(napi_env, const char*, SIZE_T, napi_value*);
typedef int (__cdecl *napi_create_string_utf16_fn)(napi_env, const WCHAR*, SIZE_T, napi_value*);
typedef int (__cdecl *napi_create_uint32_fn)(napi_env, DWORD, napi_value*);
typedef int (__cdecl *napi_get_cb_info_fn)(napi_env, napi_callback_info, SIZE_T*, napi_value*, napi_value*, void**);
typedef int (__cdecl *napi_get_value_bool_fn)(napi_env, napi_value, unsigned char*);
typedef int (__cdecl *napi_get_value_string_utf16_fn)(napi_env, napi_value, WCHAR*, SIZE_T, SIZE_T*);
typedef int (__cdecl *napi_get_value_uint32_fn)(napi_env, napi_value, DWORD*);
typedef int (__cdecl *napi_set_named_property_fn)(napi_env, napi_value, const char*, napi_value);
typedef int (__cdecl *napi_throw_error_fn)(napi_env, const char*, const char*);
typedef int (__cdecl *napi_throw_range_error_fn)(napi_env, const char*, const char*);
typedef int (__cdecl *napi_throw_type_error_fn)(napi_env, const char*, const char*);

typedef struct path_snapshot {
	BY_HANDLE_FILE_INFORMATION information;
	FILE_ID_INFO identity;
	WCHAR* canonical_path;
	SIZE_T canonical_path_length;
	BYTE* contents;
	DWORD contents_length;
} path_snapshot;

static void* node_symbol(const char* name) {
	HMODULE module = GetModuleHandleA(0);
	void* symbol = module ? (void*)GetProcAddress(module, name) : 0;
	if (symbol) return symbol;
	module = GetModuleHandleA("node.dll");
	return module ? (void*)GetProcAddress(module, name) : 0;
}

static napi_value throw_error(napi_env env, const char* message) {
	napi_throw_error_fn napi_throw_error = (napi_throw_error_fn)node_symbol("napi_throw_error");
	if (napi_throw_error) napi_throw_error(env, "PI_WIN32_SNAPSHOT", message);
	return 0;
}

static napi_value throw_type_error(napi_env env, const char* message) {
	napi_throw_type_error_fn napi_throw_type_error = (napi_throw_type_error_fn)node_symbol("napi_throw_type_error");
	if (napi_throw_type_error) napi_throw_type_error(env, "PI_WIN32_SNAPSHOT", message);
	return 0;
}

static napi_value throw_range_error(napi_env env, const char* message) {
	napi_throw_range_error_fn napi_throw_range_error = (napi_throw_range_error_fn)node_symbol("napi_throw_range_error");
	if (napi_throw_range_error) napi_throw_range_error(env, "PI_WIN32_SNAPSHOT", message);
	return 0;
}

static int wide_starts_with(const WCHAR* value, const WCHAR* prefix) {
	while (*prefix) {
		if (*value != *prefix) return 0;
		value++;
		prefix++;
	}
	return 1;
}

static int wide_equals(const WCHAR* left, SIZE_T left_length, const WCHAR* right, SIZE_T right_length) {
	SIZE_T index;
	if (left_length != right_length) return 0;
	for (index = 0; index < left_length; index++) {
		if (left[index] != right[index]) return 0;
	}
	return 1;
}

static int file_time_equals(FILETIME left, FILETIME right) {
	return left.dwLowDateTime == right.dwLowDateTime && left.dwHighDateTime == right.dwHighDateTime;
}

static int information_equals(const BY_HANDLE_FILE_INFORMATION* left, const BY_HANDLE_FILE_INFORMATION* right) {
	return left->dwFileAttributes == right->dwFileAttributes &&
		left->dwVolumeSerialNumber == right->dwVolumeSerialNumber &&
		left->nFileSizeHigh == right->nFileSizeHigh &&
		left->nFileSizeLow == right->nFileSizeLow &&
		left->nNumberOfLinks == right->nNumberOfLinks &&
		left->nFileIndexHigh == right->nFileIndexHigh &&
		left->nFileIndexLow == right->nFileIndexLow &&
		file_time_equals(left->ftCreationTime, right->ftCreationTime) &&
		file_time_equals(left->ftLastWriteTime, right->ftLastWriteTime);
}

static int identity_equals(const FILE_ID_INFO* left, const FILE_ID_INFO* right) {
	SIZE_T index;
	if (left->VolumeSerialNumber != right->VolumeSerialNumber) return 0;
	for (index = 0; index < sizeof(left->FileId.Identifier); index++) {
		if (left->FileId.Identifier[index] != right->FileId.Identifier[index]) return 0;
	}
	return 1;
}

static void release_snapshot(path_snapshot* snapshot) {
	HANDLE heap = GetProcessHeap();
	if (snapshot->canonical_path) HeapFree(heap, 0, snapshot->canonical_path);
	if (snapshot->contents) HeapFree(heap, 0, snapshot->contents);
	snapshot->canonical_path = 0;
	snapshot->contents = 0;
}

static int read_path_argument(napi_env env, napi_value value, WCHAR** result) {
	napi_get_value_string_utf16_fn napi_get_value_string_utf16 =
		(napi_get_value_string_utf16_fn)node_symbol("napi_get_value_string_utf16");
	SIZE_T length = 0;
	SIZE_T copied = 0;
	WCHAR* path;
	if (!napi_get_value_string_utf16 || napi_get_value_string_utf16(env, value, 0, 0, &length) != 0) return 0;
	if (length == 0 || length > MAXIMUM_PATH_CHARACTERS) return 0;
	path = (WCHAR*)HeapAlloc(GetProcessHeap(), 0, (length + 1) * sizeof(WCHAR));
	if (!path) return 0;
	if (napi_get_value_string_utf16(env, value, path, length + 1, &copied) != 0 || copied != length) {
		HeapFree(GetProcessHeap(), 0, path);
		return 0;
	}
	path[length] = 0;
	for (copied = 0; copied < length; copied++) {
		if (path[copied] == 0) {
			HeapFree(GetProcessHeap(), 0, path);
			return 0;
		}
	}
	*result = path;
	return 1;
}

static int canonical_path_for_handle(HANDLE file, WCHAR** result, SIZE_T* result_length) {
	DWORD required = GetFinalPathNameByHandleW(file, 0, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
	DWORD copied;
	WCHAR* path;
	SIZE_T length;
	if (required == 0 || required > MAXIMUM_PATH_CHARACTERS) return 0;
	path = (WCHAR*)HeapAlloc(GetProcessHeap(), 0, ((SIZE_T)required + 1) * sizeof(WCHAR));
	if (!path) return 0;
	copied = GetFinalPathNameByHandleW(file, path, required + 1, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
	if (copied == 0 || copied > required) {
		HeapFree(GetProcessHeap(), 0, path);
		return 0;
	}
	length = copied;
	if (wide_starts_with(path, L"\\\\?\\UNC\\")) {
		MoveMemory(path + 2, path + 8, (length - 8 + 1) * sizeof(WCHAR));
		path[0] = L'\\';
		path[1] = L'\\';
		length -= 6;
	} else if (wide_starts_with(path, L"\\\\?\\")) {
		MoveMemory(path, path + 4, (length - 4 + 1) * sizeof(WCHAR));
		length -= 4;
	}
	*result = path;
	*result_length = length;
	return 1;
}

static int is_safe_kind(const BY_HANDLE_FILE_INFORMATION* information, DWORD file_type, int expect_directory) {
	int is_directory = (information->dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
	if ((information->dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return 0;
	if (file_type != FILE_TYPE_DISK) return 0;
	return expect_directory ? is_directory : !is_directory;
}

static int capture_snapshot(
	HANDLE file,
	int expect_directory,
	DWORD maximum_bytes,
	int include_contents,
	path_snapshot* snapshot,
	const char** error_message
) {
	ULONGLONG size;
	BY_HANDLE_FILE_INFORMATION final_information;
	FILE_ID_INFO final_identity;
	WCHAR* final_path = 0;
	SIZE_T final_path_length = 0;
	DWORD offset = 0;
	if (!GetFileInformationByHandle(file, &snapshot->information) ||
		!GetFileInformationByHandleEx(file, FileIdInfo, &snapshot->identity, sizeof(snapshot->identity))) {
		*error_message = "Could not inspect Windows path";
		return 0;
	}
	if (!is_safe_kind(&snapshot->information, GetFileType(file), expect_directory)) {
		*error_message = expect_directory ? "Windows path is not a safe directory" : "Windows path is not a safe regular file";
		return 0;
	}
	if (!canonical_path_for_handle(file, &snapshot->canonical_path, &snapshot->canonical_path_length)) {
		*error_message = "Could not resolve canonical Windows path";
		return 0;
	}
	if (!expect_directory) {
		size = ((ULONGLONG)snapshot->information.nFileSizeHigh << 32) | snapshot->information.nFileSizeLow;
		if (size > maximum_bytes) {
			*error_message = "Windows regular file exceeds the allowed size";
			return 0;
		}
		snapshot->contents_length = (DWORD)size;
		if (include_contents && snapshot->contents_length > 0) {
			snapshot->contents = (BYTE*)HeapAlloc(GetProcessHeap(), 0, snapshot->contents_length);
			if (!snapshot->contents) {
				*error_message = "Could not allocate Windows file snapshot";
				return 0;
			}
			while (offset < snapshot->contents_length) {
				DWORD count = 0;
				DWORD remaining = snapshot->contents_length - offset;
				if (!ReadFile(file, snapshot->contents + offset, remaining, &count, 0) || count == 0) {
					*error_message = "Could not read complete Windows file snapshot";
					return 0;
				}
				offset += count;
			}
		}
	}
	if (!GetFileInformationByHandle(file, &final_information) ||
		!GetFileInformationByHandleEx(file, FileIdInfo, &final_identity, sizeof(final_identity)) ||
		!is_safe_kind(&final_information, GetFileType(file), expect_directory) ||
		!information_equals(&snapshot->information, &final_information) ||
		!identity_equals(&snapshot->identity, &final_identity) ||
		!canonical_path_for_handle(file, &final_path, &final_path_length) ||
		!wide_equals(snapshot->canonical_path, snapshot->canonical_path_length, final_path, final_path_length)) {
		if (final_path) HeapFree(GetProcessHeap(), 0, final_path);
		*error_message = expect_directory ?
			"Windows directory changed while being snapshotted" :
			"Windows file changed while being snapshotted";
		return 0;
	}
	HeapFree(GetProcessHeap(), 0, final_path);
	return 1;
}

static void encode_hex64(ULONGLONG value, char* output) {
	static const char alphabet[] = "0123456789abcdef";
	SIZE_T index;
	for (index = 0; index < 16; index++) {
		SIZE_T shift = (15 - index) * 4;
		output[index] = alphabet[(value >> shift) & 0xf];
	}
}

static void encode_identity(const FILE_ID_INFO* identity, char* output) {
	static const char alphabet[] = "0123456789abcdef";
	SIZE_T index;
	encode_hex64(identity->VolumeSerialNumber, output);
	output[16] = ':';
	for (index = 0; index < sizeof(identity->FileId.Identifier); index++) {
		BYTE value = identity->FileId.Identifier[index];
		output[17 + index * 2] = alphabet[value >> 4];
		output[18 + index * 2] = alphabet[value & 0xf];
	}
}

static int set_named_value(napi_env env, napi_value object, const char* name, napi_value value) {
	napi_set_named_property_fn napi_set_named_property =
		(napi_set_named_property_fn)node_symbol("napi_set_named_property");
	return napi_set_named_property && napi_set_named_property(env, object, name, value) == 0;
}

static napi_value snapshot_to_value(napi_env env, const path_snapshot* snapshot, int include_contents) {
	napi_create_buffer_copy_fn napi_create_buffer_copy =
		(napi_create_buffer_copy_fn)node_symbol("napi_create_buffer_copy");
	napi_create_double_fn napi_create_double = (napi_create_double_fn)node_symbol("napi_create_double");
	napi_create_object_fn napi_create_object = (napi_create_object_fn)node_symbol("napi_create_object");
	napi_create_string_utf8_fn napi_create_string_utf8 =
		(napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
	napi_create_string_utf16_fn napi_create_string_utf16 =
		(napi_create_string_utf16_fn)node_symbol("napi_create_string_utf16");
	napi_value result = 0;
	napi_value value = 0;
	char identity[49];
	ULONGLONG size = ((ULONGLONG)snapshot->information.nFileSizeHigh << 32) | snapshot->information.nFileSizeLow;
	if (!napi_create_object || !napi_create_string_utf8 || !napi_create_string_utf16 ||
		!napi_create_double || !napi_create_buffer_copy || napi_create_object(env, &result) != 0) return 0;

	if (SNAPSHOT_MALFORMED_RESULTS) {
		if (napi_create_string_utf8(env, "invalid", NAPI_AUTO_LENGTH, &value) != 0 ||
			!set_named_value(env, result, "canonicalPath", value)) return 0;
		return result;
	}

	if (napi_create_string_utf16(env, snapshot->canonical_path, snapshot->canonical_path_length, &value) != 0 ||
		!set_named_value(env, result, "canonicalPath", value)) return 0;
	encode_identity(&snapshot->identity, identity);
	if (napi_create_string_utf8(env, identity, sizeof(identity), &value) != 0 ||
		!set_named_value(env, result, "identity", value)) return 0;
	if (napi_create_double(env, (double)size, &value) != 0 || !set_named_value(env, result, "size", value)) return 0;
	if (include_contents) {
		BYTE empty = 0;
		const void* contents = snapshot->contents_length > 0 ? snapshot->contents : &empty;
		if (napi_create_buffer_copy(env, snapshot->contents_length, contents, 0, &value) != 0 ||
			!set_named_value(env, result, "contents", value)) return 0;
	}
	return result;
}

static napi_value snapshot_path(napi_env env, napi_callback_info info, int expect_directory) {
	napi_get_cb_info_fn napi_get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
	napi_get_value_bool_fn napi_get_value_bool = (napi_get_value_bool_fn)node_symbol("napi_get_value_bool");
	napi_get_value_uint32_fn napi_get_value_uint32 =
		(napi_get_value_uint32_fn)node_symbol("napi_get_value_uint32");
	SIZE_T argc = expect_directory ? 1 : 3;
	napi_value args[3] = {0};
	WCHAR* path = 0;
	DWORD maximum_bytes = 0;
	unsigned char include_contents = 0;
	DWORD desired_access;
	HANDLE file;
	path_snapshot snapshot = {0};
	const char* error_message = 0;
	napi_value result;
	if (!napi_get_cb_info || napi_get_cb_info(env, info, &argc, args, 0, 0) != 0 ||
		argc != (expect_directory ? 1 : 3) || !args[0]) {
		return throw_type_error(env, expect_directory ?
			"snapshotDirectory requires one path" :
			"snapshotRegularFile requires path, maximumBytes, and includeContents");
	}
	if (!read_path_argument(env, args[0], &path)) return throw_type_error(env, "Windows snapshot path must be a non-empty UTF-16 string");
	if (!expect_directory) {
		if (!napi_get_value_uint32 || napi_get_value_uint32(env, args[1], &maximum_bytes) != 0 || maximum_bytes == 0) {
			HeapFree(GetProcessHeap(), 0, path);
			return throw_range_error(env, "maximumBytes must be a positive uint32");
		}
		if (!napi_get_value_bool || napi_get_value_bool(env, args[2], &include_contents) != 0) {
			HeapFree(GetProcessHeap(), 0, path);
			return throw_type_error(env, "includeContents must be a boolean");
		}
		if (include_contents && maximum_bytes > MAXIMUM_CONTENT_BYTES) {
			HeapFree(GetProcessHeap(), 0, path);
			return throw_range_error(env, "Content snapshots are limited to 64 MiB");
		}
	}

	desired_access = expect_directory || !include_contents ? FILE_READ_ATTRIBUTES : GENERIC_READ;
	file = CreateFileW(
		path,
		desired_access,
		FILE_SHARE_READ,
		0,
		OPEN_EXISTING,
		FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
		0
	);
	HeapFree(GetProcessHeap(), 0, path);
	if (file == INVALID_HANDLE_VALUE) return throw_error(env, "Could not open Windows path for a safe snapshot");
	if (!capture_snapshot(file, expect_directory, maximum_bytes, include_contents, &snapshot, &error_message)) {
		CloseHandle(file);
		release_snapshot(&snapshot);
		return throw_error(env, error_message);
	}
	CloseHandle(file);
	result = snapshot_to_value(env, &snapshot, include_contents);
	release_snapshot(&snapshot);
	if (!result) return throw_error(env, "Could not create Windows snapshot result");
	return result;
}

static napi_value __cdecl snapshot_directory(napi_env env, napi_callback_info info) {
	return snapshot_path(env, info, 1);
}

static napi_value __cdecl snapshot_regular_file(napi_env env, napi_callback_info info) {
	return snapshot_path(env, info, 0);
}

static void set_function_export(napi_env env, napi_value exports, const char* name, napi_callback callback) {
	napi_create_function_fn napi_create_function = (napi_create_function_fn)node_symbol("napi_create_function");
	napi_set_named_property_fn napi_set_named_property =
		(napi_set_named_property_fn)node_symbol("napi_set_named_property");
	napi_value function = 0;
	if (napi_create_function && napi_set_named_property &&
		napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, 0, &function) == 0) {
		napi_set_named_property(env, exports, name, function);
	}
}

static void set_uint32_export(napi_env env, napi_value exports, const char* name, DWORD number) {
	napi_create_uint32_fn napi_create_uint32 = (napi_create_uint32_fn)node_symbol("napi_create_uint32");
	napi_set_named_property_fn napi_set_named_property =
		(napi_set_named_property_fn)node_symbol("napi_set_named_property");
	napi_value value = 0;
	if (napi_create_uint32 && napi_set_named_property && napi_create_uint32(env, number, &value) == 0) {
		napi_set_named_property(env, exports, name, value);
	}
}

BOOL WINAPI _DllMainCRTStartup(HINSTANCE instance, DWORD reason, LPVOID reserved) {
	(void)instance;
	(void)reason;
	(void)reserved;
	return TRUE;
}

__declspec(dllexport) napi_value __cdecl napi_register_module_v1(napi_env env, napi_value exports) {
	set_uint32_export(env, exports, "apiVersion", SNAPSHOT_API_VERSION);
	set_function_export(env, exports, "snapshotDirectory", snapshot_directory);
	set_function_export(env, exports, "snapshotRegularFile", snapshot_regular_file);
	return exports;
}
