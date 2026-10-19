import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("cross-spawn", () => ({ default: spawn }));

import { McpClient } from "../src/client.ts";
import { StdioTransport } from "../src/transports/stdio.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const cleanupCode = { code: "ERR_PROCESS_OWNER_CLEANUP" };
afterEach(() => {
	spawn.mockReset();
	vi.unstubAllEnvs();
});

// UNIT protocol/fence tests only. Synthetic children provide no containment evidence.
function setup(launched = true) {
	vi.stubEnv("PI_PROCESS_OWNER_BINARY", "/synthetic-owner");
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let cancellation = "";
	const control = new Duplex({
		read() {},
		write(chunk: Buffer, _encoding, callback) {
			cancellation += chunk.toString();
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
	spawn.mockReturnValueOnce(child);
	const transport = new StdioTransport({ command: "/server", args: ["arg"], closeTimeoutMs: 10 });
	const errors: Error[] = [];
	let closed = false;
	transport.onError((error) => errors.push(error));
	transport.onClose(() => {
		closed = true;
	});
	const startup = transport.start().then(
		() => undefined,
		(error: unknown) => error,
	);
	if (launched) child.emit("spawn");
	const report = (text: string) => control.push(text);
	const finish = (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
		Object.defineProperty(child, "exitCode", { value: code });
		Object.defineProperty(child, "signalCode", { value: signal });
		child.emit("exit", code, signal);
		child.emit("close", code, signal);
	};
	return {
		transport,
		child,
		control,
		stdout,
		startup,
		report,
		finish,
		errors,
		closed: () => closed,
		cancellation: () => cancellation,
	};
}

describe("process owner completion", () => {
	it.each([0, 125])("rejects matching %i status without C after both fences", async (code) => {
		const s = setup();
		s.report('S{"pid":123}\n');
		expect(await s.startup).toBeUndefined();
		s.report(`X{"code":${code},"signal":null}\n`);
		const close = s.transport.close();
		const result = close.catch((error: unknown) => error);
		s.control.push(null);
		await tick();
		expect(s.closed()).toBe(false);
		expect(s.errors).toEqual([]);
		s.finish(code);
		expect(await result).toMatchObject(cleanupCode);
		expect(s.closed()).toBe(true);
		expect(s.errors).toEqual([expect.objectContaining(cleanupCode)]);
		await expect(s.transport.close()).rejects.toMatchObject(cleanupCode);
	});

	it.each([0, 7, 125, null])("accepts primary %s with final C, not C alone", async (code) => {
		const s = setup();
		s.report('S{"pid":123}\n');
		await s.startup;
		s.report(`X${JSON.stringify({ code, signal: code === null ? 15 : null })}\nC\n`);
		let settled = false;
		const closing = s.transport.close().then(() => {
			settled = true;
		});
		await tick();
		expect(settled).toBe(false);
		expect(s.closed()).toBe(false);
		s.finish(code ?? 143);
		await tick();
		expect(settled).toBe(false);
		s.control.push(null);
		await closing;
		expect(s.closed()).toBe(true);
		expect(s.errors).toEqual([]);
	});

	it.each([
		"C\n",
		'S{"pid":123}\nC\n',
		'S{"pid":123}\nX{}\nC\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC\nC\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC\nX{"code":0,"signal":null}\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC',
		'S{"pid":123}\nS{"pid":123}\n',
		'X{"code":0,"signal":null}\nC\n',
		'S{"pid":123}\nE2 missing\nC\n',
	])("fails closed on malformed ordering %j", async (records) => {
		const s = setup();
		s.report(records);
		await tick();
		s.control.push(null);
		await tick();
		expect(s.closed()).toBe(false);
		expect(s.cancellation()).toBe("K");
		s.finish();
		await s.startup;
		await expect(s.transport.close()).rejects.toMatchObject(cleanupCode);
		expect(s.errors).toEqual([expect.objectContaining(cleanupCode)]);
	});

	for (const eofFirst of [false, true]) {
		it.each([
			{ primary: { code: 0, signal: null }, helperCode: 125, helperSignal: null },
			{ primary: { code: 0, signal: null }, helperCode: null, helperSignal: "SIGTERM" },
			{ primary: { code: null, signal: 15 }, helperCode: 15, helperSignal: null },
			{ primary: { code: 7, signal: null }, helperCode: 0, helperSignal: null },
		] as const)(
			`rejects mismatched helper outcome %j; EOF first: ${eofFirst}`,
			async ({ primary, helperCode, helperSignal }) => {
				const s = setup();
				s.report('S{"pid":123}\n');
				await s.startup;
				s.report(`X${JSON.stringify(primary)}\nC\n`);
				let settled = false;
				const closing = s.transport.close().catch((error: unknown) => {
					settled = true;
					return error;
				});
				if (eofFirst) s.control.push(null);
				else s.finish(helperCode, helperSignal);
				await tick();
				expect(settled).toBe(false);
				expect(s.closed()).toBe(false);
				expect(s.errors).toEqual([]);
				if (eofFirst) s.finish(helperCode, helperSignal);
				else s.control.push(null);
				expect(await closing).toMatchObject(cleanupCode);
				expect(s.closed()).toBe(true);
				expect(s.errors).toEqual([expect.objectContaining(cleanupCode)]);
				await expect(s.transport.close()).rejects.toMatchObject(cleanupCode);
			},
		);
	}

	it.each([
		{ code: 0, signal: null },
		{ code: null, signal: "SIGTERM" },
	] as const)("does not expose E errno for inconsistent helper outcome %j", async ({ code, signal }) => {
		const s = setup();
		s.report("E2 No such file or directory\nC\n");
		let settled = false;
		const starting = s.startup.then((result) => {
			settled = true;
			return result;
		});
		s.control.push(null);
		await tick();
		expect(settled).toBe(false);
		s.finish(code, signal);
		expect(await starting).toMatchObject(cleanupCode);
		await expect(s.transport.close()).rejects.toMatchObject(cleanupCode);
	});

	it("keeps E metadata after C and both fences", async () => {
		const s = setup();
		s.report("E2 No such file or directory\nC\n");
		s.control.push(null);
		s.finish(125);
		expect(await s.startup).toMatchObject({ code: "ENOENT", path: "/server", spawnargs: ["arg"] });
		await s.transport.close();
	});

	it("does not treat E without C as confirmed cleanup", async () => {
		const s = setup();
		s.report("E2 No such file or directory\n");
		s.control.push(null);
		s.finish(125);
		expect(await s.startup).toMatchObject(cleanupCode);
		await expect(s.transport.close()).rejects.toMatchObject(cleanupCode);
	});

	it("rejects control destruction without drain even after final C", async () => {
		const s = setup();
		s.report('S{"pid":123}\n');
		await s.startup;
		s.report('X{"code":0,"signal":null}\nC\n');
		s.control.destroy();
		s.finish();
		await expect(s.transport.close()).rejects.toMatchObject(cleanupCode);
	});

	it("does not replace failed helper launch identity with cleanup error", async () => {
		const s = setup(false);
		const error = Object.assign(new Error("helper missing"), { code: "ENOENT", path: "/synthetic-owner" });
		s.child.emit("error", error);
		s.control.push(null);
		s.finish(-2);
		expect(await s.startup).toBe(error);
		await s.transport.close();
	});

	it.each(["missing-C", "bad-helper"])(
		"joins concurrent McpClient closes on %s until transport cleanup settles",
		async (fault) => {
			const s = setup();
			const client = new McpClient({ name: "test", version: "1" });
			// Exercise public client seam without starting the already-started synthetic transport again.
			vi.spyOn(s.transport, "start").mockResolvedValue();
			const connect = client.connect(s.transport);
			s.report('S{"pid":123}\n');
			await s.startup;
			await tick();
			s.stdout.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						protocolVersion: "2025-06-18",
						capabilities: {},
						serverInfo: { name: "fake", version: "1" },
					},
				})}\n`,
			);
			await connect;
			let settled = 0;
			const closes = [client.close(), client.close()].map((close) =>
				close.then(
					() => {
						settled++;
					},
					(error: unknown) => error,
				),
			);
			await tick();
			expect(settled).toBe(0);
			s.report(`X{"code":0,"signal":null}\n${fault === "bad-helper" ? "C\n" : ""}`);
			s.control.push(null);
			s.finish(fault === "bad-helper" ? 125 : 0);
			for (const result of await Promise.all(closes)) expect(result).toMatchObject(cleanupCode);
		},
	);

	it("rejects empty owner instead of standalone fallback", async () => {
		vi.stubEnv("PI_PROCESS_OWNER_BINARY", "");
		await expect(new StdioTransport({ command: "/server" }).start()).rejects.toThrow();
		expect(spawn).not.toHaveBeenCalled();
	});
});
