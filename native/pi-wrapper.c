/*
 * pi launcher. The bundle version is embedded at compile time via
 * PI_WRAPPER_VERSION; the launcher executes bundles/<version>/pi-native
 * next to itself. No runtime pointer files are consulted.
 */
#ifdef _WIN32
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>
#include <wchar.h>

#ifndef PI_WRAPPER_VERSION_W
#error "PI_WRAPPER_VERSION_W must be provided for the Windows launcher build"
#endif

static int valid_version(const wchar_t *value) {
	if (*value == L'\0') return 0;
	for (; *value != L'\0'; value++) {
		if (!((*value >= L'a' && *value <= L'z') || (*value >= L'A' && *value <= L'Z') ||
			  (*value >= L'0' && *value <= L'9') || wcschr(L"._+-", *value))) return 0;
	}
	return 1;
}

int wmain(int argc, wchar_t **argv) {
	(void)argc;
	wchar_t directory[32768];
	DWORD length = GetModuleFileNameW(NULL, directory, (DWORD)(sizeof(directory) / sizeof(directory[0])));
	if (length == 0 || length >= sizeof(directory) / sizeof(directory[0])) return 1;
	wchar_t *separator = wcsrchr(directory, L'\\');
	if (separator == NULL) return 1;
	separator[1] = L'\0';

	wchar_t executable[32768];
	const wchar_t *version = PI_WRAPPER_VERSION_W;
	if (!valid_version(version) ||
		swprintf(executable, 32768, L"%lsbundles\\%ls\\pi-native.exe", directory, version) < 0)
		return 1;
	if (GetFileAttributesW(executable) == INVALID_FILE_ATTRIBUTES) {
		// Flat (pre-managed) layout: the executable sits next to the launcher.
		if (swprintf(executable, 32768, L"%lspi-native.exe", directory) < 0) return 1;
	}

	const wchar_t *tail = GetCommandLineW();
	if (*tail == L'"') {
		tail++;
		while (*tail != L'\0' && *tail != L'"') tail++;
		if (*tail == L'"') tail++;
	} else {
		while (*tail != L'\0' && *tail != L' ' && *tail != L'\t') tail++;
	}
	while (*tail == L' ' || *tail == L'\t') tail++;

	size_t capacity = wcslen(executable) + wcslen(tail) + 4;
	wchar_t *command_line = malloc(capacity * sizeof(*command_line));
	if (command_line == NULL) return 1;
	int written = *tail == L'\0'
		? swprintf(command_line, capacity, L"\"%ls\"", executable)
		: swprintf(command_line, capacity, L"\"%ls\" %ls", executable, tail);
	if (written < 0) { free(command_line); return 1; }

	STARTUPINFOW startup;
	PROCESS_INFORMATION process;
	ZeroMemory(&startup, sizeof(startup));
	ZeroMemory(&process, sizeof(process));
	startup.cb = sizeof(startup);
	startup.dwFlags = STARTF_USESTDHANDLES;
	startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
	startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
	startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
	BOOL created = CreateProcessW(executable, command_line, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &process);
	DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
	free(command_line);
	if (!created) {
		fwprintf(stderr, L"pi: could not execute %ls: Windows error %lu\n", executable, create_error);
		return 1;
	}
	CloseHandle(process.hThread);
	if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0) {
		CloseHandle(process.hProcess);
		return 1;
	}
	DWORD status;
	if (!GetExitCodeProcess(process.hProcess, &status)) status = 1;
	CloseHandle(process.hProcess);
	return (int)status;
}
#else
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef PI_WRAPPER_VERSION
#error "PI_WRAPPER_VERSION must be defined at compile time"
#endif

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

static int executable_path(char *path, size_t capacity) {
#if defined(__linux__)
	ssize_t length = readlink("/proc/self/exe", path, capacity - 1);
	if (length < 0 || (size_t)length >= capacity - 1) return -1;
	path[length] = '\0';
	return 0;
#elif defined(__APPLE__)
	uint32_t size = (uint32_t)capacity;
	if (_NSGetExecutablePath(path, &size) != 0) return -1;
	char resolved[32768];
	if (realpath(path, resolved) == NULL || snprintf(path, capacity, "%s", resolved) >= (int)capacity) return -1;
	return 0;
#else
	(void)path;
	(void)capacity;
	errno = ENOTSUP;
	return -1;
#endif
}

static int valid_version(const char *value) {
	if (*value == '\0') return 0;
	for (; *value != '\0'; value++) {
		if (!(('a' <= *value && *value <= 'z') || ('A' <= *value && *value <= 'Z') ||
			  ('0' <= *value && *value <= '9') || strchr("._+-", *value))) return 0;
	}
	return 1;
}

int main(int argc, char **argv) {
	(void)argc;
	char directory[32768];
	if (executable_path(directory, sizeof(directory)) != 0) return 1;
	char *separator = strrchr(directory, '/');
	if (separator == NULL) return 1;
	separator[1] = '\0';

	char executable[32768];
	if (!valid_version(PI_WRAPPER_VERSION) ||
		snprintf(executable, sizeof(executable), "%sbundles/%s/pi-native", directory, PI_WRAPPER_VERSION) >=
			(int)sizeof(executable))
		return 1;
	if (access(executable, X_OK) != 0) {
		// Flat (pre-managed) layout: the executable sits next to the launcher.
		if (snprintf(executable, sizeof(executable), "%spi-native", directory) >= (int)sizeof(executable)) return 1;
	}

	argv[0] = executable;
	execv(executable, argv);
	fprintf(stderr, "pi: could not execute %s: %s\n", executable, strerror(errno));
	return 1;
}
#endif
