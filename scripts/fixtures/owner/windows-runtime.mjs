// Windows installed runtime gate. Runs under a genuinely nonadmin token against the
// shipped CLI and its materialized embedded helper. This replaces the 38-entry
// guardian-era list: removed mechanisms (K signal, lease loss, guardian/bootstrap/
// launcher deaths, attach phases, permit expiry) are documented in the change notes,
// not counted as tests. No skip/mock path exists.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { execCommand } from "../../../packages/coding-agent/src/core/exec.ts";
import { createProcessRegistry } from "../../../packages/coding-agent/src/core/process-registry.ts";

const root = mkdtempSync(join(tmpdir(), "pi-windows-owner-"));
const artifact = process.env.PI_WINDOWS_OWNER_ARTIFACT;
const owner = process.env.PI_PROCESS_OWNER_TEST_BINARY;
const cli = process.env.PI_WINDOWS_OWNER_TEST_CLI;
const fixture = join(root, "owner-fixture.exe");
const ipcFixture = fileURLToPath(new URL("./windows-ipc.mjs", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const event of ["uncaughtException", "unhandledRejection"])
	process.on(event, (error) => {
		console.error(`gate ${event}: ${error?.stack ?? error}`);
		process.exitCode = 1;
	});
async function until(check, message, ms = 8000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		assert.ok(Date.now() < deadline, message);
		await delay(10);
	}
}
function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${JSON.stringify(pid)}`);
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}
function pids(directory) {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".pid"))
		.map((name) => Number(name.slice(0, -4)));
}
function directory() {
	return mkdtempSync(join(root, "tree-"));
}
async function run(command, args, options = {}) {
	const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
	const stdout = [];
	const stderr = [];
	child.stdout.on("data", (bytes) => stdout.push(bytes));
	child.stderr.on("data", (bytes) => stderr.push(bytes));
	const deadline = setTimeout(() => child.kill("SIGKILL"), 12000);
	let code;
	try {
		code = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
	} finally {
		clearTimeout(deadline);
	}
	return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}
// procward task control: fd3 carries the `PROCWARD/1` records; EOF is part of the
// completion contract. C with the expected scope plus EOF is the only success evidence.
function supervise(args, { control = true, retain = false, input, cwd, env } = {}) {
	const child = spawn(
		owner,
		["run", ...(control ? ["--control-fd", "3"] : []), ...(retain ? ["--retain-descendants"] : []), "--", ...args],
		{
			cwd,
			env: env && { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe", ...(control ? ["pipe"] : [])],
		},
	);
	let wire = "";
	const stdout = [];
	const stderr = [];
	if (control) {
		const lease = child.stdio[3];
		lease.setEncoding("utf8");
		lease.on("data", (text) => {
			wire += text;
		});
		lease.on("error", () => {});
	}
	if (input !== undefined) {
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	} else child.stdin.end();
	child.stdout.on("data", (bytes) => stdout.push(bytes));
	child.stderr.on("data", (bytes) => stderr.push(bytes));
	const closed = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	let deadline;
	const timeout = new Promise((_resolve, reject) => {
		deadline = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("native owner completion exceeded 10 seconds"));
		}, 10000);
	});
	const result = Promise.race([
		closed.then((code) => ({ code, wire, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })),
		timeout,
	]).finally(() => clearTimeout(deadline));
	void result.catch(() => {});
	return {
		child,
		lease: child.stdio[3],
		result,
		get wire() {
			return wire;
		},
	};
}
function nativeResult(scope) {
	const x = scope.wire.split("\n").find((line) => line.startsWith("PROCWARD/1 X "));
	assert.ok(x, `missing X record: ${JSON.stringify(scope.wire)}`);
	return Number(x.slice("PROCWARD/1 X ".length));
}
async function acknowledged(scope) {
	const result = await scope.result;
	assert.match(result.wire, /^PROCWARD\/1 S \d+ kernel\nPROCWARD\/1 X \d+\nPROCWARD\/1 C kernel\n$/);
	const primary = nativeResult(scope);
	// Bun 1.4.4 truncates the helper's public exit status to the low byte; Node keeps full u32.
	assert.equal(result.code, process.versions.bun ? primary % 256 : primary);
	assert.equal(scope.lease.readableEnded, true);
	return { ...result, code: primary };
}
function cancel(scope) {
	scope.lease.write("PROCWARD/1 CANCEL\n");
}

before(async () => {
	assert.equal(process.platform, "win32", "runtime gate requires Windows; no skip/mock allowed");
	assert.ok(
		["windows-x64-baseline", "windows-x64-modern", "windows-arm64"].includes(artifact),
		"identify shipped artifact",
	);
	assert.ok(owner && cli, "set shipped helper and CLI paths; no source-only substitute");
	console.log(
		JSON.stringify({
			artifact,
			platform: process.platform,
			arch: process.arch,
			runtime: process.versions,
			owner,
			cli,
			ownerSha256: createHash("sha256").update(readFileSync(owner)).digest("hex"),
			cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
		}),
	);
	const source = fileURLToPath(new URL("./windows-owner.cs", import.meta.url));
	const compile = await run(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $env:PI_OWNER_CS) -OutputAssembly $env:PI_OWNER_FIXTURE -OutputType ConsoleApplication",
		],
		{ env: { ...process.env, PI_OWNER_CS: source, PI_OWNER_FIXTURE: fixture } },
	);
	assert.equal(compile.code, 0, compile.stderr.toString());
	const token = await run(fixture, ["identity"]);
	console.log(`token=${token.stdout}`);
	assert.equal(token.code, 0, token.stderr.toString());
	const groups = await run("whoami.exe", ["/all"]);
	assert.equal(groups.code, 0);
	console.log(groups.stdout.toString());
	const account = await run("whoami.exe", []);
	console.log(
		JSON.stringify({
			gateIdentity: {
				...JSON.parse(token.stdout.toString()),
				name: account.stdout.toString().trim(),
				whoamiAll: groups.stdout.toString(),
			},
		}),
	);
	assert.match(groups.stdout.toString(), /S-1-16-8192\b/, "Medium integrity required");
	assert.doesNotMatch(
		groups.stdout.toString(),
		/S-1-5-32-544|S-1-16-(?:12288|16384)/,
		"genuinely nonadmin, non-elevated token required",
	);
});
after(() => rmSync(root, { recursive: true, force: true }));

// 1: shipped CLI starts; owned console and interactive TUI children handle Ctrl-C through ConPTY.
test("shipped CLI help and console/ConPTY Ctrl-C", { timeout: 30000 }, async () => {
	const help = await run(cli, ["--help"]);
	assert.equal(help.code, 0, help.stderr.toString());
	const consoleProbe = await run(fixture, ["conpty", owner]);
	assert.equal(consoleProbe.code, 0, consoleProbe.stderr.toString() + consoleProbe.stdout.toString());
	const tui = await run(fixture, ["tui", cli], {
		cwd: root,
		env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "config"), PI_OFFLINE: "1" },
	});
	assert.equal(tui.code, 0, tui.stderr.toString() + tui.stdout.toString());
});

// 2: full native u32 results; stdio bytes, argv, cwd, env and stdin are exactly preserved.
test("full native u32 status, exact stdio bytes, Unicode/empty argv, cwd/env/stdin", { timeout: 15000 }, async () => {
	for (const code of [0, 7, 125, 3221225477, 4294967295]) {
		const result = await acknowledged(supervise([fixture, "status", String(code)]));
		assert.equal(result.code, code);
	}
	const bytes = await acknowledged(supervise([fixture, "bytes"]));
	assert.deepEqual(bytes.stdout, Buffer.from([0, 255, 10, 13, 0, 128, 65]));
	assert.deepEqual(bytes.stderr, Buffer.from([65, 128, 0, 13, 10, 255, 0]));
	const args = ["", 'space quote" slash\\', "世界 λ", "tail \\"];
	const argv = await acknowledged(supervise([fixture, "args", ...args]));
	assert.deepEqual(
		argv.stdout.toString().trimEnd().split(/\r?\n/).slice(1),
		args.map((arg) => Buffer.from(arg).toString("base64")),
	);
	const cwd = directory();
	const context = await acknowledged(
		supervise([fixture, "context"], { cwd, env: { PI_OWNER_CONTEXT: "env 世界" }, input: "payload stdin λ\n" }),
	);
	assert.equal(context.code, 0);
	assert.equal(context.stdout.toString(), `${cwd}\r\nenv 世界\r\npayload stdin λ\n`);
});

// 3: natural primary exit empties recursive/new-console descendants; an unrelated peer lives.
test(
	"primary exit empties all recursive/new-console descendants; unrelated same-user peer lives",
	{ timeout: 15000 },
	async () => {
		const dir = directory();
		const peerDir = directory();
		const peer = spawn(fixture, ["leaf", peerDir], { stdio: "ignore" });
		const scope = supervise([fixture, "tree", dir, "exit"]);
		try {
			await until(() => pids(dir).length === 3, "immediate recursive descendants not ready");
			await until(() => scope.wire.startsWith("PROCWARD/1 S"), "missing ownership startup");
			assert.equal((await acknowledged(scope)).code, 7);
			assert.ok(
				pids(dir).every((pid) => !alive(pid)),
				"owned process survived acknowledged return",
			);
			assert.ok(alive(peer.pid), "unrelated same-user session was killed");
		} finally {
			scope.child.kill("SIGKILL");
			peer.kill("SIGKILL");
			for (const pid of pids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL");
		}
	},
);

// 4: CANCEL and controller EOF both cancel the live scope; every owned descendant dies.
test("CANCEL and controller EOF cancel the whole scope", { timeout: 15000 }, async () => {
	for (const eof of [false, true]) {
		const dir = directory();
		const scope = supervise([fixture, "tree", dir, "wait"]);
		try {
			await until(() => pids(dir).length === 3 && scope.wire.startsWith("PROCWARD/1 S"), "scope not ready");
			if (eof) scope.lease.destroy();
			else cancel(scope);
			const result = await scope.result;
			if (!eof) {
				assert.match(result.wire, /^PROCWARD\/1 S \d+ kernel\nPROCWARD\/1 X \d+\nPROCWARD\/1 C kernel\n$/);
			}
			await until(() => pids(dir).every((pid) => !alive(pid)), "owned descendants survived cancellation");
		} finally {
			scope.child.kill("SIGKILL");
			for (const pid of pids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL");
		}
	}
});

// 5: Windows Job breakaway must be denied for ordinary children.
test("breakaway is denied", { timeout: 15000 }, async () => {
	const result = await acknowledged(supervise([fixture, "breakaway", directory()]));
	assert.equal(result.code, 0);
});

// 6: a missing executable fails before payload; an invalid control request fails
// control and cleans the scope — neither is ever acknowledged.
test("absent executable and invalid control request fail closed before payload", { timeout: 15000 }, async () => {
	const missing = await supervise([join(root, "absent.exe")]).result;
	assert.equal(missing.code, 125);
	assert.match(missing.wire, /^PROCWARD\/1 S \d+ kernel\nPROCWARD\/1 E 125\n$/);
	const dir = directory();
	const scope = supervise([fixture, "tree", dir, "wait"]);
	try {
		await until(() => pids(dir).length === 3 && scope.wire.startsWith("PROCWARD/1 S"), "scope not ready");
		scope.lease.write("PROCWARD/1 NOISE\n");
		const result = await scope.result;
		assert.equal(result.code, 125);
		assert.ok(!result.wire.includes("C kernel"), "invalid control request cannot be acknowledged");
		await until(() => pids(dir).every((pid) => !alive(pid)), "owned descendants survived invalid control");
	} finally {
		scope.child.kill("SIGKILL");
		for (const pid of pids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL");
	}
});

// 7: retained descendants outlive the primary's return; CANCEL completes their cleanup.
test("retained descendants outlive the primary and CANCEL completes cleanup", { timeout: 20000 }, async () => {
	const dir = directory();
	const scope = supervise([fixture, "tree", dir, "exit"], { retain: true });
	try {
		await until(() => pids(dir).length === 3 && scope.wire.includes("PROCWARD/1 X "), "retained scope not ready");
		assert.equal(nativeResult(scope), 7);
		assert.equal(scope.child.exitCode, null, "helper must keep running while retained work is alive");
		// The returned primary also marked itself; exactly its two descendants must remain.
		assert.equal(
			pids(dir).filter((pid) => alive(pid)).length,
			2,
			"retained descendants died after the primary returned",
		);
		cancel(scope);
		const result = await scope.result;
		assert.match(result.wire, /^PROCWARD\/1 S \d+ kernel\nPROCWARD\/1 X 7\nPROCWARD\/1 C kernel\n$/);
		assert.ok(
			pids(dir).every((pid) => !alive(pid)),
			"retained descendants survived cancellation",
		);
	} finally {
		scope.child.kill("SIGKILL");
		for (const pid of pids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL");
	}
});

// 8: Node/Bun fork IPC, TCP handle transfer and disconnect keep working inside the Job.
test("Node/Bun fork message, TCP handle transfer and disconnect through the Job", { timeout: 20000 }, async () => {
	// Ownership must be transparent: the owned run reproduces this runtime's direct behavior.
	const direct = await run(process.execPath, [ipcFixture]);
	if (!process.versions.bun) {
		assert.equal(direct.code, 7, direct.stderr.toString());
		assert.equal(direct.stdout.toString(), "ipc-ok");
	}
	const owned = await acknowledged(supervise([process.execPath, ipcFixture]));
	assert.deepEqual(
		{ code: owned.code % (process.versions.bun ? 256 : 2 ** 32), stdout: owned.stdout.toString() },
		{ code: direct.code, stdout: direct.stdout.toString() },
		`owned stderr: ${owned.stderr}; direct stderr: ${direct.stderr}`,
	);
});

// 9: execCommand's abort and timeout cancel the owned tree; the caller must not
// return before the scope is confirmed clean.
test("execCommand abort and timeout cancel the owned tree before the caller returns", { timeout: 25000 }, async () => {
	const previous = process.env.PI_PROCWARD_BIN;
	process.env.PI_PROCWARD_BIN = owner;
	const dirs = [];
	const registries = [];
	const ownership = (registry) => ({
		registry,
		purpose: "runtime gate exec",
		provenance: { toolName: "windows-owner-runtime", toolCallId: "gate" },
	});
	try {
		// Same public status as a direct execCommand, including Bun's low-byte boundary.
		const direct = await execCommand(fixture, ["status", "3221225477"], root);
		const owned = await execCommand(
			fixture,
			["status", "3221225477"],
			root,
			undefined,
			ownership(createProcessRegistry()),
		);
		assert.deepEqual(owned, direct);
		assert.equal(direct.code, process.versions.bun ? 3221225477 % 256 : 3221225477);
		for (const mode of ["abort", "timeout"]) {
			const dir = directory();
			dirs.push(dir);
			const registry = createProcessRegistry();
			registries.push(registry);
			const controller = new AbortController();
			const pending = execCommand(
				fixture,
				["tree", dir, "wait"],
				root,
				{
					signal: mode === "abort" ? controller.signal : undefined,
					timeout: mode === "timeout" ? 2500 : undefined,
				},
				ownership(registry),
			);
			if (mode === "abort") {
				await until(() => pids(dir).length === 3, "abort fixture not ready");
				controller.abort();
			}
			const result = await pending;
			assert.equal(result.killed, true);
			// The wait-mode primary never returns naturally; a nonzero result proves the cancel path.
			assert.notEqual(result.code, 94);
			assert.ok(
				pids(dir).every((pid) => !alive(pid)),
				"caller returned before owned cleanup",
			);
			await registry.close();
		}
	} finally {
		for (const registry of registries) void registry.close();
		for (const dir of dirs) for (const pid of pids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL");
		if (previous === undefined) delete process.env.PI_PROCWARD_BIN;
		else process.env.PI_PROCWARD_BIN = previous;
	}
});

// 10: Windows PowerShell and Git Bash preserve shell-specific quoting through ownership.
test("Windows PowerShell and Git Bash preserve shell-specific quoting", { timeout: 15000 }, async () => {
	const powershell =
		"$b=[Text.Encoding]::UTF8.GetBytes('quote '' space 世界');[Console]::OpenStandardOutput().Write($b,0,$b.Length);exit 7";
	const ps = await acknowledged(supervise(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", powershell]));
	assert.equal(ps.code, 7);
	assert.equal(ps.stdout.toString(), "quote ' space 世界");
	const bash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
	const sh = await acknowledged(supervise([bash, "-c", "printf '%s\\n' 'space \" quote 世界'; exit 7"]));
	assert.equal(sh.code, 7);
	assert.equal(sh.stdout.toString(), 'space " quote 世界\n');
});
