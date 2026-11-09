// Review-only workload: live root ignoring TERM, plus an actively forking subtree.
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <unistd.h>
#include <stdatomic.h>

static atomic_int *count;
static int cap;

static void name(void) { prctl(PR_SET_NAME, "pwbomb", 0, 0, 0); }

// Live chain: each member forks one child and stays alive (deepening tree).
static void chain(void) {
  for (;;) {
    if (atomic_fetch_add(count, 1) >= cap) { for (;;) pause(); }
    pid_t p = fork();
    if (p < 0) { for (;;) pause(); }
    if (p > 0) { for (;;) pause(); }
    // child continues the chain
  }
}

// Rolling chain: fork a child, parent exits; endless fresh PIDs.
static void rolling(void) {
  for (;;) {
    pid_t p = fork();
    if (p < 0) { usleep(1000); continue; }
    if (p > 0) _exit(0);
  }
}

// Wide: keep forking sleeping children while under the cap.
static void wide(void) {
  for (;;) {
    if (atomic_load(count) >= cap) { usleep(1000); continue; }
    atomic_fetch_add(count, 1);
    pid_t p = fork();
    if (p == 0) {
      // each child also forks one grandchild while under cap
      if (atomic_fetch_add(count, 1) < cap && fork() == 0) { for (;;) pause(); }
      for (;;) pause();
    }
  }
}

int main(int argc, char **argv) {
  cap = argc > 1 ? atoi(argv[1]) : 300;
  count = mmap(NULL, sizeof *count, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  signal(SIGTERM, SIG_IGN);
  name();
  if (fork() == 0) { name(); chain(); }
  if (fork() == 0) { name(); rolling(); }
  if (fork() == 0) { name(); wide(); }
  printf("ready\n");
  fflush(stdout);
  for (;;) pause();
}
