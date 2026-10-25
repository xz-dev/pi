import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("cross-spawn", () => ({ default: spawn }));

import { StdioTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import { McpOAuthCredentialStore, McpServerConnection } from "../src/extensions/mcp/runtime.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const cleanupCode = { code: "ERR_PROCESS_OWNER_CLEANUP" };
const credentials = () => new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
afterEach(() => {
	spawn.mockReset();
	vi.unstubAllEnvs();
});

// UNIT faults only; public transport factory uses source workspace client/runtime, no credentials or network.
function setup(answerInitialize = true) {
	vi.stubEnv("PI_PROCESS_OWNER_BINARY", "/synthetic-owner");
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const control = new Duplex({
		read() {},
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
	const child = Object.assign(new EventEmitter(), {
		pid: 2147483647,
		exitCode: null,
		signalCode: null,
		kill: vi.fn(() => true),
		stdin,
		stdout,
		stderr,
		stdio: [stdin, stdout, stderr, control],
	});
	spawn.mockImplementationOnce(() => {
		queueMicrotask(() => {
			child.emit("spawn");
			control.push('S{"pid":123}\n');
		});
		return child;
	});
	let initialized: () => void;
	const initializing = new Promise<void>((resolve) => {
		initialized = resolve;
	});
	stdin.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString().trim().split("\n")) {
			const message = JSON.parse(line) as { id?: number; method?: string };
			if (message.method !== "initialize") continue;
			initialized();
			if (answerInitialize)
				stdout.write(
					`${JSON.stringify({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: "2025-06-18",
							capabilities: {},
							serverInfo: { name: "fake", version: "1" },
						},
					})}\n`,
				);
		}
	});
	const transport = new StdioTransport({ command: "/server", closeTimeoutMs: 10 });
	let created = 0;
	const connection = new McpServerConnection({
		entry: { name: "fake", source: "test", config: { command: "/server" } },
		cwd: tmpdir(),
		credentials: credentials(),
		createTransport: () => {
			created++;
			return transport;
		},
		onTools: () => {},
	});
	return {
		connection,
		initializing,
		created: () => created,
		report: (text: string) => control.push(text),
		end: () => control.push(null),
		finish: (code = 0) => {
			Object.defineProperty(child, "exitCode", { value: code });
			child.emit("exit", code, null);
			child.emit("close", code, null);
		},
	};
}

