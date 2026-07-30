import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: Array<{
		resolve: (value: IteratorResult<T>) => void;
		reject: (error: unknown) => void;
	}> = [];
	private terminalState: { kind: "active" } | { kind: "ended" } | { kind: "failed"; error: unknown } = {
		kind: "active",
	};
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private rejectFinalResult!: (error: unknown) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
		// Consumers may use either async iteration or result(). Mark the result
		// branch handled without changing the original promise's rejection.
		void this.finalResultPromise.catch(() => {});
	}

	push(event: T): void {
		if (this.terminalState.kind !== "active") return;

		if (this.isComplete(event)) {
			this.terminalState = { kind: "ended" };
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
		if (this.terminalState.kind === "ended") {
			this.resolveWaitingConsumers();
		}
	}

	end(): void;
	end(result: R): void;
	end(...args: [] | [R]): void {
		if (args.length === 0) {
			this.close();
			return;
		}
		if (this.terminalState.kind !== "active") return;
		this.terminalState = { kind: "ended" };
		this.resolveFinalResult(args[0]);
		this.resolveWaitingConsumers();
	}

	close(): void {
		if (this.terminalState.kind !== "active") return;
		this.terminalState = { kind: "failed", error: new Error("Event stream closed without a final result") };
		this.rejectFinalResult(this.terminalState.error);
		while (this.waiting.length > 0) {
			this.waiting.shift()!.reject(this.terminalState.error);
		}
	}

	private resolveWaitingConsumers(): void {
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.resolve({ value: undefined as any, done: true });
		}
	}

	fail(error: unknown): void {
		if (this.terminalState.kind !== "active") return;
		this.terminalState = { kind: "failed", error };
		this.rejectFinalResult(error);
		while (this.waiting.length > 0) {
			this.waiting.shift()!.reject(error);
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.terminalState.kind === "failed") {
				throw this.terminalState.error;
			} else if (this.terminalState.kind === "ended") {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve, reject) =>
					this.waiting.push({ resolve, reject }),
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
