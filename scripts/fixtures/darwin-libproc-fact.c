// Diagnostic-only macOS fact: query only two unreaped direct children, never a global PID list.
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc.h>
#include <sys/proc_info.h>

static volatile sig_atomic_t cancelled;
static void cancel(int signal) { (void)signal; cancelled = 1; }
static double now(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
    return value.tv_sec + value.tv_nsec / 1000000000.0;
}
static void pause_tick(void) { struct timespec tick = {0, 1000000}; (void)nanosleep(&tick, NULL); }
struct sample {
    struct proc_bsdshortinfo before, after;
    struct proc_bsdinfo full;
    int before_n, before_errno, after_n, after_errno;
    int full_n, full_errno;
};
static void measure(pid_t pid, struct sample *value) {
    memset(value, 0, sizeof(*value));
    errno = 0;
    value->before_n = proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &value->before, sizeof(value->before));
    value->before_errno = errno;
    errno = 0;
    value->full_n = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &value->full, sizeof(value->full));
    value->full_errno = errno;
    errno = 0;
    value->after_n = proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &value->after, sizeof(value->after));
    value->after_errno = errno;
}
static int stable(pid_t pid, const struct sample *s) {
    return s->before_n == (int)sizeof(s->before) && s->after_n == (int)sizeof(s->after)
        && s->before.pbsi_pid == (uint32_t)pid && s->after.pbsi_pid == (uint32_t)pid
        && s->before.pbsi_ppid == (uint32_t)getpid() && s->after.pbsi_ppid == (uint32_t)getpid()
        && s->before.pbsi_uid == s->after.pbsi_uid && s->before.pbsi_ruid == s->after.pbsi_ruid
        && s->before.pbsi_svuid == s->after.pbsi_svuid && s->before.pbsi_pgid == s->after.pbsi_pgid
        && s->before.pbsi_status != SZOMB && s->after.pbsi_status != SZOMB;
}
static void print_short(const char *name, int n, int error, const struct proc_bsdshortinfo *s) {
    printf("\"%s\":{\"returned\":%d,\"errno\":%d,\"expectedBytes\":%zu", name, n, error, sizeof(*s));
    if (n == (int)sizeof(*s)) printf(",\"pid\":%u,\"parent\":%u,\"group\":%u,\"state\":%u,\"uid\":%u,\"ruid\":%u,\"svuid\":%u", s->pbsi_pid, s->pbsi_ppid, s->pbsi_pgid, s->pbsi_status, s->pbsi_uid, s->pbsi_ruid, s->pbsi_svuid);
    printf("}");
}
static int one_child(int ps, char *header) {
    int fds[2];
    if (pipe(fds) != 0) { printf("{\"kind\":\"%s\",\"startupErrno\":%d}", ps ? "ps" : "control", errno); return 0; }
    pid_t pid = fork();
    if (pid < 0) { int error = errno; close(fds[0]); close(fds[1]); printf("{\"kind\":\"%s\",\"startupErrno\":%d}", ps ? "ps" : "control", error); return 0; }
    if (pid == 0) {
        if (signal(SIGALRM, SIG_DFL) == SIG_ERR) _exit(126);
        alarm(8);
        close(fds[0]);
        if (dup2(fds[1], STDOUT_FILENO) < 0) _exit(126);
        close(fds[1]);
        if (ps) {
            char self[32];
            (void)snprintf(self, sizeof(self), "%d", getpid());
            char *args[] = {"/bin/ps", "-ww", "-p", self, "-o", header, NULL};
            char *env[] = {"PATH=/usr/bin:/bin", "LC_ALL=C", NULL};
            execve(args[0], args, env);
            _exit(127);
        }
        size_t done = 0;
        while (!cancelled && done < strlen(header)) {
            ssize_t n = write(STDOUT_FILENO, header + done, strlen(header) - done);
            if (n > 0) done += (size_t)n;
            else if (n < 0 && errno != EINTR) _exit(125);
        }
        _exit(0);
    }
    close(fds[1]);
    int flags = fcntl(fds[0], F_GETFL);
    int ready = 0, reaped = 0, held = 1, status = 0, killed = 0;
    struct sample value;
    memset(&value, 0, sizeof(value));
    double begin = now(), until = begin + 2;
    int nonblocking = flags >= 0 && fcntl(fds[0], F_SETFL, flags | O_NONBLOCK) == 0;
    if (nonblocking) {
        while (!cancelled && now() < until) {
            measure(pid, &value);
            if (stable(pid, &value) && (!ps || memcmp(value.before.pbsi_comm, "ps\0", 3) == 0)) { ready = 1; break; }
            pid_t got = waitpid(pid, &status, WNOHANG);
            if (got == pid) { reaped = 1; held = 0; break; }
            if (got < 0 && errno != EINTR) { held = 0; break; }
            pause_tick();
        }
    }
    // Release ordinary stdout backpressure, drain bounded output, then reap our still-held child.
    double sampled = now();
    size_t drained = 0;
    until = now() + 3;
    while (nonblocking && !cancelled && now() < until) {
        char bytes[4096];
        ssize_t n = read(fds[0], bytes, sizeof(bytes));
        if (n > 0) drained += (size_t)n;
        if (!reaped && held) {
            pid_t got = waitpid(pid, &status, WNOHANG);
            if (got == pid) { reaped = 1; held = 0; }
            else if (got < 0 && errno != EINTR) { held = 0; break; }
        }
        if (!held && !reaped) break;
        if (reaped && n == 0) break;
        if (drained > 1048576) break;
        pause_tick();
    }
    close(fds[0]);
    if (!reaped && held) {
        // No other waiter exists: an unreaped direct child pins this numeric PID.
        if (kill(pid, SIGKILL) == 0) killed = 1;
        pid_t got;
        do { got = waitpid(pid, &status, 0); } while (got < 0 && errno == EINTR);
        reaped = got == pid;
    }
    printf("{\"kind\":\"%s\",\"pid\":%d,\"heldDirectChild\":true,\"stableLiveSample\":%s,\"sampleMs\":%.3f,\"drainedBytes\":%zu,\"reaped\":%s,\"cleanupKilled\":%s,\"waitStatus\":%d,", ps ? "ps" : "control", pid, ready ? "true" : "false", (sampled-begin)*1000, drained, reaped ? "true" : "false", killed ? "true" : "false", status);
    print_short("before", value.before_n, value.before_errno, &value.before); printf(",");
    printf("\"full\":{\"returned\":%d,\"errno\":%d,\"expectedBytes\":%zu", value.full_n, value.full_errno, sizeof(value.full));
    if (value.full_n == (int)sizeof(value.full)) printf(",\"pid\":%u,\"uid\":%u,\"ruid\":%u,\"startSeconds\":%llu,\"startMicros\":%llu", value.full.pbi_pid, value.full.pbi_uid, value.full.pbi_ruid, (unsigned long long)value.full.pbi_start_tvsec, (unsigned long long)value.full.pbi_start_tvusec);
    printf("},");
    print_short("after", value.after_n, value.after_errno, &value.after); printf("}");
    return ready && !killed && reaped && WIFEXITED(status) && WEXITSTATUS(status) == 0 && drained > 65536;
}
int main(void) {
    if (getuid() == 0 || geteuid() == 0) { fputs("fact requires nonroot\n", stderr); return 1; }
    struct stat mode;
    if (stat("/bin/ps", &mode) != 0 || !S_ISREG(mode.st_mode)) return 2;
    // 96 KiB exceeds Darwin's 64 KiB pipe capacity without approaching ARG_MAX.
    char *header = malloc(98309);
    if (!header) return 2;
    memcpy(header, "pid=", 4); memset(header+4, 'X', 98304); header[98308] = 0;
    struct sigaction action;
    memset(&action, 0, sizeof(action)); sigemptyset(&action.sa_mask); action.sa_handler = cancel;
    if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0 || sigaction(SIGHUP, &action, NULL) != 0 || signal(SIGCHLD, SIG_DFL) == SIG_ERR) { free(header); return 2; }
    gid_t groups[128]; int count = getgroups(128, groups);
    if (count < 0) { free(header); return 2; }
    printf("{\"diagnosticOnly\":true,\"publishable\":false,\"identity\":{\"pid\":%d,\"parent\":%d,\"uid\":%u,\"euid\":%u,\"gid\":%u,\"egid\":%u,\"groups\":[", getpid(), getppid(), getuid(), geteuid(), getgid(), getegid());
    for (int i=0;i<count;i++) printf("%s%u", i ? "," : "", groups[i]);
    printf("]},\"psFile\":{\"mode\":%u,\"uid\":%u,\"gid\":%u,\"setuid\":%s},\"children\":[", (unsigned)mode.st_mode, mode.st_uid, mode.st_gid, (mode.st_mode & S_ISUID) ? "true" : "false");
    fflush(stdout);
    int control = one_child(0, header); printf(","); fflush(stdout);
    int ps = one_child(1, header); printf("],\"complete\":%s}\n", control && ps ? "true" : "false");
    free(header);
    return control && ps ? 0 : 2;
}
#else
int main(void) { fputs("macOS-only diagnostic\n", stderr); return 77; }
#endif
