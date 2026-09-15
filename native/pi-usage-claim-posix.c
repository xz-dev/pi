// Pi bundle usage-claim module (POSIX).
//
// Session claims: open(guard, O_RDWR|O_CLOEXEC) + flock(LOCK_SH|LOCK_NB),
// held natively for the whole process lifetime.
// Retirement claims: same file, flock(LOCK_EX|LOCK_NB), returned as a scoped
// external handle with an explicit releaseScoped().
//
// Contention is always probed through a separate open (never dup), so each
// acquisition owns an independent open file description as required by the
// protocol in design.md D1.
//
// NAPI types are declared locally and resolved from the host process at load
// time, matching the self-contained pattern used by native/pi-wrapper.c
// consumers on Windows; on POSIX the dynamic loader resolves them directly
// from the embedding executable (verified for gnu and musl runtimes).

// Expose O_CLOEXEC and flock declarations in strict C11 builds. O_CLOEXEC
// is a protocol requirement: children register their own claims, never
// inherit this descriptor. If a target truly lacks it, compilation fails
// rather than silently dropping the guarantee.
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

#if !defined(O_CLOEXEC)
#error "O_CLOEXEC is required for the Pi usage claim protocol"
#endif

#include <node_api.h>

typedef struct {
	int fd;
} scoped_claim;

static int g_session_fd = -1;

static napi_value make_string(napi_env env, const char *text) {
	napi_value value;
	napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
	return value;
}

static napi_value throw_os(napi_env env, const char *label, int err) {
	char message[256];
	snprintf(message, sizeof message, "%s: %s", label, strerror(err));
	napi_throw_error(env, "PI_USAGE_EOS", message);
	return NULL;
}

static void finalize_scoped(napi_env env, void *data, void *hint) {
	(void)env;
	(void)hint;
	scoped_claim *claim = (scoped_claim *)data;
	if (claim == NULL) return;
	if (claim->fd >= 0) {
		flock(claim->fd, LOCK_UN);
		close(claim->fd);
		claim->fd = -1;
	}
	free(claim);
}

// acquire(path, mode, scope) -> "acquired" | "busy" | external handle
// mode: "shared" | "exclusive"; scope: "session" | "scoped"
static napi_value acquire(napi_env env, napi_callback_info info) {
	size_t argc = 3;
	napi_value args[3] = {0};
	if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 3) {
		napi_throw_error(env, "PI_USAGE_EARG", "acquire(path, mode, scope) required");
		return NULL;
	}
	char path[4096] = {0};
	char mode[16] = {0};
	char scope[16] = {0};
	size_t length = 0;
	if (napi_get_value_string_utf8(env, args[0], path, sizeof path, &length) != napi_ok ||
		napi_get_value_string_utf8(env, args[1], mode, sizeof mode, &length) != napi_ok ||
		napi_get_value_string_utf8(env, args[2], scope, sizeof scope, &length) != napi_ok) {
		napi_throw_error(env, "PI_USAGE_EARG", "acquire requires string arguments");
		return NULL;
	}
	int exclusive = strcmp(mode, "exclusive") == 0;
	if (!exclusive && strcmp(mode, "shared") != 0) {
		napi_throw_error(env, "PI_USAGE_EARG", "mode must be \"shared\" or \"exclusive\"");
		return NULL;
	}
	int session_scope = strcmp(scope, "session") == 0;
	if (!session_scope && strcmp(scope, "scoped") != 0) {
		napi_throw_error(env, "PI_USAGE_EARG", "scope must be \"session\" or \"scoped\"");
		return NULL;
	}


	int fd = open(path, O_RDWR | O_CLOEXEC);
	if (fd < 0) return throw_os(env, "Pi usage claim open failed", errno);
	int operation = exclusive ? (LOCK_EX | LOCK_NB) : (LOCK_SH | LOCK_NB);
	if (flock(fd, operation) != 0) {
		int err = errno;
		close(fd);
		if (err == EWOULDBLOCK || err == EAGAIN) return make_string(env, "busy");
		return throw_os(env, "Pi usage claim flock failed", err);
	}

	if (session_scope) {
		if (g_session_fd >= 0) {
			flock(fd, LOCK_UN);
			close(fd);
			napi_throw_error(env, "PI_USAGE_EDUP", "session usage claim already held");
			return NULL;
		}
		g_session_fd = fd;
		return make_string(env, "acquired");
	}

	scoped_claim *claim = malloc(sizeof(scoped_claim));
	if (claim == NULL) {
		flock(fd, LOCK_UN);
		close(fd);
		return throw_os(env, "Pi usage claim allocation failed", ENOMEM);
	}
	claim->fd = fd;
	napi_value external;
	if (napi_create_external(env, claim, finalize_scoped, NULL, &external) != napi_ok) {
		flock(fd, LOCK_UN);
		close(fd);
		free(claim);
		return throw_os(env, "Pi usage claim handle creation failed", ENOMEM);
	}
	return external;
}

// releaseScoped(handle) -> "released"
static napi_value release_scoped(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value args[1] = {0};
	if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1) {
		napi_throw_error(env, "PI_USAGE_EARG", "releaseScoped(handle) required");
		return NULL;
	}
	scoped_claim *claim = NULL;
	if (napi_get_value_external(env, args[0], (void **)&claim) != napi_ok || claim == NULL || claim->fd < 0) {
		napi_throw_error(env, "PI_USAGE_EARG", "invalid scoped usage claim handle");
		return NULL;
	}
	flock(claim->fd, LOCK_UN);
	close(claim->fd);
	claim->fd = -1;
	// The allocation stays owned by the napi external finalizer, which frees
	// it at GC; freeing here would double-free.
	return make_string(env, "released");
}

// sessionHeld() -> boolean
static napi_value session_held(napi_env env, napi_callback_info info) {
	(void)info;
	napi_value value;
	napi_get_boolean(env, g_session_fd >= 0, &value);
	return value;
}

NAPI_MODULE_INIT() {
	napi_value fn;
	napi_create_function(env, "acquire", NAPI_AUTO_LENGTH, acquire, NULL, &fn);
	napi_set_named_property(env, exports, "acquire", fn);
	napi_create_function(env, "releaseScoped", NAPI_AUTO_LENGTH, release_scoped, NULL, &fn);
	napi_set_named_property(env, exports, "releaseScoped", fn);
	napi_create_function(env, "sessionHeld", NAPI_AUTO_LENGTH, session_held, NULL, &fn);
	napi_set_named_property(env, exports, "sessionHeld", fn);
	return exports;
}
