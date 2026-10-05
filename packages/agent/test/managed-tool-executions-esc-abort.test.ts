import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "../src/index.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function streamIgnoringToolCall(): StreamFn {
	let turn = 0;
	return () => {
		const stream = new MockAssistantStream();
		const currentTurn = turn++;
		queueMicrotask(() => {
			const reason = currentTurn === 0 ? "toolUse" : "stop";
			const message: AssistantMessage =
				currentTurn === 0
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: "call-ignoring", name: "ignoring", arguments: {} }],
							api: "openai-responses",
							provider: "openai",
							model: "mock",
							usage: createUsage(),
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							api: "openai-responses",
							provider: "openai",
							model: "mock",
							usage: createUsage(),
							stopReason: "stop",
							timestamp: Date.now(),
						};
			stream.push({ type: "done", reason, message });
		});
		return stream;
	};
}

async function expectPromptSettled(prompt: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			prompt,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Agent abort did not release prompt")), 1000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

it("keeps AbortSignal-ignoring work unmanaged when Esc wins before detach", async () => {
	const started = createDeferred<void>();
	const finish = createDeferred<void>();
	let abortSeen = false;
	const ignoring: AgentTool<ReturnType<typeof Type.Object>> = {
		name: "ignoring",
		label: "ignoring",
		description: "ignores abort",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			started.resolve(undefined);
			signal?.addEventListener("abort", () => {
				abortSeen = true;
			});
			await finish.promise;
			return { content: [{ type: "text", text: "late" }], details: {} };
		},
	};
	const agent = new Agent({
		initialState: { tools: [ignoring] },
		streamFn: streamIgnoringToolCall(),
		backgroundToolCalls: { ignoring: { detachAfterSeconds: 3600 } },
	} as ConstructorParameters<typeof Agent>[0]);
	const events: AgentEvent[] = [];
	agent.subscribe((event) => {
		events.push(event);
	});

	const prompt = agent.prompt("run ignoring tool");
	try {
		await started.promise;
		agent.abort();
		await expectPromptSettled(prompt);

		expect(abortSeen).toBe(true);
		const managed = agent as Agent & { managedExecutions: { list(): unknown[] } };
		expect(managed.managedExecutions.list()).toEqual([]);
		const results = agent.state.messages.filter(
			(message) => message.role === "toolResult" && message.toolCallId === "call-ignoring",
		);
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual(expect.objectContaining({ isError: true }));
		expect(
			events.filter((event) => event.type === "tool_execution_end" && event.toolCallId === "call-ignoring"),
		).toHaveLength(1);

		finish.resolve(undefined);
		await Promise.resolve();
		expect(
			agent.state.messages.filter(
				(message) => message.role === "toolResult" && message.toolCallId === "call-ignoring",
			),
		).toHaveLength(1);
	} finally {
		finish.resolve(undefined);
		await Promise.resolve();
	}
});
