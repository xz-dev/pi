import type * as ChildProcessModule from "node:child_process";
import { ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	observeOwnedProcess,
	ownCliProcesses,
	ownedCommand,
	requestCliProcessOwnerShutdown,
} from "../src/utils/process-owner.ts";

const state = vi.hoisted(() => ({
	bundled: false,
	access: vi.fn(),
	materialize: false,
	resource: vi.fn<(options: { sourceDir: string; relativePath: string; fileMode: number }) => unknown>(),
	spawn: vi.fn(),
	worker: vi.fn(),
}));
const originalArgv = process.argv;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalBunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof ChildProcessModule>()),
	spawn: state.spawn,
}));
vi.mock("node:worker_threads", () => ({
	Worker: class {
		constructor(url: URL, options: { workerData: { parent: number; pid: number; ready: SharedArrayBuffer } }) {
			Object.assign(this, state.worker(url, options));
		}
	},
}));
vi.mock("node:fs", () => ({ accessSync: state.access, constants: { X_OK: 1 } }));
vi.mock("../src/config.ts", () => ({
	getPackageDir: () => "/private/pi",
	get isBunBinary() {
		return state.bundled;
	},
	get materializeResourceTree() {
		return state.materialize ? state.resource : undefined;
	},
}));
const handoff = new Error("handoff stopped by test");
const execute = vi.fn<NonNullable<typeof process.execve>>(() => {
	throw handoff;
});

beforeEach(() => {
	state.bundled = false;
	state.materialize = false;
	state.resource.mockReset();
	state.access.mockReset();
	state.worker.mockReset().mockImplementation((_url: URL, options: { workerData: { ready: SharedArrayBuffer } }) => {
		Atomics.store(new Int32Array(options.workerData.ready), 0, 1);
		return { once: vi.fn(), unref: vi.fn(), terminate: vi.fn(async () => 0) };
	});
	vi.spyOn(process, "on").mockReturnValue(process);
	vi.spyOn(process, "once").mockReturnValue(process);
	execute.mockClear();
	vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "");
	vi.stubEnv("PI_PROCESS_OWNER_PID", undefined);
	vi.stubEnv("PI_PROCESS_OWNER_PENDING", "");
	vi.stubEnv("PI_PROCESS_OWNER_BINARY", "");
	vi.spyOn(process, "execve").mockImplementation(execute);
});

