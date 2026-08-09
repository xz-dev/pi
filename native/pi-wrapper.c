#ifdef _WIN32
#include <errno.h>
#include <process.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <windows.h>
#include <wchar.h>

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

	wchar_t current_path[32768];
	if (swprintf(current_path, 32768, L"%lscurrent", directory) < 0) return 1;
	wchar_t executable[32768];
	FILE *current = _wfopen(current_path, L"r");
	if (current != NULL) {
		wchar_t version[256];
		if (fgetws(version, 256, current) == NULL) { fclose(current); return 1; }
		fclose(current);
		version[wcscspn(version, L"\r\n")] = L'\0';
		if (!valid_version(version) || swprintf(executable, 32768, L"%lsbundles\\%ls\\pi-native.exe", directory, version) < 0) return 1;
	} else if (errno == ENOENT) {
		if (swprintf(executable, 32768, L"%lspi-native.exe", directory) < 0) return 1;
	} else {
		return 1;
	}
	argv[0] = executable;
	intptr_t status = _wspawnv(_P_WAIT, executable, (const wchar_t *const *)argv);
	if (status != -1) return (int)status;
	fwprintf(stderr, L"pi: could not execute %ls: %hs\n", executable, strerror(errno));
	return 1;
}
#else
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

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

	char current_path[32768];
	if (snprintf(current_path, sizeof(current_path), "%scurrent", directory) >= (int)sizeof(current_path)) return 1;
	char executable[32768];
	FILE *current = fopen(current_path, "r");
	if (current != NULL) {
		char version[256];
		if (fgets(version, sizeof(version), current) == NULL) { fclose(current); return 1; }
		fclose(current);
		version[strcspn(version, "\r\n")] = '\0';
		if (!valid_version(version) || snprintf(executable, sizeof(executable), "%sbundles/%s/pi-native", directory, version) >= (int)sizeof(executable)) return 1;
	} else if (errno == ENOENT) {
		if (snprintf(executable, sizeof(executable), "%spi-native", directory) >= (int)sizeof(executable)) return 1;
	} else {
		return 1;
	}
	argv[0] = executable;
	execv(executable, argv);
	fprintf(stderr, "pi: could not execute %s: %s\n", executable, strerror(errno));
	return 1;
}
#endif
