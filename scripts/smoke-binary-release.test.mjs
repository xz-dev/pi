import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bunTarget } from "./lib/bun-targets.mjs";
import { isUnixOwnerPtyRow } from "./smoke-unix-owner-pty.mjs";
import { passedUnixIdentity, passedUnixOwnerPtyRow } from "./fixtures/unix-owner-pty.mjs";
import { assertOwnerLifecycle, ownerLifecycleRows, smokeOwnerLifecycle } from "./smoke-owner-lifecycle.mjs";

// Test-only owner: real detached descendants, deterministic cleanup, no native backend dependency.
function ownerDriver(root, cleanup) {
	const driver = join(root, "owner-driver.mjs");
	writeFileSync(driver, `import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const exit = process.exit.bind(process);
Object.defineProperty(process.versions, "bun", { value: "1.3.14" });
const kill = process.kill.bind(process);
// Test-only freeze model; the native guardian has its own Rust regressions.
const signalLeaf = (signal) => { try { kill(Number(readFileSync(process.env.PI_OWNER_PID_FILE, "utf8")), signal); } catch {} };
process.kill = (pid, signal) => { if (pid === process.pid && signal === "SIGSTOP") signalLeaf("SIGSTOP"); return kill(pid, signal); };
process.on("SIGCONT", () => signalLeaf("SIGCONT"));
const cleanup = () => { try { process.kill(Number(readFileSync(process.env.PI_OWNER_PID_FILE, "utf8")), "SIGKILL"); } catch {} };
${cleanup ? 'process.exit = (code) => { cleanup(); exit(code); }; process.on("SIGTERM", () => { cleanup(); exit(143); });' : ""}
await (await import(pathToFileURL(process.argv.at(-1)).href)).default();
`);
	return driver;
}

// Synthetic PTY records exercise the wrapper only; native fixture has its own self-tests.
function fixtureIdentity() {
	return { ...passedUnixIdentity(), uid: process.getuid(), euid: process.geteuid() };
}
function fixturePty(executable, descriptor, name, _work, identity) {
	const row = passedUnixOwnerPtyRow(name, descriptor.os, descriptor.id, createHash("sha256").update(readFileSync(executable)).digest("hex"));
	row.identity = { uid: identity.uid, euid: identity.euid };
	row.pi.uid = identity.uid;
	for (const p of [...Object.values(row.processes), ...row.paused, row.peer]) p.uid = identity.uid;
	return row;
}
function fixturePtyExecutable(root) {
	const script = join(root, "owner-pty.mjs");
	writeFileSync(script, `#!${process.execPath}
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { passedUnixOwnerPtyRow } from ${JSON.stringify(new URL("./fixtures/unix-owner-pty.mjs", import.meta.url).href)};
const row = passedUnixOwnerPtyRow(process.argv[6], "linux", ${JSON.stringify(target)}, createHash("sha256").update(readFileSync(process.argv[3])).digest("hex"));
row.identity = { uid: process.getuid(), euid: process.geteuid() }; row.pi.uid = process.getuid();
for (const p of [...Object.values(row.processes), ...row.paused, row.peer]) p.uid = process.getuid();
console.log(JSON.stringify(row));
`);
	chmodSync(script, 0o755);
	return script;
}

const target = "linux-x64-gnu-baseline";
const bunAvailable = spawnSync("bun", ["--version"]).status === 0;
const smokeScript = readFileSync(join(import.meta.dirname, "smoke-binary-release.mjs"), "utf8");

test("command kill timeout is a hang guard separate from the measured performance limit", () => {
	// A budget-sized kill timeout turned slow cold starts into opaque SIGTERM failures.
	assert.match(smokeScript, /timeout: \(options\.timeout \?\? 60_000\) \* hangGuardScale/);
	assert.match(smokeScript, /const hangGuardScale = target\.emulated \? EMULATED_SMOKE_SLOWDOWN : 1;/);
	assert.doesNotMatch(smokeScript, /timeout: options\.timeout \?\? options\.maxMs/);
	assert.match(smokeScript, /if \(options\.maxMs && elapsedMs > options\.maxMs\) throw/);
	assert.match(smokeScript, /failed after \$\{elapsedMs\}ms/);
});

test("single-executable smoke stages the raw asset as the public entrypoint", () => {
	assert.match(smokeScript, /copyFileSync\(asset, executable\)/);
	assert.match(smokeScript, /pi-resources-\$\{userInfo\(\)\.uid\}/);
	assert.doesNotMatch(smokeScript, /unzip|Expand-Archive|extractedBytes/);
});

