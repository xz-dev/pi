import assert from "node:assert/strict";
import cp, { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs, { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { bunTarget } from "./lib/bun-targets.mjs";
import { isUnixOwnerPtyRow, unixOwnerFaultRows } from "./smoke-unix-owner-pty.mjs";
import { passedUnixIdentity, passedUnixOwnerPtyRow } from "./fixtures/unix-owner-pty.mjs";
import { passedWindowsOwnerGate } from "./fixtures/windows-owner-gate.mjs";
import { windowsOwnerGateDependencies } from "./smoke-windows-owner-gate.mjs";
import { artifactBunFromOwnerRows, assertOwnerLifecycle, ownerLifecycleRows, ownerPrivilegeDropRequired, smokeOwnerLifecycle, smokeOwnerLifecycleAsNonadmin } from "./smoke-owner-lifecycle.mjs";

const standard = { ...passedUnixIdentity(), name: "host\\pi-owner-smoke", mediumIntegrity: true };
const root = { uid: 0, euid: 0, elevated: true };
const cliSha256 = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
const rowsFor = (os, target = "fixture-target") => ownerLifecycleRows(os).map((name) => isUnixOwnerPtyRow(name) ? passedUnixOwnerPtyRow(name, os, target, cliSha256) : ({ name, pi: { bun: "1.3.14" }, status: name === "darwin-fast-escape" ? "known-limitation" : "passed", ...(name === "darwin-fast-escape" ? { limitation: "25ms sweep" } : {}), aliveBefore: true, aliveAfter: false, peerAlive: true, immediateChecks: 1, piStopped: true, stopped: true, resumed: true, peerRunning: true, ownershipDisabled: true }));

// Host commands are mocked; copied scripts, runtime and artifact use real temporary files.
async function dropped(platform, { childIdentity = standard, hostIdentity, childError, childStatus, childResult, fileMutation, onCommand, failCommand, existing = false, cleanupFailure = false, silentChild = false, fileChild = false } = {}) {
	const temp = mkdtempSync(join(tmpdir(), "pi-owner-drop-test-"));
	const displacements = [];
	mkdirSync(join(temp, "Temp"));
	const calls = [];
	// Generic privilege/held-FD cases use GNU; musl prerequisite transport has its own launch-seam suite.
	const target = bunTarget(platform === "freebsd" ? "freebsd-x64" : platform === "darwin" ? "darwin-arm64" : platform === "win32" ? "windows-x64-baseline" : "linux-x64-gnu-baseline");
	const childRows = rowsFor(target.os, target.id);
	if (childError) { childRows[0].aliveAfter = true; childRows[0].status = "failed"; }
	if (fileChild) Object.assign(childRows.find(({ name }) => name === "suspend-resume"), { status: "failed", error: childError, outputTail: `pty-start-${"native PTY output\n".repeat(1024)}-pty-end` });
	const child = { target: target.id, cliSha256, status: childError ? "failed" : "passed", identity: childIdentity, rows: childRows, ...artifactBunFromOwnerRows(childRows), ...(childError ? { error: childError } : {}) };
	if (platform === "win32") child.windowsRuntimeGate = passedWindowsOwnerGate(target.id, createHash("sha256").update(readFileSync(process.execPath)).digest("hex"), standard);
	try {
		const evidence = await smokeOwnerLifecycleAsNonadmin(process.execPath, target, {
			platform, env: { CI: "true", PI_OWNER_PTY_HARNESS: process.execPath, SystemRoot: temp, SystemDrive: temp, COMPUTERNAME: "host" },
			identityProbe: () => hostIdentity ?? (platform === "darwin" ? { ...standard, adminGroup: true } : root),
			run: (file, args, options) => {
				calls.push({ file, args, options });
				onCommand?.(file, args, options);
				if (file === process.execPath && args.includes("install")) {
					const work = args[args.indexOf("--prefix") + 1];
					const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
					const dependencies = windowsOwnerGateDependencies(lock);
					writeFileSync(join(work, "package-lock.json"), JSON.stringify({ packages: Object.fromEntries(dependencies.map(({ name }) => [`node_modules/${name}`, lock.packages[`node_modules/${name}`]])) }));
					return { status: 0, stdout: "", stderr: "" };
				}
				if (file === process.execPath && args.includes("ls")) {
					const dependencies = windowsOwnerGateDependencies(JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")));
					return { status: 0, stdout: JSON.stringify({ dependencies: Object.fromEntries(dependencies.map((entry) => [entry.name, entry])) }), stderr: "" };
				}
				if (file === "bun") return { status: 0, stdout: args[0] === "--version" ? "1.3.14\n" : `${process.execPath}\n`, stderr: "" };
				if (file === "sudo" && args.includes("rm")) {
					if (lstatSync(args.at(-1)).isDirectory()) chmodSync(args.at(-1), 0o700);
					rmSync(args.at(-1), { recursive: true, force: true });
				}
				if (file === "sudo" && args.includes("chmod")) chmodSync(args.at(-1), 0o710);
				if (file === "id" || (file === "net.exe" && args.length === 2)) return { status: existing ? 0 : platform === "win32" ? 2 : 1, stdout: "", stderr: "" };
				if (file === failCommand) return { status: 1, stderr: "provision denied" };
				if (cleanupFailure && (args.includes("userdel") || args.includes("-deleteUser") || args.includes("/delete"))) return { status: 1, stderr: "cleanup denied" };
				const launch = file === "su" || (file === "sudo" && args.includes("-u")) || file === "powershell.exe";
				if (launch) {
					const stage = file === "sudo" ? dirname(dirname(args.find((value) => value.endsWith("smoke-owner-lifecycle.mjs")))) : options.cwd;
					if (file === "sudo") assert.equal(options.cwd, "/");
					assert.equal(existsSync(join(stage, target.executable)), true);
					assert.equal(existsSync(join(stage, "scripts", "fixtures", "owner", "descendant.mjs")), true);
					assert.equal(existsSync(join(stage, "scripts", "lib", "bun-targets.mjs")), true);
					assert.equal(existsSync(join(stage, "scripts", "smoke-unix-owner-pty.mjs")), true);
					if (platform !== "win32") assert.equal(existsSync(join(stage, "owner-pty")), true);
					let protectedStdout, protectedStderr;
					if (platform === "win32") {
						const launcher = readFileSync(join(stage, "launch.ps1"), "utf8");
						assert.match(launcher, /\$env:HOME=/);
						assert.match(launcher, /Remove-Item Env:NODE_OPTIONS/);
						assert.match(launcher, /PI_WINDOWS_GATE_ROOT/);
						// Scratch is outside %SystemRoot%\Temp, and every runtime layer is preflighted before the strict child run.
						assert.equal(stage.startsWith(join(temp, "Temp")), false);
						for (const probe of [/cmd\.exe' '\/d' '\/c' 'ver'/, /'--version'/, /'--experimental-strip-types' '-e' '0'/, /whoami\.exe' '\/groups'/]) assert.match(launcher, probe);
						assert.ok(launcher.indexOf("preflight") < launcher.indexOf("$ErrorActionPreference='Stop'"), "preflight must not stop the launcher");
						assert.equal(existsSync(join(stage, "packages", "coding-agent", "test", "windows-owner-runtime.mjs")), true);
						assert.equal(existsSync(join(stage, "packages", "chord", "src", "manager.ts")), true);
						assert.equal(options.timeout, 1_200_000);
						protectedStdout = args.at(-1).match(/-RedirectStandardOutput '([^']+)'/)[1];
						protectedStderr = args.at(-1).match(/-RedirectStandardError '([^']+)'/)[1];
						const redirect = dirname(protectedStdout);
						assert.notEqual(redirect, stage);
						assert.equal(dirname(protectedStderr), redirect);
						const acl = calls.findIndex((entry) => entry.file === "icacls.exe" && entry.args[0] === redirect);
						assert.ok(acl >= 0 && acl < calls.length - 1, "parent protects output directory before launch");
						assert.deepEqual(calls[acl].args, [redirect, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/Q"]);
						assert.doesNotMatch(launcher, /pi-owner-output-/, "child launcher never receives output path access");
					}
					const output = join(stage, "child-evidence.json");
					if (silentChild) { rmSync(output, { force: true }); return { status: 0, stdout: "", stderr: "child stderr tail" }; }
					const stdout = JSON.stringify(child);
					// Match the real CLI writer: truncate the pre-existing output file, never rename it.
					writeFileSync(output, `${JSON.stringify(child, null, 2)}\n`);
					fileMutation?.({ output, stage, child, temp, displaceStage: () => {
						// Keep rename on the stage filesystem, independent of TMPDIR.
						const directory = mkdtempSync(join(dirname(stage), "pi-owner-displaced-"));
						displacements.push(directory);
						renameSync(stage, join(directory, "moved-work"));
						return directory;
					} });
					if (platform === "win32") {
						// Model trusted Start-Process opening output files before passing handles to the child.
						writeFileSync(protectedStdout, `\uFEFF${stdout}\n`);
						writeFileSync(protectedStderr, "protected parent capture");
					}
					return childResult ?? { status: childStatus ?? (childError ? 1 : 0), stdout: fileChild ? stdout.slice(-4096) : stdout, stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			},
		});
		const remainingRedirects = calls.filter(({ file, args }) => file === "icacls.exe" && args[0].includes("pi-owner-output-")).map(({ args }) => args[0]).filter((path) => existsSync(path));
		return { evidence, calls, child, remainingRedirects };
	} finally {
		try { for (const directory of displacements) rmSync(directory, { recursive: true, force: true }); }
		finally { rmSync(temp, { recursive: true, force: true }); }
	}
}

test("Darwin captured timeout with held empty file reports unknown child phase, never identity proof", async () => {
	for (const stderr of ["", '[owner-lifecycle] {"phase":"identity-verified","status":"passed"}\n']) {
		const { evidence, calls } = await dropped("darwin", {
			childResult: { status: null, signal: "SIGTERM", error: new Error("spawnSync sudo ETIMEDOUT"), stdout: "", stderr },
			fileMutation: ({ output }) => {
				const stat = lstatSync(output, { bigint: true });
				assert.equal(stat.isFile(), true);
				assert.equal(stat.mode & 0o777n, 0o600n);
				writeFileSync(output, "");
			},
		});
		assert.equal(evidence.status, "failed");
		assert.equal(evidence.identity, null);
		assert.deepEqual(evidence.rows, []);
		assert.equal(evidence.privilegeDrop.verifiedNonadmin, false);
		assert.match(evidence.error, /^owner privilege drop child-evidence \(phase unknown\) failed: child produced no complete lifecycle evidence:/);
		assert.doesNotMatch(evidence.error, /identity\/setup|auth.*denied/i);
		assert.match(evidence.error, /Unexpected end of JSON input/);
		const child = evidence.privilegeDrop.diagnostics.child;
		assert.equal(child.status, null);
		assert.equal(child.signal, "SIGTERM");
		assert.equal(child.error, "spawnSync sudo ETIMEDOUT");
		assert.equal(child.stderr, stderr);
		assert.equal(calls.find(({ file, args }) => file === "sudo" && args.includes("-u")).options.timeout, 420_000);
		assert.throws(() => assertOwnerLifecycle(evidence, "darwin"), /missing nonadmin identity/);
	}
});

test("real lifecycle row boundaries emit bounded ordered nonsecret stderr only", async () => {
	const originalSpawn = cp.spawn, originalStderr = process.stderr.write, originalStdout = process.stdout.write;
	let stderr = "", stdout = "";
	const callbacks = [];
	cp.spawn = (_file, args) => {
		const child = new EventEmitter();
		child.pid = process.pid;
		child.stderr = new EventEmitter();
		child.kill = () => true;
		queueMicrotask(() => child.emit(args[0] === "-e" ? "spawn" : "error", new Error("fixture-secret-not-for-progress")));
		return child;
	};
	process.stderr.write = (chunk) => { stderr += chunk; return true; };
	process.stdout.write = (chunk, ...args) => { stdout += chunk; return originalStdout.call(process.stdout, chunk, ...args); };
	syncBuiltinESMExports();
	let evidence;
	try {
		evidence = await smokeOwnerLifecycle(process.execPath, bunTarget("darwin-arm64"), {
			identityProbe: () => standard,
			runPty: (_executable, _target, name) => {
				assert.ok(stderr.includes(`"phase":"row-start","row":"${name}"`), "progress precedes real callback boundary");
				callbacks.push(name);
				return { name, status: "failed", error: "fixture-secret-not-for-progress" };
			},
		});
	} finally {
		cp.spawn = originalSpawn; process.stderr.write = originalStderr; process.stdout.write = originalStdout;
		syncBuiltinESMExports();
	}
	assert.doesNotMatch(stdout, /\[owner-lifecycle\]/);
	assert.equal(evidence.status, "failed", "progress never grants acceptance");
	const lines = stderr.trim().split("\n");
	assert.ok(lines.every((line) => line.startsWith("[owner-lifecycle] ")));
	const events = lines.map((line) => JSON.parse(line.slice("[owner-lifecycle] ".length)));
	assert.deepEqual(events.slice(0, 2).map(({ phase }) => phase), ["identity-probe-start", "identity-verified"]);
	const rows = ownerLifecycleRows("darwin");
	assert.deepEqual(events.slice(2).map(({ phase, row, status }) => ({ phase, row, ...(status ? { status } : {}) })), rows.flatMap((row) => [{ phase: "row-start", row }, { phase: "row-complete", row, status: "failed" }]));
	assert.deepEqual(callbacks, rows.filter(isUnixOwnerPtyRow));
	assert.equal(events.length, 2 + 2 * rows.length);
	assert.ok(Buffer.byteLength(stderr) < 12_000);
	assert.doesNotMatch(stderr, /fixture-secret|argv|password|token|\/tmp\/|\/var\/|PATH|HOME/);
	for (const [i, event] of events.entries()) {
		assert.equal(event.pid, process.pid);
		assert.equal(event.uid, process.getuid?.());
		assert.equal(event.euid, process.geteuid?.());
		assert.ok(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= (events[i - 1]?.elapsedMs ?? 0));
		assert.ok(Object.keys(event).every((key) => ["phase", "row", "status", "elapsedMs", "pid", "uid", "euid"].includes(key)));
	}
});

test("FreeBSD failed child retains complete row JSON from its file before scratch cleanup", async () => {
	const { evidence, calls, child } = await dropped("freebsd", { childError: "owner lifecycle containment failed: suspend-resume", fileChild: true });
	assert.equal(evidence.status, "failed");
	assert.equal(evidence.privilegeDrop.verifiedNonadmin, true);
	assert.match(evidence.error, /child failed: owner lifecycle containment failed: suspend-resume/);
	assert.deepEqual(evidence.rows, child.rows);
	const row = evidence.rows.find(({ name }) => name === "suspend-resume");
	assert.equal(row.status, "failed");
	assert.ok(row.outputTail.length > 4096);
	assert.equal(evidence.privilegeDrop.diagnostics.child.stdout.length, 4096);
	const launch = calls.find(({ file }) => file === "su");
	assert.equal(existsSync(join(launch.options.cwd, "child-evidence.json")), false);
});

const PRIVATE_SENTINEL = "synthetic-parent-private-json-must-not-export";
function privateJson(temp) {
	const directory = join(temp, "parent-private");
	mkdirSync(directory, { mode: 0o700 });
	const file = join(directory, "child-evidence.json");
	writeFileSync(file, JSON.stringify({ privateMarker: PRIVATE_SENTINEL }), { mode: 0o600 });
	return file;
}

for (const kind of ["symlink", "replacement", "directory", "intermediate-symlink", ...(process.platform === "win32" ? [] : ["fifo"])]) {
	test(`collector rejects ${kind} evidence without copying parent-private JSON`, async () => {
		let swapped = false;
		const { evidence } = await dropped("freebsd", { fileMutation: ({ output, stage, temp, displaceStage }) => {
			const secret = privateJson(temp);
			if (kind === "intermediate-symlink") {
				displaceStage();
				symlinkSync(dirname(secret), stage, "dir");
				swapped = true;
				return;
			}
			rmSync(output);
			if (kind === "symlink") symlinkSync(secret, output);
			else if (kind === "replacement") writeFileSync(output, readFileSync(secret));
			else if (kind === "directory") mkdirSync(output);
			else execFileSync("mkfifo", [output], { timeout: 5000 });
		} });
		if (kind === "intermediate-symlink") assert.equal(swapped, true, "directory rename and symlink swap executed");
		assert.equal(evidence.status, "failed");
		assert.equal(evidence.privilegeDrop.verifiedNonadmin, false);
		assert.doesNotMatch(JSON.stringify(evidence), new RegExp(PRIVATE_SENTINEL));
		assert.match(evidence.error, /child evidence.*(?:replaced|regular|directory)/);
	});
}

for (const kind of ["symlink", "intermediate-symlink"]) {
	test(`held evidence descriptor cannot be redirected by ${kind} swap during read`, async () => {
		const originalRead = fs.readFileSync;
		let swap;
		let swapped = false;
		let descriptorReads = 0;
		fs.readFileSync = (path, ...args) => {
			if (swap && (typeof path === "number" || String(path).endsWith("/child-evidence.json"))) {
				assert.equal(typeof path, "number", "payload read must use pre-opened descriptor");
				descriptorReads++;
				const action = swap; swap = null; action();
			}
			return originalRead(path, ...args);
		};
		syncBuiltinESMExports();
		try {
			const { evidence } = await dropped("freebsd", { fileMutation: ({ output, stage, temp, displaceStage }) => {
				const secret = privateJson(temp);
				swap = () => {
					if (kind === "symlink") { rmSync(output); symlinkSync(secret, output); }
					else { displaceStage(); symlinkSync(dirname(secret), stage, "dir"); }
					swapped = true;
				};
			} });
			assert.equal(swapped, true, "symlink swap executed");
			assert.equal(descriptorReads, 1);
			assert.equal(evidence.status, "failed");
			assert.doesNotMatch(JSON.stringify(evidence), new RegExp(PRIVATE_SENTINEL));
			assert.match(evidence.error, /child evidence.*(?:replaced|directory)/);
		} finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
	});
}

test("displaced stage fixture is cleaned even when mutation assertions fail", async () => {
	let directory;
	const { evidence } = await dropped("freebsd", { fileMutation: ({ stage, temp, displaceStage }) => {
		directory = displaceStage();
		symlinkSync(dirname(privateJson(temp)), stage, "dir");
		assert.fail("fixture assertion after directory swap");
	} });
	assert.match(evidence.error, /fixture assertion after directory swap/);
	assert.equal(typeof directory, "string");
	assert.equal(existsSync(directory), false, "remove only fixture-owned displaced scratch");
});

for (const kind of ["absent", "malformed", "partial", "identity", "child-status", "file-status", "rows"]) {
	test(`held evidence preserves ${kind} failure/fallback contract without unrelated keys`, async () => {
		const { evidence } = await dropped("freebsd", { childStatus: kind === "child-status" ? 37 : 0, fileMutation: ({ output, child }) => {
			if (kind === "absent") { rmSync(output); return; }
			if (kind === "malformed") { writeFileSync(output, `{"privateMarker":"${PRIVATE_SENTINEL}"`); return; }
			if (kind === "partial") { writeFileSync(output, '{"status":"passed"}'); return; }
			const value = { ...child, privateMarker: PRIVATE_SENTINEL };
			if (kind === "identity") value.identity = root;
			if (kind === "file-status") { value.status = "failed"; value.error = "original child failure"; }
			if (kind === "rows") value.rows = child.rows.map((row, index) => index === 0 ? { ...row, status: "failed", aliveAfter: true } : row);
			writeFileSync(output, JSON.stringify(value));
		} });
		assert.equal(evidence.status, kind === "absent" ? "passed" : "failed");
		assert.doesNotMatch(JSON.stringify(evidence), new RegExp(PRIVATE_SENTINEL));
		assert.equal(evidence.privilegeDrop.verifiedNonadmin, !["malformed", "partial", "identity"].includes(kind));
		if (kind === "child-status") assert.equal(evidence.privilegeDrop.diagnostics.child.status, 37);
		if (kind === "file-status") assert.match(evidence.error, /original child failure/);
		if (kind === "rows") assert.equal(evidence.rows[0].aliveAfter, true);
	});
}

test("pre-opened evidence descriptor is closed before cleanup on every exit path", async () => {
	const originalOpen = fs.openSync, originalClose = fs.closeSync, originalRemove = fs.rmSync;
	const records = [];
	const active = new Map();
	fs.openSync = (path, flags, ...args) => {
		const fd = originalOpen(path, flags, ...args);
		if (String(path).endsWith("/child-evidence.json") && flags === "wx+") {
			const stat = fstatSync(fd, { bigint: true });
			assert.equal(stat.isFile(), true);
			assert.equal(stat.mode & 0o777n, 0o600n);
			assert.equal(typeof stat.ino, "bigint");
			const record = { fd, work: dirname(path), closed: false, removed: false };
			records.push(record); active.set(fd, record);
		}
		return fd;
	};
	fs.closeSync = (fd) => { if (active.has(fd)) { active.get(fd).closed = true; active.delete(fd); } return originalClose(fd); };
	fs.rmSync = (path, ...args) => {
		if (String(path).includes("pi-owner-output-")) assert.equal(active.size, 0, "close held evidence before protected-output cleanup");
		for (const record of records) if (path === record.work) { assert.equal(record.closed, true, "close before scratch removal"); record.removed = true; }
		return originalRemove(path, ...args);
	};
	syncBuiltinESMExports();
	try {
		const cases = [["freebsd", {}], ["freebsd", { failCommand: "pw" }], ["freebsd", { onCommand: (file) => { if (file === "su") throw new Error("spawn failure"); } }], ["freebsd", { fileMutation: ({ output }) => writeFileSync(output, "{malformed") }], ["freebsd", { childIdentity: root }], ["freebsd", { childStatus: 37 }], ["freebsd", { cleanupFailure: true }], ["darwin", {}], ["win32", {}]];
		for (const [platform, options] of cases) {
			await dropped(platform, { ...options, onCommand: (file, args, settings) => {
				if (args.includes("useradd") || args.includes("-addUser") || args.includes("/add")) assert.equal(active.size, 1, "descriptor exists before provisioning");
				options.onCommand?.(file, args, settings);
			} });
			assert.equal(active.size, 0);
		}
		assert.equal(records.length, cases.length);
		for (const record of records) { assert.equal(record.closed, true); assert.equal(record.removed, true); assert.throws(() => fstatSync(record.fd), { code: "EBADF" }); }
	} finally { fs.openSync = originalOpen; fs.closeSync = originalClose; fs.rmSync = originalRemove; syncBuiltinESMExports(); }
});

test("viaSudo metadata traversal changes only scratch-root group and mode 0710, not identity or evidence mode 0600", async () => {
	for (const platform of ["darwin", "linux", "freebsd"]) {
		const viaSudo = platform !== "freebsd";
		const { evidence, calls } = await dropped(platform, { ...(platform === "linux" ? { hostIdentity: { ...standard, rootEquivalentGroup: true } } : {}), fileMutation: ({ output, stage }) => {
			assert.equal(lstatSync(output).mode & 0o777, 0o600);
			assert.equal(lstatSync(stage).mode & 0o777, viaSudo ? 0o710 : 0o700);
			assert.equal(lstatSync(stage).gid, process.getgid());
		} });
		assert.equal(evidence.status, "passed", evidence.error);
		assert.deepEqual(evidence.identity, standard);
		const rootGroup = calls.filter(({ file, args }) => file === "sudo" && args[1] === "chown" && !args.includes("-R"));
		const rootMode = calls.filter(({ file, args }) => file === "sudo" && args[1] === "chmod");
		assert.equal(rootGroup.length, viaSudo ? 1 : 0);
		assert.equal(rootMode.length, viaSudo ? 1 : 0);
		if (viaSudo) {
			assert.deepEqual(rootGroup[0].args.slice(0, 3), ["-n", "chown", `pi-owner-smoke:${process.getgid()}`]);
			assert.deepEqual(rootMode[0].args, ["-n", "chmod", "710", rootGroup[0].args.at(-1)]);
		}
	}
});

test("dropped child cannot remove metadata traversal and receive stdout fallback", async () => {
	const { evidence } = await dropped("darwin", { fileMutation: ({ stage }) => chmodSync(stage, 0o000) });
	assert.equal(evidence.status, "failed");
	assert.equal(evidence.privilegeDrop.verifiedNonadmin, false);
	assert.match(evidence.error, /EACCES|child evidence directory/);
});

test("real lifecycle CLI writer truncates the existing held file without replacing its identity", () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-owner-held-writer-"));
	const output = join(temp, "evidence.json");
	const fd = openSync(output, "wx+", 0o600);
	try {
		const expected = { status: "failed", error: "writer fixture" };
		writeFileSync(output, "old output must be truncated\n".repeat(100));
		const preload = join(temp, "writer.cjs");
		const assignment = "const evidence = await smokeOwnerLifecycleAsNonadmin(resolve(executable), bunTarget(targetId));";
		writeFileSync(preload, `require("node:module").registerHooks({load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith("/smoke-owner-lifecycle.mjs")) {
    const source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString();
    if (!source.includes(${JSON.stringify(assignment)})) throw new Error("writer seam changed");
    return {...result, source: source.replace(${JSON.stringify(assignment)}, ${JSON.stringify(`const evidence = ${JSON.stringify(expected)};`)})};
  }
  return result;
}});
`);
		const result = spawnSync(process.execPath, ["--require", preload, join(import.meta.dirname, "smoke-owner-lifecycle.mjs"), process.execPath, "freebsd-x64", output], { encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 1, result.stderr);
		const progress = result.stderr.trim().split("\n").map((line) => JSON.parse(line.slice("[owner-lifecycle] ".length)));
		assert.deepEqual(progress.map(({ phase }) => phase), ["cli-entry", "final-write-start", "final-write-complete"]);
		assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
		assert.equal(readFileSync(fd, "utf8"), `${JSON.stringify(expected, null, 2)}\n`);
		assert.equal(fstatSync(fd, { bigint: true }).ino, lstatSync(output, { bigint: true }).ino);
		assert.equal(fstatSync(fd, { bigint: true }).dev, lstatSync(output, { bigint: true }).dev);
	} finally { closeSync(fd); rmSync(temp, { recursive: true, force: true }); }
});

function assertFailedSmokeDiagnostics(evidence) {
	assert.equal(evidence.status, "failed");
	assert.doesNotMatch(JSON.stringify(evidence), new RegExp(PRIVATE_SENTINEL));
	const temp = mkdtempSync(join(tmpdir(), "pi-owner-safe-diagnostics-"));
	try {
		const asset = join(temp, "pi-freebsd-x64"), record = join(temp, "record.json");
		writeFileSync(asset, '#!/bin/sh\nif [ -n "$BUN_JSC_verboseDiskCache" ]; then echo "[Disk Cache] Cache hit for sourceCode" >&2; fi\ncase "$1" in --version) echo 1.2.3;; --help) echo Usage: pi;; --list-models) echo model;; esac\n'); chmodSync(asset, 0o755);
		const fixture = join(temp, "collector.json"); writeFileSync(fixture, JSON.stringify(evidence));
		const preload = join(temp, "owner.cjs");
		writeFileSync(preload, `const cp = require("node:child_process"), fs = require("node:fs");
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (args?.[0]?.endsWith("/smoke-owner-lifecycle.mjs")) {
    const text = fs.readFileSync(${JSON.stringify(fixture)}, "utf8");
    fs.writeFileSync(args[3], text);
    return {status:1, signal:null, stdout:text, stderr:""};
  }
  return original(command, args, options);
};
require("node:module").syncBuiltinESMExports();
`);
		const result = spawnSync(process.execPath, ["--require", preload, join(import.meta.dirname, "smoke-binary-release.mjs"), asset, "freebsd-x64", "1.2.3", record], { encoding: "utf8", timeout: 15_000 });
		assert.equal(result.status, 1, result.stderr);
		assert.equal(existsSync(record), false);
		const diagnostics = readFileSync(`${record}.diagnostics`, "utf8");
		assert.doesNotMatch(diagnostics, new RegExp(PRIVATE_SENTINEL));
		assert.deepEqual(JSON.parse(diagnostics).ownerLifecycle, evidence);
	} finally { rmSync(temp, { recursive: true, force: true }); }
}

test("unsafe collector evidence cannot leak synthetic private JSON through final smoke diagnostics", async () => {
	const { evidence } = await dropped("freebsd", { fileMutation: ({ output, temp }) => { rmSync(output); symlinkSync(privateJson(temp), output); } });
	assertFailedSmokeDiagnostics(evidence);
});

test("Windows redirection is parent-protected before launch and cleaned on every outcome", async () => {
	const cases = [
		["acl", { failCommand: "icacls.exe" }],
		["provision", { failCommand: "net.exe" }],
		["spawn", { onCommand: (file) => { if (file === "powershell.exe") throw new Error("spawn failure"); } }],
		["identity", { childIdentity: root }],
		["child-status", { childError: "original Windows failure", childStatus: 37 }],
		["success", {}],
		["cleanup-warning", { cleanupFailure: true }],
	];
	for (const [name, options] of cases) {
		const { evidence, calls, remainingRedirects } = await dropped("win32", { ...options, fileMutation: ({ stage, temp }) => {
			const secret = privateJson(temp);
			symlinkSync(secret, join(stage, "stdout.txt"));
			symlinkSync(secret, join(stage, "stderr.txt"));
		} });
		assert.equal(evidence.status, ["success", "cleanup-warning"].includes(name) ? "passed" : "failed", `${name}: ${evidence.error}`);
		assert.doesNotMatch(JSON.stringify(evidence), new RegExp(PRIVATE_SENTINEL));
		assert.deepEqual(remainingRedirects, [], `${name}: protected output cleanup before helper cleanup`);
		const acl = calls.findIndex(({ file, args }) => file === "icacls.exe" && args[0].includes("pi-owner-output-"));
		assert.ok(acl >= 0);
		assert.deepEqual(calls[acl].args.slice(1), ["/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/Q"]);
		const create = calls.findIndex(({ file, args }) => file === "net.exe" && args.includes("/add"));
		if (name === "acl") { assert.equal(create, -1); assert.equal(calls.some(({ file }) => file === "powershell.exe"), false); }
		else assert.ok(create > acl);
		if (!["acl", "provision"].includes(name)) assert.equal(calls.some(({ file }) => file === "powershell.exe"), true, `${name}: reached launcher (${evidence.error ?? "no error"})`);
		if (["identity", "child-status", "success", "cleanup-warning"].includes(name)) assert.equal(evidence.privilegeDrop.diagnostics.child.stderr, "protected parent capture");
		if (name === "child-status") { assert.equal(evidence.privilegeDrop.diagnostics.child.status, 37); assertFailedSmokeDiagnostics(evidence); }
	}
});

for (const platform of ["darwin", "win32"]) {
	test(`${platform} silent child failure carries child tails and a step trail without passwords`, async () => {
		const { evidence, calls } = await dropped(platform, { silentChild: true });
		assert.equal(evidence.status, "failed");
		assert.equal(evidence.privilegeDrop.verifiedNonadmin, false);
		assert.match(evidence.error, /child produced no complete lifecycle evidence:/);
		assert.match(evidence.error, /child stderr tail/);
		const { child, steps } = evidence.privilegeDrop.diagnostics;
		assert.equal(child.status, 0);
		assert.equal(child.stdout, "");
		assert.match(child.scriptRealpath, /smoke-owner-lifecycle\.mjs$|realpath failed/);
		assert.ok(steps.length > 0);
		const password = calls.find(({ args }) => args.includes("-addUser") || args.includes("/add"))?.args.find((value) => value.startsWith("Pi!9"));
		assert.ok(password, "account creation call carries a password");
		assert.equal(JSON.stringify(evidence).includes(password), false, "password must never be recorded");
	});
}

test("Unix suspend and opt-out rows require independent observations", () => {
	assert.deepEqual(ownerLifecycleRows("linux"), ["normal-double-fork", "kill-double-fork", "normal-setsid", "kill-setsid", "suspend-resume", "paused-outer-death", "paused-anchor-death", "paused-guardian-death", "paused-both-owners-death", "paused-both-owners-death-shutdown-blocked", ...unixOwnerFaultRows("linux").slice(5), "ownership-disabled"]);
	const make = () => ({ status: "passed", target: "fixture-target", cliSha256, artifactBunVersion: "1.3.14", identity: standard, rows: rowsFor("linux") });
	for (const key of ["piStopped", "stopped", "resumed", "peerRunning"]) {
		const evidence = make();
		delete evidence.rows.find((row) => row.name === "suspend-resume")[key];
		assert.throws(() => assertOwnerLifecycle(evidence, "linux"), /suspend\/resume missing proof/);
	}
	const evidence = make();
	evidence.rows.find((row) => row.name === "ownership-disabled").ownershipDisabled = false;
	assert.throws(() => assertOwnerLifecycle(evidence, "linux"), /opt-out missing proof/);
});

test("lifecycle requires post-fault shutdown hook entry for guardian and both-owner loss", () => {
	for (const os of ["linux", "freebsd", "darwin"]) for (const name of ["paused-guardian-death", "paused-both-owners-death", "paused-both-owners-death-shutdown-blocked"]) {
		const rows = rowsFor(os);
		delete rows.find((row) => row.name === name).shutdownHook;
		const evidence = { status: "passed", target: "fixture-target", cliSha256, identity: standard, rows, ...artifactBunFromOwnerRows(rows) };
		assert.throws(() => assertOwnerLifecycle(evidence, os), /shutdown-hook entry/);
	}
});

for (const value of [undefined, false, "Z"]) test(`lifecycle rejects ${String(value)} pre-adoption grandchild state in every PTY row`, () => {
	for (const os of ["linux", "freebsd", "darwin"]) for (const name of ownerLifecycleRows(os).filter(isUnixOwnerPtyRow)) {
		const rows = rowsFor(os);
		const row = rows.find((row) => row.name === name);
		if (value === undefined) delete row.adoption.grandchildBefore.state;
		else row.adoption.grandchildBefore.state = value;
		const evidence = { status: "passed", target: "fixture-target", cliSha256, identity: standard, rows, ...artifactBunFromOwnerRows(rows) };
		assert.throws(() => assertOwnerLifecycle(evidence, os), /pinned spawner\/setsid grandchild/);
	}
});

test("missing or disagreeing shipped Bun versions fail on every Unix target", () => {
	for (const os of ["linux", "freebsd", "darwin"]) {
		const observations = rowsFor(os);
		delete observations[0].pi.bun;
		observations[1].pi.bun = "1.4.2";

		const evidence = { status: "passed", target: "fixture-target", cliSha256, identity: standard, rows: observations, ...artifactBunFromOwnerRows(observations) };
		assert.equal(evidence.artifactBunVersion, null);
		assert.throws(() => assertOwnerLifecycle(evidence, os), /artifact Bun version invalid/);
	}
});

test("drop decisions require explicit CI and a privileged supported host identity", () => {
	for (const platform of ["linux", "freebsd", "darwin", "win32"]) {
		for (const identity of [root, { ...standard, euid: 0 }, { ...standard, elevated: true }, { ...standard, adminGroup: true }]) {
			assert.equal(ownerPrivilegeDropRequired(platform, identity, {}), false);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { CI: "false", GITHUB_ACTIONS: "false" }), false);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { CI: "1" }), false);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { CI: "true" }), true);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { GITHUB_ACTIONS: "true" }), true);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { PI_XZ_EXECUTOR: "pinned-musl-container" }), true);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { PI_XZ_EXECUTOR: "freebsd-vm" }), true);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { PI_XZ_EXECUTOR: "local" }), false);
		}
		assert.equal(ownerPrivilegeDropRequired(platform, standard, { CI: "true" }), false);
		assert.equal(ownerPrivilegeDropRequired(platform, { ...standard, rootEquivalentGroup: true }, { CI: "true" }), true);
		assert.equal(ownerPrivilegeDropRequired(platform, { ...standard, rootEquivalentGroup: true }, {}), false);
	}
	assert.equal(ownerPrivilegeDropRequired("aix", root, { CI: "true" }), false);
});

