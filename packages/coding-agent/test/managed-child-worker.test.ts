import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { observeOwnerLoss } from "../src/utils/managed-child.ts";

const captured = vi.hoisted(() => ({
	source: "",
	data: undefined as unknown,
	listeners: new Map<string, (value?: unknown) => void>(),
}));
vi.mock("node:worker_threads", () => ({
	Worker: class {
		constructor(url: URL, options: { workerData: unknown }) {
			captured.source = Buffer.from(url.href.split(",")[1], "base64").toString();
			captured.data = options.workerData;
			captured.listeners.clear();
		}
		once(event: string, callback: (value?: unknown) => void) {
			captured.listeners.set(event, callback);
			return this;
		}
		unref() {}
		terminate() {
			return Promise.resolve(0);
		}
	},
}));
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("the actual worker program arms its absolute seven-second timer before notification, only on first loss", () => {
	vi.useFakeTimers();
	const observer = observeOwnerLoss({ ownerPid: 200, launchId: "a".repeat(32), lifecycleFd: 7 }, vi.fn());
	let pipe: EventEmitter | undefined;
	let clock = 50;
	const timer = vi.spyOn(globalThis, "setTimeout");
	const kill = vi.fn();
	const postMessage = vi.fn();
	// Execute the production worker body with controlled transport and clocks, not a second implementation.
	runInNewContext(captured.source.replace(/^import .*;\n/gm, ""), {
		workerData: captured.data,
		parentPort: { postMessage },
		Socket: class extends EventEmitter {
			constructor() {
				super();
				pipe = this;
			}
		},
		process: { versions: {}, kill },
		performance: {
			timeOrigin: 1000,
			now: () => {
				const value = clock;
				clock += 25;
				return value;
			},
		},
		BigInt64Array,
		Uint8Array,
		Atomics,
		Buffer,
		setTimeout,
	});
	expect(timer).not.toHaveBeenCalled();
	expect(observer.observedAt).toBeUndefined();
	pipe!.emit("data", Buffer.from(`PROCWARD/1 OWNER-LOSS ${"a".repeat(32)}\n`));
	expect(observer.observedAt).toBe(1050);
	// 25ms elapsed between first observation and timer scheduling; it is not granted again.
	expect(timer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 6975);
	expect(postMessage).toHaveBeenCalledExactlyOnceWith("owner-loss");
	expect(timer.mock.invocationCallOrder[0]).toBeLessThan(postMessage.mock.invocationCallOrder[0]);
	clock = 3000;
	pipe!.emit("data", Buffer.from(`PROCWARD/1 OWNER-LOSS ${"a".repeat(32)}\n`));
	pipe!.emit("end");
	expect(observer.observedAt).toBe(1050);
	expect(timer).toHaveBeenCalledTimes(1);
	expect(postMessage).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(6974);
	expect(kill).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1);
	expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, "SIGKILL");
});

test("worker failure notifies once and fails closed, without claiming a dead-worker watchdog", () => {
	const onLoss = vi.fn();
	const observer = observeOwnerLoss({ ownerPid: 200, launchId: "a".repeat(32), lifecycleFd: 7 }, onLoss);
	captured.listeners.get("error")!(new Error("worker failed"));
	const first = observer.observedAt;
	captured.listeners.get("exit")!(1);
	expect(first).toBeDefined();
	expect(observer.observedAt).toBe(first);
	expect(onLoss).toHaveBeenCalledExactlyOnceWith("worker-error", first);
	const intentional = vi.fn();
	const stopped = observeOwnerLoss({ ownerPid: 200, launchId: "a".repeat(32), lifecycleFd: 7 }, intentional);
	stopped.stop();
	captured.listeners.get("exit")!(0);
	expect(intentional).not.toHaveBeenCalled();
});
