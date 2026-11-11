# Real native Windows task-control probe

This probe is not stage1 byte I/O and does not complete Pi Windows acceptance.
It connects the public Node 22.22.2 / Bun 1.4.4 `child_process.spawn` extra
`stdio[3]` to the real procward `--control-fd 3` on native Windows x64/arm64.

The workflow checks out native main candidate
`37a8279992af704fde65e9d4212c4d6038ccda35` (tree
`d99a0c84f52588e57f6ff35ace59b29a83840a30`) and uses that repository's existing
`.github/scripts/build-dist.py` and Cargo configuration. Its MSVC `+crt-static`
setting must remain enabled and dependency inspection must reject dynamic CRT
imports. No downloaded release executable is a build input, no alternate
transport/CLI is attempted, and this unreleased source is not a Pi pin.

The driver requires native S, X, expected kernel C, transport EOF and actual
child close. It compares binary stdin/stdout/stderr, argv, cwd, environment and
status to direct execution, preserves a full u32 result, and reuses procward's
existing retained-worker fixture for natural completion and CANCEL after X.
A causal worker acknowledgement after 1600 ms proves liveness past the unchanged
1500 ms cleanup budget. Each case retains the existing native task-test 8 s
guard; guard or harness rescue is failure. Helper/fixture hashes must not change.

Artifact evidence includes the exact native source tree, all tracked live source
hashes before/after, workflow/driver/parser sources, runtime and executable hashes,
dependency inspection and raw stdout/stderr receipts. Run the parser locally with
`node --test scripts/windows-native-control-probe/driver.test.mjs`; the real driver
refuses non-Windows execution before launching anything.

Still required: genuine Pi bootstrap and task adapters, native parent/live-process
and exact 64-bit creation FILETIME verification, application lifecycle endpoint
noninheritance and owner loss, installed runtime acceptance and authenticated
native release before any Pi source-pin update. CRT's own spawn tests and these
standalone control cases cannot replace those gates.
