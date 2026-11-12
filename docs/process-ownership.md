# Process ownership

Pi owns the processes it starts. When a command finishes, is cancelled or times out, or when Pi exits or loses its owner, Pi stops that command's whole process tree, including background jobs started with `cmd &`, double forks and `setsid`. Commands still behave as before: the same stdout, stderr, exit status, interaction and timeouts, and a command that leaves background work still returns as soon as its main process exits.

Ownership is on by default and needs no setup, cgroup changes or administrator rights. It is ordinary process management, not a security sandbox: a process that deliberately escapes, or one the operating system forbids this user to signal, can survive.

## What is covered

| Owner | What Pi stops |
| --- | --- |
| Pi session | Everything Pi started, when Pi exits or its owner is lost |
| `bash` tool and `!` commands | The command's tree when it is cancelled, times out, or `process_kill` stops it; otherwise when Pi exits |
| Extension `pi.exec` | The command's tree, the same way |
| MCP stdio servers | The server's tree when the server is closed |

Each command has its own owner. Stopping one task never stops another task or an unrelated process of the same user.

## How it works

Pi builds [procward](https://github.com/xz-dev/procward) from the vendored source in `vendor/procward`, pinned to a released and authenticated tag, and embeds the helper in each Release executable.

```text
procward run                                        session owner
└─ pi
   ├─ procward run --retain-descendants ... bash -c "npm run dev &"   one owner per task
   ├─ procward run --retain-descendants ... <mcp server>
   └─ ...
```

1. **Session owner.** At startup Pi re-executes itself under `procward run` (Windows starts it as a child instead). Pi accepts the hand-off only from its live direct parent through a one-time contract, then clears it from the environment of everything it starts. `--version` and `--help` stay transparent.
2. **Task owners.** The `bash` tool, `!` commands, `pi.exec` and MCP stdio servers start their command under its own `procward run` with a private control channel. Pi returns when the main process exits; the task's remaining descendants keep running as a background task.
3. **Confirmed cleanup.** A task is confirmed clean only when its owner reports the result, reports the tree empty, and closes the control channel. Anything less is reported as `unconfirmed` and kept in the task list for inspection, never as success.

## Process tools

- `process_list` shows the session owner (id 0) and each running or background task, with the tool, the tool call and the message that started it.
- `process_kill` stops tasks by id through their owner, using the task's own grace and cleanup deadlines. It reports each id as confirmed or unconfirmed, with the cleanup scope. Id 0 is the session itself and is never cancellable.

## Turning it off

- `--no-process-ownership` turns ownership off for one invocation; `PI_NO_PROCESS_OWNERSHIP=1` turns it off for Pi and every Pi it starts. Both skip the helper entirely: it is not looked up or run, and the process tools are not registered.
- A missing helper in an enabled build is an error, not a silent opt-out.
- `PROCWARD=0` at build time produces artifacts without the helper. That is a build capability, not a runtime switch; Gentoo exposes it as `USE=procward` (on by default).

## Work that must outlive Pi

Background work stays owned and stops with Pi. For a service that must keep running after Pi exits, the built-in `persistent-background-tasks` skill tells the model to hand it to an external service manager or an already running tmux server outside Pi's tree. `nohup` and `setsid` do not escape ownership.

## Platform guarantees

| Platform | Mechanism | Scope |
| --- | --- | --- |
| Linux (glibc, musl) | Owned cgroup v2 group, or a subreaper/pidfd fallback when the cgroup cannot be delegated | Kernel |
| FreeBSD | `procctl` reaper domain | Kernel |
| Windows | Job object assigned before the command runs | Kernel |
| macOS | Observer sweep | Best-effort: fast reparenting or `setsid` can escape |

When Pi's own owner disappears, Pi runs its shutdown hooks for at most five seconds from the first observation, and a separate watchdog ends it after seven. On Windows, closing the Job can end Pi before hooks run.

## Verification

Release acceptance runs the installed executable of every target as an unprivileged user. It checks that normal exit and termination stop double-forked and `setsid` descendants while an unrelated process of the same user survives. On Windows it also runs the Node and Bun runtime gate and drives the real `bash`, `process_list` and `process_kill` tools of the installed CLI: background tasks outlive their command, one task is cancelled with confirmed kernel cleanup while the other keeps working, and a `bash` timeout cleans up its tree. Pi's Linux ownership tests that need a separate kernel are not part of the release workflow; they are run before delivery in separately booted local virtual machines. Native lifecycle tests run in procward's own CI and release workflow.
