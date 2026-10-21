import { afterEach, expect, it, vi } from "vitest";
import { bashTimeout, pauseBashTimeouts, resumeBashTimeouts } from "../src/utils/bash-timeout.ts";

afterEach(() => {
	resumeBashTimeouts();
	vi.useRealTimers();
});

it("keeps ordinary timeouts unchanged without suspend", () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const expired = vi.fn();
	const dispose = bashTimeout(expired, 100);
	try {
		vi.advanceTimersByTime(99);
		expect(expired).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(expired).toHaveBeenCalledOnce();
	} finally {
		dispose();
	}
});

it.skipIf(process.platform === "win32")("subtracts only running time and resumes once after repeated SIGCONT", () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const expired = vi.fn();
	const dispose = bashTimeout(expired, 1_000);
	try {
		vi.advanceTimersByTime(400);
		pauseBashTimeouts();
		pauseBashTimeouts();
		vi.advanceTimersByTime(30_000);
		expect(expired).not.toHaveBeenCalled();
		resumeBashTimeouts();
		vi.advanceTimersByTime(300);
		resumeBashTimeouts();
		vi.advanceTimersByTime(299);
		expect(expired).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(expired).toHaveBeenCalledOnce();
	} finally {
		dispose();
	}
});

it.skipIf(process.platform === "win32")(
	"does not resurrect cancelled timeouts or run newly registered timers while paused",
	() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const cancelled = vi.fn();
		const expired = vi.fn();
		pauseBashTimeouts();
		const cancel = bashTimeout(cancelled, 100);
		const dispose = bashTimeout(expired, 100);
		try {
			cancel();
			vi.advanceTimersByTime(1_000);
			expect(expired).not.toHaveBeenCalled();
			resumeBashTimeouts();
			vi.advanceTimersByTime(100);
			expect(expired).toHaveBeenCalledOnce();
			expect(cancelled).not.toHaveBeenCalled();
		} finally {
			cancel();
			dispose();
		}
	},
);
