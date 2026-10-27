import assert from "node:assert/strict";
import cp from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "./fixtures/owner/extension.mjs";
import { passedUnixIdentity, passedUnixOwnerPtyRow } from "./fixtures/unix-owner-pty.mjs";
import { smokeUnixOwnerPty, unixOwnerFaultRows } from "./smoke-unix-owner-pty.mjs";

const identity = passedUnixIdentity();
const target = { id: "linux-test", os: "linux" };
const digest = createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
const proof = () => passedUnixOwnerPtyRow("suspend-resume", target.os, target.id, digest);
const secret = "/private/secret-token-" + "x".repeat(4096);

function wrapper(result, { name = "suspend-resume", os = target.os, emulated = false, witness, initFailure = false, unsafe = null, concurrent = false } = {}) {
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
		return unsafe === "short" ? length - 1 : length; };
	fs.fstatSync = (fd, ...args) => { assert.ok(fd === diagnosticFd || hashFds.has(fd)); const meta = originalFstat(fd, ...args);
		if (fd === diagnosticFd && !hashFds.has(fd)) {
			if (unsafe === "uid") meta.uid += 1n;
			if (unsafe === "fifo") meta.isFile = () => false;
			if (unsafe === "post-read" && diagnosticReads > 0) meta.ino += 1n;
			if (unsafe === "metadata") delete meta.mtimeNs;
		}
		return meta; };
	fs.closeSync = (fd) => { assert.ok(fd === diagnosticFd || hashFds.has(fd)); hashFds.delete(fd); liveFds.delete(fd); originalClose(fd); if (fd === diagnosticFd && diagnosticReads > 0 && unsafe === "close") throw new Error(secret); };
	process.stderr.write = (chunk) => { stderr += chunk; return true; };
	process.stdout.write = (chunk) => { stdout += chunk; return true; };
	syncBuiltinESMExports();
	try {
		const row = smokeUnixOwnerPty(process.execPath, { ...target, os, emulated }, name, work, identity, { harness: process.execPath });
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
		syncBuiltinESMExports();
		try {
			if (witness && unsafe !== "directory") assert.deepEqual(fs.readFileSync(witnessPath), concurrent ? Buffer.concat([Buffer.from(witness), Buffer.from("partial")]) : Buffer.from(witness), "diagnostics never modify witness bytes");
		} finally { fs.rmSync(work, { recursive: true, force: true }); }
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
	const { helperWitnessSnapshot, stderrTail, ...facts } = JSON.parse(lines[0].slice("[owner-pty] ".length));
	assert.deepEqual(facts, { phase: "fixture-return", row: "suspend-resume", category, status, signal, errorCode, helperWitness: { outcome: "unknown", repair: null } });
	assert.equal(helperWitnessSnapshot, undefined);
	assert.ok(stderrTail === undefined || Buffer.byteLength(stderrTail) <= 512);
	assert.ok(Buffer.byteLength(captured.stderr) <= 4096);
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
		assert.ok(Buffer.byteLength(captured.stderr) <= 4096);
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

const cleanupName = "paused-carrier-guardian-death-shutdown-blocked";
const helperPrefix = `owner-helper-v1 ${cleanupName}\n` + ["grandchild-spawn", "snapshot", "pin", "publish"].flatMap((operation, index) => [`adoption-spawner ${operation} begin ${index * 2 + 1} ${index * 2000 + 1000} none -`, `adoption-spawner ${operation} completed ${index * 2 + 2} ${index * 2000 + 2000} none -`]).join("\n") + "\n";
const cleanupFixtures = {
 "held-fault-delivery": helperPrefix + "cleanup-session-v2 begin 0\ncleanup-session-v2 fault 1 1000000 2000000 ok\ncleanup-session-v2 fault 2 2000000 8395000000 ok\ncleanup-session-v2 timeout 8396000000\n",
 "complete-inventory": helperPrefix + "cleanup-session-v2 begin 0\ncleanup-session-v2 fault 1 0 1000000 ok\ncleanup-session-v2 fault 2 1000000 2000000 ok\ncleanup-session-v2 inventory 1 7991000000 8396000000 ok\ncleanup-session-v2 decision 1 8396000000 all eligible-absence -\ncleanup-session-v2 timeout 8396000000\n",
};
const cleanupDir = process.env.PI_OWNER_CLEANUP_TEST_DIR;
test("v2 cleanup retains existing interval facts and actual first return without acceptance credit", () => {
 const failedRow={name:cleanupName,status:"failed",error:"owned teardown exceeded 8s (stopped processes count as alive)",teardownFailureMs:8396};
 const result={status:1,signal:null,stdout:JSON.stringify(failedRow),stderr:""};
 const helper=(captured)=>JSON.parse(captured.stderr.slice("[owner-pty] ".length)).helperWitness;
 const unknown={outcome:"unknown",repair:null};
 for(const [operation,repair] of [["held-fault-delivery","ci-held-fault-delivery"],["complete-inventory","ci-owned-observation"]]) {
  const witness=cleanupDir?fs.readFileSync(join(cleanupDir,operation,"helper-witness")):Buffer.from(cleanupFixtures[operation]);
  const captured=wrapper(result,{name:cleanupName,witness});const diagnostic=helper(captured);
  assert.equal(captured.row.status,"failed");assert.equal(captured.diagnosticReads,1);assert.ok(Buffer.byteLength(captured.stderr)<4096);
  assert.equal(diagnostic.outcome,"cleanup-cost");assert.equal(diagnostic.operation,operation);assert.equal(diagnostic.repair,repair);assert.equal(diagnostic.clock,"native-session-local");assert.equal(diagnostic.timeoutNs,8396000000);
  assert.equal(diagnostic.intervals.filter(({kind})=>kind==="fault").length,2);
  if(operation==="complete-inventory") assert.deepEqual(diagnostic.intervals.at(-1),{kind:"inventory",ordinal:1,beginNs:7991000000,endNs:8396000000,result:"ok",firstReturn:{inventoryOrdinal:1,atNs:8396000000,role:"all",reason:"eligible-absence",error:"-"}});
  const text=witness.toString();
  for(const unsafe of ["mode","link","symlink","directory","fifo","uid","read","close","metadata"])assert.deepEqual(helper(wrapper(result,{name:cleanupName,witness,unsafe})),unknown);
  assert.deepEqual(helper(wrapper(result,{name:cleanupName,witness,concurrent:true})),unknown);
  const stale=wrapper(result,{name:cleanupName,witness,initFailure:true});assert.equal(stale.diagnosticReads,0);assert.deepEqual(helper(stale),unknown);
  for(const broken of [text.replaceAll("cleanup-session-v2","cleanup-session-v1"),text.replace("timeout 8396000000","timeout 7999999999"),text.replace("fault 1 ","fault 2 "),text.replace("fault 1 ","fault -1 "),text.replace("fault 1 ","fault NaN "),text.replace("timeout 8396000000","timeout 9007199254740992"),text+"cleanup-session-v2 timeout 8396000000\n",text.replace("begin 0\ncleanup-session-v2", "begin 1\ncleanup-session-v2")])assert.deepEqual(helper(wrapper(result,{name:cleanupName,witness:Buffer.from(broken)})),unknown);
 }
 const text=cleanupFixtures["complete-inventory"];
 for(const role of ["carrier","outer","backup","guardian","pi","observer","anchor","extensionChild","adoptedGrandchild"])assert.equal(helper(wrapper(result,{name:cleanupName,witness:Buffer.from(text.replace("all eligible-absence -",`${role} critical-presence -`))})).repair,"ci-owned-observation");
 for(const role of ["payload","leaf","taskOuter","taskGuardian"])assert.deepEqual(helper(wrapper(result,{name:cleanupName,witness:Buffer.from(text.replace("all eligible-absence -",`${role} critical-presence -`))})),unknown);
 for(const broken of [text.replace(/^cleanup-session-v2 decision.*\n/m,""),text.replace(/^(cleanup-session-v2 decision.*\n)/m,"$1$1"),text.replace("decision 1 ","decision 2 "),text.replace("decision 1 8396000000","decision 1 7991000000"),text.replace("decision 1 8396000000","decision 1 8396000001"),text.replace("all eligible-absence -","secret eligible-absence -"),text.replace("all eligible-absence -","all runnable -"),text.replace("all eligible-absence -","all eligible-absence EACCES"),text.replace("decision 1 8396000000","decision 1 Infinity")])assert.deepEqual(helper(wrapper(result,{name:cleanupName,witness:Buffer.from(broken)})),unknown);
 const lateFact=text.replace("inventory 1 7991000000 8396000000","inventory 1 7991000000 7992000000").replace("all eligible-absence -","anchor same-birth-non-z -");
 const late=helper(wrapper(result,{name:cleanupName,witness:Buffer.from(lateFact)}));assert.equal(late.outcome,"unknown");assert.equal(late.repair,null);assert.equal(late.intervals.at(-1).firstReturn.atNs,8396000000);
});

const retainedFailure = { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
const diagnostic = (captured) => JSON.parse(captured.stderr.slice("[owner-pty] ".length));
test("bounded retention distinguishes whole secure bytes without promoting unknown helper facts", () => {
	const header = "owner-helper-v1 suspend-resume\n";
	const complete = header + ["grandchild-spawn", "snapshot", "pin", "publish"].flatMap((operation, index) => [`adoption-spawner ${operation} begin ${index * 2 + 1} ${index * 2} none -\n`, `adoption-spawner ${operation} completed ${index * 2 + 2} ${index * 2 + 1} none -\n`]).join("");
	const inputs = [Buffer.from(header), Buffer.from(header + "adoption-spawner grandchild-spawn begin 1 0 none -\n"), Buffer.from(complete), Buffer.from([0, 255, 128, 27, 10])];
	assert.deepEqual(inputs.slice(0, 3).map((bytes) => bytes.length), [31, 82, 395]);
	for (const witness of inputs) {
		const captured = wrapper(retainedFailure, { witness });
		const event = diagnostic(captured);
		assert.deepEqual(event.helperWitness, { outcome: "unknown", repair: null });
		assert.deepEqual(event.helperWitnessSnapshot, { byteLength: witness.length, base64: witness.toString("base64") });
		assert.deepEqual(Buffer.from(event.helperWitnessSnapshot.base64, "base64"), witness);
		assert.equal(captured.diagnosticReads, 1);
		assert.equal(captured.row.status, "failed");
		assert.equal(Object.hasOwn(captured.row, "helperWitnessSnapshot"), false);
		assert.ok(Buffer.byteLength(captured.stderr) <= 4096);
	}
});

test("bounded retention honors snapshot1024, native16KiB and secure single-read boundaries", () => {
	for (const length of [1024, 1025, 16384, 16385]) {
		const witness = Buffer.alloc(length, 255);
		const captured = wrapper(retainedFailure, { witness });
		const event = diagnostic(captured);
		assert.deepEqual(event.helperWitness, { outcome: "unknown", repair: null });
		assert.equal(captured.diagnosticReads, length <= 16384 ? 1 : 0);
		assert.deepEqual(event.helperWitnessSnapshot, length <= 1024 ? { byteLength: length, base64: witness.toString("base64") } : undefined);
	}
	const witness = Buffer.from("owner-helper-v1 suspend-resume\n");
	for (const unsafe of ["mode", "link", "symlink", "directory", "fifo", "uid", "read", "close", "metadata", "short", "post-read"]) {
		const captured = wrapper(retainedFailure, { witness, unsafe });
		assert.deepEqual(diagnostic(captured).helperWitness, { outcome: "unknown", repair: null });
		assert.equal(diagnostic(captured).helperWitnessSnapshot, undefined, unsafe);
		assert.equal(captured.diagnosticReads, ["mode", "link", "symlink", "directory", "fifo", "uid", "metadata"].includes(unsafe) ? 0 : 1, unsafe);
	}
	const changed = wrapper(retainedFailure, { witness, concurrent: true });
	assert.equal(changed.diagnosticReads, 1);
	assert.equal(diagnostic(changed).helperWitnessSnapshot, undefined);
	const init = wrapper(retainedFailure, { witness, initFailure: true });
	assert.equal(init.diagnosticReads, 0);
	assert.equal(diagnostic(init).helperWitnessSnapshot, undefined);
});

test("bounded retention JSON-encodes captured stderr with UTF8 and whole-event caps", () => {
	for (const stderr of ["é".repeat(300), "€".repeat(300), "😀".repeat(300), "\u001b[31m\n".repeat(100)]) {
		const captured = wrapper({ ...retainedFailure, stderr });
		const event = diagnostic(captured);
		assert.ok(event.stderrTail.length > 0);
		assert.ok(Buffer.byteLength(event.stderrTail) <= 512);
		assert.ok(stderr.endsWith(event.stderrTail));
		assert.equal(event.stderrTail.includes("�"), false);
		assert.equal(captured.stderr.split("\n").length, 2, "escaped bytes stay inside one JSON line");
		assert.ok(Buffer.byteLength(captured.stderr) <= 4096);
		assert.match(captured.row.error, /PTY fixture missing evidence/);
	}
	const witness = Buffer.alloc(1024, 255);
	const captured = wrapper({ ...retainedFailure, stderr: "\0".repeat(512) }, { witness });
	const event = diagnostic(captured);
	assert.deepEqual(event.helperWitnessSnapshot, { byteLength: 1024, base64: witness.toString("base64") });
	assert.equal(event.stderrTail, undefined, "omit whole addition when escaped JSON would exceed4096");
	assert.deepEqual(event.helperWitness, { outcome: "unknown", repair: null });
	assert.ok(Buffer.byteLength(captured.stderr) <= 4096);
});

const sessionProducerDir = process.env.PI_OWNER_SESSION_TEST_DIR;
test("actual session producer survives secure failure-event transport at pre-return and result boundaries", { skip: sessionProducerDir ? false : "requires current Rust session_progress_transport producer" }, () => {
	const seen = [], emitted = [];
	for (const [label, stage] of [["entered", 3], ["returned", 8], ["published", 10], ["completed", 11]]) {
		const witness = fs.readFileSync(join(sessionProducerDir, label, "helper-witness"));
		const captured = wrapper(retainedFailure, { witness });
		const event = diagnostic(captured);
		emitted.push({ label, event, line: captured.stderr });
		assert.equal(captured.row.status, "failed");
		assert.deepEqual(event.helperWitness, { outcome: "unknown", repair: null });
		assert.equal(captured.diagnosticReads, 1);
		assert.equal(event.status, null); assert.equal(event.signal, "SIGTERM"); assert.equal(event.errorCode, "ETIMEDOUT");
		assert.equal(event.row, "suspend-resume");
		const progress = Buffer.from(event.sessionProgress.base64, "base64");
		assert.equal(progress.length, event.sessionProgress.byteLength);
		assert.ok(progress.length <= 1024);
		const fields = progress.toString().trim().split("\n").at(-1).split(" ");
		assert.equal(Number(fields[2]), stage);
		seen.push(fields[2]);
		assert.ok(Buffer.byteLength(captured.stderr) <= 4096);
		assert.equal(Object.hasOwn(captured.row, "sessionProgress"), false);
		for (const unsafe of ["mode", "uid", "short", "post-read", "close"]) {
			assert.equal(diagnostic(wrapper(retainedFailure, { witness, unsafe })).sessionProgress, undefined);
		}
		assert.equal(diagnostic(wrapper(retainedFailure, { witness, initFailure: true })).sessionProgress, undefined);
		for (const bad of [Buffer.concat([witness, progress.subarray(progress.indexOf(10) + 1)]), Buffer.from(witness.toString().replace(/session-v1 1 1 /, "session-v1 2 1 ")), witness.subarray(0, -1), Buffer.from(witness.toString().replace("session-v1 3 3 2 b", "session-v1 3 3 0 b")), Buffer.from(witness.toString().replace("session-v1 1 1 0 b", "session-v1 1 1 18446744073709551616 b")), Buffer.from(witness.toString().replace("owner-helper-v1 suspend-resume", "owner-helper-v1 paused-guardian-death"))]) {
			const invalid = diagnostic(wrapper(retainedFailure, { witness: bad }));
			assert.equal(invalid.sessionProgress, undefined);
			assert.deepEqual(invalid.helperWitness, { outcome: "unknown", repair: null });
		}
	}
	assert.equal(new Set(seen).size, 4);
	fs.writeFileSync(join(sessionProducerDir, "events.json"), JSON.stringify(emitted));
});

test("required session discriminator fits worst-case helper/v2 and complete event budgets", { skip: sessionProducerDir ? false : "requires current Rust session_progress_transport producer" }, () => {
	const actual = fs.readFileSync(join(sessionProducerDir, "bounds", "helper-witness"), "ascii");
	const max = "9007199254740991";
	const cleanup = "cleanup-session-v2 begin 0\n" + [1, 2].map((n) => `cleanup-session-v2 fault ${n} ${max} ${max} ok\n`).join("") + ["9007199254740990", max].map((n) => `cleanup-session-v2 inventory ${n} ${max} ${max} ok\ncleanup-session-v2 decision ${n} ${max} adoptedGrandchild disappearing-birth ENOENT\n`).join("") + `cleanup-session-v2 timeout ${max}\n`;
	let largestRaw = 0, largestProgress = 0, largestEvent = 0;
	for (const name of new Set(["suspend-resume", ...unixOwnerFaultRows("linux"), ...unixOwnerFaultRows("darwin")])) {
		const text = actual.split("\n").map((line, index) => {
			if (index === 0) return `owner-helper-v1 ${name}`;
			if (line.startsWith("adoption-spawner ")) { const fields = line.split(" "); fields[4] = "18446744073709551615"; return fields.join(" "); }
			return line;
		}).join("\n");
		const variants = [text, text + cleanup];
		for (let operation = 0; operation < 4; operation++) for (const category of ["native-error", "operation-error"]) {
			variants.push(text.split("\n").flatMap((line) => {
				if (!line.startsWith("adoption-spawner ")) return [line];
				const fields = line.split(" "), ordinal = Number(fields[3]);
				if (ordinal > operation * 2 + 2) return [];
				if (ordinal === operation * 2 + 2) { fields[2] = "error"; fields[5] = category; fields[6] = category === "native-error" ? "ENOEXEC" : "-"; }
				return [fields.join(" ")];
			}).join("\n"));
		}
		for (const variant of variants) {
			const witness = Buffer.from(variant);
			const signal = Object.keys(osConstants.signals).sort((a, b) => b.length - a.length)[0];
			const code = Object.keys(osConstants.errno).sort((a, b) => b.length - a.length)[0];
			const captured = wrapper({ ...retainedFailure, signal, error: { code }, stdout: JSON.stringify({ name, status: "passed" }), stderr: "\0".repeat(512) }, { name, os: name === "paused-observer-death" ? "darwin" : "linux", witness });
			const event = diagnostic(captured);
			assert.ok(event.sessionProgress, name);
			assert.equal(captured.diagnosticReads, 1);
			assert.ok(event.sessionProgress.byteLength <= 1024);
			assert.ok(Buffer.byteLength(captured.stderr) <= 4096);
			if (witness.length > 1024) assert.equal(event.helperWitnessSnapshot, undefined);
			assert.ok(["unknown", "operation-error"].includes(event.helperWitness.outcome));
			assert.equal(event.row, name);
			largestRaw = Math.max(largestRaw, witness.length);
			largestProgress = Math.max(largestProgress, event.sessionProgress.byteLength);
			largestEvent = Math.max(largestEvent, Buffer.byteLength(captured.stderr));
		}
	}
	assert.ok(largestRaw > 1024 && largestRaw < 16384, "projection necessary, never cap growth");
	assert.ok(largestProgress <= 1024 && largestEvent <= 4096);
	console.log(JSON.stringify({ sessionBudget: { largestRaw, largestProgress, largestEvent, clock: "u64::MAX", cleanupClock: max } }));
});

test("session progress never repairs invalid v2 or changes valid v2 selector facts", { skip: sessionProducerDir ? false : "requires current Rust session_progress_transport producer" }, () => {
	const bytes = fs.readFileSync(join(sessionProducerDir, "completed", "helper-witness"), "ascii");
	const records = bytes.split("\n").filter((line) => line.startsWith("session-v1 ")).join("\n") + "\n";
	for (const witness of Object.values(cleanupFixtures)) {
		const baseline = diagnostic(wrapper(retainedFailure, { name: cleanupName, witness: Buffer.from(witness) })).helperWitness;
		const event = diagnostic(wrapper(retainedFailure, { name: cleanupName, witness: Buffer.from(witness + records) }));
		assert.ok(event.sessionProgress);
		assert.deepEqual(event.helperWitness, baseline);
		const invalid = diagnostic(wrapper(retainedFailure, { name: cleanupName, witness: Buffer.from(witness.replace("cleanup-session-v2 begin 0", "cleanup-session-v2 begin 1") + records) }));
		assert.deepEqual(invalid.helperWitness, { outcome: "unknown", repair: null });
	}
});
