import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

function createStream(): EventStream<string, string> {
	return new EventStream(
		(event) => event === "done",
		(event) => event,
	);
}

async function captureUnhandled(run: () => Promise<void>): Promise<unknown[]> {
	const unhandled: unknown[] = [];
	const listener = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", listener);
	try {
		await run();
		await new Promise((resolve) => setImmediate(resolve));
		return unhandled;
	} finally {
		process.off("unhandledRejection", listener);
	}
}

describe("EventStream terminal errors", () => {
	it("delivers a terminal push to one waiting iterator and completes every other waiter", async () => {
		const stream = createStream();
		const first = stream[Symbol.asyncIterator]().next();
		const second = stream[Symbol.asyncIterator]().next();
		const third = stream[Symbol.asyncIterator]().next();

		stream.push("done");

		await expect(first).resolves.toEqual({ value: "done", done: false });
		await expect(
			Promise.race([
				second,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("second waiter hung")), 50)),
			]),
		).resolves.toEqual({
			value: undefined,
			done: true,
		});
		await expect(
			Promise.race([
				third,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("third waiter hung")), 50)),
			]),
		).resolves.toEqual({
			value: undefined,
			done: true,
		});
		await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({ value: undefined, done: true });
	});

	it("yields queued events before rejecting iterator and repeated result consumers", async () => {
		const stream = createStream();
		const error = new Error("stream setup failed");
		stream.push("queued");
		stream.fail(error);
		const iterator = stream[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({ value: "queued", done: false });
		await expect(iterator.next()).rejects.toBe(error);
		await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(error);
		await expect(stream.result()).rejects.toBe(error);
		await expect(stream.result()).rejects.toBe(error);
	});

	it("rejects a currently waiting iterator", async () => {
		const stream = createStream();
		const error = new Error("stream setup failed");
		const next = stream[Symbol.asyncIterator]().next();

		stream.fail(error);

		await expect(next).rejects.toBe(error);
	});

	it("treats undefined as a failure reason", async () => {
		const stream = createStream();
		const iterator = stream[Symbol.asyncIterator]();
		stream.fail(undefined);

		await expect(iterator.next()).rejects.toBeUndefined();
		await expect(stream.result()).rejects.toBeUndefined();
	});

	it("ignores push and repeated terminal calls after failure", async () => {
		const stream = createStream();
		const error = new Error("first failure");
		stream.fail(error);
		stream.push("late");
		stream.end("late result");
		stream.fail(new Error("second failure"));
		const iterator = stream[Symbol.asyncIterator]();

		await expect(iterator.next()).rejects.toBe(error);
		await expect(stream.result()).rejects.toBe(error);
	});

	it("close rejects consumers instead of leaving the final result pending", async () => {
		const stream = createStream();
		const next = stream[Symbol.asyncIterator]().next();
		stream.close();

		await expect(next).rejects.toThrow("Event stream closed without a final result");
		await expect(stream.result()).rejects.toThrow("Event stream closed without a final result");
	});

	it("preserves result-less end as a rejecting close", async () => {
		const stream = createStream();
		const next = stream[Symbol.asyncIterator]().next();
		stream.end();

		await expect(next).rejects.toThrow("Event stream closed without a final result");
		await expect(stream.result()).rejects.toThrow("Event stream closed without a final result");
	});

	it("ends with an explicit result and remains idempotent", async () => {
		const stream = createStream();
		stream.push("queued");
		stream.end("explicit result");
		stream.end("ignored result");
		stream.fail(new Error("ignored failure"));
		const iterator = stream[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({ value: "queued", done: false });
		await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
		await expect(stream.result()).resolves.toBe("explicit result");
	});

	it("does not create an unhandled rejection when the caller only iterates", async () => {
		const error = new Error("iteration-only failure");
		const unhandled = await captureUnhandled(async () => {
			const stream = createStream();
			stream.fail(error);
			await expect(async () => {
				for await (const _event of stream) {
					// No events are expected.
				}
			}).rejects.toBe(error);
		});

		expect(unhandled).toEqual([]);
	});

	it("does not create an unhandled rejection when the caller only awaits result", async () => {
		const error = new Error("result-only failure");
		const unhandled = await captureUnhandled(async () => {
			const stream = createStream();
			stream.fail(error);
			await expect(stream.result()).rejects.toBe(error);
		});

		expect(unhandled).toEqual([]);
	});
});
