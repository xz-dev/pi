import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { APP_NAME } from "../../../src/config.ts";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import * as processOwner from "../../../src/utils/process-owner.ts";

// Regression for https://github.com/earendil-works/pi/issues/5080
//
// On SIGTERM/SIGHUP the graceful shutdown must emit `session_shutdown`
// (runtimeHost.dispose) BEFORE touching the terminal. Extension teardown such
// as removing a socket does not write to the tty, so it must not be skipped if
// a later terminal-restore write fails on a dead or stalled terminal. The
// interactive quit path (Ctrl+D, /quit) keeps the opposite order to preserve
// the final TUI frame.

type ShutdownThis = {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	runtimeHost: {
		dispose: () => Promise<void>;
		session: { extensionRunner: { setShutdownProgressListener: (listener?: unknown) => void } };
	};
	ui: { terminal: { drainInput: (ms: number) => Promise<void> } };
	themeController: { disableAutoSync: () => void };
	stop: () => void;
	sessionManager: SessionManager;
};

type EmergencyExitThis = {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	agent: { managedExecutions: { dispose: () => void } };
};

type UncaughtCrashThis = EmergencyExitThis & {
	ui: { stop: () => void };
	recordCrash(kind: "uncaught_exception" | "fatal_error", error: unknown): boolean;
	crashReportInstructions(): string;
	getCrashExtensionHint(error: unknown): string | undefined;
};

type InteractiveModePrototypeWithShutdown = {
	shutdown(this: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void>;
	emergencyTerminalExit(this: EmergencyExitThis): never;
	uncaughtCrash(this: UncaughtCrashThis, error: Error): never;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown;
const tempDirs: string[] = [];
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

class ProcessExitError extends Error {
	readonly code: number | undefined;
	constructor(code?: number) {
		super(`process.exit(${code})`);
		this.code = code;
	}
}

function createSessionManager(options: { sessionFile?: string } = {}): SessionManager {
	return {
		isPersisted: () => options.sessionFile !== undefined,
		getSessionFile: () => options.sessionFile,
		getSessionId: () => "test-session",
		getSessionDir: () => "/tmp/pi-sessions",
		usesDefaultSessionDir: () => true,
	} as unknown as SessionManager;
}

function createTempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-shutdown-resume-hint-"));
	tempDirs.push(dir);
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "\n");
	return file;
}

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function restoreStdoutIsTTY(): void {
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}
}

function createContext(order: string[], sessionManager = createSessionManager()): ShutdownThis {
	const setShutdownProgressListener = vi.fn((listener?: unknown) => {
		order.push(listener ? "enableProgress" : "disableProgress");
	});
	return {
		isShuttingDown: false,
		unregisterSignalHandlers: vi.fn(),
		runtimeHost: {
			dispose: vi.fn(async () => {
				order.push("dispose");
			}),
			session: { extensionRunner: { setShutdownProgressListener } },
		},
		ui: {
			terminal: {
				drainInput: vi.fn(async () => {
					order.push("drainInput");
				}),
			},
		},
		themeController: { disableAutoSync: vi.fn() },
		stop: vi.fn(() => {
			order.push("stop");
		}),
		sessionManager,
	};
}

