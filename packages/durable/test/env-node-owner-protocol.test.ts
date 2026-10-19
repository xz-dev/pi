import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as FsPromises from "node:fs/promises";
import { Duplex, PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";

const { spawnMock, accessMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), accessMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof FsPromises>()), access: accessMock }));
const previousOwner = process.env.PI_PROCESS_OWNER_BINARY;

afterEach(() => {
	spawnMock.mockReset();
	accessMock.mockReset();
	if (previousOwner === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
	else process.env.PI_PROCESS_OWNER_BINARY = previousOwner;
});

function fakeChild() {
	const control = new PassThrough();
	let input = "";
	const lease = new Duplex({
		read() {},
		write(chunk, _encoding, done) {
			input += chunk.toString();
			done();
		},
	});
	control.on("data", (chunk: Buffer) => lease.push(chunk));
	control.once("end", () => lease.push(null));
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		stdout,
		stderr,
		stdin: null,
		stdio: [null, stdout, stderr, lease],
	});
	let spawned: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		spawned = resolve;
	});
	spawnMock.mockImplementationOnce(() => {
		spawned();
		return child as unknown as ChildProcess;
	});
	return { child, control, lease, stdout, stderr, ready, input: () => input };
}

async function turn() {
	await new Promise((resolve) => setTimeout(resolve, 5));
}