afterEach(() => {
	process.argv = originalArgv;
	Object.defineProperty(process, "platform", originalPlatform);
	if (originalBunVersion) Object.defineProperty(process.versions, "bun", originalBunVersion);
	else Reflect.deleteProperty(process.versions, "bun");
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe.skipIf(process.platform !== "linux" && process.platform !== "freebsd" && process.platform !== "darwin")(
	"CLI process ownership",
	() => {
		it("enters the packaged owner with original runtime arguments and environment", () => {
			vi.stubEnv("PI_OWNER_TEST_VALUE", "preserved");
			expect(ownCliProcesses).toThrow(handoff);
			const [binary, args, env] = execute.mock.calls[0];
			expect(binary).toBe("/private/pi/dist/native/process-owner/pi-env");
			expect(args).toEqual([
				binary,
				"supervise",
				"--",
				process.execPath,
				...process.execArgv,
				...process.argv.slice(1),
			]);
			expect(env?.PI_OWNER_TEST_VALUE).toBe("preserved");
			expect(env?.PI_PROCESS_OWNER_PENDING).toBe("1");
			expect(env?.PI_PROCESS_OWNER_PID).toBeUndefined();
			expect(Object.values(env ?? {}).every((value) => typeof value === "string")).toBe(true);
		});

		it("consumes the guardian's one-shot handoff before extensions inherit it", () => {
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(process.ppid));
			ownCliProcesses();
			expect(execute).not.toHaveBeenCalled();
			expect(state.access).toHaveBeenCalledOnce();
			expect(process.env.PI_PROCESS_OWNER_BINARY).toBe("/private/pi/dist/native/process-owner/pi-env");
			expect(process.env.PI_PROCESS_OWNER_PID).toBeUndefined();
			expect(process.env.PI_PROCESS_OWNER_PENDING).toBeUndefined();
		});

		it("starts a ready unrefed worker only after validated owned handoff", () => {
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(process.ppid));
			ownCliProcesses();
			expect(state.worker).toHaveBeenCalledOnce();
			const [url, options] = state.worker.mock.calls[0];
			expect(url.protocol).toBe("data:");
			expect(options.execArgv).toEqual([]);
			expect(options.workerData.parent).toBe(process.ppid);
			expect(options.workerData.pid).toBe(process.pid);
			expect(state.worker.mock.results[0].value.unref).toHaveBeenCalledOnce();
		});

		it.each(["constructor", "identity", "timeout"])("fails closed on watchdog %s failure", (failure) => {
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(process.ppid));
			if (failure === "constructor") {
				state.worker.mockImplementation(() => {
					throw new Error("worker unavailable");
				});
			} else {
				state.worker.mockImplementation((_url: URL, options: { workerData: { ready: SharedArrayBuffer } }) => {
					Atomics.store(new Int32Array(options.workerData.ready), 0, failure === "identity" ? -1 : 0);
					return { once: vi.fn(), unref: vi.fn(), terminate: vi.fn(async () => 0) };
				});
				vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
			}
			expect(ownCliProcesses).toThrow("--no-process-ownership");
			expect(execute).not.toHaveBeenCalled();
		});

		it.each(["error", "unexpected-exit", "normal-exit", "normal-error"])(
			"handles watchdog %s without a late normal-quit kill",
			(mode) => {
				vi.stubEnv("PI_PROCESS_OWNER_PID", String(process.ppid));
				ownCliProcesses();
				const exit = vi.spyOn(process, "exit").mockImplementation(() => {
					throw new Error("exit intercepted");
				});
				if (mode.startsWith("normal-")) {
					vi.mocked(process.once).mock.calls.find(([event]) => event === "exit")?.[1](0);
				}
				const calls: [string, () => void][] = state.worker.mock.results[0].value.once.mock.calls;
				const handler = calls.find(([event]) => event === (mode.endsWith("error") ? "error" : "exit"))![1];
				if (mode.startsWith("normal-")) {
					handler();
					expect(exit).not.toHaveBeenCalled();
				} else {
					expect(handler).toThrow("exit intercepted");
					expect(exit).toHaveBeenCalledWith(125);
				}
			},
		);

		it.each(["flag", "environment"])("disables ownership through %s before handoff validation", (mode) => {
			process.argv = [process.execPath, "pi", ...(mode === "flag" ? ["--no-process-ownership"] : [])];
			vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", mode === "environment" ? "1" : "");
			vi.stubEnv("PI_PROCESS_OWNER_PENDING", "1");
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(process.ppid + 1));
			vi.stubEnv("PI_PROCESS_OWNER_BINARY", "/inherited/helper");
			vi.stubEnv("PI_PROCESS_OWNER_TEST_FAULT", "inherited");
			ownCliProcesses();
			expect(execute).not.toHaveBeenCalled();
			expect(state.access).not.toHaveBeenCalled();
			expect(state.worker).not.toHaveBeenCalled();
			expect(process.env.PI_PROCESS_OWNER_BINARY).toBeUndefined();
			expect(process.env.PI_PROCESS_OWNER_PENDING).toBeUndefined();
			expect(process.env.PI_PROCESS_OWNER_TEST_FAULT).toBeUndefined();
			expect(ownedCommand("tool", [])).toEqual({ command: "tool", args: [], nativeOwner: false });
		});

		it.each(["--system-prompt", "--append-system-prompt", "--name", "--provider", "--extension", "-e"])(
			"does not interpret %s's value as the opt-out switch",
			(option) => {
				process.argv = [process.execPath, "pi", option, "--no-process-ownership"];
				expect(ownCliProcesses).toThrow(handoff);
			},
		);

		it("does not interpret positional opt-out text after -- as a switch", () => {
			process.argv = [process.execPath, "pi", "--", "--no-process-ownership"];
			expect(ownCliProcesses).toThrow(handoff);
		});

		it("notifies only its validated immediate owner once before signal-hook output", () => {
			const kill = vi.spyOn(process, "kill").mockReturnValue(true);
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(process.ppid));
			ownCliProcesses();
			requestCliProcessOwnerShutdown();
			requestCliProcessOwnerShutdown();
			expect(kill).toHaveBeenCalledExactlyOnceWith(process.ppid, "SIGTERM");
		});

		it("does not notify a replacement parent after owner loss", () => {
			const descriptor = Object.getOwnPropertyDescriptor(process, "ppid")!;
			const parent = process.ppid;
			const kill = vi.spyOn(process, "kill").mockReturnValue(true);
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(parent));
			try {
				ownCliProcesses();
				Object.defineProperty(process, "ppid", { configurable: true, get: () => parent + 1 });
				requestCliProcessOwnerShutdown();
				expect(kill).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(process, "ppid", descriptor);
			}
		});

		it("does not notify a parent when ownership is disabled", () => {
			const kill = vi.spyOn(process, "kill").mockReturnValue(true);
			vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "1");
			ownCliProcesses();
			requestCliProcessOwnerShutdown();
			expect(kill).not.toHaveBeenCalled();
		});

		it("requests graceful shutdown once when its guardian disappears", () => {
			vi.useFakeTimers();
			const parent = process.ppid;
			const descriptor = Object.getOwnPropertyDescriptor(process, "ppid")!;
			const kill = vi.spyOn(process, "kill").mockReturnValue(true);
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(parent));
			try {
				ownCliProcesses();
				vi.advanceTimersByTime(1_000);
				expect(kill).not.toHaveBeenCalled();
				Object.defineProperty(process, "ppid", { configurable: true, get: () => parent + 1 });
				vi.advanceTimersByTime(2_000);
				expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, "SIGTERM");
			} finally {
				Object.defineProperty(process, "ppid", descriptor);
			}
		});

		it("does not recursively restart with an incompatible owner binary", () => {
			vi.stubEnv("PI_PROCESS_OWNER_PENDING", "1");
			expect(ownCliProcesses).toThrow("Process owner did not complete its startup handoff");
			expect(execute).not.toHaveBeenCalled();
		});

		it.each([{ args: [] }, { args: ["--version"] }])(
			"rejects stale supplied owner before startup or re-owning (%j)",
			({ args }) => {
				process.argv = [process.execPath, "pi", ...args];
				vi.stubEnv("PI_PROCESS_OWNER_PID", String(process.ppid + 1));
				expect(ownCliProcesses).toThrow("Process owner exited before its startup handoff completed");
				expect(execute).not.toHaveBeenCalled();
				expect(state.access).not.toHaveBeenCalled();
				expect(state.resource).not.toHaveBeenCalled();
				expect(process.env.PI_PROCESS_OWNER_PID).toBeUndefined();
			},
		);

		it("fails closed if guardian dies between handoff creation and bootstrap", () => {
			const parent = process.ppid;
			const descriptor = Object.getOwnPropertyDescriptor(process, "ppid")!;
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(process.ppid));
			try {
				Object.defineProperty(process, "ppid", { configurable: true, get: () => parent + 1 });
				expect(ownCliProcesses).toThrow("Process owner exited before its startup handoff completed");
				expect(execute).not.toHaveBeenCalled();
				expect(state.access).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(process, "ppid", descriptor);
			}
		});

		it("fails closed if guardian dies during helper resolution", () => {
			vi.useFakeTimers();
			const parent = process.ppid;
			const descriptor = Object.getOwnPropertyDescriptor(process, "ppid")!;
			const kill = vi.spyOn(process, "kill").mockReturnValue(true);
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(parent));
			state.access.mockImplementation(() =>
				Object.defineProperty(process, "ppid", { configurable: true, get: () => parent + 1 }),
			);
			try {
				expect(ownCliProcesses).toThrow("Process owner watchdog unavailable");
				vi.advanceTimersByTime(1_000);
				expect(execute).not.toHaveBeenCalled();
				expect(kill).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(process, "ppid", descriptor);
			}
		});

		it("does not pass Bun's virtual entrypoint back as a user argument", () => {
			state.bundled = true;
			expect(ownCliProcesses).toThrow(handoff);
			const [binary, args] = execute.mock.calls[0];
			expect(binary).toBe("/private/pi/native/process-owner/pi-env");
			expect(args).toEqual([binary, "supervise", "--", process.execPath, ...process.argv.slice(2)]);
		});

		it("keeps SDK execution unchanged outside an owned Pi session", () => {
			delete process.env.PI_PROCESS_OWNER_BINARY;
			expect(ownedCommand("tool", ["a b"])).toEqual({ command: "tool", args: ["a b"], nativeOwner: false });
			expect(state.access).not.toHaveBeenCalled();
		});

		it("rejects explicit empty owner instead of running unowned", () => {
			expect(() => ownedCommand("tool", [])).toThrow("Process owner helper is empty");
			expect(state.access).not.toHaveBeenCalled();
		});

		it("gives an owned task a separate native lifetime", () => {
			vi.stubEnv("PI_PROCESS_OWNER_BINARY", "/owner/pi-env");
			expect(ownedCommand("tool", ["a b"])).toEqual({
				command: "/owner/pi-env",
				args: ["supervise", "--", "tool", "a b"],
				nativeOwner: true,
			});
		});

		it("does not run a task unowned when its helper disappears", () => {
			vi.stubEnv("PI_PROCESS_OWNER_BINARY", "/owner/pi-env");
			state.access.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			expect(() => ownedCommand("tool", [])).toThrow("ENOENT");
		});

		it("keeps version-only startup free of helper materialization", () => {
			process.argv = [process.execPath, "/cli.ts", "--version"];
			ownCliProcesses();
			expect(execute).not.toHaveBeenCalled();
			expect(state.access).not.toHaveBeenCalled();
			expect(state.resource).not.toHaveBeenCalled();
		});

		it("still owns help startup because help loads extensions", () => {
			process.argv = [process.execPath, "/cli.ts", "--help"];
			expect(ownCliProcesses).toThrow(handoff);
		});

		it("materializes embedded executables through the existing resource interface", () => {
			state.bundled = true;
			state.materialize = true;
			state.resource.mockReturnValue("/cache/process-owner");
			expect(ownCliProcesses).toThrow(handoff);
			expect(state.resource).toHaveBeenCalledWith({
				sourceDir: "/private/pi/process-owner",
				relativePath: "process-owner",
				fileMode: 0o700,
			});
			expect(execute.mock.calls[0][0]).toBe("/cache/process-owner/pi-env");
		});

		it("rejects invalid materialization instead of running unowned", () => {
			state.bundled = true;
			state.materialize = true;
			state.resource.mockReturnValue(undefined);
			expect(ownCliProcesses).toThrow("Process owner materialization failed");
			expect(execute).not.toHaveBeenCalled();
		});

		it("does not run unowned when the shipped helper is missing", () => {
			state.access.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			expect(ownCliProcesses).toThrow("Process owner helper is unavailable");
			expect(execute).not.toHaveBeenCalled();
		});
	},
);

