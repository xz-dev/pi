import type * as FsModule from "node:fs";
import * as fs from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { ownCliProcesses } from "../src/utils/process-owner.ts";

vi.mock("node:fs", async (original) => {
	const actual = await original<typeof FsModule>();
	return { ...actual, fstatSync: vi.fn(actual.fstatSync), closeSync: vi.fn(actual.closeSync) };
});

type FakeUi = {
	start: () => void;
	stop: () => void;
	requestRender: (force?: boolean) => void;
};

type HandleCtrlZThis = {
	ui: FakeUi;
};

type ProcessSignalHandler = () => void;

type InteractiveModePrototypeWithHandleCtrlZ = {
	handleCtrlZ(this: HandleCtrlZThis): void;
};

function callHandleCtrlZ(context: HandleCtrlZThis): void {
	(interactiveModePrototype as InteractiveModePrototypeWithHandleCtrlZ).handleCtrlZ.call(context);
}

const interactiveModePrototype = InteractiveMode.prototype as unknown;

describe("InteractiveMode.handleCtrlZ", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.mocked(fs.fstatSync).mockRestore();
		vi.mocked(fs.closeSync).mockRestore();
	});

	test("shows a status message and skips suspend on Windows", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const showStatus = vi.fn();
		const context: HandleCtrlZThis & { showStatus: (message: string) => void } = { ui, showStatus };
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "win32",
		});
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const processOnSpy = vi.spyOn(process, "on");
		const processOnceSpy = vi.spyOn(process, "once");
		const processKillSpy = vi.spyOn(process, "kill");

		try {
			callHandleCtrlZ(context);
		} finally {
			if (platformDescriptor) {
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		}

		expect(showStatus).toHaveBeenCalledWith("Suspend to background is not supported on Windows");
		expect(ui.stop).not.toHaveBeenCalled();
		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(processOnSpy).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).not.toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(processKillSpy).not.toHaveBeenCalled();
	});

	test("keeps the process alive while suspended and restores the TUI on SIGCONT", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);

		let sigintHandler: ProcessSignalHandler | undefined;
		let sigcontHandler: ProcessSignalHandler | undefined;

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGINT") {
				sigintHandler = listener;
			}
			return process;
		}) as typeof process.on);
		const processOnceSpy = vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGCONT") {
				sigcontHandler = listener;
			}
			return process;
		}) as typeof process.once);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		callHandleCtrlZ(context);

		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2 ** 30);
		expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(processKillSpy).toHaveBeenCalledWith(0, "SIGTSTP");
		expect(sigintHandler).toBeDefined();
		expect(sigcontHandler).toBeDefined();

		sigcontHandler?.();

		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledWith(true);
	});

	test("requests shutdown without restarting the background tty on a parent-death CONT", () => {
		const ui: FakeUi = { start: vi.fn(), stop: vi.fn(), requestRender: vi.fn() };
		const parent = process.ppid;
		const descriptor = Object.getOwnPropertyDescriptor(process, "ppid")!;
		const keepAlive = setTimeout(() => undefined, 0);
		clearTimeout(keepAlive);
		vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAlive);
		const clear = vi.spyOn(globalThis, "clearInterval");
		let resume: ProcessSignalHandler | undefined;
		vi.spyOn(process, "on").mockImplementation((() => process) as typeof process.on);
		vi.spyOn(process, "once").mockImplementation(((event: string, listener: ProcessSignalHandler) => {
			if (event === "SIGCONT") resume = listener;
			return process;
		}) as typeof process.once);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		try {
			callHandleCtrlZ({ ui });
			Object.defineProperty(process, "ppid", { configurable: true, value: parent + 1 });
			resume?.();
			expect(kill).toHaveBeenLastCalledWith(process.pid, "SIGTERM");
			expect(ui.start).not.toHaveBeenCalled();
			expect(ui.requestRender).not.toHaveBeenCalled();
			expect(clear).not.toHaveBeenCalled(); // keep shutdown alive until SIGTERM is handled
		} finally {
			Object.defineProperty(process, "ppid", descriptor);
		}
	});

	test("cleans up the temporary handlers if suspension fails", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);
		const suspendError = new Error("suspend failed");

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		vi.spyOn(process, "on").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.on,
		);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		vi.spyOn(process, "once").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.once,
		);
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw suspendError;
		});

		expect(() => callHandleCtrlZ(context)).toThrow(suspendError);
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(ui.start).not.toHaveBeenCalled();
		expect(ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("owner-loss shutdown deadline", () => {
	for (const mode of ["owner-loss", "loss-during-shutdown", "ordinary-signal", "interactive-quit"] as const) {
		test(mode, async () => {
			vi.useFakeTimers();
			const parentDescriptor = Object.getOwnPropertyDescriptor(process, "ppid")!;
			const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
			const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
			const parent = process.ppid;
			const stopped = vi.fn();
			const exited = new Error("exit intercepted");
			const exit = vi.spyOn(process, "exit").mockImplementation(() => {
				throw exited;
			});
			vi.spyOn(process, "kill").mockReturnValue(true);
			vi.spyOn(fs, "accessSync").mockImplementation(() => {});
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			Object.defineProperty(process, "stdin", {
				configurable: true,
				value:
					mode === "owner-loss" ? { closed: false, fd: 0, isTTY: true, _handle: { fd: 42 } } : { closed: true },
			});
			const stat = fs.statSync(new URL(import.meta.url));
			vi.spyOn(stat, "isCharacterDevice").mockReturnValue(true);
			vi.mocked(fs.fstatSync).mockReturnValue(stat);
			const close = vi.mocked(fs.closeSync).mockImplementation(() => {});
			vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "");
			vi.stubEnv("PI_PROCESS_OWNER_PENDING", undefined);
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(parent));
			ownCliProcesses();
			const context = {
				isShuttingDown: false,
				isSuspended: true,
				runtimeHost: { dispose: vi.fn(() => new Promise<void>(() => {})) },
				themeController: { disableAutoSync: vi.fn() },
				ui: { terminal: { drainInput: vi.fn(async () => {}) } },
				stop: stopped,
			};
			const prototype = interactiveModePrototype as {
				shutdown(this: typeof context, options?: { fromSignal: boolean }): Promise<void>;
			};
			try {
				if (mode === "owner-loss")
					Object.defineProperty(process, "ppid", { configurable: true, value: parent + 1 });
				void prototype.shutdown.call(context, mode === "interactive-quit" ? undefined : { fromSignal: true });
				if (mode === "loss-during-shutdown") {
					Object.defineProperty(process, "ppid", { configurable: true, value: parent + 1 });
					await prototype.shutdown.call(context, { fromSignal: true });
				}
				if (mode === "owner-loss" || mode === "loss-during-shutdown") {
					await vi.advanceTimersByTimeAsync(4_999);
					expect(exit).not.toHaveBeenCalled();
					await expect(vi.advanceTimersByTimeAsync(1)).rejects.toBe(exited);
					expect(exit).toHaveBeenCalledExactlyOnceWith(0);
					expect(stopped).toHaveBeenCalledOnce();
					if (mode === "owner-loss") expect(close).toHaveBeenCalledExactlyOnceWith(42);
				} else {
					await vi.advanceTimersByTimeAsync(20_000);
					expect(exit).not.toHaveBeenCalled();
				}
				expect(context.runtimeHost.dispose).toHaveBeenCalledOnce();
			} finally {
				Object.defineProperty(process, "ppid", parentDescriptor);
				Object.defineProperty(process, "platform", platformDescriptor);
				Object.defineProperty(process, "stdin", stdinDescriptor);
				vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "1");
				ownCliProcesses();
				vi.clearAllTimers();
				vi.useRealTimers();
				vi.restoreAllMocks();
				vi.mocked(fs.fstatSync).mockRestore();
				vi.mocked(fs.closeSync).mockRestore();
				vi.unstubAllEnvs();
			}
		});
	}
});

