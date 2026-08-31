import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	Agent,
	type AgentEvent,
	type AgentTool,
	type AgentToolResult,
	type ManagedExecutionCancelResult,
	type StreamFn,
} from "../src/index.ts";

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

type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

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

function createAssistantToolUseMessage(content: ToolCallContent[]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createDeferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

const emptySchema = Type.Object({});

type ManagedExecutionStatus = "running" | "completed" | "error" | "cancel_requested";

type ManagedExecutionInfo = {
	id: string;
	toolName: string;
	toolCallId: string;
	status: ManagedExecutionStatus;
};

type ManagedWaitResult = {
	content: Array<{ type: string; text?: string }>;
	details: unknown;
	isError: boolean;
};

type ManagedExecutionsApi = {
	list(): ManagedExecutionInfo[];
	info(id: string): ManagedExecutionInfo | undefined;
	wait(id: string, timeoutSeconds: number): Promise<ManagedWaitResult>;
	cancel(id: string): ManagedExecutionCancelResult;
};

type AgentWithManagedExecutions = Agent & {
	managedExecutions: ManagedExecutionsApi;
};

function managed(agent: Agent): ManagedExecutionsApi {
	const api = (agent as AgentWithManagedExecutions).managedExecutions;
	expect(api, "Agent.managedExecutions public registry").toBeDefined();
	return api;
}

async function expectSettled(promise: Promise<unknown>, label: string): Promise<void> {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let i = 0; i < 20; i++) {
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
	}
	expect(settled, label).toBe(true);
}

function toolResultMessages(agent: Agent) {
	return agent.state.messages.filter((message) => message.role === "toolResult");
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n") ?? ""
	);
}

