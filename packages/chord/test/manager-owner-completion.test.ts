import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants as osConstants } from "node:os";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { createHostManager, forkDriver } from "../src/manager.ts";

const { fork, spawn } = vi.hoisted(() => ({ fork: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ fork, spawn }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

const entry = "/unit/host.ts";
const owner = "/unit/process-owner";
const startup = 'S{"pid":456}\n';
const exit = (code: number) => `X{"code":${code},"signal":null}\n`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanupError = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "ERR_PROCESS_OWNER_CLEANUP";

function helper() {
	const writes: string[] = [];
	const lease = new Duplex({
		read() {},
		write(chunk: Buffer, _encoding, callback) {
			writes.push(chunk.toString());
			callback();
		},
	});
	const child = Object.assign(new EventEmitter(), {
		pid: 123 as number | undefined,
		exitCode: null as number | null,
		signalCode: null as string | null,
		connected: true,
		stdio: [null, null, null, null, lease],
		send: vi.fn(() => true),
		kill: vi.fn(),
	});
	fork.mockReturnValue(child);
	return {
		child,
		lease,
		writes,
		record: (text: string) => lease.emit("data", Buffer.from(text)),
		drain: () => lease.emit("end"),
		close: (code = 0, signal: string | null = null) => child.emit("close", code, signal),
	};
}

beforeEach(() => {
	fork.mockReset();
	vi.spyOn(process, "kill").mockImplementation(() => true);
	vi.stubEnv("PI_PROCESS_OWNER_BINARY", owner);
});
afterEach(() => {
	Object.defineProperty(process, "platform", originalPlatform);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("forkDriver native completion protocol (unit only; no PID signals)", () => {
	for (const code of [0, 125]) {
		it(`rejects matching primary/helper ${code} without C`, async () => {
			const native = helper();
			const instance = forkDriver({ entry }).spawn();
			const rejected = assert.rejects(instance.exited, cleanupError);
			native.record(startup + exit(code));
			native.drain();
			native.close(code);
			await rejected;
			assert.ok(native.lease.destroyed, "invalid ABI must cancel lease");
		});
	}

	for (const last of ["close", "end"] as const) {
		it(`waits for C, helper close AND control drain (${last} last)`, async () => {
			const native = helper();
			const instance = forkDriver({ entry }).spawn();
			let settled = false;
			void instance.exited.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			native.record(`${startup}${exit(0)}C\n`);
			await tick();
			assert.equal(settled, false, "C alone is not completion");
			if (last === "close") native.drain();
			else native.close();
			await tick();
			assert.equal(settled, false, "two of three completion conditions cannot settle");
			if (last === "close") native.close();
			else native.drain();
			assert.deepEqual(await instance.exited, { code: 0, signal: null });
		});
	}

	it("accepts control close after readable EOF, still waiting for helper close", async () => {
		const native = helper();
		const instance = forkDriver({ entry }).spawn();
		let settled = false;
		void instance.exited.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		native.lease.push(`${startup}${exit(0)}C\n`);
		native.lease.push(null);
		await tick();
		assert.equal(native.lease.readableEnded, true);
		native.lease.destroy();
		await tick();
		assert.equal(settled, false);
		native.close();
		assert.deepEqual(await instance.exited, { code: 0, signal: null });
	});

	for (const [name, records, code] of [
		["after C with exit 0", `${startup}${exit(0)}C\n`, 0],
		["after C with exit 125", `${startup}${exit(125)}C\n`, 125],
		["before C", `${startup}${exit(0)}`, 0],
	] as const) {
		for (const helperFirst of [false, true]) {
			it(`rejects control destroy without EOF ${name}, helper close ${helperFirst ? "first" : "last"}`, async () => {
				const native = helper();
				const instance = forkDriver({ entry }).spawn();
				let settled = false;
				const outcome = instance.exited.then(
					() => {
						settled = true;
						return undefined;
					},
					(error: unknown) => {
						settled = true;
						return error;
					},
				);
				native.lease.push(records);
				await tick();
				if (helperFirst) {
					native.close(code);
					await tick();
					assert.equal(settled, false, "helper close cannot replace control EOF");
				}
				native.lease.destroy();
				await tick();
				assert.equal(native.lease.readableEnded, false);
				if (!helperFirst) {
					assert.equal(settled, false, "cleanup failure must wait for helper close");
					native.close(code);
				}
				assert.ok(cleanupError(await outcome));
				assert.equal(native.lease.destroyed, true);
				assert.equal(native.child.kill.mock.calls.length, 0);
				assert.equal(vi.mocked(process.kill).mock.calls.length, 0);
			});
		}
	}

	for (const code of [0, 7, 125, 137]) {
		it(`preserves primary exit ${code} with C`, async () => {
			const native = helper();
			const instance = forkDriver({ entry }).spawn();
			native.record(`${startup}${exit(code)}C\n`);
			native.close(code);
			native.drain();
			assert.deepEqual(await instance.exited, { code, signal: null });
		});
	}

	for (const signal of ["SIGKILL", "SIGTERM"] as const) {
		it(`preserves primary ${signal}; force uses lease only`, async () => {
			const native = helper();
			const instance = forkDriver({ entry }).spawn();
			instance.killTree();
			instance.killTree();
			assert.deepEqual(native.writes, ["K"]);
			assert.equal(native.child.kill.mock.calls.length, 0);
			assert.equal(vi.mocked(process.kill).mock.calls.length, 0);
			native.record(`${startup}X{"code":null,"signal":${osConstants.signals[signal]}}\nC\n`);
			native.drain();
			native.close(128 + osConstants.signals[signal]);
			assert.deepEqual(await instance.exited, { code: null, signal });
		});
	}

	for (const [name, records] of [
		["early C", "C\n"],
		["C before primary exit", `${startup}C\n`],
		["duplicate C", `${startup}${exit(0)}C\nC\n`],
		["record after C", `${startup}${exit(0)}C\n${exit(0)}`],
		["partial record after C", `${startup}${exit(0)}C\nS`],
		["truncated C", `${startup}${exit(0)}C`],
		["truncated exit", `${startup}X{`],
		["exit before startup", `${exit(0)}C\n`],
		["duplicate startup", `${startup}${startup}${exit(0)}C\n`],
		["duplicate exit", `${startup}${exit(0)}${exit(0)}C\n`],
		["errno after startup", `${startup}E2 missing\nC\n`],
		["startup after errno", `E2 missing\n${startup}C\n`],
		["bad errno", "E0 missing\nC\n"],
		["errno without C", "E2 missing\n"],
		["unknown record", "Q\n"],
		["invalid PID", 'S{"pid":0}\n'],
		["invalid signal", `${startup}X{"code":null,"signal":99999}\nC\n`],
		["invalid code", `${startup}X{"code":256,"signal":null}\nC\n`],
		["record too large", "S".repeat(4097)],
		["infrastructure failure before startup", ""],
	]) {
		it(`fails closed on ${name}`, async () => {
			const native = helper();
			const instance = forkDriver({ entry }).spawn();
			const rejected = assert.rejects(instance.exited, cleanupError);
			native.record(records);
			native.drain();
			native.close();
			await rejected;
			assert.ok(native.lease.destroyed);
		});
	}

	it("accepts fragmented records without settling on truncated C", async () => {
		const native = helper();
		const instance = forkDriver({ entry }).spawn();
		native.record(`${startup}${exit(0)}C`);
		let settled = false;
		void instance.exited.then(() => {
			settled = true;
		});
		await tick();
		assert.equal(settled, false);
		native.record("\n");
		native.drain();
		native.close();
		await instance.exited;
	});

	it("rejects control error and cancels lease", async () => {
		const native = helper();
		const instance = forkDriver({ entry }).spawn();
		const rejected = assert.rejects(instance.exited, cleanupError);
		native.record(startup);
		native.lease.emit("error", new Error("control failed"));
		native.close(125);
		await rejected;
		assert.ok(native.lease.destroyed);
	});

	it("rejects mismatched helper status even with C", async () => {
		const native = helper();
		const instance = forkDriver({ entry }).spawn();
		const rejected = assert.rejects(instance.exited, cleanupError);
		native.record(`${startup}${exit(0)}C\n`);
		native.drain();
		native.close(125);
		await rejected;
	});

	it("translates only E into primary program spawn errno metadata", async () => {
		const native = helper();
		const instance = forkDriver({ entry, args: ["value"], execArgv: ["--no-warnings"] }).spawn();
		const rejected = assert.rejects(instance.exited, (error: unknown) => {
			assert.ok(error instanceof Error && "code" in error);
			assert.equal(error.code, "ENOENT");
			assert.equal((error as NodeJS.ErrnoException).errno, -osConstants.errno.ENOENT);
			assert.equal((error as NodeJS.ErrnoException).syscall, `spawn ${process.execPath}`);
			assert.equal((error as { path?: string }).path, process.execPath);
			assert.deepEqual((error as { spawnargs?: string[] }).spawnargs, ["--no-warnings", entry, "value"]);
			return true;
		});
		native.record(`E${osConstants.errno.ENOENT} missing program\nC\n`);
		native.close(125);
		native.drain();
		await rejected;
	});

	it("preserves original helper launch error identity without pretending E", async () => {
		const native = helper();
		native.child.pid = undefined;
		const instance = forkDriver({ entry }).spawn();
		const error = Object.assign(new Error("missing owner"), { code: "ENOENT", path: owner });
		const rejected = assert.rejects(instance.exited, (actual: unknown) => actual === error);
		native.child.emit("error", error);
		native.close(125);
		await rejected;
	});

	it("releases queued readiness only after S establishes real primary PID; retains IPC3/control4", async () => {
		const native = helper();
		const instance = forkDriver({ entry }).spawn();
		const pids: number[] = [];
		instance.onControl(() => pids.push(instance.pid));
		native.child.emit("message", { chord2control: { type: "ready" } });
		assert.deepEqual(pids, []);
		native.record(startup);
		assert.deepEqual(pids, [456]);
		assert.deepEqual(fork.mock.calls[0][2].stdio, ["ignore", "inherit", "inherit", "ipc", "pipe"]);
		assert.deepEqual(fork.mock.calls[0][2].execArgv, [
			"supervise",
			"--control-fd",
			"4",
			"--ipc-fd",
			"3",
			"--",
			process.execPath,
		]);
		native.record(`${exit(0)}C\n`);
		native.drain();
		native.close();
		await instance.exited;
	});

	for (const hostOwner of [owner, undefined]) {
		it(`captures host ownership ${hostOwner === undefined ? "absence" : "presence"} before env override`, async () => {
			vi.stubEnv("PI_PROCESS_OWNER_BINARY", hostOwner);
			const native = helper();
			const instance = forkDriver({ entry, env: { PI_PROCESS_OWNER_BINARY: "/unit/override" } }).spawn();
			const options = fork.mock.calls[0][2];
			assert.equal(options.execPath, hostOwner ?? process.execPath);
			assert.equal(options.env.PI_PROCESS_OWNER_BINARY, hostOwner);
			if (hostOwner !== undefined) {
				native.record(`${startup}${exit(0)}C\n`);
				native.drain();
				native.close();
			} else native.child.emit("exit", 0, null);
			await instance.exited;
		});
	}

	it("rejects supplied empty owner rather than launching unowned", () => {
		vi.stubEnv("PI_PROCESS_OWNER_BINARY", "");
		helper();
		assert.throws(() => forkDriver({ entry }).spawn(), /owner.*empty/i);
		assert.equal(fork.mock.calls.length, 0);
	});
});

describe("host manager cleanup failure propagation", () => {
	for (const action of ["stop", "replace"] as const) {
		it(`${action} waits for helper fence then rejects control destroy without EOF; start remains blocked`, async () => {
			const native = helper();
			const manager = createHostManager({ driver: forkDriver({ entry }), grace: 100, readyTimeout: 50 });
			const starting = manager.start();
			await tick();
			native.record(startup);
			native.child.emit("message", { chord2control: { type: "ready" } });
			const instance = await starting;
			let settled = false;
			const outcome = manager[action]().then(
				() => {
					settled = true;
					return undefined;
				},
				(error: unknown) => {
					settled = true;
					return error;
				},
			);
			await tick();
			native.lease.push(`${exit(0)}C\n`);
			await tick();
			native.lease.destroy();
			await tick();
			assert.equal(settled, false, "manager operation cannot settle before helper close");
			native.close();
			await tick();
			assert.equal(fork.mock.calls.length, 1, "replacement cannot spawn after unconfirmed cleanup");
			assert.ok(cleanupError(await outcome));
			await assert.rejects(instance.exited, cleanupError);
			await assert.rejects(manager.start(), cleanupError);
			await assert.rejects(manager.stop(), cleanupError);
			assert.equal(manager.status, "stopping");
		});
	}

	for (const action of ["stop", "replace", "start"] as const) {
		it(`${action} cannot hide missing C or start replacement`, async () => {
			const native = helper();
			const manager = createHostManager({ driver: forkDriver({ entry }), grace: 10 });
			const starting = manager.start();
			await tick();
			native.record(startup);
			native.child.emit("message", { chord2control: { type: "ready" } });
			const instance = await starting;
			const rejected = assert.rejects(instance.exited, cleanupError);
			native.record(exit(125));
			native.drain();
			native.close(125);
			await rejected;
			await assert.rejects(manager[action](), cleanupError);
			assert.equal(manager.status, "stopping");
			assert.equal(fork.mock.calls.length, 1);
		});
	}

	it("automatic keepAlive stop retains cleanup failure without unhandled rejection", async () => {
		const native = helper();
		const shutdown = new Promise<void>((resolve) => {
			native.child.send.mockImplementation(() => {
				resolve();
				return true;
			});
		});
		const manager = createHostManager({
			driver: forkDriver({ entry }),
			keepAlive: () => false,
			checkInterval: 1,
			grace: 100,
		});
		const starting = manager.start();
		await tick();
		native.record(startup);
		native.child.emit("message", { chord2control: { type: "ready" } });
		const instance = await starting;
		await shutdown;
		const rejected = assert.rejects(instance.exited, cleanupError);
		native.record(exit(0));
		native.drain();
		native.close();
		await rejected;
		await assert.rejects(manager.stop(), cleanupError);
		assert.equal(manager.status, "stopping");
		assert.equal(fork.mock.calls.length, 1);
	});

	it("startup cleanup failure rejects without unhandled promise branches", async () => {
		const native = helper();
		const manager = createHostManager({ driver: forkDriver({ entry }), readyTimeout: 50 });
		const rejected = assert.rejects(manager.start(), cleanupError);
		await tick();
		native.record(startup + exit(125));
		native.drain();
		native.close(125);
		await rejected;
		await assert.rejects(manager.stop(), cleanupError);
	});

	it("confirmed E startup failure and helper launch failure leave manager safely stopped", async () => {
		for (const launchFailure of [false, true]) {
			const native = helper();
			if (launchFailure) native.child.pid = undefined;
			const manager = createHostManager({ driver: forkDriver({ entry }), readyTimeout: 50 });
			const rejected = assert.rejects(
				manager.start(),
				(error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
			);
			await tick();
			if (launchFailure) native.child.emit("error", Object.assign(new Error("missing owner"), { code: "ENOENT" }));
			else {
				native.record("E2 missing\nC\n");
				native.drain();
			}
			native.close(125);
			await rejected;
			await manager.stop();
			assert.equal(manager.status, "stopped");
		}
	});
});

describe("Windows direct-fork attach adapter (unit, not runtime proof)", () => {
	function attachFixture() {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		vi.spyOn(performance, "now").mockReturnValue(1000);
		const native = helper();
		native.child.stdio = [null, null, null, native.lease];
		spawn.mockReturnValue(native.child);
		const payload = helper();
		payload.child.pid = 456;
		return { native, payload };
	}

	const opened = (creationTime = performance.timeOrigin + 1000, parentPid = process.pid) =>
		`O${JSON.stringify({ pid: 456, parentPid, creationTime })}\n`;

	it("forks real runtime, queues both init and frames until confirmed attach, fences both processes", async () => {
		const { native, payload } = attachFixture();
		const instance = forkDriver({ entry, init: "first" }).spawn();
		instance.link.send({ t: "bye", reason: "test" });
		assert.equal(payload.child.send.mock.calls.length, 0);
		assert.equal(fork.mock.calls[0][2].execPath, process.execPath);
		assert.deepEqual(fork.mock.calls[0][2].execArgv, []);
		assert.deepEqual(fork.mock.calls[0][2].stdio, ["ignore", "inherit", "inherit", "ipc"]);
		assert.deepEqual(spawn.mock.calls.at(-1)?.slice(0, 2), [
			owner,
			["supervise", "--control-fd", "3", "--attach-pid", "456"],
		]);
		native.record(opened());
		assert.deepEqual(native.writes, ["permit\n"]);
		assert.equal(payload.child.send.mock.calls.length, 0, "opened is not assignment acknowledgment");
		native.record(startup);
		assert.equal(payload.child.send.mock.calls.length, 2);
		instance.killTree();
		instance.killTree();
		assert.deepEqual(native.writes, ["permit\n", "K"]);
		assert.equal(native.lease.writableEnded, false, "Windows cancellation must retain response pipe");
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(native.lease.destroyed, false);
		assert.equal(payload.child.kill.mock.calls.length, 0);
		native.record(`${exit(137)}C\n`);
		native.drain();
		native.close(137);
		let settled = false;
		void instance.exited.then(() => {
			settled = true;
		});
		await tick();
		assert.equal(settled, false);
		payload.close(137);
		assert.deepEqual(await instance.exited, { code: 137, signal: null });
	});

	for (const fault of ["exited", "signal", "parent", "old", "future", "no-open"] as const) {
		it(`denies ${fault} identity before assignment; never releases init`, async () => {
			const { native, payload } = attachFixture();
			const instance = forkDriver({ entry, init: "must not run" }).spawn();
			const rejected = assert.rejects(instance.exited, cleanupError);
			if (fault === "exited") payload.child.exitCode = 7;
			if (fault === "signal") payload.child.signalCode = "SIGKILL";
			native.record(
				fault === "no-open"
					? startup
					: opened(
							performance.timeOrigin + 1000 + (fault === "old" ? -17 : fault === "future" ? 16.001 : 0),
							fault === "parent" ? process.pid + 1 : process.pid,
						),
			);
			assert.deepEqual(native.writes, ["deny\n"]);
			assert.equal(instance.pid, -1);
			instance.send({ type: "shutdown" });
			assert.equal(payload.child.send.mock.calls.length, 0);
			assert.ok(payload.child.kill.mock.calls.length > 0);
			native.drain();
			native.close(125);
			payload.close(7);
			await rejected;
		});
	}

	for (const margin of [-16, 16])
		it(`allows ${margin} ms clock-tick margin, never beyond it`, async () => {
			const { native, payload } = attachFixture();
			const instance = forkDriver({ entry }).spawn();
			native.record(opened(performance.timeOrigin + 1000 + margin));
			assert.deepEqual(native.writes, ["permit\n"]);
			native.record(`${startup}${exit(0)}C\n`);
			native.drain();
			native.close();
			payload.close();
			await instance.exited;
		});

	it("failed assignment sends no messages, kills P through Node handle and surfaces cleanup failure", async () => {
		const { native, payload } = attachFixture();
		const instance = forkDriver({ entry, init: "must not run" }).spawn();
		const rejected = assert.rejects(instance.exited, cleanupError);
		native.record("C\n");
		native.drain();
		native.close(125);
		assert.ok(payload.child.kill.mock.calls.length > 0);
		assert.equal(payload.child.send.mock.calls.length, 0);
		payload.close(1);
		await rejected;
	});
});
