import assert from "node:assert/strict";
import cp from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "./fixtures/owner/extension.mjs";
import { passedUnixIdentity, passedUnixOwnerPtyRow } from "./fixtures/unix-owner-pty.mjs";
import { smokeUnixOwnerPty } from "./smoke-unix-owner-pty.mjs";

const identity = passedUnixIdentity();
const target = { id: "linux-test", os: "linux" };
const digest = createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
const proof = () => passedUnixOwnerPtyRow("suspend-resume", target.os, target.id, digest);
const secret = "/private/secret-token-" + "x".repeat(4096);

function wrapper(result, { name = "suspend-resume", emulated = false, witness, initFailure = false, unsafe = null, concurrent = false } = {}) {
	const work = fs.mkdtempSync(join(tmpdir(), "owner-feedback-"));
	const originalSpawn = cp.spawnSync, originalRead = fs.readFileSync, originalMkdir = fs.mkdirSync;
	const originalStderr = process.stderr.write, originalStdout = process.stdout.write;
	const commands = new Map(["spawn", "exec", "execFile", "execSync", "execFileSync", "fork"].map((key) => [key, cp[key]]));
	for (const key of commands.keys()) cp[key] = () => { throw new Error(`unexpected native execution: ${key}`); };
	const probes = new Map(["existsSync", "statSync", "lstatSync", "readdirSync", "accessSync", "realpathSync"].map((key) => [key, fs[key]]));
	let stderr = "", stdout = "", launches = 0, directories = 0, diagnosticReads = 0;
	const originalOpen = fs.openSync, originalFdRead = fs.readSync, originalFstat = fs.fstatSync, originalClose = fs.closeSync;
	let diagnosticFd;
	const liveFds = new Set();
	const unexpected = [];
	const witnessPath = join(work, "helper-witness");
	const reads = [];
	cp.spawnSync = (_file, args, options) => {
		launches++;
		assert.deepEqual(args.slice(0, 2), ["--run", process.execPath]);
		assert.deepEqual(args.slice(-3), [work, name, String(emulated ? 180_000 : 60_000)]);
		assert.deepEqual(options, { encoding: "utf8", timeout: emulated ? 200_000 : 80_000, maxBuffer: 1024 * 1024 });
		if (witness) {
			fs.writeFileSync(witnessPath, witness, { mode: 0o600 });
			if (unsafe === "mode") fs.chmodSync(witnessPath, 0o644);
			if (unsafe === "link") fs.linkSync(witnessPath, join(work, "other-link"));
			if (["symlink", "directory", "fifo"].includes(unsafe)) {
				fs.renameSync(witnessPath, join(work, "original"));
				if (unsafe === "symlink") fs.symlinkSync(join(work, "original"), witnessPath);
				if (unsafe === "directory") originalMkdir(witnessPath);
				// No native mkfifo command: FIFO type is injected through real fstat below.
				if (unsafe === "fifo") fs.renameSync(join(work, "original"), witnessPath);
			}
		}
		return initFailure ? { ...result, stderr: "[owner-pty] helper-witness-init-failed\n" } : result;
	};
	fs.readFileSync = (path, ...args) => { reads.push(path); return originalRead(path, ...args); };
	fs.mkdirSync = (...args) => { directories++; return originalMkdir(...args); };
	for (const key of probes.keys()) fs[key] = (path, ...args) => {
		if (key === "lstatSync" && [work, witnessPath].includes(path)) return probes.get(key)(path, ...args);
		unexpected.push(key); throw new Error(`new filesystem probe: ${key}`);
	};
	const hashFds = new Set();
	fs.openSync = (path, flags, ...args) => { if (path === process.execPath) { assert.equal(flags, "r"); const fd = originalOpen(path, flags, ...args); hashFds.add(fd); liveFds.add(fd); return fd; } assert.equal(path, witnessPath); assert.equal(launches, 1); diagnosticFd = originalOpen(path, flags, ...args); liveFds.add(diagnosticFd); return diagnosticFd; };
	fs.readSync = (fd, buffer, ...args) => { if (hashFds.has(fd)) return originalFdRead(fd, buffer, ...args); assert.equal(fd, diagnosticFd); diagnosticReads++; assert.ok(diagnosticReads <= 1); assert.equal(buffer.length, 16384); if (unsafe === "read") throw new Error(secret); const length = originalFdRead(fd, buffer, ...args);
		if (concurrent) { const writer = originalOpen(witnessPath, "a"); try { fs.writeSync(writer, "partial"); } finally { originalClose(writer); } }
		return length; };
	fs.fstatSync = (fd, ...args) => { assert.ok(fd === diagnosticFd || hashFds.has(fd)); const meta = originalFstat(fd, ...args);
		if (fd === diagnosticFd && !hashFds.has(fd)) {
			if (unsafe === "uid") meta.uid += 1n;
			if (unsafe === "fifo") meta.isFile = () => false;
			if (unsafe === "metadata") delete meta.mtimeNs;
		}
		return meta; };
	fs.closeSync = (fd) => { assert.ok(fd === diagnosticFd || hashFds.has(fd)); hashFds.delete(fd); liveFds.delete(fd); originalClose(fd); if (fd === diagnosticFd && diagnosticReads > 0 && unsafe === "close") throw new Error(secret); };
	process.stderr.write = (chunk) => { stderr += chunk; return true; };
	process.stdout.write = (chunk) => { stdout += chunk; return true; };
	syncBuiltinESMExports();
	try {
		const row = smokeUnixOwnerPty(process.execPath, { ...target, emulated }, name, work, identity, { harness: process.execPath });
		assert.equal(launches, 1);
		assert.equal(directories, 1);
		assert.ok(reads.length === 1 || reads.length === 2);
		assert.ok(reads.every((path) => path === process.execPath), "only existing executable hash reads");
		assert.equal(stdout, "");
		assert.deepEqual(unexpected, []);
		assert.equal(liveFds.size, 0, "all diagnostic and original hash descriptors close");
		return { row, stderr, reads: reads.length, diagnosticReads };
	} finally {
		cp.spawnSync = originalSpawn; fs.readFileSync = originalRead; fs.mkdirSync = originalMkdir;
		fs.openSync = originalOpen; fs.readSync = originalFdRead; fs.fstatSync = originalFstat; fs.closeSync = originalClose;
		for (const [key, original] of commands) cp[key] = original;
		for (const [key, original] of probes) fs[key] = original;
		process.stderr.write = originalStderr; process.stdout.write = originalStdout;
		syncBuiltinESMExports(); fs.rmSync(work, { recursive: true, force: true });
	}
}

