import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import * as processOwner from "../../../src/utils/process-owner.ts";

// #5080: native fatal-owner cleanup can end before the independent JS exit timer.
describe("owner-loss shutdown allowance", () => {
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function setup(ownerLost: boolean, hookMs: number, terminalUnavailable = false) {
		vi.useFakeTimers();
		vi.spyOn(processOwner, "hasLostCliProcessOwner").mockReturnValue(ownerLost);
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw Object.assign(new Error("exit"), { code });
		}) as typeof process.exit);
		const entered = vi.fn();
		const returned = vi.fn();
		const context = {
			isShuttingDown: false,
			terminalUnavailable,
			unregisterSignalHandlers: vi.fn(),
			runtimeHost: {
				session: { extensionRunner: { setShutdownProgressListener: vi.fn() } },
				dispose: async () => {
					entered();
					await new Promise<void>((resolve) => setTimeout(resolve, hookMs));
					returned();
				},
			},
			ui: { terminal: { drainInput: vi.fn(async () => {}) } },
			themeController: { disableAutoSync: vi.fn() },
			stop: vi.fn(),
			sessionManager: { isPersisted: () => false } as SessionManager,
		};
		const prototype = InteractiveMode.prototype as unknown as {
			shutdown(this: typeof context, options: { fromSignal: boolean }): Promise<void>;
		};
		const completed = prototype.shutdown.call(context, { fromSignal: true }).catch((error: unknown) => error);
		return { context, entered, returned, exit, completed };
	}

	test.each([100, 1000, 2900])("hook completing at %i ms exits zero and restores terminal", async (ms) => {
		const state = setup(true, ms);
		expect(state.entered).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(ms);
		await expect(state.completed).resolves.toMatchObject({ code: 0 });
		expect(state.returned).toHaveBeenCalledOnce();
		expect(state.context.stop).toHaveBeenCalledOnce();
		expect(state.exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test.each([false, true])(
		"blocked hook: no JS exit at fatal 3s cutoff; old 6s allowance reaches 5s timer (dead tty=%s)",
		async (deadTty) => {
			const state = setup(true, 12_000, deadTty);
			expect(state.entered).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(3000);
			// Native SIGKILL at this point cannot run JS restoration or process.exit(0).
			expect(state.exit).not.toHaveBeenCalled();
			expect(state.context.stop).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1999);
			expect(state.exit).not.toHaveBeenCalled();
			await expect(vi.advanceTimersByTimeAsync(1)).rejects.toMatchObject({ code: 0 });
			expect(state.exit).toHaveBeenCalledExactlyOnceWith(0);
			expect(state.returned).not.toHaveBeenCalled();
			expect(state.context.stop).toHaveBeenCalledTimes(deadTty ? 0 : 1);
		},
	);

	test("ordinary forwarded signal retains hooks longer than fatal grace without owner-loss timer", async () => {
		const state = setup(false, 5500);
		await vi.advanceTimersByTimeAsync(5000);
		expect(state.exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(500);
		await expect(state.completed).resolves.toMatchObject({ code: 0 });
		expect(state.returned).toHaveBeenCalledOnce();
		expect(state.context.stop).toHaveBeenCalledOnce();
		expect(state.exit).toHaveBeenCalledExactlyOnceWith(0);
	});
});