async function callShutdown(context: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void> {
	try {
		await (interactiveModePrototype as InteractiveModePrototypeWithShutdown).shutdown.call(context, options);
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

function callEmergencyTerminalExit(context: EmergencyExitThis): void {
	try {
		(interactiveModePrototype as InteractiveModePrototypeWithShutdown).emergencyTerminalExit.call(context);
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

function callUncaughtCrash(context: UncaughtCrashThis, error: Error): void {
	try {
		(interactiveModePrototype as InteractiveModePrototypeWithShutdown).uncaughtCrash.call(context, error);
	} catch (caught) {
		if (!(caught instanceof ProcessExitError)) throw caught;
	}
}

describe("InteractiveMode.shutdown ordering (#5080)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdoutIsTTY();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("signal-triggered shutdown emits session_shutdown before terminal writes", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual(["enableProgress", "dispose", "drainInput", "stop"]);
		expect(context.isShuttingDown).toBe(true);
		expect(context.runtimeHost.session.extensionRunner.setShutdownProgressListener).toHaveBeenCalledWith(
			expect.any(Function),
		);
	});

	test("interactive quit stops the TUI before emitting session_shutdown", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "enableProgress", "dispose", "disableProgress"]);
	});

	test("interactive quit prints a resume hint for persisted sessions", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((() => true) as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionFile: createTempFile() }));

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "enableProgress", "dispose", "disableProgress"]);
		expect(stdoutWrite).toHaveBeenCalledWith(
			`${chalk.dim("To resume this session:")} ${APP_NAME} --session test-session\n`,
		);
	});

	// Owner-loss regression (#5080): an ordinary quit may still be draining input.
	test.each(["drain", "drain-raw-failure", "drain-blocked-hook"] as const)(
		"owner loss during interactive quit at %s suppresses further tty I/O and disposes once",
		async (phase) => {
			vi.useFakeTimers();
			let lost = false;
			vi.spyOn(processOwner, "hasLostCliProcessOwner").mockImplementation(() => lost);
			const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
				throw new ProcessExitError(code);
			}) as typeof process.exit);
			const writes = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const rawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
			const setRawMode = vi.fn(() => {
				throw new Error(`setRawMode failed with errno: ${constants.errno.EBADF}`);
			});
			if (phase === "drain-raw-failure") {
				Object.defineProperty(process.stdin, "setRawMode", { configurable: true, value: setRawMode });
			}
			let releaseDrain!: () => void;
			const drain = new Promise<void>((resolve) => {
				releaseDrain = resolve;
			});
			const setShutdownProgressListener = vi.fn((_listener: () => void) => {});
			const extensionRunner = phase === "drain-raw-failure" ? {} : { setShutdownProgressListener };
			const order: string[] = [];
			const context = Object.assign(createContext(order, createSessionManager({ sessionFile: createTempFile() })), {
				shutdown(options?: { fromSignal?: boolean }): Promise<void> {
					return (interactiveModePrototype as InteractiveModePrototypeWithShutdown).shutdown.call(
						context,
						options,
					);
				},
				runtimeHost: {
					session: { extensionRunner },
					dispose: vi.fn(async () => {
						order.push("hook-enter");
						if (phase === "drain-blocked-hook") await new Promise<void>(() => {});
						order.push("hook-return");
					}),
				},
				ui: {
					stop: vi.fn(),
					terminal: { drainInput: vi.fn(() => drain) },
				},
				stop: vi.fn(() => {
					if (phase === "drain-raw-failure") new ProcessTerminal().stop();
				}),
			});
			const prototype = interactiveModePrototype as { emergencyTerminalExit(this: typeof context): void };
			const quitting = context.shutdown().catch((error: unknown) => error);
			try {
				lost = true;
				prototype.emergencyTerminalExit.call(context);
				prototype.emergencyTerminalExit.call(context);
				releaseDrain();
				if (phase === "drain-blocked-hook") {
					await vi.advanceTimersByTimeAsync(4_999);
					expect(exit).not.toHaveBeenCalled();
					await expect(vi.advanceTimersByTimeAsync(1)).rejects.toMatchObject({ code: 0 });
					expect(order).not.toContain("hook-return");
				} else {
					await expect(quitting).resolves.toMatchObject({ code: 0 });
					expect(vi.getTimerCount()).toBe(0);
				}
				expect(context.runtimeHost.dispose).toHaveBeenCalledOnce();
				expect(setShutdownProgressListener).toHaveBeenCalledTimes(phase === "drain-raw-failure" ? 0 : 1);
				if (phase !== "drain-raw-failure")
					expect(setShutdownProgressListener.mock.calls[0][0]).toBeTypeOf("function");
				expect(context.stop).not.toHaveBeenCalled();
				expect(context.ui.stop).toHaveBeenCalledExactlyOnceWith({ restoreTerminal: false });
				expect(context.ui.terminal.drainInput).toHaveBeenCalledOnce();
				expect(exit).toHaveBeenCalledExactlyOnceWith(0);
				expect(setRawMode).not.toHaveBeenCalled();
				expect(writes).not.toHaveBeenCalled();
			} finally {
				if (rawDescriptor) Object.defineProperty(process.stdin, "setRawMode", rawDescriptor);
				else Reflect.deleteProperty(process.stdin, "setRawMode");
				vi.clearAllTimers();
				vi.useRealTimers();
			}
		},
	);

	test("signal-triggered shutdown does not print a resume hint", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((() => true) as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionFile: createTempFile() }));

		await callShutdown(context, { fromSignal: true });

		for (const call of stdoutWrite.mock.calls) {
			expect(call[0]).not.toContain("To resume this session:");
		}
	});

	test("re-entrant shutdown is a no-op", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);
		context.isShuttingDown = true;

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual([]);
		expect(context.runtimeHost.dispose).not.toHaveBeenCalled();
	});

	test("emergency terminal exit cancels managed executions before exiting", () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const dispose = vi.fn();
		const context: EmergencyExitThis = {
			isShuttingDown: false,
			unregisterSignalHandlers: vi.fn(),
			agent: { managedExecutions: { dispose } },
		};

		callEmergencyTerminalExit(context);

		expect(dispose).toHaveBeenCalledOnce();
		expect(context.isShuttingDown).toBe(true);
	});

	test("uncaught crash cancels managed executions before exiting", () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const dispose = vi.fn();
		const context: UncaughtCrashThis = {
			isShuttingDown: false,
			unregisterSignalHandlers: vi.fn(),
			agent: { managedExecutions: { dispose } },
			ui: { stop: vi.fn() },
			recordCrash: () => false,
			crashReportInstructions: () => "",
			getCrashExtensionHint: () => undefined,
		};

		callUncaughtCrash(context, new Error("boom"));

		expect(dispose).toHaveBeenCalledOnce();
		expect(context.isShuttingDown).toBe(true);
	});

	test("re-entrant uncaught crash still cancels managed executions", () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const dispose = vi.fn();
		const context: UncaughtCrashThis = {
			isShuttingDown: true,
			unregisterSignalHandlers: vi.fn(),
			agent: { managedExecutions: { dispose } },
			ui: { stop: vi.fn() },
			recordCrash: () => false,
			crashReportInstructions: () => "",
			getCrashExtensionHint: () => undefined,
		};

		callUncaughtCrash(context, new Error("boom"));

		expect(dispose).toHaveBeenCalledOnce();
	});
});

