import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";

const realNow = performance.now.bind(performance);

// Fake clock advancement cannot flush compression's real worker-thread I/O.
export async function waitForNativeIo(check: () => boolean): Promise<void> {
	const deadline = realNow() + 2000;
	while (!check()) {
		if (realNow() > deadline) throw new Error("Native I/O did not complete");
		await setImmediate();
	}
}