function createHangTool(name: string): {
	tool: AgentTool<typeof emptySchema>;
	started: ReturnType<typeof createDeferred<void>>;
	finish: ReturnType<typeof createDeferred<{ text: string; error?: boolean }>>;
	abortSeen: { current: boolean };
} {
	const started = createDeferred<void>();
	const finish = createDeferred<{ text: string; error?: boolean }>();
	hangCleanups.push(() => finish.resolve({ text: "cleanup", error: true }));
	const abortSeen = { current: false };
	const tool: AgentTool<typeof emptySchema> = {
		name,
		label: name,
		description: `${name} hang tool`,
		parameters: emptySchema,
		async execute(_toolCallId, _params, signal) {
			started.resolve(undefined);
			const onAbort = () => {
				abortSeen.current = true;
			};
			signal?.addEventListener("abort", onAbort);
			try {
				const outcome = await finish.promise;
				if (outcome.error) {
					throw new Error(outcome.text);
				}
				return {
					content: [{ type: "text", text: outcome.text }],
					details: { output: outcome.text },
				};
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
	return { tool, started, finish, abortSeen };
}

function streamToolCallsThenStop(calls: ToolCallContent[]): StreamFn {
	let turn = 0;
	return () => {
		const stream = new MockAssistantStream();
		const currentTurn = turn++;
		queueMicrotask(() => {
			if (currentTurn === 0) {
				const message = createAssistantToolUseMessage(calls);
				stream.push({ type: "done", reason: "toolUse", message });
				return;
			}
			stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
		});
		return stream;
	};
}

const hangCleanups: Array<() => void> = [];

describe("managed tool executions", () => {
	afterEach(() => {
		while (hangCleanups.length > 0) {
			hangCleanups.pop()?.();
		}
		vi.useRealTimers();
	});

	it("detaches an opted-in call once with a synthetic result and keeps the promise observed", async () => {
		vi.useFakeTimers();
		const hang = createHangTool("hang");
		const agent = new Agent({
			initialState: { tools: [hang.tool] },
			streamFn: streamToolCallsThenStop([{ type: "toolCall", id: "call-hang", name: "hang", arguments: {} }]),
			backgroundToolCalls: { hang: { detachAfterSeconds: 1 } },
		} as ConstructorParameters<typeof Agent>[0]);

		const promptPromise = agent.prompt("run hang");
		await hang.started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(promptPromise, "original call released after detach");

		const originalResults = toolResultMessages(agent).filter((message) => message.toolCallId === "call-hang");
		expect(originalResults).toHaveLength(1);
		expect(originalResults[0]?.isError).toBeFalsy();
		expect(textOf(originalResults[0]!)).not.toContain("secret-output");
		expect(originalResults[0]?.details).toEqual(
			expect.objectContaining({
				taskId: expect.any(String),
			}),
		);

		const listed = managed(agent).list();
		expect(listed).toHaveLength(1);
		expect(listed[0]).toEqual(
			expect.objectContaining({
				id: (originalResults[0]?.details as { taskId: string }).taskId,
				toolName: "hang",
				toolCallId: "call-hang",
				status: "running",
			}),
		);
		expect(JSON.stringify(listed[0])).not.toContain("secret-output");

		hang.finish.resolve({ text: "secret-output" });
		await vi.advanceTimersByTimeAsync(0);
		expect(toolResultMessages(agent).filter((message) => message.toolCallId === "call-hang")).toHaveLength(1);
		expect(managed(agent).info(listed[0]!.id)?.status).toBe("completed");
	});

	it("keeps detached tools terminal when they emit updates after the original run settles", async () => {
		vi.useFakeTimers();
		const started = createDeferred<void>();
		const finish = createDeferred<void>();
		hangCleanups.push(() => finish.resolve(undefined));
		const tool: AgentTool<typeof emptySchema> = {
			name: "updating",
			label: "updating",
			description: "emits a late update",
			parameters: emptySchema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				started.resolve(undefined);
				await finish.promise;
				onUpdate?.({ content: [{ type: "text", text: "late-update" }], details: {} });
				return { content: [{ type: "text", text: "final-output" }], details: {} };
			},
		};
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: streamToolCallsThenStop([
				{ type: "toolCall", id: "call-updating", name: "updating", arguments: {} },
			]),
			backgroundToolCalls: { updating: { detachAfterSeconds: 1 } },
		} as ConstructorParameters<typeof Agent>[0]);

		const promptPromise = agent.prompt("run updating");
		await started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(promptPromise, "original call released after detach");
		const taskId = managed(agent).list()[0]!.id;

		finish.resolve(undefined);
		await vi.advanceTimersByTimeAsync(0);

		expect(managed(agent).info(taskId)?.status).toBe("completed");
		expect(textOf(await managed(agent).wait(taskId, 1))).toContain("final-output");
		expect(toolResultMessages(agent).filter((message) => message.toolCallId === "call-updating")).toHaveLength(1);
	});

	it("returns the real outcome on the original call when completion wins the detach race", async () => {
		vi.useFakeTimers();
		const hang = createHangTool("hang");
		const agent = new Agent({
			initialState: { tools: [hang.tool] },
			streamFn: streamToolCallsThenStop([{ type: "toolCall", id: "call-hang", name: "hang", arguments: {} }]),
			backgroundToolCalls: { hang: { detachAfterSeconds: 1 } },
		} as ConstructorParameters<typeof Agent>[0]);

		const promptPromise = agent.prompt("run hang");
		await hang.started.promise;
		hang.finish.resolve({ text: "real-output" });
		await vi.advanceTimersByTimeAsync(0);
		await expectSettled(promptPromise, "original call released after detach");
		await vi.advanceTimersByTimeAsync(1000);

		const originalResults = toolResultMessages(agent).filter((message) => message.toolCallId === "call-hang");
		expect(originalResults).toHaveLength(1);
		expect(textOf(originalResults[0]!)).toContain("real-output");
		expect(managed(agent).list()).toEqual([]);
	});

	it("never emits a second original result when detach wins, including later success or error", async () => {
		vi.useFakeTimers();
		const hang = createHangTool("hang");
		const agent = new Agent({
			initialState: { tools: [hang.tool] },
			streamFn: streamToolCallsThenStop([{ type: "toolCall", id: "call-hang", name: "hang", arguments: {} }]),
			backgroundToolCalls: { hang: { detachAfterSeconds: 1 } },
		} as ConstructorParameters<typeof Agent>[0]);

		const promptPromise = agent.prompt("run hang");
		await hang.started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(promptPromise, "original call released after detach");
		const taskId = managed(agent).list()[0]!.id;

		hang.finish.resolve({ text: "late-error", error: true });
		await vi.advanceTimersByTimeAsync(0);

		expect(toolResultMessages(agent).filter((message) => message.toolCallId === "call-hang")).toHaveLength(1);
		expect(managed(agent).info(taskId)?.status).toBe("error");
	});

	it("keeps sibling parallel tool results in assistant source order while one call detaches", async () => {
		vi.useFakeTimers();
		const hang = createHangTool("hang");
		const fast: AgentTool<typeof emptySchema> = {
			name: "fast",
			label: "fast",
			description: "fast tool",
			parameters: emptySchema,
			async execute() {
				return { content: [{ type: "text", text: "fast-done" }], details: { ok: true } };
			},
		};
		const agent = new Agent({
			initialState: { tools: [hang.tool, fast] },
			streamFn: streamToolCallsThenStop([
				{ type: "toolCall", id: "call-hang", name: "hang", arguments: {} },
				{ type: "toolCall", id: "call-fast", name: "fast", arguments: {} },
			]),
			backgroundToolCalls: { hang: { detachAfterSeconds: 1 } },
			toolExecution: "parallel",
		} as ConstructorParameters<typeof Agent>[0]);

		const promptPromise = agent.prompt("run both");
		await hang.started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(promptPromise, "original call released after detach");

		const results = toolResultMessages(agent);
		expect(results.map((message) => message.toolCallId)).toEqual(["call-hang", "call-fast"]);
		expect(textOf(results[1]!)).toContain("fast-done");
		expect(results[0]?.details).toEqual(expect.objectContaining({ taskId: expect.any(String) }));
	});

	it("does not abort an already-detached execution when the current run is aborted", async () => {
		vi.useFakeTimers();
		const hang = createHangTool("hang");
		const agent = new Agent({
			initialState: { tools: [hang.tool] },
			streamFn: streamToolCallsThenStop([{ type: "toolCall", id: "call-hang", name: "hang", arguments: {} }]),
			backgroundToolCalls: { hang: { detachAfterSeconds: 1 } },
		} as ConstructorParameters<typeof Agent>[0]);

		const promptPromise = agent.prompt("run hang");
		await hang.started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(promptPromise, "original call released after detach");

		agent.abort();
		await vi.advanceTimersByTimeAsync(0);
		expect(hang.abortSeen.current).toBe(false);
		expect(managed(agent).list()[0]?.status).toBe("running");
	});

	it("treats an empty background rule as a 600-second detach and leaves omitted tools unmanaged", async () => {
		vi.useFakeTimers();
		const opted = createHangTool("opted");
		const omitted = createHangTool("omitted");
		const agent = new Agent({
			initialState: { tools: [opted.tool, omitted.tool] },
			streamFn: streamToolCallsThenStop([
				{ type: "toolCall", id: "call-opted", name: "opted", arguments: {} },
				{ type: "toolCall", id: "call-omitted", name: "omitted", arguments: {} },
			]),
			backgroundToolCalls: { opted: {} },
			toolExecution: "parallel",
		} as ConstructorParameters<typeof Agent>[0]);

		const promptPromise = agent.prompt("run both");
		await Promise.all([opted.started.promise, omitted.started.promise]);
		await vi.advanceTimersByTimeAsync(599_000);
		expect(agent.state.isStreaming).toBe(true);

		await vi.advanceTimersByTimeAsync(1000);
		opted.finish.resolve({ text: "opted-done" });
		omitted.finish.resolve({ text: "omitted-done" });
		await expectSettled(promptPromise, "original call released after detach");

		const optedResult = toolResultMessages(agent).find((message) => message.toolCallId === "call-opted");
		const omittedResult = toolResultMessages(agent).find((message) => message.toolCallId === "call-omitted");
		expect(optedResult?.details).toEqual(expect.objectContaining({ taskId: expect.any(String) }));
		expect(textOf(omittedResult!)).toContain("omitted-done");
	});

	it("reuses a cached wait outcome, supports concurrent waits, and never auto-backgrounds wait", async () => {
		vi.useFakeTimers();
		const hang = createHangTool("hang");
		const agent = new Agent({
			initialState: { tools: [hang.tool] },
			streamFn: streamToolCallsThenStop([{ type: "toolCall", id: "call-hang", name: "hang", arguments: {} }]),
			backgroundToolCalls: { hang: { detachAfterSeconds: 1 }, tool_task: {} },
		} as ConstructorParameters<typeof Agent>[0]);

		const promptPromise = agent.prompt("run hang");
		await hang.started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(promptPromise, "original call released after detach");
		const taskId = managed(agent).list()[0]!.id;

		await expect(managed(agent).wait(taskId, undefined as unknown as number)).rejects.toThrow();
		await expect(managed(agent).wait(taskId, 0)).rejects.toThrow();
		await expect(managed(agent).wait(taskId, 1801)).rejects.toThrow();

		const firstWait = managed(agent).wait(taskId, 30);
		const secondWait = managed(agent).wait(taskId, 30);
		hang.finish.resolve({ text: "wait-output" });
		const [first, second] = await Promise.all([firstWait, secondWait]);
		expect(textOf(first)).toContain("wait-output");
		expect(first.isError).toBe(false);
		expect(textOf(second)).toContain("wait-output");

		const repeated = await managed(agent).wait(taskId, 1);
		expect(textOf(repeated)).toContain("wait-output");
		expect(toolResultMessages(agent).filter((message) => message.toolCallId === "call-hang")).toHaveLength(1);

		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});
		await vi.advanceTimersByTimeAsync(600_000);
		expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(0);
	});

	it("requests cancel once, stops abort-aware tools, and keeps abort-ignoring tools running until they settle", async () => {
		vi.useFakeTimers();
		const abortAware = createHangTool("aware");
		const ignoringStarted = createDeferred<void>();
		const ignoringFinish = createDeferred<{ text: string }>();
		hangCleanups.push(() => ignoringFinish.resolve({ text: "cleanup" }));
		const ignoringAbortSeen = { current: false };
		const ignoring: AgentTool<typeof emptySchema> = {
			name: "ignoring",
			label: "ignoring",
			description: "ignores abort",
			parameters: emptySchema,
			async execute(_toolCallId, _params, signal) {
				ignoringStarted.resolve(undefined);
				signal?.addEventListener("abort", () => {
					ignoringAbortSeen.current = true;
				});
				const outcome = await ignoringFinish.promise;
				return { content: [{ type: "text", text: outcome.text }], details: { output: outcome.text } };
			},
		};
		const agent = new Agent({
			initialState: { tools: [abortAware.tool, ignoring] },
			streamFn: streamToolCallsThenStop([
				{ type: "toolCall", id: "call-aware", name: "aware", arguments: {} },
				{ type: "toolCall", id: "call-ignoring", name: "ignoring", arguments: {} },
			]),
			backgroundToolCalls: { aware: { detachAfterSeconds: 1 }, ignoring: { detachAfterSeconds: 1 } },
			toolExecution: "parallel",
		} as ConstructorParameters<typeof Agent>[0]);

		const promptPromise = agent.prompt("run both");
		await Promise.all([abortAware.started.promise, ignoringStarted.promise]);
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(promptPromise, "original call released after detach");

		const awareId = managed(agent)
			.list()
			.find((task) => task.toolName === "aware")!.id;
		const ignoringId = managed(agent)
			.list()
			.find((task) => task.toolName === "ignoring")!.id;
		expect(managed(agent).cancel(awareId)).toEqual({
			disposition: "requested",
			status: "cancel_requested",
		});
		expect(managed(agent).cancel(awareId)).toEqual({
			disposition: "already_requested",
			status: "cancel_requested",
		});
		expect(managed(agent).cancel(ignoringId)).toEqual({
			disposition: "requested",
			status: "cancel_requested",
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(abortAware.abortSeen.current).toBe(true);
		expect(managed(agent).info(ignoringId)?.status).toBe("cancel_requested");
		expect(managed(agent).info(ignoringId)?.status).not.toBe("completed");

		abortAware.finish.resolve({ text: "aware-cancelled" });
		await vi.advanceTimersByTimeAsync(0);
		ignoringFinish.resolve({ text: "ignoring-finished" });
		await vi.advanceTimersByTimeAsync(0);
		expect(managed(agent).info(ignoringId)?.status).toBe("completed");
		expect(managed(agent).cancel(ignoringId)).toEqual({ disposition: "already_terminal", status: "completed" });
		expect(textOf(await managed(agent).wait(ignoringId, 1))).toContain("ignoring-finished");
	});

	it("does not let ordinary tool result fields bypass finalization", async () => {
		const tool: AgentTool<typeof emptySchema> = {
			name: "ordinary",
			label: "ordinary",
			description: "ordinary tool",
			parameters: emptySchema,
			execute: async () => {
				const outcome: AgentToolResult<unknown> = { content: [{ type: "text", text: "raw" }], details: {} };
				Object.defineProperties(outcome, {
					isError: { value: true, enumerable: true },
					skipAfterToolCall: { value: true, enumerable: true },
				});
				return outcome;
			},
		};
		let afterCalls = 0;
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: streamToolCallsThenStop([
				{ type: "toolCall", id: "call-ordinary", name: "ordinary", arguments: {} },
			]),
			afterToolCall: async () => {
				afterCalls++;
				return { content: [{ type: "text", text: "after" }] };
			},
		} as ConstructorParameters<typeof Agent>[0]);

		await agent.prompt("run ordinary");

		const result = toolResultMessages(agent).find((message) => message.toolCallId === "call-ordinary");
		expect(afterCalls).toBe(1);
		expect(textOf(result!)).toBe("after");
		expect(result?.isError).toBe(false);
	});

	it("cancels and clears managed executions on reset without late completion notifications", async () => {
		vi.useFakeTimers();
		const hang = createHangTool("hang");
		const onCompletion = vi.fn();
		const agent = new Agent({
			initialState: { tools: [hang.tool] },
			streamFn: streamToolCallsThenStop([{ type: "toolCall", id: "call-hang", name: "hang", arguments: {} }]),
			backgroundToolCalls: { hang: { detachAfterSeconds: 1 } },
		} as ConstructorParameters<typeof Agent>[0]);
		agent.managedExecutions.setCompletionHandler(onCompletion);

		const promptPromise = agent.prompt("run hang");
		await hang.started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(promptPromise, "original call released after detach");
		const taskId = managed(agent).list()[0]!.id;

		agent.reset();
		await vi.advanceTimersByTimeAsync(0);
		expect(hang.abortSeen.current).toBe(true);
		expect(managed(agent).list()).toEqual([]);

		hang.finish.resolve({ text: "late-output" });
		await vi.advanceTimersByTimeAsync(0);
		expect(onCompletion).not.toHaveBeenCalled();
		expect(managed(agent).info(taskId)).toBeUndefined();
		await expect(managed(agent).wait(taskId, 1)).rejects.toThrow(`Unknown managed tool execution: ${taskId}`);
	});
});