test("native TUI smoke scopes the Windows benchmark lifecycle to the TUI child", () => {
	assert.match(smokeScript, /const env = \{ \.\.\.process\.env, NODE_ENV: "production", PI_OFFLINE: "1", PI_CODING_AGENT_DIR/);
	assert.doesNotMatch(smokeScript.match(/const env = [^;]+/)?.[0] ?? "", /PI_STARTUP_BENCHMARK/);
	assert.match(smokeScript, /const tuiEnv = \{ \.\.\.env, PI_XZ_TUI_PASTE_PROBE: "1"[^\n]*PI_STARTUP_BENCHMARK/);
	assert.match(smokeScript, /run\("version"[^\n]+\{ env, maxMs/);
	assert.match(smokeScript, /"smoke-bun-tui\.mjs"[^\n]+\{ env: tuiEnv, timeout/);
});

test("Unix TUI harness allows startup initialization to settle before sending exit", { skip: !bunAvailable && "Bun is not installed" }, () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tui-startup-settle-"));
	try {
		const executable = join(root, "pi");
		writeFileSync(executable, `#!/usr/bin/env python3
import os, select, sys, time, tty
tty.setraw(sys.stdin.fileno()); os.write(sys.stdout.fileno(), b"\\x1b[?2004h")
time.sleep(0.75)
settling, _, _ = select.select([sys.stdin], [], [], 0)
premature = os.read(sys.stdin.fileno(), 1024) if settling else b""
if b"\\x03" in premature or b"\\x04" in premature: raise SystemExit(2)
os.write(sys.stdout.fileno(), b"startup-settled")
deadline = time.monotonic() + 2; received = premature
while time.monotonic() < deadline and b"\\x04" not in received:
    readable, _, _ = select.select([sys.stdin], [], [], 0.1)
    if readable: received += os.read(sys.stdin.fileno(), 1024)
raise SystemExit(0 if b"\\x04" in received else 3)
`);
		chmodSync(executable, 0o755);
		const result = execFileSync("bun", [join(import.meta.dirname, "smoke-bun-tui.mjs"), executable], { encoding: "utf8" });
		const evidence = JSON.parse(result.trim());
		assert.equal(evidence.cleanExit, true);
		assert.equal(evidence.input, "ctrl-c,ctrl-d");
		assert.ok(evidence.elapsedMs >= 1000);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("TUI benchmark harness starts the binary from its isolated bundle directory", { skip: !bunAvailable && "Bun is not installed" }, () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tui-benchmark-"));
	try {
		mkdirSync(join(root, ".pi", "skills"), { recursive: true });
		const bundle = join(root, "bundle");
		mkdirSync(bundle);
		const executable = join(bundle, "pi");
		writeFileSync(executable, "#!/bin/sh\n[ \"$PWD\" = \"$(dirname \"$0\")\" ] || exit 2\nprintf 'benchmark-output__PI_STARTUP_'\nsleep 0.05\nprintf 'BENCHMARK_COMPLETE__\\n'\n"); chmodSync(executable, 0o755);
		const result = execFileSync("bun", [join(import.meta.dirname, "smoke-bun-tui.mjs"), executable], { encoding: "utf8", cwd: root, env: { ...process.env, PI_STARTUP_BENCHMARK: "1" } });
		const evidence = JSON.parse(result.trim());
		assert.equal(evidence.input, "startup-benchmark");
		assert.equal(evidence.exitSent, false);
		assert.equal(evidence.childExitCode, 0);
		assert.equal(evidence.terminalClosed, true);
		assert.ok(Number.isSafeInteger(evidence.terminalExitCode));
		assert.equal(evidence.benchmarkCompleted, true);
		assert.ok(evidence.outputBytes > 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("TUI benchmark harness rejects a clean exit without the completion marker", { skip: !bunAvailable && "Bun is not installed" }, () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tui-incomplete-benchmark-"));
	try {
		const executable = join(root, "pi");
		writeFileSync(executable, "#!/bin/sh\nprintf benchmark-output\n"); chmodSync(executable, 0o755);
		assert.throws(() => execFileSync("bun", [join(import.meta.dirname, "smoke-bun-tui.mjs"), executable], { encoding: "utf8", env: { ...process.env, PI_STARTUP_BENCHMARK: "1" } }), /TUI PTY acceptance failed/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("TUI benchmark timeout reports only a bounded escaped output tail", { skip: !bunAvailable && "Bun is not installed", timeout: 10_000 }, () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tui-timeout-tail-"));
	try {
		const executable = join(root, "pi");
		writeFileSync(executable, "#!/bin/sh\nprintf 'discard-me\\n'; i=0; while [ $i -lt 3000 ]; do printf '\\033'; i=$((i + 1)); done; printf '\\ntail-line\\n'; while :; do :; done\n"); chmodSync(executable, 0o755);
		const result = spawnSync("bun", [join(import.meta.dirname, "smoke-bun-tui.mjs"), executable], { encoding: "utf8", env: { ...process.env, PI_STARTUP_BENCHMARK: "1", GITHUB_ACTIONS: "true" }, timeout: 9_000 });
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		assert.notEqual(result.status, 0);
		assert.match(output, /lastStage=null tail="(?:\\u001b){100,}\\r\\ntail-line\\r\\n"/);
		assert.doesNotMatch(output, /discard-me/);
		assert.ok(Buffer.byteLength(output) < 5_000);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("TUI harness failure keeps pid, bounded tail, and the send schedule", { skip: !bunAvailable && "Bun is not installed" }, () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tui-failure-evidence-"));
	try {
		const executable = join(root, "pi");
		writeFileSync(executable, "#!/bin/sh\nprintf 'sentinel-dropme\\n'\ni=0; while [ $i -lt 900 ]; do printf 'X'; i=$((i + 1)); done\nprintf '\\nsentinel-crash-tail\\n'\nexit 139\n"); chmodSync(executable, 0o755);
		const diagnostics = join(root, "tui-diag.json");
		const result = spawnSync("bun", [join(import.meta.dirname, "smoke-bun-tui.mjs"), executable], { encoding: "utf8", env: { ...process.env, PI_XZ_TUI_DIAGNOSTICS: diagnostics } });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /TUI PTY acceptance failed: pid=\d+ exit=139/);
		assert.match(result.stderr, /sentinel-crash-tail/);
		assert.doesNotMatch(result.stderr, /sentinel-dropme/);
		assert.match(result.stderr, /X{400,}\\r\\nsentinel-crash-tail/);
		assert.ok(Buffer.byteLength(result.stderr) < 5_000);
		const evidence = JSON.parse(readFileSync(diagnostics, "utf8"));
		assert.ok(Number.isSafeInteger(evidence.childPid) && evidence.childPid > 0);
		assert.equal(evidence.childExitCode, 139);
		assert.equal(evidence.tail.includes("sentinel-crash-tail"), true);
		assert.equal(evidence.tail.length <= 512, true);
		assert.equal(evidence.exitSent, false);
		assert.ok(Number.isSafeInteger(evidence.elapsedMs));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("TUI harness records the Ctrl-C/Ctrl-D schedule for a child that exits nonzero after exit", { skip: !bunAvailable && "Bun is not installed" }, () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tui-schedule-evidence-"));
	try {
		const executable = join(root, "pi");
		writeFileSync(executable, `#!/usr/bin/env python3
import os, select, sys, tty
sys.stdout.write("ready\\n"); sys.stdout.flush()
tty.setraw(sys.stdin.fileno())
deadline = __import__("time").monotonic() + 5
received = b""
while __import__("time").monotonic() < deadline and b"\\x04" not in received:
    readable, _, _ = select.select([sys.stdin], [], [], 0.1)
    if readable: received += os.read(sys.stdin.fileno(), 1024)
raise SystemExit(139)
`);
		chmodSync(executable, 0o755);
		const diagnostics = join(root, "tui-diag.json");
		const result = spawnSync("bun", [join(import.meta.dirname, "smoke-bun-tui.mjs"), executable], { encoding: "utf8", env: { ...process.env, PI_XZ_TUI_DIAGNOSTICS: diagnostics, PI_XZ_TUI_PASTE_PROBE: "1", PI_XZ_TUI_TIMEOUT_MS: "7000" }, timeout: 15_000 });
		assert.notEqual(result.status, 0);
		const evidence = JSON.parse(readFileSync(diagnostics, "utf8"));
		assert.equal(evidence.childExitCode, 139);
		assert.equal(evidence.exitSent, true);
		assert.ok(Number.isSafeInteger(evidence.inputEvents.interruptMs));
		assert.ok(Number.isSafeInteger(evidence.inputEvents.exitMs));
		assert.ok(Number.isSafeInteger(evidence.inputEvents.lastPasteMs));
		assert.ok(evidence.inputEvents.lastPasteMs < evidence.inputEvents.interruptMs);
		assert.ok(evidence.inputEvents.interruptMs < evidence.inputEvents.exitMs);
		assert.ok(evidence.inputEvents.exitMs < evidence.elapsedMs);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("smoke failure writes .diagnostics outside the deleted work directory", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-smoke-diagnostics-"));
	try {
		const pi = join(root, `pi-${target}`);
		writeFileSync(pi, "#!/bin/sh\necho 0.0.0\n"); chmodSync(pi, 0o755);
		const recordPath = join(root, "record.json");
		const result = spawnSync(process.execPath, [join(import.meta.dirname, "smoke-binary-release.mjs"), pi, target, "1.2.3", recordPath], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /cold version mismatch|failed after/);
		const diagnosticsPath = `${recordPath}.diagnostics`;
		assert.equal(existsSync(diagnosticsPath), true);
		const diagnostics = JSON.parse(readFileSync(diagnosticsPath, "utf8"));
		assert.equal(diagnostics.schemaVersion, 1);
		assert.equal(diagnostics.target, target);
		assert.equal(diagnostics.version, "1.2.3");
		assert.match(diagnostics.error, /cold version mismatch/);
		assert.equal(diagnostics.asset.file, `pi-${target}`);
		assert.match(diagnostics.asset.sha256, /^[0-9a-f]{64}$/);
		assert.ok(diagnostics.asset.bytes > 0);
		// Staged copy was hashed before cleanup and lives under the deleted work dir.
		assert.match(diagnostics.staged.sha256, /^[0-9a-f]{64}$/);
		assert.equal(diagnostics.staged.sha256, diagnostics.asset.sha256);
		assert.match(diagnostics.staged.path, /pi-binary-smoke-.*\/install\/pi$/);
		assert.equal(existsSync(diagnostics.staged.path), false);
		assert.ok(Array.isArray(diagnostics.commands));
		assert.ok(diagnostics.runner.os);
		assert.ok(diagnostics.runner.cpuFeatures);
		// A green-path record file must not exist: nothing to accept.
		assert.equal(existsSync(recordPath), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("smoke diagnostics context failure cannot replace the original acceptance error", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-smoke-context-fault-"));
	try {
		// A module loader hook makes node:os report darwin and throw from
		// userInfo(), faulting diagnostics context enrichment after staging.
		writeFileSync(join(root, "os-hooks.mjs"), `let osSource = "";
export function initialize(data) { osSource = data.osSource; }
export async function load(url, context, next) {
	if (url === "node:os") return { format: "module", shortCircuit: true, source: osSource };
	return next(url, context);
}
`);
		// createRequire bypasses ESM hooks, so the synthesized module re-exports
		// real builtin bindings while platform/userInfo are faulted.
		writeFileSync(join(root, "register.mjs"), `import { register } from "node:module";
const real = process.getBuiltinModule("os");
const names = Object.keys(real).filter((name) => name !== "platform" && name !== "userInfo" && name !== "default");
const osSource = \`import { createRequire } from "node:module";\nconst real = createRequire(process.cwd() + "/x.cjs")("os");\n\` + names.map((name) => \`export const \${name} = real[\\'\${name}\\'];\n\`).join("") + \`export const platform = () => "darwin";\nexport const userInfo = () => { throw new Error("FAULT_USERINFO") };\nexport default real;\n\`;
register("./os-hooks.mjs", { parentURL: import.meta.url, data: { osSource } });
`);
		const pi = join(root, `pi-${target}`);
		writeFileSync(pi, "#!/bin/sh\necho 0.0.0\n"); chmodSync(pi, 0o755);
		const recordPath = join(root, "record.json");
		const result = spawnSync(process.execPath, ["--import", join(root, "register.mjs"), join(import.meta.dirname, "smoke-binary-release.mjs"), pi, target, "1.2.3", recordPath], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		// The thrown acceptance failure, not FAULT_USERINFO, reaches the process.
		assert.match(result.stderr, /cold version mismatch/);
		assert.doesNotMatch(result.stderr, /Unhandled|FAULT_USERINFO\n/);
		const diagnostics = JSON.parse(readFileSync(`${recordPath}.diagnostics`, "utf8"));
		assert.match(diagnostics.error, /cold version mismatch/);
		assert.match(diagnostics.contextError, /FAULT_USERINFO/);
		assert.equal(existsSync(recordPath), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("external TUI evidence contributes the authoritative pseudoterminal command", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-external-tui-"));
	try {
		const stage = join(root, "stage");
		mkdirSync(stage, { recursive: true });
		// The fixture executable is a shell script that materializes the native
		// helper tree into the isolated tmpdir resource cache itself, so the
		// materialization/clipboard probes have real files to find.
		const descriptor = bunTarget(target);
		const helperRelative = `${descriptor.nativeHelperDir}/${descriptor.nativeHelperFile}`;
		const pi = join(stage, `pi-${target}`);
		const driver = ownerDriver(root, true);
		writeFileSync(pi, `#!/bin/sh
uid=$(id -u)
cache="$TMPDIR/pi-resources-$uid/${target}/1.2.3/${helperRelative}"
mkdir -p "$(dirname "$cache")"
printf 'module.exports = { getText: async () => null, getImage: async () => null };\\n' > "$cache"
mkdir -p "$TMPDIR/pi-resources-$uid/${target}/1.2.3/native"
printf '{}' > "$TMPDIR/pi-resources-$uid/${target}/1.2.3/native/clipboard-native-provenance.json"
if [ -n "$BUN_JSC_verboseDiskCache" ]; then echo "[Disk Cache] Cache hit for sourceCode /$bunfs/entry" >&2; fi
case "$1" in
  --version) echo 1.2.3;;
  --help) echo Usage: pi;;
  --list-models) echo model;;
  -p) exec "${process.execPath}" "${driver}" "$@";;
  *) exit 0;;
esac
`); chmodSync(pi, 0o755);
		const preload = join(root, "native-fixture.cjs");
		writeFileSync(preload, `require.extensions['.node'] = (module, filename) => module._compile(require('node:fs').readFileSync(filename, 'utf8'), filename);
// This test's fake CLI/PTY run on a developer host, possibly in wheel. Identity rejection has separate tests.
require('node:module').registerHooks({load(url, context, next) {
	const result = next(url, context);
	if (url.endsWith('/smoke-owner-lifecycle.mjs')) {
		const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString();
		return {...result, source: source.replace('export function ownerIdentity() {', 'export function ownerIdentity() { return ' + ${JSON.stringify(JSON.stringify(fixtureIdentity()))} + ';')};
	}
	return result;
}});
`);
		const bin = join(root, "bin"); mkdirSync(bin); const bun = join(bin, "bun");
		// The in-display paste probe runs `bun smoke-bun-tui.mjs <pi>`; a fixture pi
		// materializes on any invocation, so run it directly instead of a PTY.
		writeFileSync(bun, `#!/bin/sh\ncase "$1" in *smoke-bun-tui.mjs) exec "$2";; esac\nexec "${process.execPath}" "$@"\n`); chmodSync(bun, 0o755);
		const evidence = join(root, "tui.json"); writeFileSync(evidence, JSON.stringify({ harness: "Bun.Terminal PTY", elapsedMs: 37, outputBytes: 42, input: "ctrl-v,ctrl-c,ctrl-d", childExitCode: 0, terminalClosed: true, terminalExitCode: 1, observedOutput: true, benchmarkCompleted: null, exitSent: true, cleanExit: true }));
		const recordPath = join(root, "record.json");
		mkdirSync(join(root, "smoke-tmp"));
		// Fixture smoke runs as this test user; never trigger the CI-only dedicated-account drop here.
		execFileSync(process.execPath, [join(import.meta.dirname, "smoke-binary-release.mjs"), pi, target, "1.2.3", recordPath], { env: { ...process.env, CI: "false", GITHUB_ACTIONS: "false", PATH: `${bin}:${process.env.PATH}`, PI_OWNER_PTY_HARNESS: fixturePtyExecutable(root), NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, PI_XZ_TUI_EVIDENCE: evidence, TMPDIR: join(root, "smoke-tmp"), RUNNER_OS: "Linux", RUNNER_ARCH: "X64" } });
		const record = JSON.parse(readFileSync(recordPath, "utf8"));
		assert.deepEqual(record.commands.map(({ name }) => name), descriptor.requiredCommands);
		assert.deepEqual(record.commands.at(-2).name, "resource-materialization");
		assert.deepEqual(record.commands.at(-1).name, "clipboard");
		assert.equal(record.asset.file, `pi-${target}`);
		assert.equal(record.clipboard.loadedAndCalled, true);
		assert.equal(record.clipboard.textRead, true);
		assert.equal(record.clipboard.imageRead, true);
		assert.equal(record.ownerLifecycle.status, "passed");
		assertOwnerLifecycle(record.ownerLifecycle, "linux");
		assert.equal(record.timingsMs.interactive, 37);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("owner lifecycle measures immediate normal/kill containment and same-user peer isolation", { skip: process.platform !== "linux" || process.getuid?.() === 0 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-owner-positive-"));
	try {
		const driver = ownerDriver(root, true);
		const executable = join(root, "pi");
		writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${driver}" "$@"\n`); chmodSync(executable, 0o755);
		const evidence = await smokeOwnerLifecycle(executable, bunTarget(target), { timeoutMs: 10_000, runPty: fixturePty, identityProbe: fixtureIdentity });
		assert.equal(evidence.status, "passed", JSON.stringify(evidence));
		assert.equal(evidence.identity.elevated, false);
		assert.ok(evidence.identity.capabilities.CapEff);
		assertOwnerLifecycle(evidence, "linux");
		assert.equal(evidence.rows.length, 8);
		assert.ok(evidence.rows.every((row) => row.aliveBefore && !row.aliveAfter && row.peerAlive && row.immediateChecks === 1));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("owner lifecycle fails leaked descendants without polling or expiry credit", { skip: process.platform !== "linux" || process.getuid?.() === 0 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-owner-negative-"));
	try {
		const driver = ownerDriver(root, false);
		const executable = join(root, "pi");
		writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${driver}" "$@"\n`); chmodSync(executable, 0o755);
		const evidence = await smokeOwnerLifecycle(executable, bunTarget(target), { timeoutMs: 10_000, runPty: fixturePty, identityProbe: fixtureIdentity });
		assert.equal(evidence.status, "failed");
		assert.ok(evidence.rows.filter((row) => row.name !== "ownership-disabled" && !isUnixOwnerPtyRow(row.name)).every((row) => row.aliveAfter && row.peerAlive && row.immediateChecks === 1 && row.status === "failed"), JSON.stringify(evidence));
		assert.equal(evidence.rows.find((row) => row.name === "ownership-disabled").status, "passed");
		assert.throws(() => assertOwnerLifecycle(evidence, "linux"), /owner lifecycle/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("owner lifecycle acceptance rejects elevated identity, missing rows, peer loss, and Windows leaks", () => {
	const evidence = { status: "passed", artifactBunVersion: "1.3.14", identity: { elevated: false, mediumIntegrity: true }, rows: ownerLifecycleRows("windows").map((name) => ({ name, pi: { bun: "1.3.14" }, status: "passed", aliveBefore: true, aliveAfter: false, peerAlive: true, immediateChecks: 1, ownershipDisabled: true })) };
	assertOwnerLifecycle(evidence, "windows");
	for (const mutate of [
		(value) => { value.identity.elevated = true; },
		(value) => { value.identity.adminGroup = true; },
		(value) => { value.identity.mediumIntegrity = false; },
		(value) => { value.rows.pop(); },
		(value) => { value.rows[0].peerAlive = false; },
		(value) => { value.rows[0].aliveAfter = true; },
		(value) => { value.rows[0].immediateChecks = 2; },
		(value) => { value.rows[0].guardExpired = true; },
	]) {
		const changed = structuredClone(evidence); mutate(changed);
		assert.throws(() => assertOwnerLifecycle(changed, "windows"), /owner lifecycle/);
	}
	assert.throws(() => assertOwnerLifecycle({ ...evidence, identity: passedUnixIdentity() }, "darwin"), /inventory/);
	evidence.identity = passedUnixIdentity(); evidence.target = "darwin-arm64"; evidence.cliSha256 = "d".repeat(64);
	evidence.rows = ownerLifecycleRows("darwin").map((name) => isUnixOwnerPtyRow(name) ? passedUnixOwnerPtyRow(name, "darwin", evidence.target, evidence.cliSha256) : ({ ...evidence.rows[0], name, ...(name === "darwin-fast-escape" ? { aliveAfter: true, status: "known-limitation", limitation: "unseen setsid reparent before sweep" } : {}), piStopped: true, stopped: true, resumed: true, peerRunning: true }));
	assertOwnerLifecycle(evidence, "darwin");
});
