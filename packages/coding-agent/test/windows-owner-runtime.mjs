// Explicit CI gate, not part of Linux vitest discovery. Run once per shipped Windows artifact AND Node/Bun runtime.
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { forkDriver } from "../../chord/src/manager.ts";
import { execCommand } from "../src/core/exec.ts";
import { observeOwnedProcess } from "../src/utils/process-owner.ts";

const root = mkdtempSync(join(tmpdir(), "pi-windows-owner-"));
const artifact = process.env.PI_WINDOWS_OWNER_ARTIFACT;
const owner = process.env.PI_PROCESS_OWNER_TEST_BINARY;
const cli = process.env.PI_WINDOWS_OWNER_TEST_CLI;
const fixture = join(root, "owner-fixture.exe");
const launcherFixture = fileURLToPath(new URL("./fixtures/windows-owner-launcher.mjs", import.meta.url));
const ipcFixture = fileURLToPath(new URL("./fixtures/windows-owner-ipc.mjs", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, ms = 8000) {
	const deadline = Date.now() + ms;
	while (!check()) { assert.ok(Date.now() < deadline, message); await delay(10); }
}
async function bounded(pending, ms = 8000) {
	let timer;
	try { return await Promise.race([pending, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("caller completion deadline")), ms); })]); }
	finally { clearTimeout(timer); }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
function pids(directory) { return readdirSync(directory).filter((name) => name.endsWith(".pid")).map((name) => Number(name.slice(0, -4))); }
function directory() { return mkdtempSync(join(root, "tree-")); }
async function run(command, args, options = {}) {
	const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
	const stdout = [], stderr = [];
	child.stdout.on("data", (bytes) => stdout.push(bytes)); child.stderr.on("data", (bytes) => stderr.push(bytes));
	const deadline = setTimeout(() => child.kill("SIGKILL"), 12000);
	let code;
	try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
	finally { clearTimeout(deadline); }
	return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}
function supervise(args, flags = [], env = {}, context = {}) {
	const child = spawn(owner, ["supervise", ...flags, "--control-fd", "3", ...args], {
		cwd: context.cwd, env: { ...process.env, ...env }, stdio: [context.input === undefined ? "ignore" : "pipe", "pipe", "pipe", "pipe"],
	});
	if (context.input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(context.input); }
	let wire = ""; const stdout = [], stderr = [];
	const lease = child.stdio[3];
	lease.setEncoding("utf8"); lease.on("data", (text) => { wire += text; });
	lease.on("error", () => {});
	child.stdout.on("data", (bytes) => stdout.push(bytes)); child.stderr.on("data", (bytes) => stderr.push(bytes));
	const drained = new Promise((resolve) => { lease.once("end", resolve); lease.once("close", resolve); });
	const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
	let deadline;
	const timeout = new Promise((_resolve, reject) => { deadline = setTimeout(() => {
		child.kill("SIGKILL"); lease.destroy(); child.stdout.destroy(); child.stderr.destroy();
		reject(new Error("native owner completion exceeded 10 seconds"));
	}, 10000); });
	const result = Promise.race([Promise.all([closed, drained]).then(([code]) => ({ code, wire, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })), timeout]).finally(() => clearTimeout(deadline));
	void result.catch(() => {});
	return { child, lease, result, get wire() { return wire; } };
}
async function acknowledged(scope) {
	const result = await scope.result;
	assert.match(result.wire, /^(?:O[^\n]+\n)?S\{"pid":\d+\}\nX\{"code":\d+,"signal":null\}\nC\n$/);
	const primary = JSON.parse(result.wire.split("\n").find((line) => line.startsWith("X")).slice(1)).code;
	assert.equal(result.code, process.versions.bun ? primary % 256 : primary);
	assert.equal(scope.lease.readableEnded, true);
	return { ...result, code: primary };
}