// Deterministic stream/event ordering only. These mocks prove no OS containment.
describe("UNIT native completion fences", () => {
	it("joins helper close AND delayed control EOF; E after helper exit keeps program errno", async () => {
		process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
		accessMock.mockResolvedValue(undefined);
		const fake = fakeChild();
		let settled = false;
		const pending = new NodeExecutionEnv({ cwd: "/test" })
			.exec(["/test/program"], undefined, BACKGROUND_CONTEXT)
			.then((result) => {
				settled = true;
				return result;
			});
		await fake.ready;
		fake.child.emit("exit", 125, null);
		fake.child.emit("close", 125, null);
		await turn();
		expect(settled).toBe(false);
		fake.control.end("E2 missing\nC\n");
		const result = await pending;
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("spawn_error");
			expect(result.error.cause).toMatchObject({
				code: "ENOENT",
				errno: -2,
				path: "/test/program",
				syscall: "spawn /test/program",
				spawnargs: [],
			});
		}
	});

	it("X, C and control EOF do not settle before helper CLOSE", async () => {
		process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
		accessMock.mockResolvedValue(undefined);
		const fake = fakeChild();
		let settled = false;
		const env = new NodeExecutionEnv({ cwd: "/test" });
		const pending = env.exec(["/test/program"], undefined, BACKGROUND_CONTEXT).then((result) => {
			settled = true;
			return result;
		});
		await fake.ready;
		fake.control.end('S{"pid":123}\nX{"code":7,"signal":null}\nC\n');
		fake.child.emit("exit", 7, null);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(settled).toBe(false);
		let cleaned = false;
		const cleanup = env.cleanup(BACKGROUND_CONTEXT).then(() => {
			cleaned = true;
		});
		await turn();
		expect(cleaned).toBe(false);
		fake.child.emit("close", 7, null);
		const result = await pending;
		await cleanup;
		expect(result.ok && result.value.exitCode).toBe(7);
	});

	for (const { primary, helper, exitCode } of [
		{ primary: { code: 0, signal: null }, helper: { code: 125, signal: null }, exitCode: undefined },
		{ primary: { code: 0, signal: null }, helper: { code: null, signal: "SIGTERM" }, exitCode: undefined },
		{ primary: { code: 0, signal: null }, helper: { code: 0, signal: null }, exitCode: 0 },
		{ primary: { code: 7, signal: null }, helper: { code: 7, signal: null }, exitCode: 7 },
		{ primary: { code: 125, signal: null }, helper: { code: 125, signal: null }, exitCode: 125 },
		{ primary: { code: null, signal: 9 }, helper: { code: 137, signal: null }, exitCode: 137 },
		{ primary: { code: null, signal: 15 }, helper: { code: 143, signal: null }, exitCode: 143 },
	] as const) {
		it(`checks helper close ${JSON.stringify(helper)} against primary ${JSON.stringify(primary)}`, async () => {
			process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
			accessMock.mockResolvedValue(undefined);
			const fake = fakeChild();
			const pending = new NodeExecutionEnv({ cwd: "/test" }).exec(["/test/program"], undefined, BACKGROUND_CONTEXT);
			await fake.ready;
			fake.control.end(`S{"pid":123}\nX${JSON.stringify(primary)}\nC\n`);
			fake.child.emit("close", helper.code, helper.signal);
			const result = await pending;
			if (exitCode === undefined) {
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.code).toBe("unknown");
					expect(result.error.message).toContain("Process owner failed");
					expect(result.error.cause).toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
				}
			} else expect(result.ok && result.value.exitCode).toBe(exitCode);
		});
	}

	it("malformed record actively cancels lease before helper close", async () => {
		process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
		accessMock.mockResolvedValue(undefined);
		const fake = fakeChild();
		const pending = new NodeExecutionEnv({ cwd: "/test" }).exec(["/test/program"], undefined, BACKGROUND_CONTEXT);
		await fake.ready;
		fake.control.write("invalid\n");
		await turn();
		expect(fake.input()).toBe("K");
		fake.control.end();
		fake.child.emit("close", 0, null);
		expect((await pending).ok).toBe(false);
	});

	it("keeps genuine early stderr in paused readable stream until S, including helper exit flushing", async () => {
		process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
		accessMock.mockResolvedValue(undefined);
		const fake = fakeChild();
		let stderr = "";
		const pending = new NodeExecutionEnv({ cwd: "/test" }).exec(
			["/test/program"],
			{
				onOutput: (text, _context, info) => {
					if (info.stream === "stderr") stderr += text;
				},
			},
			BACKGROUND_CONTEXT,
		);
		await fake.ready;
		const bytes = "λ".repeat(128 * 1024);
		fake.stderr.write(Buffer.from(bytes));
		fake.child.emit("exit", 0, null);
		fake.stderr.resume();
		await turn();
		expect(stderr).toBe("");
		fake.control.write('S{"pid":123}\n');
		await turn();
		expect(stderr).toBe(bytes);
		fake.stderr.end();
		fake.control.end('X{"code":0,"signal":null}\nC\n');
		fake.child.emit("close", 0, null);
		expect((await pending).ok).toBe(true);
	});

	for (const code of [0, 125]) {
		it(`rejects matching primary/helper ${code} without C and cancels lease`, async () => {
			process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
			accessMock.mockResolvedValue(undefined);
			const fake = fakeChild();
			const pending = new NodeExecutionEnv({ cwd: "/test" }).exec(["/test/program"], undefined, BACKGROUND_CONTEXT);
			await fake.ready;
			fake.control.end(`S{"pid":123}\nX{"code":${code},"signal":null}\n`);
			fake.child.emit("close", code, null);
			const result = await pending;
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe("unknown");
				expect((result.error.cause as NodeJS.ErrnoException).code).toBe("ERR_PROCESS_OWNER_CLEANUP");
			}
			expect(fake.input()).toBe("K");
		});
	}

	for (const report of [
		"C\n",
		'S{"pid":123}\nC\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC\nC\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC\nS{"pid":123}\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC\nE2 late\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC\nX{"code":0,"signal":null}\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC\ninvalid\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC\ntail',
		"E2 missing\n",
		"E2 missing\nC\nC\n",
	]) {
		it(`rejects malformed C ordering/framing ${JSON.stringify(report)} and cancels lease`, async () => {
			process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
			accessMock.mockResolvedValue(undefined);
			const fake = fakeChild();
			const pending = new NodeExecutionEnv({ cwd: "/test" }).exec(["/test/program"], undefined, BACKGROUND_CONTEXT);
			await fake.ready;
			fake.control.end(report);
			fake.child.emit("close", 0, null);
			const result = await pending;
			expect(result.ok).toBe(false);
			if (!result.ok) expect((result.error.cause as NodeJS.ErrnoException).code).toBe("ERR_PROCESS_OWNER_CLEANUP");
			expect(fake.input()).toBe("K");
		});
	}

	it("helper CLOSE with X waits for delayed C AND control drain", async () => {
		process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
		accessMock.mockResolvedValue(undefined);
		const fake = fakeChild();
		let settled = false;
		const pending = new NodeExecutionEnv({ cwd: "/test" })
			.exec(["/test/program"], undefined, BACKGROUND_CONTEXT)
			.then((result) => {
				settled = true;
				return result;
			});
		await fake.ready;
		fake.control.write('S{"pid":123}\nX{"code":0,"signal":null}\n');
		fake.child.emit("close", 0, null);
		await turn();
		expect(settled).toBe(false);
		fake.control.write("C\n");
		await turn();
		expect(settled).toBe(false);
		fake.control.end();
		expect((await pending).ok).toBe(true);
	});

	for (const closeFirst of [false, true]) {
		it(`rejects control destroy after C without readable EOF; helper close first=${closeFirst}`, async () => {
			process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
			accessMock.mockResolvedValue(undefined);
			const fake = fakeChild();
			let settled = false;
			const pending = new NodeExecutionEnv({ cwd: "/test" })
				.exec(["/test/program"], undefined, BACKGROUND_CONTEXT)
				.then((result) => {
					settled = true;
					return result;
				});
			await fake.ready;
			fake.control.write('S{"pid":123}\nX{"code":0,"signal":null}\nC\n');
			await turn();
			if (closeFirst) fake.child.emit("close", 0, null);
			fake.lease.destroy();
			await turn();
			expect(fake.lease.readableEnded).toBe(false);
			expect(fake.lease.destroyed).toBe(true);
			if (!closeFirst) {
				expect(settled).toBe(false);
				fake.child.emit("close", 0, null);
			}
			const result = await pending;
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.cause).toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
		});
	}

	for (const helper of [
		{ code: 0, signal: null },
		{ code: null, signal: "SIGTERM" },
	] as const) {
		it(`E,C validates helper ${JSON.stringify(helper)} before translating program errno`, async () => {
			process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
			accessMock.mockResolvedValue(undefined);
			const fake = fakeChild();
			const pending = new NodeExecutionEnv({ cwd: "/test" }).exec(["/test/program"], undefined, BACKGROUND_CONTEXT);
			await fake.ready;
			fake.control.end("E2 missing\nC\n");
			fake.child.emit("close", helper.code, helper.signal);
			const result = await pending;
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe("unknown");
				expect(result.error.cause).toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
				expect(result.error.message).toContain("Process owner failed: expected exit 125");
			}
		});
	}

	for (const ownerFailure of ["missing C", "helper mismatch", "helper signal"] as const) {
		for (const interruption of ["abort", "callback", "timeout", "spill"] as const) {
			it(`${ownerFailure} remains cleanup failure despite ${interruption}`, async () => {
				process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
				accessMock.mockResolvedValue(undefined);
				const fake = fakeChild();
				const controller = new AbortController();
				const env = new NodeExecutionEnv({ cwd: "/test" });
				if (interruption === "spill") {
					env.createTempFile = async () => {
						throw new Error("spill failed");
					};
				}
				const pending = env.exec(
					["/test/program"],
					{
						timeout: interruption === "timeout" ? 0.001 : undefined,
						spill: interruption === "spill" ? { afterBytes: 0, afterLines: 0 } : undefined,
						onOutput: () => {
							if (interruption === "callback") throw new Error("callback failed");
						},
					},
					withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
				);
				await fake.ready;
				fake.control.write('S{"pid":123}\n');
				fake.stdout.write("output");
				if (interruption === "abort") controller.abort();
				await turn();
				fake.control.end(`X{"code":0,"signal":null}\n${ownerFailure === "missing C" ? "" : "C\n"}`);
				fake.child.emit(
					"close",
					ownerFailure === "missing C" ? 0 : ownerFailure === "helper signal" ? null : 125,
					ownerFailure === "helper signal" ? "SIGTERM" : null,
				);
				const result = await pending;
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.code).toBe("unknown");
					expect((result.error.cause as NodeJS.ErrnoException).code).toBe("ERR_PROCESS_OWNER_CLEANUP");
				}
			});
		}
	}

	it("control error after C cancels lease and fails instead of returning primary status", async () => {
		process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
		accessMock.mockResolvedValue(undefined);
		const fake = fakeChild();
		const pending = new NodeExecutionEnv({ cwd: "/test" }).exec(["/test/program"], undefined, BACKGROUND_CONTEXT);
		await fake.ready;
		fake.control.write('S{"pid":123}\nX{"code":0,"signal":null}\nC\n');
		await turn();
		fake.child.stdio[3]?.emit("error", new Error("control failed"));
		await turn();
		expect(fake.input()).toBe("K");
		fake.control.end();
		fake.child.emit("close", 0, null);
		const result = await pending;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.cause).toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
	});

	it("helper launch error without scope/report preserves original error identity", async () => {
		process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
		accessMock.mockResolvedValue(undefined);
		const fake = fakeChild();
		const pending = new NodeExecutionEnv({ cwd: "/test" }).exec(["/test/program"], undefined, BACKGROUND_CONTEXT);
		await fake.ready;
		const error = Object.assign(new Error("owner launch failed"), { code: "ENOENT", path: "/test/owner" });
		fake.child.emit("error", error);
		fake.control.end();
		fake.child.emit("close", -2, null);
		const result = await pending;
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("spawn_error");
			expect(result.error.cause).toBe(error);
		}
	});

	it("absent host owner stays absent across asynchronous cwd resolution", async () => {
		delete process.env.PI_PROCESS_OWNER_BINARY;
		accessMock.mockResolvedValue(undefined);
		const fake = fakeChild();
		const pending = new NodeExecutionEnv({ cwd: "/test" }).exec(["/test/program"], undefined, BACKGROUND_CONTEXT);
		process.env.PI_PROCESS_OWNER_BINARY = "/test/later-owner";
		await fake.ready;
		expect(spawnMock.mock.calls[0]?.[0]).toBe("/test/program");
		fake.child.emit("close", 0, null);
		expect((await pending).ok).toBe(true);
	});

	for (const code of [0, 125]) {
		it(`discovery rejects matching ${code} without C instead of shell fallback`, async () => {
			process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
			accessMock.mockImplementation(async (path: string) => {
				if (path === "/bin/bash") throw new Error("missing");
			});
			const fake = fakeChild();
			const pending = new NodeExecutionEnv({ cwd: "/test" }).exec("echo unused", undefined, BACKGROUND_CONTEXT);
			await fake.ready;
			expect(spawnMock.mock.calls[0]?.[1]).toContain("which");
			fake.control.end(`S{"pid":123}\nX{"code":${code},"signal":null}\n`);
			fake.child.emit("close", code, null);
			const result = await pending;
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe("unknown");
				expect((result.error.cause as NodeJS.ErrnoException).code).toBe("ERR_PROCESS_OWNER_CLEANUP");
			}
			expect(fake.input()).toBe("K");
			expect(spawnMock).toHaveBeenCalledTimes(1);
		});
	}

	it("discovery retains entry owner, joins cancellation and rejects missing X instead of shell fallback", async () => {
		process.env.PI_PROCESS_OWNER_BINARY = "/test/captured-owner";
		accessMock.mockImplementation(async (path: string) => {
			if (path === "/bin/bash") throw new Error("missing");
		});
		const fake = fakeChild();
		const env = new NodeExecutionEnv({ cwd: "/test" });
		const pending = env.exec("echo unused", undefined, BACKGROUND_CONTEXT);
		process.env.PI_PROCESS_OWNER_BINARY = "/test/later-owner";
		await fake.ready;
		expect(spawnMock.mock.calls[0]?.[0]).toBe("/test/captured-owner");
		expect(spawnMock.mock.calls[0]?.[1]).toContain("which");
		const cleanup = env.cleanup(BACKGROUND_CONTEXT);
		await turn();
		expect(fake.input()).toBe("K");
		fake.control.end('S{"pid":123}\n');
		fake.child.emit("close", 0, null);
		expect((await pending).ok).toBe(false);
		await cleanup;
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});
});