// Regression for the `read EIO` crash reports (crash_tty_read_eio).
//
// When the terminal goes away, stdin reads and setRawMode fail with EIO (pi is
// left in an orphaned background process group) or ENOTTY (macOS revoked the
// tty). Node emits these as `error` events on process.stdin. Without a stdin
// listener they became uncaught exceptions that were recorded as crashes and
// prompted users to run /bug on the next launch.

type HandlerContext = {
	isShuttingDown: boolean;
	signalCleanupHandlers: Array<() => void>;
	shutdown: (options?: { fromSignal: boolean }) => Promise<void>;
	unregisterSignalHandlers: () => void;
	emergencyTerminalExit: () => void;
	uncaughtCrash: (error: Error) => void;
	recordCrash: () => boolean;
	getCrashExtensionHint: () => string | undefined;
	crashReportInstructions: () => string;
	ui: { stop: (options?: { restoreTerminal: boolean }) => void };
	themeController: { disableAutoSync: () => void };
};

type InteractiveModePrivates = {
	registerSignalHandlers(this: HandlerContext): void;
	unregisterSignalHandlers(this: HandlerContext): void;
	emergencyTerminalExit(this: HandlerContext): never;
	uncaughtCrash(this: HandlerContext, error: Error): never;
};

const proto = InteractiveMode.prototype as unknown as InteractiveModePrivates;