describe("MCP owner cleanup propagation", () => {
	it.each([0, 125])("joins concurrent connection closes and reports missing C for %i", async (code) => {
		const s = setup();
		await s.connection.getClient();
		expect(s.connection.state).toBe("connected");
		let settled = 0;
		const closes = [s.connection.close(), s.connection.close()].map((work) =>
			work.then(
				() => {
					settled++;
				},
				(error: unknown) => {
					settled++;
					return error;
				},
			),
		);
		s.report(`X{"code":${code},"signal":null}\n`);
		s.end();
		await tick();
		expect(settled).toBe(0);
		s.finish(code);
		for (const result of await Promise.all(closes)) expect(result).toMatchObject(cleanupCode);
		await expect(s.connection.close()).rejects.toMatchObject(cleanupCode);
	});

	it("does not settle connection closes on C or helper close before control drain", async () => {
		const s = setup();
		await s.connection.getClient();
		let settled = 0;
		const closes = [s.connection.close(), s.connection.close()].map((work) =>
			work.then(() => {
				settled++;
			}),
		);
		s.report('X{"code":125,"signal":null}\nC\n');
		await tick();
		expect(settled).toBe(0);
		s.finish(125);
		await tick();
		expect(settled).toBe(0);
		s.end();
		await Promise.all(closes);
		expect(settled).toBe(2);
	});

	it("retains cleanup failure after spontaneous close instead of reconnecting", async () => {
		const s = setup();
		await s.connection.getClient();
		s.report('X{"code":0,"signal":null}\n');
		s.finish();
		s.end();
		await tick();
		expect(s.connection.state).toBe("failed");
		expect(s.connection.error).toContain("cleanup unconfirmed");
		await expect(s.connection.getClient()).rejects.toMatchObject(cleanupCode);
		expect(s.created()).toBe(1);
		await expect(s.connection.close()).rejects.toMatchObject(cleanupCode);
	});

	it("propagates cleanup failure while setup is aborted and joins both fences", async () => {
		const s = setup(false);
		const opening = s.connection.getClient().catch((error: unknown) => error);
		await s.initializing;
		let settled = false;
		const closing = s.connection.close().catch((error: unknown) => {
			settled = true;
			return error;
		});
		s.report('X{"code":0,"signal":null}\n');
		s.finish();
		await tick();
		expect(settled).toBe(false);
		s.end();
		expect(await closing).toMatchObject(cleanupCode);
		expect(await opening).toMatchObject(cleanupCode);
	});

	it("joins a reconnect already closing its detached client", async () => {
		const s = setup();
		await s.connection.getClient();
		const reconnect = s.connection.reconnect().catch((error: unknown) => error);
		await tick();
		let settled = false;
		const closing = s.connection.close().catch((error: unknown) => {
			settled = true;
			return error;
		});
		s.report('X{"code":0,"signal":null}\n');
		s.end();
		await tick();
		expect(settled).toBe(false);
		s.finish();
		expect(await reconnect).toMatchObject(cleanupCode);
		expect(await closing).toMatchObject(cleanupCode);
		expect(s.created()).toBe(1);
	});

	it("propagates generated helper mismatch through runtime and blocks reconnect", async () => {
		const s = setup();
		await s.connection.getClient();
		s.report('X{"code":0,"signal":null}\nC\n');
		s.finish(125);
		await tick();
		expect(s.connection.state).toBe("connected");
		s.end();
		await tick();
		expect(s.connection.state).toBe("failed");
		expect(s.connection.error).toContain("cleanup unconfirmed");
		await expect(s.connection.getClient()).rejects.toMatchObject(cleanupCode);
		expect(s.created()).toBe(1);
		const results = await Promise.allSettled([s.connection.close(), s.connection.close()]);
		for (const result of results) expect(result).toMatchObject({ status: "rejected", reason: cleanupCode });
	});

	it.each(["missing-C", "bad-helper"])(
		"reaches builtin CLI close boundary for %s without printing connected",
		async (fault) => {
			const s = setup();
			const directory = mkdtempSync(join(tmpdir(), "mcp-owner-cli-"));
			const output: string[] = [];
			try {
				writeFileSync(
					join(directory, "mcp.json"),
					JSON.stringify({ mcpServers: { fake: { command: "/server" } } }),
				);
				const result = runMcpCommand(["list"], {
					cwd: directory,
					agentDir: directory,
					credentials: credentials(),
					log: (line) => output.push(line),
					error: (line) => output.push(line),
				}).catch((error: unknown) => error);
				await s.initializing;
				await tick();
				s.report(`X{"code":0,"signal":null}\n${fault === "bad-helper" ? "C\n" : ""}`);
				s.finish(fault === "bad-helper" ? 125 : 0);
				s.end();
				expect(await result).toMatchObject(cleanupCode);
				expect(output.join("\n")).not.toContain("connected");
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("retains intentional HTTP shutdown error suppression", async () => {
		const pair = createInMemoryTransportPair();
		pair.server.onMessage((message) => {
			if (!("id" in message)) return;
			void pair.server.send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					serverInfo: { name: "http-unit", version: "1" },
				},
			});
		});
		await pair.server.start();
		const connection = new McpServerConnection({
			entry: {
				name: "http",
				source: "test",
				config: { url: "https://unused.invalid", headers: { Authorization: "unit" } },
			},
			cwd: tmpdir(),
			credentials: credentials(),
			createTransport: () => pair.client,
			onTools: () => {},
		});
		await connection.getClient();
		const close = vi.spyOn(pair.client, "close").mockRejectedValue(new Error("HTTP shutdown failed"));
		await connection.close();
		close.mockRestore();
		await pair.server.close();
	});
});
