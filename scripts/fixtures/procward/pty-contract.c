// Linux/musl test glue only: one lifecycle pipe, one PTY, actual saved terminal settings.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

static double now_ms(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) abort();
    return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
}
static int event(const char *root, const char *name) {
    char path[4096];
    if (snprintf(path, sizeof(path), "%s/%s", root, name) >= (int)sizeof(path)) return 0;
    int fd = open(path, O_RDONLY);
    if (fd < 0) return 0;
    char bytes[1024];
    ssize_t size = read(fd, bytes, sizeof(bytes));
    close(fd);
    return size > 0 && bytes[size - 1] == '\n';
}
static void snapshot(const struct termios *value) {
    const unsigned char *bytes = (const unsigned char *)value;
    putchar('"');
    for (size_t i = 0; i < sizeof(*value); ++i) printf("%02x", bytes[i]);
    putchar('"');
}
static void drain(int master, FILE *output, size_t *written) {
    struct pollfd descriptor = { master, POLLIN, 0 };
    int ready = poll(&descriptor, 1, 20);
    if (ready <= 0 || !(descriptor.revents & POLLIN)) return;
    char bytes[65536];
    ssize_t count = read(master, bytes, sizeof(bytes));
    if (count <= 0) return;
    if (*written < 4 * 1024 * 1024) {
        size_t size = (size_t)count;
        if (size > 4 * 1024 * 1024 - *written) size = 4 * 1024 * 1024 - *written;
        if (fwrite(bytes, 1, size, output) != size) abort();
        *written += size;
    }
    for (ssize_t i = 0; i + 3 < count; ++i) if (!memcmp(bytes + i, "\033[6n", 4)) {
        if (write(master, "\033[1;1R", 6) < 0 && errno != EIO) abort();
    }
}

int main(int argc, char **argv) {
    if (argc != 6) { fprintf(stderr, "usage: pty-contract <pi> <extension> <new directory> <blocked 0|1> <slowdown>\n"); return 1; }
    double scale = strtod(argv[5], NULL);
    if (!(scale >= 1 && scale <= 15) || (strcmp(argv[4], "0") && strcmp(argv[4], "1"))) return 1;
    if (mkdir(argv[3], 0700)) { perror("mkdir contract directory"); return 1; }
    char path[4096];
    if (snprintf(path, sizeof(path), "%s/terminal-output.bin", argv[3]) >= (int)sizeof(path)) return 1;
    FILE *output = fopen(path, "wb");
    if (!output) return 1;
    int master, slave, notice[2];
    struct winsize size = { .ws_row = 24, .ws_col = 100 };
    if (openpty(&master, &slave, NULL, NULL, &size) || pipe(notice)) { perror("PTY/pipe"); return 1; }
    struct termios before, after;
    memset(&before, 0, sizeof(before));
    memset(&after, 0, sizeof(after));
    if (tcgetattr(slave, &before)) { perror("initial tcgetattr"); return 1; }
    char owner[32], endpoint[32];
    snprintf(owner, sizeof(owner), "%ld", (long)getpid());
    snprintf(endpoint, sizeof(endpoint), "%d", notice[0]);
    const char *id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    pid_t child = fork();
    if (child < 0) { perror("fork"); return 1; }
    if (!child) {
        close(master); close(notice[1]);
        if (setsid() < 0 || ioctl(slave, TIOCSCTTY, 0) < 0 || dup2(slave, 0) < 0 || dup2(slave, 1) < 0 || dup2(slave, 2) < 0) _exit(125);
        if (slave > 2) close(slave);
        unsetenv("PROCWARD_LIFECYCLE_HANDLE"); unsetenv("PROCWARD_PRIMARY_PID");
        setenv("PROCWARD_PROTOCOL", "1", 1); setenv("PROCWARD_OWNER_PID", owner, 1);
        setenv("PROCWARD_CONTRACT_ID", id, 1); setenv("PROCWARD_LIFECYCLE_FD", endpoint, 1);
        setenv("PI_PROCWARD_BOOTSTRAP_NONCE", id, 1);
        setenv("PI_PROCWARD_CONTRACT_DIRECTORY", argv[3], 1); setenv("PI_PROCWARD_CONTRACT_BLOCKED", argv[4], 1);
        if (snprintf(path, sizeof(path), "%s/agent", argv[3]) >= (int)sizeof(path)) _exit(125);
        setenv("PI_CODING_AGENT_DIR", path, 1);
        if (chdir(argv[3])) _exit(125);
        char *args[] = {argv[1], "--offline", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "anthropic", "--model", "claude-sonnet-4-5", "--api-key", "fixture-never-used", "-e", argv[2], NULL};
        execv(argv[1], args); _exit(125);
    }
    close(notice[0]);
    int result = 1, reaped = 0, status = 0;
    size_t written = 0;
    char record[256];
    int count = snprintf(record, sizeof(record), "PROCWARD/1 READY %s %ld parent %s\n", owner, (long)child, id);
    if (write(notice[1], record, (size_t)count) != count) goto cleanup;
    double deadline = now_ms() + 30000 * scale;
    while (!event(argv[3], "ready.json")) {
        drain(master, output, &written);
        if (waitpid(child, &status, WNOHANG) == child) { reaped = 1; fprintf(stderr, "Pi exited before readiness\n"); goto cleanup; }
        if (now_ms() >= deadline) { fprintf(stderr, "Pi readiness deadline\n"); goto cleanup; }
    }
    double started = now_ms();
    count = snprintf(record, sizeof(record), "PROCWARD/1 OWNER-LOSS %s\n", id);
    if (write(notice[1], record, (size_t)count) != count) goto cleanup;
    close(notice[1]); notice[1] = -1;
    deadline = started + 9000 * scale;
    while (waitpid(child, &status, WNOHANG) != child) {
        drain(master, output, &written);
        if (now_ms() >= deadline) { fprintf(stderr, "Pi notice shutdown deadline\n"); goto cleanup; }
    }
    reaped = 1;
    double elapsed = now_ms() - started;
    if (!WIFEXITED(status) || WEXITSTATUS(status) || !event(argv[3], "hook.json")) { fprintf(stderr, "notice did not run shutdown hook\n"); goto cleanup; }
    if (tcgetattr(slave, &after) || memcmp(&before, &after, sizeof(before))) { fprintf(stderr, "full terminal settings not restored\n"); goto cleanup; }
    if (!strcmp(argv[4], "1") && !(elapsed >= 4500 && elapsed < 6500 * scale)) { fprintf(stderr, "5s hook bound not observed\n"); goto cleanup; }
    printf("{\"noticeOnly\":true,\"parentAlive\":true,\"hookRan\":true,\"terminalRestored\":true,\"terminalBefore\":");
    snapshot(&before); printf(",\"terminalAfter\":"); snapshot(&after);
    printf(",\"elapsedMs\":%.0f,\"blockedHook\":%s}\n", elapsed, !strcmp(argv[4], "1") ? "true" : "false");
    result = 0;
cleanup:
    if (!reaped) { kill(child, SIGKILL); while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {} }
    if (notice[1] >= 0) close(notice[1]);
    fclose(output); close(master); close(slave);
    return result;
}