for (const [name, result, category, status, signal, errorCode] of [
	["timeout", { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT", message: secret }, stdout: "", stderr: secret }, "parse", null, "SIGTERM", "ETIMEDOUT"],
	["nonzero", { status: 37, signal: null, stdout: JSON.stringify(proof()), stderr: "" }, "invocation", 37, null, null],
	["signal", { status: null, signal: "SIGKILL", stdout: JSON.stringify(proof()), stderr: "" }, "invocation", null, "SIGKILL", null],
	["malformed-zero", { status: 0, signal: null, stdout: "{broken", stderr: "" }, "parse", 0, null, null],
	["partial-zero", { status: 0, signal: null, stdout: JSON.stringify({ name: "suspend-resume", status: "passed" }), stderr: "" }, "validation", 0, null, null],
	["forged", { status: secret, signal: secret, error: { code: secret, message: secret }, stdout: "", stderr: '[owner-pty] {"status":0,"passed":true}' }, "parse", null, null, null],
]) test(`PTY ${name} stays failed with one bounded stderr diagnostic`, () => {
	const captured = wrapper(result);
	assert.equal(captured.row.status, "failed");
	const lines = captured.stderr.trim().split("\n");
	assert.equal(lines.length, 1);
	assert.ok(lines[0].startsWith("[owner-pty] "));
	assert.deepEqual(JSON.parse(lines[0].slice("[owner-pty] ".length)), { phase: "fixture-return", row: "suspend-resume", category, status, signal, errorCode, helperWitness: { outcome: "unknown", repair: null } });
	assert.ok(Buffer.byteLength(captured.stderr) < 512);
	assert.equal(captured.stderr.includes(secret), false);
	assert.equal(Object.hasOwn(captured.row, "fixtureInvocation"), false, "no acceptance schema additions");
});

test("unknown row names cannot leak and complete valid rows pass without diagnostics or new queries", () => {
	const unknown = wrapper({ status: 1, stdout: "", stderr: secret }, { name: secret });
	assert.equal(unknown.row.status, "failed");
	assert.equal(JSON.parse(unknown.stderr.slice("[owner-pty] ".length)).row, "unknown");
	assert.equal(unknown.stderr.includes(secret), false);
	const valid = proof();
	for (const emulated of [false, true]) {
		const captured = wrapper({ status: 0, signal: null, stdout: JSON.stringify(valid), stderr: "" }, { emulated });
		assert.deepEqual(captured.row, valid);
		assert.equal(captured.stderr, "");
		assert.equal(captured.reads, 2);
	}
});

for (const kind of ["missing", "malformed", "unknown", "valid"]) test(`real spawner ${kind} identity preserves original throw or publish and reports only failures`, async () => {
	const work = fs.mkdtempSync(join(tmpdir(), "spawner-feedback-"));
	const keys = ["PI_OWNER_CASE", "PI_OWNER_PTY_WORK", "PI_OWNER_PTY_SCENARIO", "PI_OWNER_PTY_HARNESS", "PI_OWNER_READY"];
	const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	Object.assign(process.env, { PI_OWNER_CASE: "pty", PI_OWNER_PTY_WORK: work, PI_OWNER_PTY_SCENARIO: "paused-backup-death", PI_OWNER_PTY_HARNESS: "not-executed", PI_OWNER_READY: join(work, "ready") });
	const originalSpawn = cp.spawn, originalRead = fs.readFileSync, originalStderr = process.stderr.write;
	const commands = new Map(["spawnSync", "exec", "execFile", "execSync", "execFileSync", "fork"].map((key) => [key, cp[key]]));
	for (const key of commands.keys()) cp[key] = () => { throw new Error(`unexpected native execution: ${key}`); };
	const probes = new Map(["existsSync", "statSync", "lstatSync", "readdirSync", "accessSync"].map((key) => [key, fs[key]]));
	const children = [], handlers = new Map();
	let stderr = "", reads = 0;
	const missing = Object.assign(new Error(secret), { code: "ENOENT" });
	cp.spawn = (_file, _args, options) => { assert.deepEqual(options, { stdio: "ignore" }); const child = new EventEmitter(); child.pid = 12345; children.push(child); return child; };
	fs.readFileSync = (path) => { reads++; assert.equal(path, join(work, "spawner")); if (["missing", "unknown"].includes(kind)) throw missing; return kind === "valid" ? '{"birth":"fixture-birth"}' : "{broken"; };
	for (const key of probes.keys()) fs[key] = () => { throw new Error(`new filesystem probe: ${key}`); };
	process.stderr.write = (chunk) => { stderr += chunk; return true; };
	syncBuiltinESMExports();
	try {
		await extension({ on: (name, callback) => handlers.set(name, callback), exec: async () => ({}) });
		handlers.get("session_start")({}, {});
		assert.equal(children.length, 2);
		const code = kind === "unknown" ? undefined : kind === "valid" ? 0 : 37;
		const signal = kind === "unknown" ? secret : kind === "valid" ? null : "SIGTERM";
		if (kind === "valid") {
			children[1].emit("exit", code, signal);
			assert.equal(stderr, "");
			assert.deepEqual(JSON.parse(originalRead(join(work, "spawner-exit"), "utf8")), { pid: 12345, birth: "fixture-birth", code: 0, signal: null });
		} else {
			assert.throws(() => children[1].emit("exit", code, signal), (error) => {
				if (kind !== "malformed") assert.equal(error, missing, "rethrow same original object");
				else assert.ok(error instanceof SyntaxError);
				assert.ok(stderr, "diagnostic precedes propagation");
				return true;
			});
			const lines = stderr.trim().split("\n"); assert.equal(lines.length, 1);
			assert.ok(lines[0].startsWith("[owner-pty] "));
			assert.deepEqual(JSON.parse(lines[0].slice("[owner-pty] ".length)), { phase: "spawner-exit", category: kind === "malformed" ? "identity-parse" : "identity-read", code: kind === "unknown" ? null : 37, signal: kind === "unknown" ? null : "SIGTERM" });
			assert.ok(Buffer.byteLength(stderr) < 512); assert.equal(stderr.includes(secret), false);
			assert.throws(() => originalRead(join(work, "spawner-exit")), { code: "ENOENT" });
		}
		assert.equal(reads, 1, "exactly original identity read");
	} finally {
		cp.spawn = originalSpawn; fs.readFileSync = originalRead; process.stderr.write = originalStderr;
		for (const [key, original] of commands) cp[key] = original;
		for (const [key, original] of probes) fs[key] = original;
		syncBuiltinESMExports();
		for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
		fs.rmSync(work, { recursive: true, force: true });
	}
});

// Captured from witness_emit_production_errors; focused cross-language runs use fresh Rust output.
const producerFixtures = {
	"grandchild-spawn": "owner-helper-v1 suspend-resume\nadoption-spawner grandchild-spawn begin 1 11993 none -\nadoption-spawner grandchild-spawn error 2 22132 native-error ENOENT\n",
	"snapshot": "owner-helper-v1 suspend-resume\nadoption-spawner grandchild-spawn begin 1 3898 none -\nadoption-spawner grandchild-spawn completed 2 9278 none -\nadoption-spawner snapshot begin 3 14007 none -\nadoption-spawner snapshot error 4 18686 operation-error -\n",
	"pin": "owner-helper-v1 suspend-resume\nadoption-spawner grandchild-spawn begin 1 3807 none -\nadoption-spawner grandchild-spawn completed 2 8656 none -\nadoption-spawner snapshot begin 3 13335 none -\nadoption-spawner snapshot completed 4 18034 none -\nadoption-spawner pin begin 5 22833 none -\nadoption-spawner pin error 6 27552 operation-error -\n",
	"publish": "owner-helper-v1 suspend-resume\nadoption-spawner grandchild-spawn begin 1 3657 none -\nadoption-spawner grandchild-spawn completed 2 8305 none -\nadoption-spawner snapshot begin 3 12934 none -\nadoption-spawner snapshot completed 4 17763 none -\nadoption-spawner pin begin 5 22372 none -\nadoption-spawner pin completed 6 26900 none -\nadoption-spawner publish begin 7 31459 none -\nadoption-spawner publish error 8 35988 operation-error -\n"
};
const producerDir = process.env.PI_OWNER_WITNESS_TEST_DIR;
test("same outer timeout selects distinct repairs only from real Rust operation errors", () => {
	const result = { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
	for (const [operation, repair] of [["grandchild-spawn", "ci-child-launch-setup"], ["snapshot", "ci-native-query-error"], ["pin", "ci-identity-sampling"], ["publish", "ci-file-publication"]]) {
		const witness = producerDir ? fs.readFileSync(join(producerDir, operation, "helper-witness")) : Buffer.from(producerFixtures[operation]);
		const captured = wrapper(result, { witness });
		assert.equal(captured.row.status, "failed");
		assert.equal(captured.diagnosticReads, 1);
		assert.ok(Buffer.byteLength(captured.stderr) < 512);
		assert.deepEqual(JSON.parse(captured.stderr.slice("[owner-pty] ".length)).helperWitness, { outcome: "operation-error", operation, repair, clock: "native-process-local" });
		for (const unsafe of ["mode", "link", "symlink", "directory", "fifo", "uid", "read", "close", "metadata"]) {
			assert.deepEqual(JSON.parse(wrapper(result, { witness, unsafe }).stderr.slice("[owner-pty] ".length)).helperWitness, { outcome: "unknown", repair: null });
		}
		assert.deepEqual(JSON.parse(wrapper(result, { witness, concurrent: true }).stderr.slice("[owner-pty] ".length)).helperWitness, { outcome: "unknown", repair: null });
		for (const broken of [Buffer.from("owner-helper-v1 suspend-resume\n"), Buffer.from(witness.toString().split("\n").slice(0, -2).join("\n") + "\n"), witness.subarray(0, -1), Buffer.concat([witness, Buffer.from("partial")]), Buffer.from(witness.toString().replace("suspend-resume", "paused-outer-death")), Buffer.from(witness.toString().replace(" begin 1 ", " begin 7 ")), Buffer.alloc(16385, 120)]) {
			assert.deepEqual(JSON.parse(wrapper(result, { witness: broken }).stderr.slice("[owner-pty] ".length)).helperWitness, { outcome: "unknown", repair: null });
		}
		const stale = wrapper({ ...result, status: 1, signal: null, error: undefined }, { witness, initFailure: true });
		assert.equal(stale.row.status, "failed"); assert.equal(stale.diagnosticReads, 0);
		assert.deepEqual(JSON.parse(stale.stderr.slice("[owner-pty] ".length)).helperWitness, { outcome: "unknown", repair: null });
	}
});