describe("POSIX held-controller cancellation", () => {
	for (const mode of ["live", "exited", "signaled", "unspawned", "resume-false", "resume-error"] as const) {
		it(`resumes only live held controller, once: ${mode}`, async () => {
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			const events: string[] = [];
			const lease = new Duplex({
				read() {},
				write(chunk, _encoding, done) {
					events.push(chunk.toString());
					done();
				},
			});
			const child = Object.assign(new ChildProcess(), {
				stdio: [null, null, null, lease],
				pid: mode === "unspawned" ? undefined : 42,
				exitCode: mode === "exited" ? 0 : null,
				signalCode: mode === "signaled" ? ("SIGTERM" as const) : null,
			});
			const kill = vi.spyOn(child, "kill").mockImplementation(() => {
				events.push("SIGCONT");
				if (mode === "resume-error") throw new Error("resume denied");
				return mode !== "resume-false";
			});
			const numericKill = vi.spyOn(process, "kill");
			const owner = observeOwnedProcess(child);
			const failed = mode === "resume-error" || mode === "resume-false";
			const checked = failed
				? expect(owner.completion).rejects.toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" })
				: expect(owner.completion).resolves.toEqual({ code: mode === "exited" ? 0 : 143, errno: undefined });
			child.emit("spawn");
			owner.cancel();
			owner.cancel();
			const live = mode === "live" || failed;
			expect(kill).toHaveBeenCalledTimes(live ? 1 : 0);
			if (live) expect(kill).toHaveBeenCalledWith("SIGCONT");
			expect(events).toEqual(live ? ["SIGCONT", "K"] : ["K"]);
			expect(numericKill).not.toHaveBeenCalled();
			lease.push(
				`S{"pid":42}\nX${JSON.stringify(mode === "exited" ? { code: 0, signal: null } : { code: null, signal: 15 })}\nC\n`,
			);
			lease.push(null);
			child.emit("close", mode === "exited" ? 0 : 143, null);
			await checked;
		});
	}
});

