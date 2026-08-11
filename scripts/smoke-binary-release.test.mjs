import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const target = "linux-x64-gnu-baseline";
const bunAvailable = spawnSync("bun", ["--version"]).status === 0;
const smokeScript = readFileSync(join(import.meta.dirname, "smoke-binary-release.mjs"), "utf8");

test("command runtime timeout defaults to the authoritative performance limit", () => {
	assert.match(smokeScript, /timeout: options\.timeout \?\? options\.maxMs \?\? 10_000/);
});

test("Windows extraction passes absolute paths through environment variables with a bounded archive budget", () => {
	assert.match(smokeScript, /PI_XZ_ARCHIVE: archive, PI_XZ_EXTRACT_DIR: work/);
	assert.match(smokeScript, /Expand-Archive -LiteralPath \$env:PI_XZ_ARCHIVE -DestinationPath \$env:PI_XZ_EXTRACT_DIR -Force/);
	assert.match(smokeScript, /PI_XZ_EXTRACT_DIR: work \}, timeout: 60_000/);
	assert.doesNotMatch(smokeScript, /Expand-Archive[^\n]*\$args/);
});

test("native TUI smoke scopes the Windows benchmark lifecycle to the TUI child", () => {
	assert.match(smokeScript, /const env = \{ \.\.\.process\.env, NODE_ENV: "production", PI_OFFLINE: "1", PI_CODING_AGENT_DIR/);
	assert.doesNotMatch(smokeScript.match(/const env = [^;]+/)?.[0] ?? "", /PI_STARTUP_BENCHMARK/);
	assert.match(smokeScript, /const tuiEnv = target\.os === "windows" \? \{ \.\.\.env, PI_STARTUP_BENCHMARK: "1" \} : env/);
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
		const result = spawnSync("bun", [join(import.meta.dirname, "smoke-bun-tui.mjs"), executable], { encoding: "utf8", env: { ...process.env, PI_STARTUP_BENCHMARK: "1" }, timeout: 9_000 });
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		assert.notEqual(result.status, 0);
		assert.match(output, /lastStage=null tail="(?:\\u001b){100,}\\r\\ntail-line\\r\\n"/);
		assert.doesNotMatch(output, /discard-me/);
		assert.ok(Buffer.byteLength(output) < 5_000);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("external TUI evidence contributes the authoritative pseudoterminal command", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-external-tui-"));
	try {
		const stage = join(root, "stage"); mkdirSync(join(stage, "node_modules", "@mariozechner", "clipboard"), { recursive: true });
		const pi = join(stage, "pi"); writeFileSync(pi, "#!/bin/sh\ncase \"$1\" in --version) echo 1.2.3;; --help) echo Usage: pi;; --list-models) echo model;; *) exit 1;; esac\n"); chmodSync(pi, 0o755);
		writeFileSync(join(stage, "node_modules", "@mariozechner", "clipboard", "package.json"), JSON.stringify({ name: "@mariozechner/clipboard", version: "1.0.0", license: "MIT" }));
		writeFileSync(join(stage, "node_modules", "@mariozechner", "clipboard", "LICENSE"), "fixture clipboard license\n");
		writeFileSync(join(stage, "node_modules", "@mariozechner", "clipboard", "clipboard.linux-x64-gnu.node"), "native");
		const lockPath = join(root, "package-lock.json");
		writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages: { "packages/coding-agent": { name: "@earendil-works/pi-coding-agent", dependencies: { fixture: "1.0.0" } }, "node_modules/fixture": { version: "1.0.0", license: "MIT" } } }));
		execFileSync(process.execPath, [join(import.meta.dirname, "generate-third-party-notices.mjs"), stage, join(stage, "THIRD_PARTY_NOTICES.md"), lockPath]);
		const notices = readFileSync(join(stage, "THIRD_PARTY_NOTICES.md"), "utf8");
		assert.match(notices, /## node_modules\/@mariozechner\/clipboard@1\.0\.0/);
		assert.match(notices, /### LICENSE\nLicense SHA-256: [0-9a-f]{64}/);
		const archive = join(root, "pi-linux-x64-gnu-baseline.zip"); execFileSync("zip", ["-qr", archive, "."], { cwd: stage });
		const bin = join(root, "bin"); mkdirSync(bin); const bun = join(bin, "bun"); writeFileSync(bun, "#!/bin/sh\nexit 0\n"); chmodSync(bun, 0o755);
		const evidence = join(root, "tui.json"); writeFileSync(evidence, JSON.stringify({ harness: "Bun.Terminal PTY", elapsedMs: 37, outputBytes: 42, input: "ctrl-c,ctrl-d", childExitCode: 0, terminalClosed: true, terminalExitCode: 1, observedOutput: true, benchmarkCompleted: null, exitSent: true, cleanExit: true }));
		const recordPath = join(root, "record.json");
		execFileSync(process.execPath, [join(import.meta.dirname, "smoke-binary-release.mjs"), archive, target, "1.2.3", recordPath], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_XZ_TUI_EVIDENCE: evidence, RUNNER_OS: "Linux", RUNNER_ARCH: "X64" } });
		const record = JSON.parse(readFileSync(recordPath, "utf8"));
		assert.deepEqual(record.commands.map(({ name }) => name), ["extract", "measure-extracted-size", "cold-version", "version", "help", "list-models", "clipboard", "tui-pseudoterminal"]);
		assert.deepEqual(record.commands.at(-1), { name: "tui-pseudoterminal", command: `external:${evidence}`, status: 0, elapsedMs: 37 });
		assert.ok(Number.isSafeInteger(record.timingsMs.coldVersion));
		assert.ok(Number.isSafeInteger(record.timingsMs.version));
		assert.equal(record.timingsMs.interactive, 37);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
