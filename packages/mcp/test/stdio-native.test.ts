import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpClient, StdioTransport } from "../src/index.ts";
import type { JsonRpcSuccessResponse } from "../src/protocol/jsonrpc.ts";

const binary = process.env.PI_MCP_TEST_OWNER_BINARY;
const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
const lifetime = fileURLToPath(new URL("./fixtures/stdio-lifetime.mjs", import.meta.url));
const originalOwner = process.env.PI_PROCESS_OWNER_BINARY;
const transports: StdioTransport[] = [];
let directory: string;

function exists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

function makeTransport(
	command: string,
	args: string[] = [],
	extra: Partial<ConstructorParameters<typeof StdioTransport>[0]> = {},
): StdioTransport {
	const transport = new StdioTransport({ command, args, cwd: directory, ...extra });
	transports.push(transport);
	return transport;
}

function lifetimeTransport(mode: string) {
	let output = "";
	let ready: (pid: number) => void;
	const daemon = new Promise<number>((resolve) => {
		ready = resolve;
	});
	const transport = makeTransport(process.execPath, [lifetime, mode], {
		closeTimeoutMs: 120,
		onStderr(chunk) {
			output += chunk;
			const match = /daemon (\d+)/.exec(output);
			if (match) ready(Number(match[1]));
		},
	});
	return { transport, daemon };
}