for (const platform of ["linux", "freebsd", "darwin", "win32"]) {
	test(`${platform} provisions a dedicated account and accepts only child identity evidence`, async () => {
		const { evidence, calls } = await dropped(platform);
		assert.equal(evidence.status, "passed", JSON.stringify(evidence));
		assert.deepEqual(evidence.identity, standard);
		assert.equal(evidence.privilegeDrop.user, "pi-owner-smoke");
		assert.equal(evidence.privilegeDrop.verifiedNonadmin, true);
		assert.ok(evidence.privilegeDrop.path);
		assert.equal(calls.some(({ args }) => args.includes("nobody") || args.includes("-admin")), false);
		if (platform === "freebsd") {
			assert.equal(calls.some(({ file, args }) => file === "pw" && args[0] === "useradd" && args.includes("-m") && args.includes("/bin/sh")), true);
			assert.equal(calls.some(({ file, args }) => file === "su" && args[0] === "-m" && args[1] === "pi-owner-smoke" && args.at(-1).includes("'-i'")), true);
		} else if (platform === "darwin") {
			assert.equal(calls.some(({ file, args }) => file === "sudo" && args.includes("sysadminctl") && args.includes("-addUser")), true);
			assert.equal(calls.some(({ file, args }) => file === "sudo" && args.includes("-u") && args.includes("-H") && args.includes("-i")), true);
		} else if (platform === "win32") {
			assert.equal(calls.some(({ file, args }) => file === "net.exe" && args.includes("/add")), true);
			assert.equal(calls.some(({ file, args }) => file === "powershell.exe" && args.at(-1).includes("-Credential $c") && args.at(-1).includes("-Wait -PassThru")), true);
			assert.equal(calls.some(({ file }) => file === "icacls.exe"), true);
			for (const directory of ["packages", "node_modules", "scripts"]) {
				assert.equal(calls.some(({ file, args }) => file === "icacls.exe" && args[0].endsWith(directory) && args.includes("host\\pi-owner-smoke:(OI)(CI)RX") && args.includes("/inheritance:r") && !args.includes("/T")), true);
				assert.equal(calls.some(({ file, args }) => file === "icacls.exe" && args[0].endsWith(join(directory, "*")) && args.includes("/reset") && args.includes("/T")), true);
			}
			// Contents (node.exe) must inherit the scratch grant: never combine /inheritance:r with /T.
			assert.equal(calls.some(({ file, args }) => file === "icacls.exe" && args.includes("/inheritance:r") && args.includes("/T")), false);
			assert.equal(calls.some(({ file, args }) => file === "icacls.exe" && args.includes("host\\pi-owner-smoke:(OI)(CI)F") && !args.includes("/T")), true);
		}
		assert.equal(calls.some(({ args }) => args.includes("userdel") || args.includes("-deleteUser") || args.includes("/delete") || args.some((arg) => arg.includes('exec userdel "$1"'))), true);
		const launch = calls.find(({ file, args }) => file === "su" || file === "powershell.exe" || (file === "sudo" && args.includes("-u")));
		const stage = launch.file === "sudo" ? dirname(dirname(launch.args.find((value) => value.endsWith("smoke-owner-lifecycle.mjs")))) : launch.options.cwd;
		assert.equal(existsSync(stage), false);
	});
}

