import { afterEach, expect, test, vi } from "vitest";
import type { observeOwnerLoss } from "../src/utils/managed-child.ts";
import { ownCliProcess, prepareProcessShutdown, repeatedShutdownSignal } from "../src/utils/procward.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

test("the default bridge uses the remaining absolute five-second budget and never renews it", () => {
	vi.useFakeTimers();
	vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", undefined);
	vi.stubEnv("PI_PROCWARD_BOOTSTRAP_NONCE", "a".repeat(32));
	vi.stubEnv("PROCWARD_PROTOCOL", "1");
	vi.stubEnv("PROCWARD_OWNER_PID", "200");
	let onLoss: Parameters<typeof observeOwnerLoss>[1] | undefined;
	let now = 4000;
	vi.spyOn(performance, "now").mockImplementation(() => now - performance.timeOrigin);
	const timer = vi.spyOn(globalThis, "setTimeout");
	const kill = vi.spyOn(process, "kill").mockReturnValue(true);
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const exited = new Error("exit");
	const exit = vi.spyOn(process, "exit").mockImplementation(() => {
		throw exited;
	});
	// Without an observed owner loss, a second signal skips graceful cleanup as before.
	expect(repeatedShutdownSignal(2)).toBe(true);
	expect(repeatedShutdownSignal(1)).toBe(false);
	ownCliProcess([], {
		resolveBinary: () => {
			throw new Error("no native helper");
		},
		consumeContract: () => ({ ownerPid: 200, lifecycleFd: 7, launchId: "a".repeat(32) }),
		observeLoss: (_contract, callback) => {
			onLoss = callback;
			return { stop() {}, observedAt: 1000 };
		},
	});
	onLoss!("owner-loss", 1000);
	expect(timer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 2000);
	expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, "SIGTERM");
	// After observed owner loss, further TERMs never skip hooks; the deadline bounds exit.
	expect(repeatedShutdownSignal(2)).toBe(false);
	expect(repeatedShutdownSignal(5)).toBe(false);
	now = 5000;
	prepareProcessShutdown();
	onLoss!("eof", 5000);
	expect(timer).toHaveBeenCalledTimes(1);
	expect(kill).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(1999);
	expect(exit).not.toHaveBeenCalled();
	expect(() => vi.advanceTimersByTime(1)).toThrow(exited);
	expect(exit).toHaveBeenCalledWith(143);
});