function createHandlerContext(): HandlerContext {
	const context: HandlerContext = {
		isShuttingDown: false,
		signalCleanupHandlers: [],
		shutdown: vi.fn(async () => {}),
		unregisterSignalHandlers: () => proto.unregisterSignalHandlers.call(context),
		emergencyTerminalExit: () => proto.emergencyTerminalExit.call(context),
		uncaughtCrash: (error: Error) => proto.uncaughtCrash.call(context, error),
		recordCrash: vi.fn(() => true),
		getCrashExtensionHint: () => undefined,
		crashReportInstructions: () => "",
		ui: { stop: vi.fn() },
		themeController: { disableAutoSync: vi.fn() },
	};
	return context;
}

function errnoError(message: string, code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

function captureExit(fn: () => void): number | undefined {
	try {
		fn();
	} catch (error) {
		if (error instanceof ProcessExitError) return error.code;
		throw error;
	}
	throw new Error("expected process.exit");
}

describe("dead terminal errors on stdin", () => {
	let context: HandlerContext | undefined;

	afterEach(() => {
		context?.unregisterSignalHandlers();
		context = undefined;
		vi.restoreAllMocks();
	});

	function setup(): HandlerContext {
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ProcessExitError(code);
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation(() => {});
		context = createHandlerContext();
		proto.registerSignalHandlers.call(context);
		return context;
	}

	test.each([
		["ENOTTY", constants.errno.ENOTTY],
		["EIO", constants.errno.EIO],
		["EBADF", constants.errno.EBADF],
	])("owner loss during SIGCONT raw-mode %s enters the shutdown hook", async (code, errno) => {
		let lost = false;
		vi.spyOn(processOwner, "hasLostCliProcessOwner").mockImplementation(() => lost);
		vi.spyOn(process, "kill").mockReturnValue(true);
		const rawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
		Object.defineProperty(process.stdin, "setRawMode", {
			configurable: true,
			value: () => {
				throw new Error(`setRawMode failed with errno: ${errno}`);
			},
		});
		const ctx = setup();
		const entered = vi.fn();
		const runtimeContext = Object.assign(ctx, {
			sessionManager: createSessionManager(),
			runtimeHost: {
				dispose: async () => {
					entered();
				},
				session: { extensionRunner: { setShutdownProgressListener: vi.fn() } },
			},
			ui: {
				stop: vi.fn(),
				requestRender: vi.fn(),
				start: () => {
					lost = true;
					new ProcessTerminal().start(
						() => {},
						() => {},
					);
				},
				terminal: { drainInput: vi.fn(async () => {}) },
			},
			stop: vi.fn(),
		});
		let shutdown: Promise<void> | undefined;
		ctx.shutdown = (options) => {
			const result = (interactiveModePrototype as InteractiveModePrototypeWithShutdown).shutdown.call(
				runtimeContext,
				options,
			);
			shutdown ??= result;
			return result;
		};
		try {
			(InteractiveMode.prototype as unknown as { handleCtrlZ(this: typeof runtimeContext): void }).handleCtrlZ.call(
				runtimeContext,
			);
			try {
				process.emit("SIGCONT");
				throw new Error("expected raw-mode failure");
			} catch (error) {
				expect(error).toMatchObject({ code, errno, syscall: "setRawMode" });
				ctx.uncaughtCrash(error as Error);
			}
			await expect(shutdown).rejects.toMatchObject({ code: 0 });
			expect(entered).toHaveBeenCalledOnce();
			expect(ctx.ui.stop).toHaveBeenLastCalledWith({ restoreTerminal: false });
			expect(ctx.recordCrash).not.toHaveBeenCalled();
		} finally {
			if (rawDescriptor) Object.defineProperty(process.stdin, "setRawMode", rawDescriptor);
			else Reflect.deleteProperty(process.stdin, "setRawMode");
		}
	});

	test("owner-loss TERM followed by terminal EIO enters shutdown without more terminal I/O", async () => {
		vi.spyOn(processOwner, "hasLostCliProcessOwner").mockReturnValue(true);
		const ctx = setup();
		const entered = vi.fn();
		const runtimeContext = Object.assign(ctx, {
			sessionManager: createSessionManager(),
			runtimeHost: {
				dispose: async () => {
					entered();
				},
				session: { extensionRunner: { setShutdownProgressListener: vi.fn() } },
			},
			ui: { stop: vi.fn(), terminal: { drainInput: vi.fn(async () => {}) } },
			stop: vi.fn(),
		});
		let shutdown: Promise<void> | undefined;
		ctx.shutdown = (options) => {
			const result = (interactiveModePrototype as InteractiveModePrototypeWithShutdown).shutdown.call(
				runtimeContext,
				options,
			);
			shutdown ??= result;
			return result;
		};
		// Call only this product's prepended handler, not unrelated test-process listeners.
		process.listeners("SIGTERM")[0]!("SIGTERM");
		process.stdin.emit("error", errnoError("read EIO", "EIO"));
		await expect(shutdown).rejects.toMatchObject({ code: 0 });
		expect(entered).toHaveBeenCalledOnce();
		expect(ctx.ui.stop).toHaveBeenCalledExactlyOnceWith({ restoreTerminal: false });
		expect(runtimeContext.ui.terminal.drainInput).not.toHaveBeenCalled();
		expect(runtimeContext.stop).not.toHaveBeenCalled();
		expect(ctx.recordCrash).not.toHaveBeenCalled();
	});

	test.each([
		["read EIO", "EIO"],
		["setRawMode EIO", "EIO"],
		["setRawMode ENOTTY", "ENOTTY"],
	])("stdin %s exits quietly without recording a crash", (message, code) => {
		const ctx = setup();

		const exitCode = captureExit(() => process.stdin.emit("error", errnoError(message, code)));

		expect(exitCode).toBe(129);
		expect(ctx.recordCrash).not.toHaveBeenCalled();
		expect(ctx.ui.stop).not.toHaveBeenCalled();
	});

	test.each([
		[false, "setRawMode"],
		[true, undefined],
		[true, "open"],
	])("EBADF remains a crash outside owner-loss raw-mode failure: ownerLost=%s syscall=%s", (lost, syscall) => {
		vi.spyOn(processOwner, "hasLostCliProcessOwner").mockReturnValue(lost);
		const ctx = setup();
		const error = Object.assign(errnoError("bad descriptor", "EBADF"), { syscall });
		expect(captureExit(() => ctx.uncaughtCrash(error))).toBe(1);
		expect(ctx.recordCrash).toHaveBeenCalledOnce();
		expect(ctx.shutdown).not.toHaveBeenCalled();
	});

	test("other stdin errors still crash", () => {
		setup();
		const error = errnoError("read ECONNREFUSED", "ECONNREFUSED");

		expect(() => process.stdin.emit("error", error)).toThrow(error);
	});

	test("uncaught dead terminal errors are not recorded as crashes", () => {
		const ctx = setup();

		const exitCode = captureExit(() => ctx.uncaughtCrash(errnoError("read EIO", "EIO")));

		expect(exitCode).toBe(129);
		expect(ctx.recordCrash).not.toHaveBeenCalled();
	});

	test("other uncaught errors are still recorded as crashes", () => {
		const ctx = setup();

		const exitCode = captureExit(() => ctx.uncaughtCrash(new Error("boom")));

		expect(exitCode).toBe(1);
		expect(ctx.recordCrash).toHaveBeenCalledOnce();
	});

	test("handlers are removed on unregister", () => {
		const ctx = setup();
		const before = process.stdin.listenerCount("error");

		ctx.unregisterSignalHandlers();

		expect(process.stdin.listenerCount("error")).toBe(before - 1);
	});
});