test("non-root Linux runner in a root-equivalent group drops through sudo to the dedicated user", async () => {
	const runner = { ...standard, name: undefined, groupNames: ["runner", "adm", "docker"], rootEquivalentGroup: true };
	assert.equal(ownerPrivilegeDropRequired("linux", runner, { CI: "true" }), true);
	const { evidence, calls } = await dropped("linux", { hostIdentity: runner });
	assert.equal(evidence.status, "passed", JSON.stringify(evidence));
	assert.equal(evidence.privilegeDrop.method, "sudo -u");
	assert.equal(evidence.privilegeDrop.verifiedNonadmin, true);
	assert.equal(calls.some(({ file, args }) => file === "sudo" && args[0] === "-n" && args.includes("sh") && args.some((arg) => arg.includes("useradd"))), true);
	assert.equal(calls.some(({ file, args }) => file === "sudo" && args.includes("-u") && args.includes("pi-owner-smoke") && args.includes("-i")), true);
	assert.equal(calls.some(({ file }) => file === "su"), false);
	assert.equal(calls.some(({ file, args }) => file === "sudo" && args.some((arg) => arg.includes('exec userdel "$1"'))), true);
});

test("privileged and non-medium child tokens fail identity; never report verifiedNonadmin", async () => {
	for (const [platform, childIdentity] of [["freebsd", root], ["darwin", { ...standard, adminGroup: true }], ["win32", { ...standard, mediumIntegrity: false }], ["linux", { ...standard, rootEquivalentGroup: true }]]) {
		const { evidence } = await dropped(platform, { childIdentity });
		assert.equal(evidence.status, "failed");
		assert.equal(evidence.privilegeDrop.verifiedNonadmin, false);
		assert.match(evidence.error, /child-evidence \(phase unknown\) failed: owner lifecycle missing nonadmin identity/);
	}
});

