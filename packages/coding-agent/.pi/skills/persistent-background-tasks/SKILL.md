---
name: persistent-background-tasks
description: Run tasks that must survive Pi exiting. Use when deciding whether background work needs an external owner, or handing such work to a service manager or an existing external tmux server.
---

# Persistent background tasks

## Decide who owns the task

Ask whether the task must keep running after Pi exits. Background execution
alone does not require persistence. Keep ordinary commands under Pi ownership;
use `process_list` to find their task IDs and `process_kill` to cancel them.
Read each cancellation result: `unconfirmed` is not proof of cleanup, and
`best-effort` scope is not a kernel guarantee. Ownership-disabled sessions do
not expose these tools.

For work that must survive Pi, hand execution to an owner already outside Pi's
cleanup scope. Record the command, absolute working directory, required
environment, log destination, and intended stop condition before submission.

`nohup`, `setsid`, and setting `PI_NO_PROCESS_OWNERSHIP=1` inside an owned child
do not escape an outer owner. The variable prevents additional local wrapping;
it does not revoke ownership already imposed by Pi or another owner.

## Submit to an external owner

Choose an available service manager or an already-running external tmux server.
Use the platform's manager rather than starting a new supervisor beneath Pi.
If neither is available, report the missing prerequisite and ask the user to
establish an external owner. Keep the task owned until handoff is possible.

For a systemd user manager, use a uniquely named service, not a scope that
executes the command as a child of the submitting shell. For example, replace
these placeholders with the recorded values:

    systemd-run --user --unit=NAME --service-type=exec --working-directory=ABS /abs/program ARG

For tmux, identify the existing server by its explicit socket and verify its
PID and ownership before creating a dedicated window with `new-window` on that
server. Record the window/pane ID and arrange a file log before starting work.
If the server is missing or belongs to Pi's tree, stop this route; do not create
or restart it from an owned shell.

## Verify the handoff

Submission success or a live PID is insufficient. Obtain the actual worker PID
from the service manager or tmux pane and identify the task, not just its shell.
Inspect its parent chain and its owner's parent chain against Pi and all
relevant outer owners. Check cleanup membership too: on Linux compare cgroup
paths with the owners' scopes; on Windows inspect Job membership; on other
platforms inspect the applicable ownership mechanism and state its limits.
Reparenting or a changed session ID alone does not prove independence.

Confirm the worker is under the chosen external owner and outside every
applicable Pi cleanup scope. Read a task-specific readiness result and recent
logs. If ancestry or scope cannot be verified, report persistence as unverified
and resolve that gap before promising the task will survive Pi.

## Leave a management record

For a systemd service, give `systemctl --user status NAME`,
`journalctl --user -u NAME`, and `systemctl --user stop NAME`.
For tmux, give the socket, window/pane ID, `list-panes` status command, log file,
and the task's stop command. Remove a dedicated window only after stopping its
work; preserve a shared server and unrelated windows.

Report the owner, worker PID, independence evidence, readiness, log location,
and exact status/stop instructions. After a requested stop, verify the task's
scope is empty; PID disappearance alone does not prove descendant cleanup.