before(async () => {
	assert.equal(process.platform, "win32", "runtime gate requires Windows; no skip/mock allowed");
	assert.ok(["windows-x64-baseline", "windows-x64-modern", "windows-arm64"].includes(artifact), "identify shipped artifact");
	assert.ok(owner && cli, "set shipped helper and CLI paths; no source-only substitute");
	console.log(JSON.stringify({ artifact, platform: process.platform, arch: process.arch, runtime: process.versions, owner, cli,
		ownerSha256: createHash("sha256").update(readFileSync(owner)).digest("hex"),
		cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
	}));
	const source = fileURLToPath(new URL("./fixtures/windows-owner.cs", import.meta.url));
	const compile = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
		"Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $env:PI_OWNER_CS) -OutputAssembly $env:PI_OWNER_FIXTURE -OutputType ConsoleApplication"],
		{ env: { ...process.env, PI_OWNER_CS: source, PI_OWNER_FIXTURE: fixture } });
	assert.equal(compile.code, 0, compile.stderr.toString());
	const token = await run(fixture, ["identity"]);
	console.log(`token=${token.stdout}`);
	assert.equal(token.code, 0, token.stderr.toString());
	const groups = await run("whoami.exe", ["/all"]);
	assert.equal(groups.code, 0);
	console.log(groups.stdout.toString());
	assert.doesNotMatch(groups.stdout.toString(), /S-1-5-32-544|S-1-16-(?:12288|16384)/, "genuinely nonadmin, non-elevated token required");
});
after(() => rmSync(root, { recursive: true, force: true }));

test("shipped CLI respawn and console/ConPTY Ctrl-C", { timeout: 20000 }, async () => {
	const help = await run(cli, ["--help"]); assert.equal(help.code, 0, help.stderr.toString());
	const console = await run(fixture, ["conpty", owner]); assert.equal(console.code, 0, console.stderr.toString() + console.stdout.toString());
	const tui = await run(fixture, ["tui", cli], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "config"), PI_OFFLINE: "1" } });
	assert.equal(tui.code, 0, tui.stderr.toString() + tui.stdout.toString());
});

test("unsigned statuses, exact separate binary stdio and Unicode/empty argv", async () => {
	for (const code of [0, 7, 125, 3221225477, 4294967295]) {
		const result = await acknowledged(supervise(["--", fixture, "status", String(code)])); assert.equal(result.code, code);
	}
	const bytes = await acknowledged(supervise(["--", fixture, "bytes"]));
	assert.deepEqual(bytes.stdout, Buffer.from([0, 255, 10, 13, 0, 128, 65]));
	assert.deepEqual(bytes.stderr, Buffer.from([65, 128, 0, 13, 10, 255, 0]));
	const args = ["", "space quote\" slash\\", "世界 λ", "tail \\"];
	const argv = await acknowledged(supervise(["--", fixture, "args", ...args]));
	assert.deepEqual(argv.stdout.toString().trimEnd().split(/\r?\n/).slice(1), args.map((arg) => Buffer.from(arg).toString("base64")));
	const cwd = directory();
	const context = await acknowledged(supervise(["--", fixture, "context"], [], { PI_OWNER_CONTEXT: "env 世界" }, { cwd, input: "payload stdin λ\n" }));
	assert.equal(context.stdout.toString(), `${cwd}\r\nenv 世界\r\npayload stdin λ\n`);
	const failure = await supervise(["--", join(root, "absent.exe")]).result;
	assert.equal(failure.code, 125); assert.match(failure.wire, /^E2 .+\nC\n$/); assert.equal(failure.stderr.length, 0);
});

