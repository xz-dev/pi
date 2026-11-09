# Managed-child contract, version 1

`procward run -- <command>` grants its **direct primary** an application-only
lifecycle pipe. This is generic application integration, not a pi mode or a
public Rust library. Environment alone never proves managed state.

The consumer discipline follows OS-standard socket activation: validate the
intended process, consume environment once, and make the endpoint close-on-exec
before starting children. See [sd_listen_fds(3)](https://www.freedesktop.org/software/systemd/man/latest/sd_listen_fds.html).
Unlike socket activation, this pipe carries bounded lifecycle records, not
application sockets.

## Environment

| Variable | Value |
| --- | --- |
| `PROCWARD_PROTOCOL` | Exactly `1` |
| `PROCWARD_OWNER_PID` | Decimal immediate native parent's PID |
| `PROCWARD_CONTRACT_ID` | Fresh 128-bit launch ID, 32 lowercase hexadecimal characters |
| `PROCWARD_LIFECYCLE_FD` | Unix read-only pipe fd, decimal integer greater than 2 |
| `PROCWARD_LIFECYCLE_HANDLE` | Windows inherited read-pipe HANDLE, unsigned decimal value |

Exactly one platform transport variable is present. `PROCWARD_PRIMARY_PID` is
**not** emitted: primary PID is in READY on every platform. Windows must prepare
its environment before CreateProcess returns a PID; no environment injection or
extra process layer is used. Existing contract variables are replaced, not
forwarded as a reusable claim.

## Wire records

UTF-8/ASCII lines, LF terminated. Each complete line, including LF, is at most
**256 bytes**. Decimal PIDs are positive native PIDs. Unknown versions, wrong
field counts, malformed values, wrong launch IDs, overlong records and partial
records at EOF are invalid.

```text
PROCWARD/1 READY <owner_pid> <primary_pid> <owner_identity> <launch_id>\n
PROCWARD/1 OWNER-LOSS <launch_id>\n
```

READY is first and appears once. Its owner PID and launch ID must match the
environment. Its primary PID must equal the consumer's own live PID, not a PID
inherited from an ancestor.

On Unix, `owner_identity` is `parent`: `getppid()` must match the announced owner.
The kernel's immediate-parent relationship binds that identity while the
primary lives; a departed parent reparents the child rather than authorizing a
reused numeric PID. Check this relationship at acceptance, not only when reading
environment.

On Windows, `owner_identity` is the owner's 64-bit creation FILETIME, encoded as
16 lowercase hexadecimal characters. Check the primary's native parent PID,
open that owner with query/synchronize rights, compare GetProcessTimes creation
time and confirm the handle is still live. A reused numeric parent PID cannot
pass the creation-time check. The application receives **no Job handle**.

Use a startup response deadline. Poll/retry only while transport is not ready;
neither silence nor an endless partial record can extend that deadline. EOF
before READY is failed readiness. The reference fixture uses a two-second
startup response deadline; that is fixture policy, not a procward hook budget.

## Consume before starting tools

After validating READY:

1. Set `FD_CLOEXEC` on Unix, or clear `HANDLE_FLAG_INHERIT` on Windows.
2. Unset every contract environment variable above (and discard any obsolete
   `PROCWARD_PRIMARY_PID` metadata).
3. Only then launch ordinary children or load code that can launch them.
4. Retain the read endpoint for owner-loss notification; close it at shutdown.

A consumer that deliberately leaves its application endpoint inheritable can
leak that endpoint. It cannot keep a native ownership lease or Job alive:
application transport is separate from those private non-inheritable handles.
An ordinary descendant cannot reuse the claim: its own PID and immediate-parent
identity differ, and a pipe's consumed READY cannot be rewound. This is a
lifecycle convention, not a security boundary against a malicious parent or
application forging its own state.

## Nested scopes

Nesting is supported by default:

```sh
procward run -- procward run -- command args
```

Each invocation creates its own ownership layer; an existing procward tree or
READY record does not suppress it. Normal payload exit preserves its native
result through both layers, after cleanup. Losing the outer owner cleans the
whole nested tree within the **outer** configured cleanup deadline, even if the
inner layer has a longer grace. Losing only the inner owner cleans its subtree;
the outer layer returns its primary's native termination result after cleanup
(for example 137 for Unix SIGKILL). macOS retains its observed-tree best-effort
boundary; nesting does not turn either observer into kernel containment.

A nested procward discards its inherited application lifecycle endpoint before
creating native roles or its own handoff. It closes an incoming pipe only after
checking its type (and Unix access), ignores stale/closed/malformed or mismatched
application metadata, and never interprets that metadata as permission to skip
ownership. Ordinary intermediaries such as Python subprocess and shells can
close inherited descriptors without scrubbing their environment; nesting still
adds a fresh layer. Strict validation remains required for explicitly supplied
native/task endpoints and for a consumer accepting its own READY.
It replaces all contract variables, including obsolete/wrong-platform ones, with
the inner layer's environment and fresh launch ID. The inner payload receives
only its inner lifecycle fd/HANDLE and READY record, never the outer endpoint or
private native ownership handles. Consumers must still follow the ordinary-child
unset/close-on-exec discipline above.

Pi's later adapter follows the same default: pi under pi or any external
procward adds its own layer. Only its launcher's `--no-process-ownership` or
`PI_NO_PROCESS_OWNERSHIP=1` disables that pi-added layer, without escaping an
external scope. Pi skips only its **own** bootstrap reentry, identified by a
private one-shot marker **and** valid READY; external PROCWARD metadata alone is
not that marker. This is an integration requirement, not implemented pi code in
this repository.

`tests/nesting.rs` exercises payload exit, each owner loss and contract isolation
through the real nested CLI on every matrix target. The isolation fixture checks
all open Unix descriptors or snapshots all Windows handles, rather than assuming
unused handle numbers prove noninheritance. Before its first spawn, the test
launcher marks unrelated ambient CI-runner pipes non-inheritable; it does not
exclude any pipe from the payload assertion. Omitting procward's inherited
handoff discard still fails that assertion with an extra outer pipe. Windows
stdio aliases are recognized by `CompareObjectHandles`, not by matching raw
HANDLE numbers. Scenarios are serialized so another test's transient spawn
handles cannot enter the tested tree. The outer lifecycle pipe is a distinct
kernel object and is never excluded as stdio.

## Owner loss and shutdown

The surviving native owner queues OWNER-LOSS before starting its termination
signals, then closes the application writer. Accept a notice only for the
validated launch ID. EOF without a notice **after** valid READY also means owner
loss, never successful cleanup. Do not confuse the startup EOF rejection with
this active-lifecycle failure path.

An application can drain the notice before running its own signal hooks and
cooperate during the selected grace. The application must handle TERM if it
needs that opportunity: default signal termination can preempt application
callbacks. Procward's independent TERM/CONT/KILL policy does not await a hook,
an application acknowledgement or terminal output. Its existing `--grace`,
`--fatal-grace` and `--cleanup-deadline` options select the bound; notification
never restarts or extends it. Fixed application hook/watchdog durations are not
part of this contract.

Windows kill-on-last-Job-handle-close can kill the primary before it observes a
notice or EOF. Notification/cooperation there is best-effort; Job containment
remains kernel-enforced. On macOS, READY does not prove descendant observation;
cleanup retains the documented best-effort/pre-observation limitation.

## Standalone reference consumer

`tests/fixtures/managed.rs` is a test-only consumer, not an installed API.
`tests/contract.rs` checks real procward startup, ordinary-child claim/endpoint
removal, parent/primary/launch identity mismatches, unsupported versions,
truncation, oversized records and EOF before readiness. Applications, including
pi's later adapter, implement the same documented boundary independently.

## Per-task control, result and cleanup

Use `procward run --control-fd N -- <command>` on Unix, or
`--control-handle N` on Windows. The endpoint is an inherited duplex Unix-domain
stream socket or Windows byte-mode duplex named pipe, respectively. It must be
valid before launch; procward takes ownership and makes it non-inheritable.
Task mode creates no new session/private PTY, even if inherited stdio is a tty.
The primary's application lifecycle pipe remains separate from task control.

The controller sends at most one bounded request:

```text
PROCWARD/1 CANCEL\n
```

EOF also cancels; an incomplete, oversized or invalid request fails control and
initiates cleanup. The controller receives LF-terminated records, each bounded
to 256 bytes:

```text
PROCWARD/1 S <owner_pid> <scope>\n
PROCWARD/1 X <native_primary_result>\n
PROCWARD/1 C <scope>\n
```

`S` means the control endpoint was accepted and native initialization is
starting, **not** that application readiness was reached. `X` is the primary's
result, not tree completion: owned descendants can still be shutting down.
Results are decimal Unix exit/signal-derived status or full native Windows u32.
`scope` is `kernel` on Linux/FreeBSD/Windows and `best-effort` on Darwin. A
startup/control/cleanup failure produces `PROCWARD/1 E 125\n` instead of C.
Cancellation before a primary exists can therefore produce E rather than X/C.

Success requires S, a valid X, C with the expected scope **and transport EOF**.
Missing C, an error record, truncation, invalid ordering or a transport that does
not drain/close is unconfirmed cleanup, even if X was zero. Native leases, the
policy publication channel and Windows Job handles never travel on task control
or into ordinary children. A blocked controller cannot hold up native cleanup;
record buffering is bounded, and the final transport flush has a configured
cleanup-deadline bound. Darwin C confirms a best-effort sweep, not containment.
EOF following C is required evidence that the owning helper closed its endpoint.
EOF on the separate application pipe is owner loss, not this task completion.

## Independent deadline examples

Standalone managed fixtures cover a responsive primary that observes OWNER-LOSS,
a primary blocked after readiness that cannot observe it, and EOF when the
immediate native parent disappears. Their Unix policy is explicitly configured
as 1s ordinary grace, 500ms fatal grace and 1500ms cleanup deadline. The blocked
primary cannot extend those bounds. Windows kill-on-close may preempt this
opportunity, as described above.

A separate pipe interaction fixture replies NOT-READY before accepting quit.
The harness acts once, waits for the response and only then retries. Silence
and endless NOT-READY responses both fail at the original response deadline;
terminating the failed interaction's owner and observing transport closure is
separate teardown, not a successful interaction. Fixture deadlines are testing
policy, not procward hook/watchdog settings.

Task conformance also faults a native controller after X while an ignoring
worker remains. Even with a known primary status, controller failure produces E,
never a successful C. Error diagnostics are best-effort when inherited stderr is
blocked: exit status and task error/completion records remain authoritative.
