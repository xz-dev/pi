# Windows runtime owner gate

Run `test/windows-owner-runtime.mjs` from package root on each shipped artifact, under a nonadmin, non-elevated account:

```powershell
$env:PI_WINDOWS_OWNER_ARTIFACT = 'windows-x64-baseline' # also windows-x64-modern, windows-arm64
$env:PI_PROCESS_OWNER_TEST_BINARY = 'C:\artifact\native\process-owner\pi-env.exe'
$env:PI_WINDOWS_OWNER_TEST_CLI = 'C:\artifact\pi.exe'
node --test test/windows-owner-runtime.mjs
bun test --reporter=junit --reporter-outfile=bun-junit.xml --timeout 60000 ./test/windows-owner-runtime.mjs
```

Use Node 22 and the Bun version embedded in the artifact (runner Bun must match). CI reads that version from every owner fixture row, copies runner Bun into nonadmin scratch with its SHA-256, then runs only the exact runtime test file with the JUnit reporter and a 60000 ms per-test timeout. Bun's plain-script mode cannot run the `node:test` hooks. Acceptance requires the complete per-test inventory, zero failures/skips/todos and exit status 0; missing or invalid JUnit evidence fails. Supply actual extracted shipped artifact paths; retain logged SHA-256 values alongside artifact provenance. No builds or mocked helpers substitute for shipped artifacts. Run all three artifacts on their designated Windows runners. The gate rejects unavailable ownership, elevated/admin tokens, incomplete cleanup, and unsupported IPC instead of skipping. `whoami /all`, effective elevation, inherited Job state, runtime versions and artifact hashes are logged.

Covered: recursive/new-console descendants, nested Job, breakaway denial, primary exit, cancellation, timeout, full lease loss (cleanup without caller acknowledgment), real launcher/guardian/bootstrap death at six handshake boundaries, private failure injection, cleanup delayed beyond 50 ms, early worker exit before/after guardian OpenProcess, bounded phase expiry, separate binary stdio, argv/environment/cwd/stdin, unsigned statuses, CLI respawn, ConPTY console Ctrl-C and interactive TUI exit, Node/Bun IPC message/TCP-handle/disconnect round trips, post-attach Chord work and failed attachment. Test-only fault flags require `PI_ENV_SUPERVISE_TEST_FAULTS=1`; ordinary JS callers never pass them.

Windows fork ownership uses attachment, not transparent handle forwarding. Worker module startup before first manager message must not spawn descendants. Guardian holds OpenProcess handle, verifies parent PID against pipe server, and reports O (opened) without assignment. Pi checks child.exitCode/signalCode are null, parent/PID match, and creation time lies between before-fork minus 16 ms and after-fork (strict upper bound), using performance.timeOrigin + performance.now(). Pi sends permit or deny. Guardian assigns only after permit; first outgoing control/frame messages wait for native S acknowledgment.

Node 22.20.0 sets exitCode/signalCode before closing original process handle in JS onexit callback. Checking those fields after O proves original handle remained open when guardian opened PID, excluding PID reuse. Pinned Bun 1.3.14 schedules JS handleOnExit on nextTick; inspected source does not prove equivalent OS-handle lifetime ordering. Bun retains same field fence plus mandatory parent/creation-time checks, but exact identity proof remains a recorded gap. Neither runtime uses timestamps as proof equivalent to Node handle fence.

Windows cancellation writes K without ending pipe. Readers require C, native EOF and helper close before successful completion. Native treats full pipe close as lease loss: cleanup still runs, but caller cannot report acknowledged success. Windows runtime acceptance remains pending until gate passes on real artifacts; local Linux/type checks do not establish containment or console behavior.