describe("Windows CLI trusted respawn (unit, not runtime proof)", () => {
	for (const lost of [false, true]) {
		it(`Windows cancellation retains X/C beyond 50 ms; lease loss ${lost}`, async () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			let writes = "";
			const lease = new Duplex({
				read() {},
				write(chunk, _encoding, done) {
					writes += chunk.toString();
					done();
				},
			});
			const child = Object.assign(new ChildProcess(), { stdio: [null, null, null, lease] });
			const owner = observeOwnedProcess(child);
			let settled = false;
			const outcome = owner.completion.then(
				(value) => {
					settled = true;
					return value;
				},
				(error: unknown) => {
					settled = true;
					return error;
				},
			);
			child.emit("spawn");
			lease.push('S{"pid":42}\n');
			owner.cancel();
			owner.cancel();
			expect(writes).toBe("K");
			expect(lease.writableEnded).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(settled).toBe(false);
			expect(lease.destroyed).toBe(false);
			if (lost) lease.destroy();
			else {
				lease.push('X{"code":137,"signal":null}\nC\n');
				lease.push(null);
			}
			await new Promise((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			child.emit("close", 137, null);
			if (lost) expect(await outcome).toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
			else expect(await outcome).toEqual({ code: 137, errno: undefined });
			expect(lease.destroyed).toBe(true);
		});
	}
	for (const valid of [true, false])
		it(`Bun u8 helper close ${valid ? "preserves full X" : "must still match X"}`, async () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			Object.defineProperty(process.versions, "bun", { value: "1.3.14", configurable: true });
			const lease = new Duplex({
				read() {},
				write(_chunk, _encoding, done) {
					done();
				},
			});
			const child = Object.assign(new ChildProcess(), { stdio: [null, null, null, lease] });
			const owner = observeOwnedProcess(child);
			const checked = valid
				? expect(owner.completion).resolves.toEqual({ code: 3221225477, errno: undefined })
				: expect(owner.completion).rejects.toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
			child.emit("spawn");
			lease.push('S{"pid":42}\nX{"code":3221225477,"signal":null}\nC\n');
			lease.push(null);
			child.emit("close", valid ? 5 : 6, null);
			await checked;
		});

	it("preserves Windows/Bun CreateProcess errors even when no control handle exists", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const child = Object.assign(new ChildProcess(), { stdio: [null, null, null, null] });
		const owner = observeOwnedProcess(child);
		const error = new Error("CreateProcess failed");
		const rejected = expect(owner.completion).rejects.toBe(error);
		child.emit("error", error);
		child.emit("close", 125, null);
		await rejected;
	});

	it("keeps wrapper out of main; passes source argv, inherited console and named-pipe lease", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const lease = new Duplex({
			read() {},
			write(_chunk, _encoding, done) {
				done();
			},
		});
		const child = Object.assign(new ChildProcess(), { stdio: [null, null, null, lease] });
		state.spawn.mockReturnValue(child);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		vi.spyOn(process, "on").mockReturnValue(process);
		expect(ownCliProcesses()).toBe(false);
		expect(execute).not.toHaveBeenCalled();
		const [binary, args, options] = state.spawn.mock.calls.at(-1)!;
		expect(binary.endsWith("pi-env.exe")).toBe(true);
		expect(args).toEqual([
			"supervise",
			"--control-fd",
			"3",
			"--",
			process.execPath,
			...process.execArgv,
			...process.argv.slice(1),
		]);
		expect(options.stdio).toEqual(["inherit", "inherit", "inherit", "pipe"]);
		expect(options.env.PI_PROCESS_OWNER_PENDING).toBe("1");
		child.emit("spawn");
		lease.push('S{"pid":42}\nX{"code":3221225477,"signal":null}\nC\n');
		lease.push(null);
		child.emit("close", process.versions.bun ? 5 : 3221225477, null);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(exit).toHaveBeenCalledWith(3221225477);
	});

	it("retains Bun argument distinction and executable suffix after materialization", () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		state.bundled = true;
		state.materialize = true;
		state.resource.mockReturnValue("/cache/process-owner");
		const lease = new Duplex({
			read() {},
			write(_chunk, _encoding, done) {
				done();
			},
		});
		state.spawn.mockReturnValue(Object.assign(new ChildProcess(), { stdio: [null, null, null, lease] }));
		vi.spyOn(process, "on").mockReturnValue(process);
		expect(ownCliProcesses()).toBe(false);
		expect(state.spawn.mock.calls.at(-1)?.slice(0, 2)).toEqual([
			"/cache/process-owner/pi-env.exe",
			["supervise", "--control-fd", "3", "--", process.execPath, ...process.argv.slice(2)],
		]);
		lease.destroy();
	});
});
