# Process ownership

Pi cleans up every subprocess it starts, including the processes those subprocesses start. When a task finishes, is cancelled or times out, or when Pi itself exits or is killed, Pi stops the task's whole process tree. Background jobs (`npm run dev &`), double-forked daemons and `setsid` sessions are included.

This needs no setup, cgroups or administrator rights. It works as an ordinary user on every Release target.

## What is covered

| Owner | What Pi stops |
| --- | --- |
| Pi session | Everything Pi started, when Pi exits, crashes or is killed |
| `bash` tool, `!` commands, extension `exec` | The command's tree when it ends, times out or is cancelled |
| MCP stdio servers | The server's tree when the server is closed |
| Chord workers | The worker's tree when the worker is stopped |
| Durable environment commands | The command's tree |
| Remote environment commands (`pi-env`) | The command's tree on the remote host, when the remote daemon supports owned execution (see [Remote environments](#remote-environments)) |

Each task has its own owner. Cancelling one task never stops another task or an unrelated process of the same user.

## How it works

Pi ships a small native helper, `pi-env supervise`, inside the Release executable. At runtime it is extracted with the other bundled resources.

```text
pi                                   (you start Pi)
└─ pi-env supervise                  session owner
   └─ guardian
      └─ Pi
         ├─ pi-env supervise -- bash -c "…"      one owner per task
         ├─ pi-env supervise -- <mcp server>
         └─ …
```

1. **Session owner.**
   - At startup, Pi re-executes itself under `pi-env supervise`. On Windows, where there is no `exec`, Pi starts the helper instead.
   - The helper starts a guardian, and the guardian starts Pi.
   - Pi accepts ownership only from its immediate parent, through a one-time handshake. If the handshake does not complete, Pi refuses to start, so it never silently runs without an owner.
   - `pi --version` skips this step.
2. **Task owners.** Every built-in subprocess launcher wraps its command in its own `pi-env supervise`.
3. **Cleanup.**
   - The helper and its guardian each hold the tree.
   - If either one dies, the other still stops the tree.
   - The helper signals only live processes it still holds, never a remembered PID that the system could have reused.
   - A stop request reaches the task's main command as `SIGTERM`. If it is still running after a grace period, it gets `SIGKILL`.
   - Remaining descendants then get `SIGKILL` until none are left. If any survive five seconds, cleanup fails.
4. **Confirmed completion.**
   - Pi reports a task as cleaned up only after the helper confirms that the tree is empty, the helper has exited, and its control channel is drained. The main process exiting is not enough.
   - If cleanup cannot be confirmed, the task fails.
   - A task that was cancelled before its command started reports `aborted` instead of an invented exit code.

## Platform guarantees

| Platform | Mechanism | Guarantee |
| --- | --- | --- |
| Linux (glibc, musl) | Child subreaper (`PR_SET_CHILD_SUBREAPER`) and parent-death signal | Kernel-enforced. Orphaned descendants are re-parented to the owner, so it always finds them |
| FreeBSD 14.3+ | Reaper (`procctl PROC_REAP_ACQUIRE`) and parent-death signal | Kernel-enforced |
| Windows | Job Object with kill-on-close and no breakaway | Kernel-enforced. Closing the job stops every process in it |
| macOS | Process sweep (see below) | **Best effort** |

None of these need root, administrator rights or a special group.

### macOS limits

macOS has no unprivileged way to hold a whole process tree. There is no equivalent of cgroups, a subreaper or a Job Object. Pi uses a sweep instead:
- Two observers list the owned descendants every 25 ms.
- They remember each process by PID, start time and user, so they recognise a descendant even after it is re-parented.
- They check that identity again before sending any signal.

A process can escape if it calls `setsid` and is re-parented before the first sweep sees it. Its unseen children escape with it. Killing both observers also stops cleanup. In practice, ordinary background jobs and double-forked daemons are stopped.

If you need a hard boundary on macOS, run Pi in a container ([Docker, OrbStack or Apple `container`](../packages/coding-agent/docs/containerization.md)). macOS containers run in a Linux virtual machine, so Pi uses the kernel-enforced Linux owner there.

Interactive Pi on macOS shows a one-line startup hint about this limit. Print, JSON and RPC modes do not. The hint is not shown with `--offline`, `PI_OFFLINE=1` or a quiet startup.

> [!NOTE]
> macOS 27 adds an Endpoint Security client scoped to a process's descendants (`es_new_descendants_client`). It would remove this limit, but it requires a restricted entitlement granted by Apple. Pi does not use it yet.

### Windows: Chord workers

Node and Bun start IPC workers (`fork`) directly, so a Chord worker is added to its Job after it starts. Pi checks the worker before it is added:
- the helper keeps the process open;
- Pi checks that the worker is its own child and is still alive;
- Pi checks that the worker was created within one clock tick (16 ms) of the `fork` call.

Pi only sends the worker its first message after the worker is in the Job. Code that the worker runs before that point is not contained.

## Remote environments

The `pi-env` daemon can run commands under the same owner on the remote host. It does this only when the daemon advertises the `ownedExec1` capability. Today that means 64-bit GNU/Linux whose runtime glibc is exactly 2.44, the only version this path is qualified on.

On other remote hosts, Pi uses the previous execution path: commands still run, but their descendants are not owned.

## Linux cgroups

Pi does not create or write cgroups. If your Linux session supports cgroup delegation but Pi cannot use it, Pi shows a startup hint, for example:

```bash
systemd-run --user --scope -p Delegate=yes pi
```

You can also point `PI_ENV_CGROUP_PARENT` at a writable delegated subtree. The hint is informational: process ownership above does not depend on cgroups, and the external cgroup runner stays disabled. The hint is not shown with `--offline`, `PI_OFFLINE=1` or a quiet startup.

## Verification

Every Release candidate is checked on all 14 targets before publication. CI creates a dedicated standard account with no administrator, `sudo`, `wheel` or `docker` membership, then runs the shipped executable as that account:
- **Linux, FreeBSD and macOS:** for each target, Pi starts a background descendant with a double fork and with `setsid`, then exits normally or is killed. The check passes only if the descendant is gone after Pi exits, while an unrelated process of the same user is still alive.
- **macOS:** the fast `setsid` escape is reported as a separate, labelled known limitation.
- **Windows:** additionally runs a 39-test owner suite under both Node and the bundled Bun. It covers job cleanup, console and ConPTY `Ctrl+C`, Chord attach checks and failure handling at each startup step.

## Limits

- macOS cleanup is best effort, as described above.
- Owned remote execution requires a 64-bit GNU/Linux daemon on glibc 2.44.
- On Windows, a Chord worker's code before it is added to the Job is not contained.
- Process ownership is lifetime management, not a sandbox. It does not restrict files, network or credentials. For isolation, see [containerization](../packages/coding-agent/docs/containerization.md).