for (const mode of ["tree", "nested"]) for (const stop of ["exit", "K", "lease-loss", "guardian-death"]) {
	test(`${mode}: ${stop} empties all recursive/new-console descendants; unrelated same-user peer lives`, { timeout: 15000 }, async () => {
		const dir = directory(), peerDir = directory();
		const peer = spawn(fixture, ["leaf", peerDir], { stdio: "ignore" });
		const scope = supervise(["--", fixture, mode, dir, stop === "exit" ? "exit" : "wait"]);
		try {
			await until(() => pids(dir).length === 3, "immediate recursive descendants not ready");
			await until(() => scope.wire.startsWith("S"), "missing ownership startup");
			if (stop === "K") scope.lease.write("K");
			else if (stop === "lease-loss") scope.lease.destroy();
			else if (stop === "guardian-death") scope.child.kill("SIGKILL");
			if (stop === "guardian-death" || stop === "lease-loss") { const result = await scope.result; assert.ok(!result.wire.includes("C\n"), "dead guardian/lost lease cannot acknowledge"); }
			else assert.equal((await acknowledged(scope)).code, stop === "exit" ? 7 : 137);
			if (stop === "guardian-death" || stop === "lease-loss") await until(() => pids(dir).every((pid) => !alive(pid)), "owned process survived guardian/lease death");
			else assert.ok(pids(dir).every((pid) => !alive(pid)), "owned process survived acknowledged return");
			assert.ok(alive(peer.pid), "unrelated same-user session was killed");
		} finally { scope.child.kill("SIGKILL"); peer.kill("SIGKILL"); for (const pid of pids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL"); }
	});
}

for (const lost of [false, true]) test(`delayed native cleanup (>50 ms), lease loss=${lost} cannot fake acknowledgment`, { timeout: 15000 }, async () => {
	const path = `\\\\.\\pipe\\pi-owner-cleanup-${randomUUID()}`;
	const sockets = new Set();
	let delayed = false;
	const server = createServer((socket) => {
		sockets.add(socket); socket.on("error", () => {});
		let pending = "";
		socket.on("data", (bytes) => {
			pending += bytes;
			if (!pending.endsWith("\n")) return;
			if (pending.startsWith("cleanup ")) { delayed = true; setTimeout(() => socket.write("L\n"), 150); }
			else socket.write("L\n");
		});
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
	const dir = directory();
	const scope = supervise(["--", fixture, "tree", dir], ["--test-phase-pipe", path], { PI_ENV_SUPERVISE_TEST_FAULTS: "1" });
	const observed = observeOwnedProcess(scope.child);
	try {
		await until(() => pids(dir).length === 3 && observed.started, "cleanup fixture not ready");
		const outcome = lost ? assert.rejects(observed.completion, { code: "ERR_PROCESS_OWNER_CLEANUP" }) : observed.completion;
		if (lost) scope.lease.destroy(); else observed.cancel();
		if (lost) { await outcome; const result = await scope.result; assert.ok(!result.wire.includes("C\n")); }
		else { assert.deepEqual(await outcome, { code: 137, errno: undefined }); await acknowledged(scope); }
		assert.equal(delayed, true, "native cleanup delay not exercised");
		assert.ok(pids(dir).every((pid) => !alive(pid)), "cleanup returned with live descendants");
	} finally {
		scope.child.kill("SIGKILL"); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve));
		for (const pid of pids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL");
	}
});

for (const phase of ["attach-opening", "attach-opened"]) test(`${phase}: worker exit revokes identity before assignment`, { timeout: 15000 }, async () => {
	const path = `\\\\.\\pipe\\pi-owner-identity-${randomUUID()}`;
	const sockets = new Set(); let held;
	const server = createServer((socket) => {
		sockets.add(socket); socket.on("error", () => {}); let pending = "";
		socket.on("data", (bytes) => { pending += bytes; if (!pending.endsWith("\n")) return; if (pending.startsWith(`${phase} `)) held = socket; else socket.write("L\n"); });
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
	const child = fork(ipcFixture, [], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
	const scope = supervise(["--attach-pid", String(child.pid)], ["--test-phase-pipe", path], { PI_ENV_SUPERVISE_TEST_FAULTS: "1" });
	let denied = false;
	scope.lease.on("data", () => {
		if (!denied && scope.wire.startsWith("O") && scope.wire.includes("\n")) {
			assert.ok(child.exitCode !== null || child.signalCode !== null, "original child must exit before identity decision");
			denied = true; scope.lease.write("deny\n");
		}
	});
	try {
		await until(() => held, "attach delay not reached");
		child.disconnect(); await closed;
		held.write("L\n");
		const result = await scope.result;
		assert.equal(result.code, 125); assert.ok(!result.wire.includes("S{"), "exited worker must never be assigned");
		if (phase === "attach-opened") assert.equal(denied, true, "held process must be explicitly denied");
		assert.ok(!result.wire.includes("C\n"), "denial cannot report acknowledged success");
	} finally { child.kill("SIGKILL"); scope.child.kill("SIGKILL"); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
});

test("breakaway is denied", async () => { const result = await acknowledged(supervise(["--", fixture, "breakaway", directory()])); assert.equal(result.code, 0); });

test("fault flags disabled without opt-in; assignment/transport fail before payload; query failure never sends C", async () => {
	const disabled = await run(owner, ["supervise", "--test-fail", "assign", "--", fixture, "status", "0"], { env: { ...process.env, PI_ENV_SUPERVISE_TEST_FAULTS: "0" } });
	assert.equal(disabled.code, 2);
	for (const fail of ["assign", "transport", "query"]) {
		const scope = supervise(["--", fixture, "status", "0"], ["--test-fail", fail], { PI_ENV_SUPERVISE_TEST_FAULTS: "1" });
		const result = await scope.result; assert.equal(result.code, 125);
		if (fail === "query") assert.ok(!result.wire.includes("C\n"));
		else assert.ok(!result.wire.includes("S{"), `${fail}: payload must not start`);
	}
});

for (const phase of ["spawned", "transferred", "received", "assigned", "ready", "launch"]) for (const victim of ["guardian", "bootstrap", "launcher-death"]) {
	test(`${phase}: ${victim} death revokes launch or contains payload; no Job/control handle leak`, { timeout: 15000 }, async () => {
		const path = `\\\\.\\pipe\\pi-owner-gate-${randomUUID()}`;
		let held; const sockets = new Set();
		const server = createServer((socket) => {
			sockets.add(socket); socket.on("error", () => {}); let buffer = "";
			socket.on("data", (data) => {
				buffer += data.toString(); if (!buffer.endsWith("\n")) return;
				const [step, pid, peer] = buffer.trim().split(" ");
				if (step === phase) held = { pid: Number(pid), peer: Number(peer), socket };
				else socket.write("L\n");
			});
		});
		await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
		const dir = directory();
		let scope;
		if (victim === "launcher-death") {
			const child = spawn(process.execPath, [launcherFixture, owner, JSON.stringify(["supervise", "--test-phase-pipe", path, "--control-fd", "3", "--", fixture, "tree", dir])], {
				env: { ...process.env, PI_ENV_SUPERVISE_TEST_FAULTS: "1" }, stdio: ["ignore", "pipe", "inherit"],
			});
			let wire = ""; child.stdout.on("data", (bytes) => { wire += bytes; });
			scope = { child, result: new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code) => resolve({code, wire})); }) };
		} else scope = supervise(["--", fixture, "tree", dir], ["--test-phase-pipe", path], { PI_ENV_SUPERVISE_TEST_FAULTS: "1" });
		try {
			await until(() => held, "handshake phase not reached", 4000);
			const guardianPhase = ["spawned", "transferred", "ready"].includes(phase);
			const bootstrapPid = guardianPhase ? held.peer : held.pid;
			if (victim === "guardian") { scope.child.kill("SIGKILL"); await until(() => !alive(scope.child.pid), "guardian kill did not finish"); }
			else if (victim === "bootstrap") process.kill(bootstrapPid, "SIGKILL");
			else scope.child.kill("SIGKILL");
			held.socket.write("L\n");
			const result = await scope.result;
			assert.ok(!result.wire.includes("S{"), "no payload may run after pre-launch death");
			await until(() => !alive(bootstrapPid), "trusted bootstrap survived guardian/lease death");
			await until(() => !alive(guardianPhase ? held.pid : held.peer), "guardian survived launcher/bootstrap death");
			if (phase === "launch" && victim === "launcher-death")
				await until(() => pids(dir).every((pid) => !alive(pid)), "authorized payload survived lease EOF");
			else assert.deepEqual(pids(dir), []);
		} finally { scope.child.kill("SIGKILL"); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
	});
}

test("direct Node/Bun fork message, TCP handle transfer and disconnect through attached Job", { timeout: 15000 }, async () => {
	const beforeFork = performance.timeOrigin + performance.now();
	const child = fork(ipcFixture, [], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const afterFork = performance.timeOrigin + performance.now();
	const scope = supervise(["--attach-pid", String(child.pid)]);
	const messages = []; child.on("message", (message) => messages.push(message));
	child.on("error", (error) => assert.fail(error));
	const server = createServer();
	try {
		await until(() => scope.wire.startsWith("O") && scope.wire.includes("\n"), "attach did not open process");
		const opened = JSON.parse(scope.wire.split("\n")[0].slice(1));
		const valid = opened.pid === child.pid && opened.parentPid === process.pid &&
			opened.creationTime >= beforeFork - 16 && opened.creationTime <= afterFork &&
			child.exitCode === null && child.signalCode === null;
		scope.lease.write(valid ? "permit\n" : "deny\n");
		assert.ok(valid, "attach identity denied");
		assert.equal(scope.wire.includes("S{"), false, "opened must precede assignment");
		await until(() => scope.wire.includes("\nS"), "attach failed before first IPC message");
		child.send({ kind: "echo", value: "世界" });
		await until(() => messages.some((message) => message.kind === "echo" && message.value === "世界"), "message round trip failed");
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = server.address().port;
		await new Promise((resolve, reject) => child.send({ kind: "server" }, server, (error) => error ? reject(error) : resolve()));
		await until(() => messages.some((message) => message.kind === "handle-ready"), "handle transfer failed");
		await new Promise((resolve) => server.close(resolve));
		const response = await new Promise((resolve, reject) => { const socket = createConnection(port, "127.0.0.1"); let text = ""; socket.on("error", reject); socket.on("data", (data) => { text += data; }); socket.on("end", () => resolve(text)); });
		assert.equal(response, "handle-round-trip");
		const disconnected = new Promise((resolve) => child.once("disconnect", resolve)); child.disconnect(); await disconnected;
		assert.equal((await acknowledged(scope)).code, 7);
	} finally { child.kill("SIGKILL"); scope.child.kill("SIGKILL"); server.close(); }
});

test("Chord contains double-detached descendants only after attach ack; failed attach kills P without init", { timeout: 15000 }, async () => {
	const previous = process.env.PI_PROCESS_OWNER_BINARY;
	const dir = directory(), failedDir = directory();
	const identity = join(dir, "worker.identity"), failedIdentity = join(failedDir, "worker.identity");
	try {
		process.env.PI_PROCESS_OWNER_BINARY = owner;
		const instance = forkDriver({ entry: ipcFixture, init: { fixture, directory: dir }, execArgv: [], env: { PI_WINDOWS_OWNER_PIDFILE: identity } }).spawn();
		await until(() => pids(dir).length === 3, "post-message recursive worker not ready");
		instance.killTree(); await bounded(instance.exited);
		assert.ok(pids(dir).every((pid) => !alive(pid)), "post-ack descendant survived");
		process.env.PI_PROCESS_OWNER_BINARY = process.execPath; // Existing executable that cannot run native attach protocol.
		const failed = forkDriver({ entry: ipcFixture, init: { fixture, directory: failedDir }, execArgv: [], env: { PI_WINDOWS_OWNER_PIDFILE: failedIdentity } }).spawn();
		await assert.rejects(bounded(failed.exited), (error) => error.message !== "caller completion deadline");
		if (existsSync(failedIdentity)) assert.ok(!alive(Number(readFileSync(failedIdentity))), "failed attach left P alive");
		assert.deepEqual(pids(failedDir), [], "init leaked through failed attach");
	} finally {
		for (const file of [identity, failedIdentity]) if (existsSync(file)) { const pid = Number(readFileSync(file)); if (alive(pid)) process.kill(pid, "SIGKILL"); }
		for (const pid of pids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL");
		if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY; else process.env.PI_PROCESS_OWNER_BINARY = previous;
	}
});

test("exec caller abort and timeout use lease, never terminate guardian before cleanup", { timeout: 20000 }, async () => {
	const previous = process.env.PI_PROCESS_OWNER_BINARY;
	const dirs = [];
	process.env.PI_PROCESS_OWNER_BINARY = owner;
	try {
		assert.equal((await execCommand(fixture, ["status", "3221225477"], root)).code, 3221225477);
		for (const mode of ["abort", "timeout"]) {
			const dir = directory(); dirs.push(dir);
			const controller = new AbortController();
			const pending = execCommand(fixture, ["tree", dir], root, { signal: controller.signal, timeout: mode === "timeout" ? 2500 : undefined });
			if (mode === "abort") { await until(() => pids(dir).length === 3, "abort fixture not ready"); controller.abort(); }
			const result = await bounded(pending);
			assert.equal(result.killed, true);
			assert.equal(result.code, 137, result.stderr);
			assert.ok(pids(dir).every((pid) => !alive(pid)), "caller returned before owned cleanup");
		}
	} finally {
		for (const dir of dirs) for (const pid of pids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL");
		if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY; else process.env.PI_PROCESS_OWNER_BINARY = previous;
	}
});

test("test phase permit expiry is bounded and cannot authorize payload", { timeout: 12000 }, async () => {
	const path = `\\\\.\\pipe\\pi-owner-expiry-${randomUUID()}`;
	const sockets = new Set();
	// Withhold only the prelaunch `spawned` permit; cleanup must be permitted so expiry is the single bounded wait.
	let withheld = 0;
	const server = createServer((socket) => {
		sockets.add(socket); socket.on("error", () => {});
		let line = "", answered = false;
		socket.on("data", (chunk) => {
			line += chunk; if (answered || !line.includes("\n")) return;
			answered = true;
			if (line.startsWith("spawned ")) withheld++; else socket.write("L\n");
		});
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
	const started = Date.now();
	const scope = supervise(["--", fixture, "status", "0"], ["--test-phase-pipe", path], { PI_ENV_SUPERVISE_TEST_FAULTS: "1" });
	try {
		const result = await scope.result;
		assert.ok(Date.now() - started <= 8000, "test permit timeout exceeded bound");
		assert.equal(result.code, 125);
		assert.equal(withheld, 1, "exactly one prelaunch permit must be withheld");
		assert.ok(!result.wire.includes("S{"), "expired permit launched payload");
	} finally { scope.child.kill("SIGKILL"); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
});

test("Windows PowerShell and Git Bash preserve shell-specific quoting", { timeout: 15000 }, async () => {
	const powershell = "$b=[Text.Encoding]::UTF8.GetBytes('quote '' space 世界');[Console]::OpenStandardOutput().Write($b,0,$b.Length);exit 7";
	const ps = await acknowledged(supervise(["--", "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", powershell]));
	assert.equal(ps.code, 7); assert.equal(ps.stdout.toString(), "quote ' space 世界");
	const bash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
	const sh = await acknowledged(supervise(["--", bash, "-c", "printf '%s\\n' 'space \" quote 世界'; exit 7"]));
	assert.equal(sh.code, 7); assert.equal(sh.stdout.toString(), "space \" quote 世界\n");
});
