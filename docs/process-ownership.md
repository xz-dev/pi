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

## Turning it off

Use `pi --no-process-ownership` when an external sandbox or supervisor already owns Pi's subprocess lifecycle. This skips the session wrapper, per-task native owners, owner-loss watcher and macOS ownership hint. Legacy process-group cancellation remains available, but detached descendants may outlive Pi.

The flag applies to this invocation. Set `PI_NO_PROCESS_OWNERSHIP=1` instead to pass the opt-out to nested Pi invocations through the environment. Pi clears inherited internal `PI_PROCESS_OWNER_*` variables when disabled; it does not change the external sandbox or supervisor.

## Suspending and resuming

On Linux, FreeBSD and macOS, interactive `Ctrl-Z` pauses Pi and its owned local tool trees; `fg` resumes them. Tools keep their separate sessions (`setsid`): they do not gain access to Pi's controlling terminal. This includes shell commands, MCP stdio servers, Chord workers and local environment commands. It does not suspend remote hosts or unrelated processes.

The shell-facing supervisor stops, but the guardian keeps running so owner death, cancellation and resume requests remain observable. A resume received during a freeze pass wins; the guardian never parks itself after a late stop operation. Graceful teardown resumes stopped payloads before sending `SIGTERM`, then escalates after a bounded grace period. Adopted zombies are reaped while Pi continues running, and Pi requests graceful shutdown if its immediate owner disappears.

Linux freezing requires working `pidfd_open` and `pidfd_send_signal` (Linux 5.3+ and a seccomp policy that permits them). If unavailable, Pi still suspends, but prints a warning that owned tools keep running. Ordinary ownership and cleanup do not require pidfds. FreeBSD uses kernel-scoped reaper signals, including nested reapers; macOS retains its identity-checked, best-effort boundary below.

Interactive `Ctrl-Z` excludes suspended time from shell-command timeouts. Externally delivered `SIGTSTP`, print/JSON/RPC shell deadlines and MCP request deadlines may still count suspended wall-clock time. Windows has no Unix job-control suspension and is unchanged.

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

## Verification

Every Release candidate is checked on all 14 targets before publication. CI creates a dedicated standard account with no administrator, `sudo`, `wheel` or `docker` membership, then runs the shipped executable as that account:
- **Linux, FreeBSD and macOS:** for each target, Pi starts a background descendant with a double fork and with `setsid`, then exits normally or is killed. The check passes only if the descendant is gone after Pi exits, while an unrelated process of the same user is still alive.
- **macOS:** the fast `setsid` escape is reported as a separate, labelled known limitation.
- **Windows:** additionally runs a 39-test owner suite under both Node and the bundled Bun. It covers job cleanup, console and ConPTY `Ctrl+C`, Chord attach checks and failure handling at each startup step.

### Unix paused-owner acceptance

The release gate also runs the actual staged executable interactively in a fresh native PTY, under that same dedicated account. It does not pre-stop print mode or substitute the host Bun for the artifact's runtime.

| Row | Input and required result |
| --- | --- |
| `suspend-resume` | Send real `Ctrl-Z`, observe Pi, shell-facing outer, task controllers and payload stopped with an advancing heartbeat now stable. Guardian stays runnable. Simulate shell `fg`, observe resumed work, then `Ctrl-D` and complete cleanup. |
| `paused-guardian-death` | While paused, kill Pi's verified parent guardian. All owned processes must exit automatically within 8 seconds. No user or harness rescue `CONT`. |
| `paused-both-owners-death` | While paused, kill both verified session owners: harness child outer and Pi's parent guardian. Same complete teardown bound, with no `fg` fallback. |
| `paused-observer-death` (macOS) | Kill the verified session wake observer while paused. Same full, automatic teardown requirement; partial supervision is a failure. |

Every fault row keeps an unowned sibling stopped in the *same foreground job group*. That peer must survive without a `CONT` or heartbeat advancement. The harness returns terminal foreground to its shell but never writes terminal modes: `ISIG`, `ICANON` and `ECHO` must match the originally cooked terminal after product teardown. States, PID birth identities, ancestry, fault targets, terminal flags and heartbeat counts are recorded, not inferred from a passed label. A stopped survivor or absent observation fails aggregation. Linux non-direct fault signals require validated pidfds, with no numeric-PID fallback; FreeBSD and macOS use birth-checked identities.

On macOS, startup must show exactly guardian plus one native observer as outer's direct children. The observer must remain runnable outside the frozen job groups, and disappear without an adopted zombie on normal completion and every fault case. This does not change the fast-escape limitation above.

### CI fixture staging and local checks

`packages/env/daemon/examples/owner-pty.rs` only includes the CI source in `scripts/fixtures/owner/pty.rs`. The fixture reuses the locked daemon manifest's libc/JSON dependencies and the official Pi Durable `pty.rs` openpty/setsid mechanism. That module's private PTY interface does not expose terminal modes or a shell-owned same-group peer, so direct reuse of its API cannot supply these assertions. No new dependency, production mode or shipped helper is added.

```bash
# Use an isolated build directory, outside the source checkout.
CARGO_TARGET_DIR=/var/tmp/pi-owner-pty-target \
  node scripts/build-owner-pty.mjs linux-x64-gnu-baseline /var/tmp/pi-owner-pty/owner-pty
PI_OWNER_PTY_HARNESS=/var/tmp/pi-owner-pty/owner-pty \
  node scripts/smoke-owner-lifecycle.mjs /absolute/path/to/staged/pi linux-x64-gnu-baseline /var/tmp/owner-evidence.json
```

The build script selects the existing pinned daemon toolchain and authoritative target triple; local builds never install toolchains. FreeBSD arm64 retains its existing explicitly recorded packaged-Rust exception. Release workflow staging is:

- Linux GNU and macOS: build the matching example, upload private `owner-pty-<commit>-<target>` CI artifact, download in acceptance, then copy it alongside the CLI into the dedicated user's scratch directory.
- Linux musl: build the matching musl example, download it, mount it read-only at `/owner-pty`, and pass `PI_OWNER_PTY_HARNESS=/owner-pty/owner-pty` into the existing pinned native-musl container. The nonadmin child receives its own copied executable.
- FreeBSD: build and execute the fixture inside each matching FreeBSD guest. Keep the fixture as a separate private CI artifact. Failure diagnostics remain separate from release acceptance records.
- Windows: no Unix fixture; existing Node and artifact-matched Bun 39/39 gates and opt-out remain required.

The fixture is not a public release asset or attestation subject. `binary-acceptance.json` binds every PTY row to the target and CLI hash and requires the artifact's reported Bun version to agree across owner rows. Synthetic Node proof fixtures and Cargo self-tests validate the harness/assertions only. They do **not** prove a product candidate passes these cases. Actual GNU/musl, FreeBSD and macOS nonadmin release-artifact runs, plus the unchanged Windows matrix, remain mandatory before release.

## Limits

- macOS cleanup is best effort, as described above.
- Owned remote execution requires a 64-bit GNU/Linux daemon on glibc 2.44.
- On Windows, a Chord worker's code before it is added to the Job is not contained.
- Process ownership is lifetime management, not a sandbox. It does not restrict files, network or credentials. For isolation, see [containerization](../packages/coding-agent/docs/containerization.md).
