# Tiny genuine-Windows byte-I/O probe (stage 1)

**Stage1 byte-I/O only. Source and preparation checks do not prove Windows support.** This diagnostic was admitted after the actual full43 local replay, full check, 815 connected tests and 99 controlled script tests passed. It changes no Pi runtime or native contract/pin; genuine Windows results are retained separately.

## Files and behavior

- `fixture.rs`: std-only Windows Rust executable, direct UCRT/kernel32 declarations; no Cargo/dependencies. Windows metadata typecheck is not linking or API execution.
- `driver.mjs`: same public Node-compatible source for Node **22.22.2** and Bun **1.4.4**; runtime mismatch stops before spawning. Non-Windows execution immediately refuses, exit 2, before reading the fixture or spawning.
- `driver.test.mjs`: pure framing/observation tests; imports the driver but does not spawn, listen, or run the fixture.
- `.github/workflows/probe-windows-interop.yml`: four independent runtime × mechanism cells on `windows-2025`, with no fallback. Manual dispatch is available once the workflow is on the default branch. Initial execution uses only the explicit `ci-probe/windows-interop-20261111` scratch push and matching workflow/source paths; it does not push product branches or rebuild/publish main.
- `SHA256SUMS`: source hashes; `.gitattributes` pins source bytes against checkout CRLF conversion. Local logs are preparation evidence only. Executable hash is generated on Windows, never fabricated now.

Each invocation runs exactly the selected case (`crt` or `named`):

1. **CRT**: public `spawn(..., stdio: ['ignore','pipe','pipe','pipe'])`; fixture resolves `_get_osfhandle(3)` inside its own UCRT. Missing fd3 emits `PROBE_UNSUPPORTED crt-fd3-unavailable`, exit 78; report status `unsupported`, driver exit 1. No named-pipe rescue. The fixture logs fd **3** separately from the actual source HANDLE, duplicates with inheritance false, adopts only that duplicate as `File`, closes the CRT source with `_close(3)` once, then verifies the CRT slot is invalid. It records source and owned HANDLE separately; no parent numeric HANDLE is ever obtained or passed.
2. **Named**: public `net.createServer({allowHalfOpen:true}).listen(unique \\.\pipe\pi-interop-...)` completes before ordinary spawn. Fixture opens the path using `CreateFileW`, duplex and noninheritable. The listener stops accepting after connection; listener, accepted socket and fixture endpoint must close for success.
3. Both inspect pipe type/read-mode/handle flags and then exchange `ready {metadata}\n`, `ping\n`, `pong\n`, parent send EOF, child observes EOF and closes, parent observes EOF. Duplex access is proved only by a completed real exchange, not claimed from the type flags alone. Ordinary stdout/stderr markers and exit **17** remain independent of control data.
4. JSON records actual runtime/version/architecture, executable and driver SHA-256, fd/HANDLE metadata, pipe flags, payload PID matching spawned child PID, stdout/stderr and exit. **Path, PID payload and endpoint metadata are observations, not authenticated peer identity.**
5. The 8-second case guard marks `status: failed, guardFired: true`, requests termination of **only its own fixture ChildProcess**, destroys only its own streams/listener, and bounds cleanup to another 2 seconds. A cleanup timeout is separately recorded; there is no success rescue or whole-tree cleanup claim. The fixture itself uses synchronous I/O and relies on this driver guard; do not run it directly. Status `unsupported` is not green. Any failure ends that invocation; there is no alternate CLI.

## Exact future commands (genuine Windows PowerShell only)

Prerequisites: Node 22.22.2, Bun 1.4.4, Rust with `x86_64-pc-windows-msvc` and MSVC linker already available. The reviewed workflow sets up only Node/Bun; it requires the image's Rust/MSVC setup and stops if missing. Stop on missing tools/API/setup failure; no installs or fallback CLI in this local command sequence. Set `$probe` to the transferred scratch directory, or the applied `scripts/windows-interop-probe` directory.

```powershell
$ErrorActionPreference = 'Stop'
$probe = (Resolve-Path '.\scripts\windows-interop-probe').Path
Set-Location $probe
foreach ($line in Get-Content '.\SHA256SUMS') {
  $parts = $line -split '  ', 2
  if ($parts.Count -ne 2) { throw 'Malformed source manifest' }
  if ((Get-FileHash -Algorithm SHA256 $parts[1]).Hash.ToLowerInvariant() -cne $parts[0]) {
    throw "Source hash mismatch: $($parts[1])"
  }
}
node --check .\driver.mjs
if ($LASTEXITCODE -ne 0) { throw 'Node syntax check failed' }
node .\driver.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Parser tests failed' }
rustc --version
rustc --edition=2024 --target=x86_64-pc-windows-msvc .\fixture.rs -o .\fixture.exe
if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed; stop, no fallback' }
Get-FileHash -Algorithm SHA256 .\fixture.exe
```

Run each following command as an **explicit independent experiment**, not a fallback after another fails. The four workflow matrix cells automate these independent experiments and preserve all diagnostics even when a cell fails. To run manually, use this helper only for logging (no retry/fallback); select one of the four calls for each reviewed experiment:

```powershell
function Invoke-OneProbe([string]$runtime, [string]$case) {
  & $runtime .\driver.mjs "$probe\fixture.exe" $case 1> "$runtime-$case.json" 2> "$runtime-$case.stderr.log"
  if ($LASTEXITCODE -ne 0) { throw "$runtime/$case failed or unsupported; stop and inspect JSON/stderr, do not rescue" }
}
Invoke-OneProbe node crt
# Separate reviewed experiments, not continuation/rescue after an error:
Invoke-OneProbe node named
Invoke-OneProbe bun crt
Invoke-OneProbe bun named
```

GitHub requires a workflow to exist on the default branch before manual dispatch. The bounded scratch push trigger permits the initial experiment without prematurely syncing or publishing the product. See the [manual-dispatch requirement](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/manually-running-a-workflow). The scratch ref is not a product input or production predecessor; final CI changes remain on downstream `ci`.

## Remaining gates

Stage 1 proves **byte I/O only** on whichever genuine Windows runtime/architecture actually passes. It does **not** prove a Pi adapter, bootstrap identity, native S/X/C records, native cleanup, lifecycle inheritance/loss, descendant termination, or shipped packaging.

Stage 2 must use the winning real-Windows mechanism with actual native READY, wrong-identity rejection, native parent lookup, live-process query and exact **64-bit creation FILETIME**, lifecycle noninheritance/loss checks, then **S → X → C → EOF plus child close and one retained descendant**. Native handles used for identity queries must close. No stage-1 metadata substitutes for these checks.

Arm64: after gated x64 evidence and stage-2 design approval, repeat the same unmodified driver and recompile fixture for `aarch64-pc-windows-msvc` on an authorized real Windows arm64 runner with native arm64 Node 22.22.2 and Bun 1.4.4. Confirm runtime/compiler architecture in logs, change only runner/target/artifact labels in a separately reviewed patch, then repeat stage 2 and shipped-package checks. `windows-11-arm` is a historical label, **not a capacity/availability claim**. If matching runtimes/runner/target are unavailable, record unvalidated and stop; do not emulate or silently use x64.

See SOURCES.md for immutable source and action references; LICENSE retains the vendor BSD-3-Clause notice.