describe.skipIf(!binary || process.platform !== "linux")("native StdioTransport", () => {
	beforeEach(async () => {
		expect(process.getuid?.()).toBeGreaterThan(0);
		expect(process.geteuid?.()).toBeGreaterThan(0);
		expect(process.getgid?.()).toBeGreaterThan(0);
		expect(process.getegid?.()).toBeGreaterThan(0);
		const status = readFileSync("/proc/self/status", "utf8");
		for (const cap of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {
			expect(status).toMatch(new RegExp(`${cap}:\\s+0000000000000000`));
		}
		await mkdir(join(tmpdir(), "mcp-native"), { recursive: true });
		directory = await mkdtemp(join(tmpdir(), "mcp-native/case-"));
		process.env.PI_PROCESS_OWNER_BINARY = binary;
	});

	afterEach(async () => {
		await Promise.all(transports.splice(0).map((transport) => transport.close()));
		vi.restoreAllMocks();
		if (originalOwner === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
		else process.env.PI_PROCESS_OWNER_BINARY = originalOwner;
		await rm(directory, { recursive: true, force: true });
	});

	it("rejects missing helper with its infrastructure identity, never reports ready", async () => {
		const missing = `${binary}.missing`;
		process.env.PI_PROCESS_OWNER_BINARY = missing;
		const transport = makeTransport(process.execPath, [fixture]);
		let closed = false;
		transport.onClose(() => {
			closed = true;
		});
		await expect(transport.start()).rejects.toMatchObject({
			code: "ENOENT",
			errno: -osConstants.errno.ENOENT,
			syscall: `spawn ${missing}`,
			path: missing,
			spawnargs: ["supervise", "--control-fd", "3", "--", process.execPath, fixture],
		});
		expect(closed).toBe(true);
		expect(transport.pid).toBeUndefined();
		expect(transport.stderr).toBe("");
	});

	it.each(["ENOENT", "EACCES"] as const)("rejects %s only after owner cleanup", async (code) => {
		const command = join(directory, "server");
		if (code === "EACCES") {
			await writeFile(command, "not executable\n");
			await chmod(command, 0o600);
		}
		const transport = makeTransport(command, ["original-arg"]);
		let closed = false;
		transport.onClose(() => {
			closed = true;
		});
		await expect(transport.start()).rejects.toMatchObject({
			code,
			errno: -osConstants.errno[code],
			syscall: `spawn ${command}`,
			path: command,
			spawnargs: ["original-arg"],
		});
		expect(closed).toBe(true);
		expect(transport.pid).toBeUndefined();
		expect(transport.stderr).toBe("");
	});

	it.each(["pipe", "inherit"] as const)(
		"preserves real %s stderr and spawn failures",
		async (mode) => {
			const denied = join(directory, "non-executable");
			await writeFile(denied, "not executable\n", { mode: 0o600 });
			for (const command of [undefined, join(directory, "missing"), denied]) {
				const host = spawn(
					process.execPath,
					[
						fileURLToPath(new URL("./fixtures/stdio-stderr-host.mjs", import.meta.url)),
						mode,
						...(command ? [command] : []),
					],
					{ cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
				);
				let output = "";
				let stderr = "";
				host.stdout.on("data", (chunk: Buffer) => {
					output += chunk.toString();
				});
				host.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				const status = await new Promise<number | null>((resolve, reject) => {
					host.once("error", reject);
					host.once("close", resolve);
				});
				expect(status, stderr).toBe(0);
				expect(JSON.parse(output)).toMatchObject({ mode, closed: true, failed: Boolean(command) });
				expect(stderr).toBe(
					!command && mode === "inherit" ? 'E2 genuine stderr; S{"pid":1}; pi-env supervise: GENUINE--TAIL' : "",
				);
			}
		},
		5_000,
	);

	it("preserves RPC, real pid, cwd, env, args and immediate genuine stderr", async () => {
		const transport = makeTransport(process.execPath, [fixture, "arg"], {
			inheritEnv: false,
			env: { MCP_TEST_VALUE: "kept", PI_PROCESS_OWNER_BINARY: "/cannot/bypass/host" },
		});
		const client = new McpClient({ name: "native-test", version: "1" });
		await client.connect(transport);
		const info = new Promise<JsonRpcSuccessResponse>((resolve) =>
			transport.onMessage((message) => {
				if ("id" in message && message.id === 77 && "result" in message) resolve(message);
			}),
		);
		await transport.send({ jsonrpc: "2.0", id: 77, method: "test/info" });
		expect((await info).result).toEqual({ pid: transport.pid, cwd: directory, value: "kept", argv: ["arg"] });
		expect(readFileSync(`/proc/${transport.pid}/comm`, "utf8").trim()).not.toBe("pi-env");
		expect(transport.stderr).toContain('E2 genuine server stderr; S{"pid":1}');
		expect(await client.callTool("echo", { text: "native roundtrip" })).toEqual({
			content: [{ type: "text", text: "native roundtrip" }],
		});
		// Capture is immutable: later host environment changes cannot change shutdown mode.
		delete process.env.PI_PROCESS_OWNER_BINARY;
		await client.close();
	});

	it.each(["eof", "term", "stubborn"])(
		"awaits double-fork disappearance on concurrent %s close",
		async (mode) => {
			const signals = vi.spyOn(process, "kill");
			const peer = makeTransport(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { closeTimeoutMs: 120 });
			await peer.start();
			const peerPid = peer.pid as number;
			try {
				const { transport, daemon } = lifetimeTransport(mode);
				await transport.start();
				const pid = await daemon;
				const ownerPid = Number(/^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${transport.pid}/status`, "utf8"))?.[1]);
				expect(ownerPid).toBeGreaterThan(0);
				expect(exists(pid)).toBe(true);
				let aliveAtClose: boolean | undefined;
				transport.onClose(() => {
					aliveAtClose = exists(pid);
				});
				const start = Date.now();
				await Promise.all([transport.close(), transport.close(), transport.close()]);
				expect(exists(ownerPid)).toBe(false);
				expect(exists(pid)).toBe(false);
				expect(aliveAtClose).toBe(false);
				expect(exists(peerPid)).toBe(true);
				if (mode !== "eof") expect(transport.stderr).toContain("term received");
				if (mode === "stubborn") expect(Date.now() - start).toBeGreaterThanOrEqual(220);
				if (mode === "term") expect(Date.now() - start).toBeLessThan(1_000);
				expect(transport.stderr).toContain("stdin closed");
				await transport.close();
				expect(signals.mock.calls.filter(([pid]) => pid < 0)).toEqual([]);
			} finally {
				await peer.close();
				expect(exists(peerPid)).toBe(false);
			}
		},
		5_000,
	);

	it.each(["7", "125", "SIGTERM"])("accepts real primary %s with confirmed cleanup", async (status) => {
		const transport = makeTransport(process.execPath, [
			"-e",
			status === "SIGTERM" ? 'process.kill(process.pid, "SIGTERM")' : `process.exitCode = ${status}`,
		]);
		const errors: Error[] = [];
		transport.onError((error) => errors.push(error));
		const closed = new Promise<void>((resolve) => transport.onClose(resolve));
		await transport.start();
		const pid = transport.pid as number;
		await closed;
		await transport.close();
		expect(exists(pid)).toBe(false);
		expect(errors).toEqual([]);
	});

	it("reaps finite C fixture and preserves an unrelated owned peer at awaited return", async () => {
		const nativeFixture = process.env.PI_PROCESS_OWNER_TEST_FIXTURE;
		expect(nativeFixture).toBeTruthy();
		const peer = makeTransport(nativeFixture as string, ["--peer"], { closeTimeoutMs: 120 });
		await peer.start();
		const peerPid = peer.pid as number;
		let output = "";
		let ready: (pid: number) => void;
		const daemon = new Promise<number>((resolve) => {
			ready = resolve;
		});
		const transport = makeTransport(
			process.execPath,
			[
				"-e",
				`
			const { spawn } = require("node:child_process");
			const child = spawn(process.argv[1], [process.argv[2], "8", "linger"], {
				stdio: ["ignore", "pipe", "inherit"]
			});
			child.on("error", (error) => { throw error; });
			child.stdout.on("data", (chunk) => process.stderr.write("daemon " + chunk));
			process.stdin.resume();
			process.stdin.on("end", () => process.exit(0));
			setTimeout(() => process.exit(90), 8000);
		`,
				nativeFixture as string,
				directory,
			],
			{
				closeTimeoutMs: 120,
				onStderr(chunk) {
					output += chunk;
					const match = /daemon (\d+)/.exec(output);
					if (match) ready(Number(match[1]));
				},
			},
		);
		try {
			await transport.start();
			const pid = await daemon;
			const identity = JSON.parse(readFileSync(join(directory, "daemon.ready"), "utf8")) as {
				pid: number;
				uid: number;
				euid: number;
				gid: number;
				egid: number;
				caps: string[];
			};
			expect(identity.pid).toBe(pid);
			for (const key of ["uid", "euid", "gid", "egid"] as const) expect(identity[key]).toBe(1000);
			expect(identity.caps).toEqual(Array(4).fill("0000000000000000"));
			expect(exists(pid)).toBe(true);
			await transport.close();
			expect(exists(pid)).toBe(false);
			expect(exists(peerPid)).toBe(true);
		} finally {
			await peer.close();
			expect(exists(peerPid)).toBe(false);
		}
	}, 5_000);

	it("exit hook cancels owner lease without killing guardian; inherited pipe fences cleanup", async () => {
		const host = spawn(
			process.execPath,
			[fileURLToPath(new URL("./fixtures/stdio-exit-host.mjs", import.meta.url))],
			{
				cwd: directory,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		let stderr = "";
		host.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		host.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const status = await new Promise<number | null>((resolve, reject) => {
			host.once("error", reject);
			host.once("close", resolve);
		});
		expect(status, stderr).toBe(0);
		const info: { primary: number; daemon: number } = JSON.parse(output);
		expect(exists(info.primary)).toBe(false);
		expect(exists(info.daemon)).toBe(false);
	}, 5_000);

	it("emits normal closed only after detached daemon is reaped, host remains live", async () => {
		const signals = vi.spyOn(process, "kill");
		const { transport, daemon } = lifetimeTransport("stubborn");
		await transport.start();
		const pid = await daemon;
		const closed = new Promise<boolean>((resolve) => transport.onClose(() => resolve(exists(pid))));
		await transport.send({ jsonrpc: "2.0", id: 1, method: "exit" });
		expect(await closed).toBe(false);
		expect(exists(pid)).toBe(false);
		await transport.close();
		expect(signals.mock.calls.filter(([target]) => target < 0)).toEqual([]);
	});
});
