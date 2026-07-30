import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Message,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolUpdateCallback,
	agentLoop,
	type StreamFn,
	setDefaultStreamFn,
} from "../src/index.ts";

// Mock stream that mimics AssistantMessageEventStream
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

function standardMessages(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function createAssistantToolUseMessage(content: ToolCallContent[]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const unusedStreamFunction: StreamFn = () => {
	throw new Error("Unexpected stream call");
};

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("Agent", () => {
	it("uses the configured default when a legacy caller omits streamFn", async () => {
		let calls = 0;
		setDefaultStreamFn(() => {
			calls++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("fallback");
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		try {
			const agent = Reflect.construct(Agent, [{}]) as Agent;
			await agent.prompt("Hello");
			expect(calls).toBe(1);
		} finally {
			setDefaultStreamFn(undefined);
		}
	});

	it("should create an agent instance with default state", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		expect(agent.state).toBeDefined();
		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.model).toBeDefined();
		expect(agent.state.thinkingLevel).toBe("off");
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBe(undefined);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("should create an agent instance with custom initial state", () => {
		const customModel = getModel("openai", "gpt-4o-mini");
		const agent = new Agent({
			streamFn: unusedStreamFunction,
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: customModel,
				thinkingLevel: "low",
			},
		});

		expect(agent.state.systemPrompt).toBe("You are a helpful assistant.");
		expect(agent.state.model).toBe(customModel);
		expect(agent.state.thinkingLevel).toBe("low");
	});

	it("should subscribe to events", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		let eventCount = 0;
		const unsubscribe = agent.subscribe((_event) => {
			eventCount++;
		});

		// No initial event on subscribe
		expect(eventCount).toBe(0);

		// State mutators don't emit events
		agent.state.systemPrompt = "Test prompt";
		expect(eventCount).toBe(0);
		expect(agent.state.systemPrompt).toBe("Test prompt");

		// Unsubscribe should work
		unsubscribe();
		agent.state.systemPrompt = "Another prompt";
		expect(eventCount).toBe(0); // Should not increase
	});

	it("emits full lifecycle events for thrown run failures", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("provider exploded");
			},
		});
		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});

		await agent.prompt("hello");

		expect(events).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toBe("provider exploded");
		expect(agent.state.errorMessage).toBe("provider exploded");
	});

	it("should await async subscribers before prompt resolves", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		let listenerFinished = false;
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		let promptResolved = false;
		const promptPromise = agent.prompt("hello").then(() => {
			promptResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(promptResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await promptPromise;

		expect(listenerFinished).toBe(true);
		expect(promptResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("waitForIdle should wait for async subscribers", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				await barrier.promise;
			}
		});

		const promptPromise = agent.prompt("hello");
		let idleResolved = false;
		const idlePromise = agent.waitForIdle().then(() => {
			idleResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);

		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("should pass the active abort signal to subscribers", async () => {
		let receivedSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		agent.subscribe((event, signal) => {
			if (event.type === "agent_start") {
				receivedSignal = signal;
			}
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);

		agent.abort();
		await promptPromise;

		expect(receivedSignal?.aborted).toBe(true);
	});

	it.each(["agent_start", "turn_start", "message_start", "message_end", "turn_end"] as const)(
		"should abort a stuck %s listener and clear streaming state",
		async (stuckEvent) => {
			const stream = new MockAssistantStream();
			const agent = new Agent({
				streamFn: () => stream,
			});
			let listenerStarted = false;

			agent.subscribe((event) => {
				if (event.type === stuckEvent) {
					listenerStarted = true;
					return new Promise(() => {});
				}
			});

			const promptPromise = agent.prompt("hello");
			if (stuckEvent === "turn_end") {
				queueMicrotask(() => {
					const message = createAssistantMessage("done");
					stream.push({ type: "done", reason: "stop", message });
				});
			}
			await vi.waitFor(() => expect(listenerStarted).toBe(true));
			expect(agent.state.isStreaming).toBe(true);

			agent.abort();
			await promptPromise;

			expect(agent.state.isStreaming).toBe(false);
		},
	);

	it("should abort a stuck fallback message_end listener after result-only stream completion", async () => {
		const stream = new MockAssistantStream();
		const agent = new Agent({
			streamFn: () => stream,
		});
		let listenerStarted = false;

		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				listenerStarted = true;
				return new Promise(() => {});
			}
		});

		const promptPromise = agent.prompt("hello");
		queueMicrotask(() => {
			stream.end(createAssistantMessage("done"));
		});
		await vi.waitFor(() => expect(listenerStarted).toBe(true));
		expect(agent.state.isStreaming).toBe(true);

		agent.abort();
		await promptPromise;

		expect(agent.state.isStreaming).toBe(false);
	});

	it("should abort a stuck context transform before the provider request", async () => {
		let providerCalled = false;
		const agent = new Agent({
			transformContext: () => new Promise(() => {}),
			streamFn: () => {
				providerCalled = true;
				return new MockAssistantStream();
			},
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));
		agent.abort();
		await promptPromise;

		expect(agent.state.isStreaming).toBe(false);
		expect(providerCalled).toBe(false);
	});

	it("should abort while waiting for the provider stream to be created", async () => {
		const agent = new Agent({
			streamFn: () => new Promise(() => {}),
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(agent.state.isStreaming).toBe(true);

		agent.abort();
		await promptPromise;

		expect(agent.state.isStreaming).toBe(false);
	});

	it("should abort while waiting for an already-created provider stream event", async () => {
		let streamCreated = false;
		const agent = new Agent({
			streamFn: () => {
				streamCreated = true;
				return new MockAssistantStream();
			},
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(streamCreated).toBe(true);
		expect(agent.state.isStreaming).toBe(true);

		agent.abort();
		await promptPromise;

		expect(agent.state.isStreaming).toBe(false);
	});

	it("should abort a direct agentLoop stream while waiting for a stuck provider stream event", async () => {
		const controller = new AbortController();
		const events: AgentEvent[] = [];
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [],
		};
		const stream = agentLoop(
			[{ role: "user", content: "hello", timestamp: Date.now() }],
			context,
			{
				model: getModel("openai", "gpt-4o-mini")!,
				convertToLlm: () => [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			controller.signal,
			() => new MockAssistantStream(),
		);

		const consume = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
		})();
		await new Promise((resolve) => setTimeout(resolve, 10));

		controller.abort();
		await expect(stream.result()).rejects.toThrow("aborted");
		await expect(consume).rejects.toThrow("aborted");
		expect(events.some((event) => event.type === "agent_start")).toBe(true);
	});

	it("should ignore tool updates after the tool execution settles", async () => {
		const toolSchema = Type.Object({});
		let delayedUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
		const events: AgentEvent[] = [];
		const tool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "delayed_tool",
			label: "Delayed Tool",
			description: "Captures progress callbacks",
			parameters: toolSchema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				delayedUpdate = onUpdate;
				onUpdate?.({
					content: [{ type: "text", text: "running" }],
					details: { status: "running" },
				});
				return {
					content: [{ type: "text", text: "ok" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "delayed_tool", arguments: {} },
						]),
					});
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("run tool");
		const eventCountAfterPrompt = events.length;

		delayedUpdate?.({
			content: [{ type: "text", text: "late" }],
			details: { status: "late" },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(1);
		expect(events).toHaveLength(eventCountAfterPrompt);
	});

	it("should ignore a settled parallel tool update while another tool is still running", async () => {
		const toolSchema = Type.Object({});
		const slowStarted = createDeferred();
		const settledToolEnded = createDeferred();
		const releaseSlow = createDeferred();
		let settledToolUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
		const events: AgentEvent[] = [];
		const settledTool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "settled_tool",
			label: "Settled Tool",
			description: "Captures progress callbacks",
			parameters: toolSchema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				settledToolUpdate = onUpdate;
				return {
					content: [{ type: "text", text: "done" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const slowTool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "slow_tool",
			label: "Slow Tool",
			description: "Keeps the agent run active",
			parameters: toolSchema,
			async execute() {
				slowStarted.resolve();
				await releaseSlow.promise;
				return {
					content: [{ type: "text", text: "done" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const agent = new Agent({
			initialState: { tools: [settledTool, slowTool] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "settled_tool", arguments: {} },
							{ type: "toolCall", id: "call-2", name: "slow_tool", arguments: {} },
						]),
					});
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "tool_execution_end" && event.toolCallId === "call-1") {
				settledToolEnded.resolve();
			}
		});

		const promptPromise = agent.prompt("run tools");
		await Promise.all([slowStarted.promise, settledToolEnded.promise]);
		const eventCountBeforeLateUpdate = events.length;

		settledToolUpdate?.({
			content: [{ type: "text", text: "late" }],
			details: { status: "late" },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toHaveLength(eventCountBeforeLateUpdate);

		releaseSlow.resolve();
		await promptPromise;
		expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(0);
	});

	it("should update state with mutators", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// Test setSystemPrompt
		agent.state.systemPrompt = "Custom prompt";
		expect(agent.state.systemPrompt).toBe("Custom prompt");

		// Test setModel
		const newModel = getModel("google", "gemini-2.5-flash");
		agent.state.model = newModel;
		expect(agent.state.model).toBe(newModel);

		// Test setThinkingLevel
		agent.state.thinkingLevel = "high";
		expect(agent.state.thinkingLevel).toBe("high");

		// Test setTools
		const tools = [{ name: "test", description: "test tool" } as any];
		agent.state.tools = tools;
		expect(agent.state.tools).toEqual(tools);
		expect(agent.state.tools).not.toBe(tools); // Should be a copy

		// Test replaceMessages
		const messages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];
		agent.state.messages = messages;
		expect(agent.state.messages).toEqual(messages);
		expect(agent.state.messages).not.toBe(messages); // Should be a copy

		// Test appendMessage
		const newMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi" }] };
		agent.state.messages.push(newMessage as any);
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[1]).toBe(newMessage);

		// Test clearMessages
		agent.state.messages = [];
		expect(agent.state.messages).toEqual([]);
	});

	it("should support steering message queue", async () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		const message = { role: "user" as const, content: "Steering message", timestamp: Date.now() };
		agent.steer(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should support follow-up message queue", async () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		const message = { role: "user" as const, content: "Follow-up message", timestamp: Date.now() };
		agent.followUp(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should handle abort controller", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// Should not throw even if nothing is running
		expect(() => agent.abort()).not.toThrow();
	});

	it("should throw when prompt() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			// Use a stream function that responds to abort
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					// Check abort signal periodically
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = agent.prompt("First message");

		// Wait a tick for isStreaming to be set
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// Second prompt should reject
		await expect(agent.prompt("Second message")).rejects.toThrow(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		// Cleanup - abort to stop the stream
		agent.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("should throw when continue() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt
		const firstPrompt = agent.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// continue() should reject
		await expect(agent.continue()).rejects.toThrow(
			"Agent is already processing. Wait for completion before continuing.",
		);

		// Cleanup
		agent.abort();
		await firstPrompt.catch(() => {});
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some((message) => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some((part) => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	it("continue() should keep one-at-a-time steering semantics from assistant tail", async () => {
		let responseCount = 0;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				responseCount++;
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(`Processed ${responseCount}`),
					});
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 1" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 2" }],
			timestamp: Date.now() + 1,
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(responseCount).toBe(2);
	});

	it("keeps legacy prepareNextTurn signal callback behavior", async () => {
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop tool",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		let requestCount = 0;
		let sawAbortSignal = false;
		const agent = new Agent({
			initialState: { tools: [tool] },
			prepareNextTurn: async (signal) => {
				sawAbortSignal = signal instanceof AbortSignal;
				return undefined;
			},
			streamFn: () => {
				requestCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (requestCount === 1) {
						const message = createAssistantToolUseMessage([
							{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} },
						]);
						stream.push({ type: "done", reason: "toolUse", message });
						return;
					}
					const message = createAssistantMessage("done");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("start");

		expect(requestCount).toBe(2);
		expect(sawAbortSignal).toBe(true);
	});

	it("forwards sessionId to streamFunction options", async () => {
		let receivedSessionId: string | undefined;
		const agent = new Agent({
			sessionId: "session-abc",
			streamFn: (_model, _context, options) => {
				receivedSessionId = options?.sessionId;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("ok");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedSessionId).toBe("session-abc");

		// Test setter
		agent.sessionId = "session-def";
		expect(agent.sessionId).toBe("session-def");

		await agent.prompt("hello again");
		expect(receivedSessionId).toBe("session-def");
	});

	it("continues from supplied raw context with one transform and conversion pass", async () => {
		let transformCalls = 0;
		let convertCalls = 0;
		let providerCalls = 0;
		const agent = new Agent({
			initialState: { systemPrompt: "current system", thinkingLevel: "high" },
			transformContext: async (messages) => {
				transformCalls++;
				return messages;
			},
			convertToLlm: (messages) => {
				convertCalls++;
				return messages.flatMap((message) =>
					message.role === "custom"
						? [{ role: "user" as const, content: message.content, timestamp: message.timestamp }]
						: message.role === "user" || message.role === "assistant" || message.role === "toolResult"
							? [message]
							: [],
				);
			},
			streamFn: (_model, context) => {
				providerCalls++;
				expect(context.systemPrompt).toBe("detached system");
				expect(context.messages.at(-1)?.role).toBe("user");
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("retried") });
				});
				return stream;
			},
		});
		const rawContext = {
			systemPrompt: "detached system",
			messages: [
				{
					role: "custom" as const,
					customType: "retry-tail",
					content: "raw tail",
					display: false,
					timestamp: Date.now(),
				},
			],
			tools: [],
		};

		await agent.continueFrom(rawContext);

		expect(transformCalls).toBe(1);
		expect(convertCalls).toBe(1);
		expect(providerCalls).toBe(1);
		expect(agent.state.messages).toHaveLength(1);
		expect(agent.state.messages[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "retried" }],
		});
	});

	it("waits for pre-admission transformContext after abort without emitting lifecycle", async () => {
		const started = createDeferred();
		const release = createDeferred();
		const events: AgentEvent[] = [];
		const agent = new Agent({
			transformContext: async (messages) => {
				started.resolve();
				await release.promise;
				return messages;
			},
			streamFn: unusedStreamFunction,
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		const continuation = agent.continueFrom(
			{
				systemPrompt: "system",
				messages: [{ role: "user", content: "retry", timestamp: Date.now() }],
				tools: [],
			},
			{ throwBeforeAdmission: true },
		);
		await started.promise;
		agent.abort();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(events).toEqual([]);
		expect(agent.state.isStreaming).toBe(true);

		release.resolve();
		await expect(continuation).rejects.toThrow("This operation was aborted");
		expect(events).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("does not settle an admitted run while convertToLlm remains in flight after abort", async () => {
		const started = createDeferred();
		const release = createDeferred();
		let providerCalls = 0;
		const events: AgentEvent[] = [];
		const agent = new Agent({
			convertToLlm: async (messages) => {
				started.resolve();
				await release.promise;
				return standardMessages(messages);
			},
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream();
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		const prompt = agent.prompt("hello");
		await started.promise;
		agent.abort();
		let idleResolved = false;
		const idle = agent.waitForIdle().then(() => {
			idleResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(idleResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);
		expect(events.map((event) => event.type)).toEqual(["agent_start", "turn_start", "message_start", "message_end"]);

		release.resolve();
		await expect(prompt).resolves.toBeUndefined();
		await idle;
		expect(providerCalls).toBe(0);
		expect(agent.state.isStreaming).toBe(false);
		expect(events.at(-1)?.type).toBe("agent_end");
		await new Promise((resolve) => setImmediate(resolve));
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("waits for pre-admission convertToLlm after abort without emitting lifecycle", async () => {
		const started = createDeferred();
		const release = createDeferred();
		const events: AgentEvent[] = [];
		let providerCalls = 0;
		const agent = new Agent({
			convertToLlm: async (messages) => {
				started.resolve();
				await release.promise;
				return standardMessages(messages);
			},
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream();
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		const continuation = agent.continueFrom(
			{
				systemPrompt: "system",
				messages: [{ role: "user", content: "retry", timestamp: Date.now() }],
				tools: [],
			},
			{ throwBeforeAdmission: true },
		);
		await started.promise;
		agent.abort();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(events).toEqual([]);
		expect(agent.state.isStreaming).toBe(true);

		release.resolve();
		await expect(continuation).rejects.toThrow("This operation was aborted");
		expect(events).toEqual([]);
		expect(providerCalls).toBe(0);
		expect(agent.state.isStreaming).toBe(false);
		await new Promise((resolve) => setImmediate(resolve));
		expect(events).toEqual([]);
	});

	it("admits a continuation once while emitting one agent start and one turn start per provider turn", async () => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema> = {
			name: "continue_tool",
			label: "Continue tool",
			description: "Produces a second provider turn",
			parameters: toolSchema,
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		let providerCalls = 0;
		let admissionCalls = 0;
		const events: AgentEvent[] = [];
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: () => {
				providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCalls === 1) {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantToolUseMessage([
								{ type: "toolCall", id: "continue-1", name: "continue_tool", arguments: {} },
							]),
						});
						return;
					}
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("finished") });
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.continueFrom(
			{
				systemPrompt: "system",
				messages: [{ role: "user", content: "continue", timestamp: Date.now() }],
				tools: [tool],
			},
			{
				onAdmitted: () => {
					admissionCalls++;
				},
			},
		);

		expect(providerCalls).toBe(2);
		expect(admissionCalls).toBe(1);
		expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(2);
	});

	it("rejects an empty or assistant effective tail before starting the provider", async () => {
		let providerCalls = 0;
		const agent = new Agent({
			convertToLlm: () => [],
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream();
			},
		});
		const context = {
			systemPrompt: "detached",
			messages: [{ role: "user" as const, content: "raw", timestamp: Date.now() }],
			tools: [],
		};

		await expect(agent.continueFrom(context, { throwBeforeAdmission: true })).rejects.toThrow(
			"Cannot continue: converted context must end with a non-assistant message",
		);

		expect(providerCalls).toBe(0);
		expect(agent.state.messages).toEqual([]);
	});
});