test("verified Windows identity cannot hide containment failures", async () => {
	const { evidence } = await dropped("win32", { childError: "owner lifecycle containment failed: normal-double-fork" });
	assert.equal(evidence.status, "failed");
	assert.equal(evidence.privilegeDrop.verifiedNonadmin, true);
	assert.match(evidence.error, /child failed: owner lifecycle containment failed/);
	assert.throws(() => assertOwnerLifecycle(evidence, "windows"), /containment failed/);
});

test("provision failure and existing account fail closed without a privileged fallback", async () => {
	for (const options of [{ failCommand: "pw" }, { existing: true }]) {
		const { evidence, calls } = await dropped("freebsd", options);
		assert.equal(evidence.status, "failed");
		assert.equal(evidence.privilegeDrop.verifiedNonadmin, false);
		assert.match(evidence.error, /identity\/setup failed/);
		assert.equal(calls.some(({ file }) => file === "su"), false);
		if (options.existing) assert.equal(calls.length, 1);
	}
});

test("account cleanup failure is a warning, not acceptance credit or a failed smoke", async () => {
	const { evidence } = await dropped("win32", { cleanupFailure: true });
	assert.equal(evidence.status, "passed");
	assert.match(evidence.privilegeDrop.cleanupWarnings[0], /user cleanup: net.exe: cleanup denied/);
});

