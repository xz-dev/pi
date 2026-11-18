import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/managed-child-runtime.mjs", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const directory = mkdtempSync(join(tmpdir(), "pi-runtime-compatibility-"));
const compiled = join(directory, "runtime-fixture");
const execPeer = join(directory, "exec-peer.mjs");
const runtimes = ["node", "bun", "compiled-bun"];

beforeAll(() => {
	writeFileSync(
		execPeer,
		`#!${process.execPath}\nconsole.log(JSON.stringify({pid:process.pid,args:process.argv.slice(2),nonce:process.env.PI_PROCWARD_BOOTSTRAP_NONCE,sentinel:process.env.PI_RUNTIME_SENTINEL}));\nprocess.exitCode=23;\n`,
		{ mode: 0o700 },
	);
	if (bunAvailable) {
		const result = spawnSync("bun", ["build", "--compile", fixture, "--outfile", compiled], {
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(result.status, result.stderr).toBe(0);
	}
}, 35_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function invocation(runtime: string): { command: string; args: string[] } {
	return runtime === "compiled-bun"
		? { command: compiled, args: [] }
		: { command: runtime === "node" ? process.execPath : "bun", args: [fixture] };
}

function environment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("PROCWARD_") || key === "PI_PROCWARD_BOOTSTRAP_NONCE" || key === "PI_NO_PROCESS_OWNERSHIP")
			delete env[key];
	}
	return env;
}

interface LifecycleResult {
	mode: string;
	flags: string;
	caught?: { message: string; code?: string };
	readyMs?: number;
	elapsedMs: number;
	remaining: number;
	active?: number;
	repeatedStopPreservedFd?: boolean;
}

async function lifecycle(runtime: string, transport: string, mode: string): Promise<LifecycleResult> {
	const launch = invocation(runtime);
	const fifo = join(directory, `${runtime}-${transport}-${mode}`);
	let reader: number | undefined;
	let writer: number | undefined;
	if (transport !== "socketpair") {
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		const sentinel = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
		// The sentinel is a writer, so a blocking open returns at once. Open the inherited reader
		// blocking: whether a spawning runtime clears O_NONBLOCK on a shared description varies by
		// Node version, and the nonblocking case reopens fd 3 in the child explicitly.
		reader = openSync(fifo, constants.O_RDONLY);
		writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
		closeSync(sentinel);
	}
	const child = spawn(launch.command, [...launch.args, mode], {
		env: { ...environment(), PI_RUNTIME_NONBLOCK: transport === "nonblocking-fifo" ? "1" : "0" },
		stdio: ["ignore", "pipe", "pipe", reader ?? "pipe"],
	});
	if (reader !== undefined) closeSync(reader);
	let stdout = "";
	let stderr = "";
	let guarded = false;
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const endpoint = child.stdio[3];
	if (endpoint instanceof Duplex)
		endpoint.on("error", (error: Error) => {
			stderr += error.message;
		});
	const timers: NodeJS.Timeout[] = [];
	if (mode === "valid" || mode === "fragmented") {
		const ready = `PROCWARD/1 READY ${process.pid} ${child.pid} parent ${"a".repeat(32)}\n`;
		const pieces: [number, string][] =
			mode === "fragmented"
				? [
						[150, ready.slice(0, 17)],
						[210, ready.slice(17, -1)],
						[260, "\n"],
					]
				: [[150, ready]];
		for (const [ms, text] of pieces)
			timers.push(
				setTimeout(() => {
					if (writer !== undefined) writeSync(writer, text);
					else if (endpoint instanceof Duplex) endpoint.write(text);
				}, ms),
			);
	}
	const guard = setTimeout(() => {
		guarded = true;
		child.kill("SIGKILL");
	}, 4000);
	try {
		const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		expect(guarded, stdout + stderr).toBe(false);
		expect(result, stdout + stderr).toEqual({ code: 0, signal: null });
		expect(stderr).toBe("");
		return JSON.parse(stdout) as LifecycleResult;
	} finally {
		clearTimeout(guard);
		for (const timer of timers) clearTimeout(timer);
		if (writer !== undefined) closeSync(writer);
		if (endpoint instanceof Duplex) endpoint.destroy();
	}
}

describe.skipIf(process.platform !== "linux")("controlled runtime lifecycle compatibility (no native helper)", () => {
	for (const runtime of runtimes) {
		for (const transport of ["fifo", "nonblocking-fifo", "socketpair"]) {
			test.skipIf(runtime !== "node" && !bunAvailable).each(["valid", "fragmented", "never", "stop"])(
				`${runtime} ${transport}: %s`,
				async (mode) => {
					const result = await lifecycle(runtime, transport, mode);
					expect((Number.parseInt(result.flags, 8) & constants.O_NONBLOCK) !== 0).toBe(
						transport === "nonblocking-fifo",
					);
					if (mode === "valid" || mode === "fragmented") {
						expect(result.caught).toBeUndefined();
						expect(result.readyMs).toBeLessThan(2000);
						// The fixture's own 400ms pause after READY; both ends are rounded to whole milliseconds.
						expect(result.elapsedMs - result.readyMs!).toBeGreaterThanOrEqual(399);
					} else if (mode === "never") {
						expect(result.caught?.message).toBe("procward: READY startup deadline exceeded");
						expect(result.elapsedMs).toBeGreaterThanOrEqual(2000);
						expect(result.elapsedMs).toBeLessThan(2600);
						expect(result.remaining).toBe(0);
					} else {
						expect(result.active).toBeGreaterThan(0);
						expect(result.remaining).toBe(0);
						expect(result.repeatedStopPreservedFd).toBe(true);
					}
				},
			);
		}
		if (runtime !== "node")
			test.skipIf(!bunAvailable).each(["invalid", "closed"])(
				`${runtime}: %s descriptor fails before transfer`,
				async (mode) => {
					const result = await lifecycle(runtime, "socketpair", mode);
					expect(result.caught?.code).toBe("EBADF");
					expect(result.elapsedMs).toBeLessThan(500);
					expect(result.remaining).toBe(0);
				},
			);
	}
});

describe.skipIf(process.platform === "win32")("runtime PID-preserving exec with a controlled Node peer", () => {
	for (const runtime of runtimes)
		test.skipIf(runtime !== "node" && !bunAvailable)(
			`${runtime} preserves PID, arguments, environment, and quiet owner launch`,
			() => {
				const launch = invocation(runtime);
				const args = ["--model", "--no-process-ownership", "name with spaces", "--help"];
				const result = spawnSync(launch.command, [...launch.args, ...args], {
					env: {
						...environment(),
						PI_RUNTIME_EXEC_PEER: execPeer,
						PI_RUNTIME_SENTINEL: "preserved",
						PI_RUNTIME_STANDALONE: runtime === "compiled-bun" ? "1" : "0",
					},
					encoding: "utf8",
					timeout: 4000,
				});
				expect(result.status, result.stderr).toBe(23);
				expect(result.stderr).toBe("");
				const [before, after] = result.stdout
					.trim()
					.split("\n")
					.map((line: string) => JSON.parse(line));
				expect(after.pid).toBe(before.pid);
				expect(after.args).toEqual([
					"run",
					"--quiet",
					"--",
					runtime === "compiled-bun"
						? compiled
						: runtime === "node"
							? process.execPath
							: expect.stringMatching(/bun$/),
					...(runtime === "compiled-bun" ? [] : [...before.execArgv, before.entry]),
					...args,
				]);
				expect(after.nonce).toMatch(/^[0-9a-f]{32}$/);
				expect(after.sentinel).toBe("preserved");
			},
		);
});
