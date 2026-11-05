#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

static void finite_sleep(unsigned seconds) {
	struct timespec remaining = { seconds, 0 };
	alarm(seconds + 2);
	while (nanosleep(&remaining, &remaining) < 0) {
		if (errno != EINTR) _exit(80);
	}
}

static void marker(const char *directory, const char *name, const char *text) {
	char path[4096];
	int length = snprintf(path, sizeof(path), "%s/%s", directory, name);
	if (length < 0 || (size_t)length >= sizeof(path)) _exit(81);
	int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
	if (fd < 0 || write(fd, text, strlen(text)) != (ssize_t)strlen(text)) _exit(82);
	if (close(fd) < 0) _exit(83);
}

int main(int argc, char **argv) {
	if (argc == 2 && strcmp(argv[1], "--peer") == 0) {
		finite_sleep(20);
		return 0;
	}
	int linger = argc == 4 && strcmp(argv[3], "linger") == 0;
	if (argc != 3 && !linger) return 2;
	char *end;
	long lifetime = strtol(argv[2], &end, 10);
	if (*end || lifetime < 1 || lifetime > 20) return 3;
	alarm(22);
	int ready[2];
	if (pipe(ready) < 0) return 4;
	pid_t middle = fork();
	if (middle < 0) return 5;
	if (middle > 0) {
		close(ready[1]);
		pid_t daemon;
		ssize_t count = read(ready[0], &daemon, sizeof(daemon));
		close(ready[0]);
		if (count != (ssize_t)sizeof(daemon) || daemon <= 0) return 6;
		printf("%ld\n", (long)daemon);
		if (fflush(stdout) != 0) return 13;
		if (linger) finite_sleep((unsigned)lifetime);
		return 0;
	}
	close(ready[0]);
	if (setsid() < 0) _exit(7);
	pid_t daemon = fork();
	if (daemon < 0) _exit(8);
	if (daemon > 0) _exit(0);
	if (setsid() < 0) _exit(9);
	alarm(22);
	int null = open("/dev/null", O_RDWR);
	if (null < 0) _exit(10);
	for (int fd = 0; fd < 3; fd++) if (dup2(null, fd) < 0) _exit(11);
	if (null > 2) close(null);
	char capabilities[4][32] = {{0}};
	FILE *status = fopen("/proc/self/status", "r");
	if (!status) _exit(84);
	char line[256];
	while (fgets(line, sizeof(line), status)) {
		sscanf(line, "CapInh: %31s", capabilities[0]);
		sscanf(line, "CapPrm: %31s", capabilities[1]);
		sscanf(line, "CapEff: %31s", capabilities[2]);
		sscanf(line, "CapAmb: %31s", capabilities[3]);
	}
	fclose(status);
	for (int i = 0; i < 4; i++) if (!capabilities[i][0]) _exit(85);
	char identity[512];
	snprintf(identity, sizeof(identity),
		"{\"pid\":%ld,\"sid\":%ld,\"uid\":%lu,\"euid\":%lu,\"gid\":%lu,\"egid\":%lu,"
		"\"caps\":[\"%s\",\"%s\",\"%s\",\"%s\"]}\n",
		(long)getpid(), (long)getsid(0), (unsigned long)getuid(),
		(unsigned long)geteuid(), (unsigned long)getgid(), (unsigned long)getegid(),
		capabilities[0], capabilities[1], capabilities[2], capabilities[3]);
	marker(argv[1], "daemon.ready", identity);
	pid_t me = getpid();
	if (write(ready[1], &me, sizeof(me)) != (ssize_t)sizeof(me)) _exit(12);
	close(ready[1]);
	finite_sleep((unsigned)lifetime);
	marker(argv[1], "daemon.expired", "expired\n");
	_exit(0);
}