describe("suspended final-exit descriptor boundary", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.mocked(fs.fstatSync).mockRestore();
		vi.mocked(fs.closeSync).mockRestore();
	});
	for (const mode of [
		"private",
		"public",
		"closed",
		"missing",
		"negative",
		"fraction",
		"unsafe",
		"string",
		"not-tty",
		"not-char",
		"reused",
		"stat-error",
	] as const) {
		test(`validates own tty before final close: ${mode}`, async () => {
			const descriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
			const events: string[] = [];
			const expectedExit = new Error("exit intercepted");
			const exit = vi.spyOn(process, "exit").mockImplementation(() => {
				events.push("exit");
				throw expectedExit;
			});
			const base = fs.statSync(new URL(import.meta.url));
			const current = fs.statSync(new URL(import.meta.url));
			vi.spyOn(base, "isCharacterDevice").mockReturnValue(true);
			vi.spyOn(current, "isCharacterDevice").mockReturnValue(mode !== "not-char");
			if (mode === "reused") current.ino++;
			const stat = vi.mocked(fs.fstatSync).mockReturnValueOnce(base).mockReturnValueOnce(current);
			if (mode === "stat-error")
				stat.mockReset().mockImplementation(() => {
					throw new Error("EBADF");
				});
			const close = vi.mocked(fs.closeSync).mockImplementation(() => {
				events.push("close");
			});
			const fd: unknown =
				mode === "missing"
					? undefined
					: mode === "negative"
						? -1
						: mode === "fraction"
							? 1.5
							: mode === "unsafe"
								? Number.MAX_SAFE_INTEGER + 1
								: mode === "string"
									? "42"
									: 42;
			Object.defineProperty(process, "stdin", {
				configurable: true,
				value: {
					fd: 0,
					isTTY: mode !== "not-tty",
					closed: mode === "closed",
					_handle: mode === "public" ? undefined : { fd },
				},
			});
			const context = {
				isShuttingDown: false,
				isSuspended: true,
				runtimeHost: {
					dispose: async () => {
						events.push("dispose");
					},
				},
				themeController: { disableAutoSync: vi.fn() },
				ui: { terminal: { drainInput: vi.fn(async () => {}) } },
				stop: () => {
					events.push("stop");
				},
			};
			const prototype = interactiveModePrototype as {
				shutdown(this: typeof context, options: { fromSignal: boolean }): Promise<void>;
			};
			try {
				const result = prototype.shutdown.call(context, { fromSignal: true });
				if (mode === "private" || mode === "public" || mode === "closed") {
					await expect(result).rejects.toBe(expectedExit);
					expect(exit).toHaveBeenCalledWith(0);
					if (mode === "closed") {
						expect(close).not.toHaveBeenCalled();
						expect(stat).not.toHaveBeenCalled();
					} else {
						expect(close).toHaveBeenCalledExactlyOnceWith(mode === "public" ? 0 : 42);
					}
					expect(events).toEqual(
						mode === "closed" ? ["dispose", "stop", "exit"] : ["dispose", "stop", "close", "exit"],
					);
				} else {
					await expect(result).rejects.toThrow();
					expect(close).not.toHaveBeenCalled();
					expect(exit).not.toHaveBeenCalled();
				}
				expect(context.ui.terminal.drainInput).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(process, "stdin", descriptor);
			}
		});
	}
});