const retainedEvent = (row = "paused-both-owners-death-shutdown-blocked") => ({ phase: "fixture-return", row, category: "parse", status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT", helperWitness: { outcome: "unknown", repair: null }, helperWitnessSnapshot: { byteLength: 3, base64: "AP+A" }, stderrTail: "captured wrapper stderr" });
const eventLine = (event) => `[owner-pty] ${JSON.stringify(event)}\n`;
async function interruptedDiagnostic(stderr) {
	return dropped("darwin", { childResult: { status: null, signal: "SIGTERM", error: new Error("spawnSync sudo ETIMEDOUT"), stdout: "", stderr }, fileMutation: ({ output }) => writeFileSync(output, "") });
}

test("bounded retention keeps latest complete event before tail and interrupted next row", async () => {
	const fifth = retainedEvent();
	const stderr = eventLine(retainedEvent("suspend-resume")) + eventLine(fifth) + "ordinary captured output\n".repeat(300) + '[owner-lifecycle] {"phase":"row-start","row":"paused-observer-death"}\n' + '[owner-pty] {"phase":"fixture-return","row":"paused-observer-death"';
	const { evidence, calls } = await interruptedDiagnostic(stderr);
	const child = evidence.privilegeDrop.diagnostics.child;
	assert.equal(evidence.status, "failed");
	assert.deepEqual(evidence.rows, []);
	assert.equal(evidence.identity, null);
	assert.equal(evidence.privilegeDrop.verifiedNonadmin, false);
	assert.deepEqual(child.fixtureReturn, fifth);
	assert.equal(child.stderr, stderr.slice(-4096), "ordinary4096 tail unchanged");
	assert.equal(child.stderr.includes(fifth.helperWitnessSnapshot.base64), false);
	assert.equal(child.fixtureReturn.row, "paused-both-owners-death-shutdown-blocked");
	assert.equal(calls.find(({ file, args }) => file === "sudo" && args.includes("-u")).options.timeout, 420_000);
	assert.throws(() => assertOwnerLifecycle(evidence, "darwin"), /missing nonadmin identity/);
});

test("bounded retention ignores malformed partial overlong and wrong-type events", async () => {
	const valid = retainedEvent();
	const invalid = [
		{ ...valid, phase: "spawner-exit" }, { ...valid, row: "unknown" }, { ...valid, row: "paused-anchor-death" },
		{ ...valid, category: "native-progress" }, { ...valid, status: "1" }, { ...valid, signal: "not-a-signal" }, { ...valid, errorCode: "not-an-errno" },
		{ ...valid, helperWitness: { outcome: "unknown", repair: "ci-owned-observation" } },
		{ ...valid, stderrTail: "é".repeat(257) }, { ...valid, stderrTail: 1 }, { ...valid, extra: "not approved" },
		...[null, { byteLength: 3, base64: "AP+A\n" }, { byteLength: 2, base64: "AP+A" }, { byteLength: 1, base64: "AB==" }, { byteLength: "3", base64: "AP+A" }, { byteLength: 1025, base64: Buffer.alloc(1025).toString("base64") }, { byteLength: 3, base64: "AP+A", extra: 1 }].map((helperWitnessSnapshot) => ({ ...valid, helperWitnessSnapshot })),
	];
	for (const event of invalid) {
		const { evidence } = await interruptedDiagnostic(eventLine(valid) + eventLine(event) + '[owner-pty] {"phase":');
		assert.deepEqual(evidence.privilegeDrop.diagnostics.child.fixtureReturn, valid);
	}
	const { evidence } = await interruptedDiagnostic(eventLine(valid) + '[owner-pty] {"phase":"fixture-return","padding":"' + "x".repeat(4096) + '"}\n' + '[owner-pty] malformed\n');
	assert.deepEqual(evidence.privilegeDrop.diagnostics.child.fixtureReturn, valid);
	const none = await interruptedDiagnostic(eventLine({ ...valid, row: "unknown" }) + eventLine(valid).trimEnd());
	assert.equal(Object.hasOwn(none.evidence.privilegeDrop.diagnostics.child, "fixtureReturn"), false);
});

test("bounded retention accepts canonical1024 snapshot and exact4096 event only on failure", async () => {
	const event = { ...retainedEvent(), helperWitnessSnapshot: { byteLength: 1024, base64: Buffer.alloc(1024, 255).toString("base64") }, stderrTail: "\0".repeat(400) };
	const remaining = 4096 - Buffer.byteLength(eventLine(event));
	assert.ok(remaining >= 0 && 400 + remaining <= 512);
	event.stderrTail += "x".repeat(remaining);
	assert.equal(Buffer.byteLength(eventLine(event)), 4096);
	const kept = await interruptedDiagnostic(eventLine(event));
	assert.deepEqual(kept.evidence.privilegeDrop.diagnostics.child.fixtureReturn, event);
	const over = await interruptedDiagnostic(eventLine({ ...event, stderrTail: event.stderrTail + "x" }));
	assert.equal(Object.hasOwn(over.evidence.privilegeDrop.diagnostics.child, "fixtureReturn"), false);
	const success = await dropped("darwin", { childResult: { status: 0, stdout: "", stderr: eventLine(retainedEvent()) } });
	assert.equal(success.evidence.status, "passed");
	assert.equal(Object.hasOwn(success.evidence.privilegeDrop.diagnostics.child, "fixtureReturn"), false);
});

test("bounded retention transports existing error and v2 facts without selecting new repairs", async () => {
	const intervals = [{ kind: "inventory", ordinal: 1, beginNs: 7991000000, endNs: 8396000000, result: "ok", firstReturn: { inventoryOrdinal: 1, atNs: 8396000000, role: "all", reason: "eligible-absence", error: "-" } }];
	const facts = { clock: "native-session-local", timeoutNs: 8396000000, intervals };
	const helpers = [
		...[ ["grandchild-spawn", "ci-child-launch-setup"], ["snapshot", "ci-native-query-error"], ["pin", "ci-identity-sampling"], ["publish", "ci-file-publication"] ].map(([operation, repair]) => ({ outcome: "operation-error", operation, repair, clock: "native-process-local" })),
		{ outcome: "cleanup-cost", operation: "complete-inventory", repair: "ci-owned-observation", ...facts },
		{ outcome: "cleanup-cost", operation: "held-fault-delivery", repair: "ci-held-fault-delivery", ...facts },
		{ outcome: "unknown", repair: null, ...facts },
	];
	for (const helperWitness of helpers) {
		const event = { ...retainedEvent(), helperWitness };
		const { evidence } = await interruptedDiagnostic(eventLine(event));
		assert.deepEqual(evidence.privilegeDrop.diagnostics.child.fixtureReturn, event);
		assert.equal(evidence.status, "failed");
		assert.deepEqual(evidence.rows, []);
	}
	for (const helperWitness of [null, { outcome: "operation-error", operation: "snapshot", repair: "ci-owned-observation", clock: "native-process-local" }, { outcome: "unknown", repair: null, ...facts, intervals: [{ ...intervals[0], firstReturn: { ...intervals[0].firstReturn, atNs: "8396000000" } }] }]) {
		const { evidence } = await interruptedDiagnostic(eventLine({ ...retainedEvent(), helperWitness }));
		assert.equal(Object.hasOwn(evidence.privilegeDrop.diagnostics.child, "fixtureReturn"), false);
	}
});

test("actual session producer events survive aggregate timeout without case or selector changes", { skip: process.env.PI_OWNER_SESSION_TEST_DIR ? false : "requires current Rust/secure-reader event fixture" }, async () => {
	const events = JSON.parse(readFileSync(join(process.env.PI_OWNER_SESSION_TEST_DIR, "events.json"), "utf8"));
	assert.equal(events.length, 4);
	for (const { event, line } of events) {
		const { evidence } = await interruptedDiagnostic(line + "ordinary output\n".repeat(400) + '[owner-pty] {"phase":"fixture-return","row":"paused-observer-death"');
		assert.equal(evidence.status, "failed"); assert.deepEqual(evidence.rows, []);
		assert.deepEqual(evidence.privilegeDrop.diagnostics.child.fixtureReturn, event);
		assert.equal(event.row, "suspend-resume");
		assert.deepEqual(event.helperWitness, { outcome: "unknown", repair: null });
		const wrongCase = { ...event, row: "paused-guardian-death" };
		const rejected = await interruptedDiagnostic(line + eventLine(wrongCase));
		assert.deepEqual(rejected.evidence.privilegeDrop.diagnostics.child.fixtureReturn, event);
	}
});
