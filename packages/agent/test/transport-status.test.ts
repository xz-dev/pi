import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Message,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	Agent,
	type AgentEvent,
	type AgentLoopConfig,
	type AgentTool,
	runAgentLoop,
	type StreamFn,
} from "../src/index.ts";

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

function createToolCallMessage(): AssistantMessage {
	return {
		...createAssistantMessage(""),
		content: [
			{
				type: "toolCall",
				id: "tc1",
				name: "noop",
				arguments: {},
			},
		],
		stopReason: "toolUse",
	};
}

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

function createAgent(streamFn: StreamFn, tools: AgentTool[] = []): Agent {
	return new Agent({
		initialState: { systemPrompt: "Test", tools, model: getModel("openai", "gpt-4o-mini") },
		streamFn,
	});
}

function noopTool(): AgentTool {
	return {
		name: "noop",
		label: "noop",
		description: "noop tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "noop" }], details: {} }),
	};
}

function transportEvents(events: AgentEvent[]): (string | undefined)[] {
	return events
		.filter((event): event is Extract<AgentEvent, { type: "transport_status" }> => event.type === "transport_status")
		.map((event) => event.transport);
}

function loopConfig(model = getModel("openai", "gpt-4o-mini")!): AgentLoopConfig {
	return {
		model,
		convertToLlm: (messages): Message[] =>
			messages.filter(
				(m): m is Message =>
					m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
			),
	};
}

function collectEvents(agent: Agent): AgentEvent[] {
	const events: AgentEvent[] = [];
	agent.subscribe((event) => {
		events.push(event);
	});
	return events;
}

describe("transport_status request lifecycle", () => {
	it("emits a terminal clear when the request settles with a known transport", async () => {
		const agent = createAgent((_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await options?.onTransport?.("SSE", _model);
				const msg = createAssistantMessage("ok");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		});

		const events = collectEvents(agent);
		await agent.prompt("hello");

		expect(transportEvents(events)).toEqual(["SSE", undefined]);
	});

	it("emits no trailing clear when the request never reported a transport", async () => {
		const agent = createAgent(() => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const msg = createAssistantMessage("ok");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		});

		const events = collectEvents(agent);
		await agent.prompt("hello");

		expect(transportEvents(events)).toEqual([]);
	});

	it("clears a known transport when the stream errors mid-flight", async () => {
		const agent = createAgent((_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await options?.onTransport?.("WS", _model);
				const msg = { ...createAssistantMessage("fail"), stopReason: "error" as const, errorMessage: "boom" };
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "error", reason: "error", error: msg });
			});
			return stream;
		});

		const events = collectEvents(agent);
		await agent.prompt("hello");

		expect(transportEvents(events)).toEqual(["WS", undefined]);
	});

	it("clears a known transport when the stream is abandoned after abort", async () => {
		const stream = createAssistantMessageEventStream();
		let capturedOnTransport: ((transport: string | undefined) => Promise<void>) | undefined;
		const agent = createAgent((_model, _context, options) => {
			capturedOnTransport = async (transport) => options?.onTransport?.(transport, _model);
			queueMicrotask(async () => {
				await options?.onTransport?.("SSE", _model);
				const msg = createAssistantMessage("partial");
				stream.push({ type: "start", partial: msg });
			});
			return stream;
		});

		const events = collectEvents(agent);
		const prompt = agent.prompt("hello");
		// Wait for the transport report to land, then abort mid-stream.
		await vi.waitFor(() => expect(transportEvents(events)).toEqual(["SSE"]));
		agent.abort();
		// Abort retires the known transport promptly; a late report stays dead.
		await vi.waitFor(() => expect(transportEvents(events)).toEqual(["SSE", undefined]));
		await capturedOnTransport?.("WS");
		const done = { ...createAssistantMessage(""), stopReason: "aborted" as const };
		stream.push({ type: "error", reason: "aborted", error: done });
		await prompt;

		expect(transportEvents(events)).toEqual(["SSE", undefined]);
	});

	it("clears a known transport before tool execution starts", async () => {
		let call = 0;
		const agent = createAgent(
			(_model, _context, options) => {
				call++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(async () => {
					if (call === 1) {
						await options?.onTransport?.("WS", _model);
						const msg = createToolCallMessage();
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						// The follow-up request after the tool result reports nothing and stops.
						const msg = createAssistantMessage("done");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
			[noopTool()],
		);

		const events = collectEvents(agent);
		await agent.prompt("hello");

		const toolStartIndex = events.findIndex((e) => e.type === "tool_execution_start");
		const clears = events
			.map((e, i) => (e.type === "transport_status" && e.transport === undefined ? i : -1))
			.filter((i) => i >= 0);
		expect(toolStartIndex).toBeGreaterThan(-1);
		expect(clears.some((i) => i < toolStartIndex)).toBe(true);
		// The request's own clear is its last transport event.
		expect(transportEvents(events)).toEqual(["WS", undefined]);
	});

	it("swallows a throwing stream factory: callback is dead and the clear still fires", async () => {
		let capturedOnTransport: ((transport: string | undefined) => Promise<void>) | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			capturedOnTransport = async (transport) => options?.onTransport?.(transport, _model);
			throw new Error("setup exploded");
		};
		const agent = createAgent(streamFn);

		const events = collectEvents(agent);
		await agent.prompt("hello");

		// Factory threw; run fails but the callback must already be dead.
		await capturedOnTransport?.("SSE");
		expect(transportEvents(events)).toEqual([]);
	});

	it("a transport reported after the run aborted does not survive as settled state", async () => {
		let capturedOnTransport: ((transport: string | undefined) => Promise<void>) | undefined;
		const started = createDeferred();
		const stream = createAssistantMessageEventStream();
		const agent = createAgent((_model, _context, options) => {
			capturedOnTransport = async (transport) => options?.onTransport?.(transport, _model);
			started.resolve();
			return stream;
		});

		const events = collectEvents(agent);
		const prompt = agent.prompt("hello");
		// Abort only after the stream factory ran, then report while aborted.
		await started.promise;
		agent.abort();
		await capturedOnTransport?.("SSE");
		const done = { ...createAssistantMessage(""), stopReason: "aborted" as const };
		stream.push({ type: "error", reason: "aborted", error: done });
		await prompt;

		// Signal aborted before the report: callback ignores it, nothing to clear.
		expect(transportEvents(events)).toEqual([]);
	});

	it("a late cleanup from an aborted request cannot erase a newer request's transport", async () => {
		let firstOnTransport: ((transport: string | undefined) => Promise<void>) | undefined;
		let call = 0;
		const firstGate = createDeferred();
		const firstStream = createAssistantMessageEventStream();
		const streamFn: StreamFn = (_model, _context, options) => {
			call++;
			const onTransport = async (transport: string | undefined) => options?.onTransport?.(transport, _model);
			if (call === 1) {
				firstOnTransport = onTransport;
				void (async () => {
					await onTransport("WS");
					const msg = createAssistantMessage("partial");
					firstStream.push({ type: "start", partial: msg });
					await firstGate.promise;
					const done = { ...createAssistantMessage(""), stopReason: "aborted" as const };
					firstStream.push({ type: "error", reason: "aborted", error: done });
				})();
				return firstStream;
			}
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await onTransport("SSE");
				const msg = createAssistantMessage("ok");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		};

		// Drive runAgentLoop directly: it accepts a caller-owned signal, so a second
		// run can start while the aborted request's stream is still open.
		const firstEvents: AgentEvent[] = [];
		const controller = new AbortController();
		const abortReason = new Error("Controlled first-request cancellation");
		const firstRun = runAgentLoop(
			[{ role: "user", content: "one", timestamp: Date.now() }],
			{ messages: [] },
			loopConfig(),
			async (event) => {
				firstEvents.push(event);
			},
			controller.signal,
			streamFn,
		).catch((error: unknown) => {
			if (!controller.signal.aborted || !(error instanceof Error) || error.message !== abortReason.message) {
				throw error;
			}
		});
		await vi.waitFor(() => expect(transportEvents(firstEvents)).toEqual(["WS"]));
		controller.abort(abortReason);
		// Abort retires the known transport promptly; a late report stays dead.
		await vi.waitFor(() => expect(transportEvents(firstEvents)).toEqual(["WS", undefined]));
		await firstOnTransport?.("WS");
		firstGate.resolve();
		await firstRun;

		const secondEvents: AgentEvent[] = [];
		await runAgentLoop(
			[{ role: "user", content: "two", timestamp: Date.now() }],
			{ messages: [] },
			loopConfig(),
			async (event) => {
				secondEvents.push(event);
			},
			undefined,
			streamFn,
		);
		expect(transportEvents(secondEvents)).toEqual(["SSE", undefined]);

		// Late clear from the aborted request is a no-op: its callback is dead and
		// its settled flag already fired. Nothing here can touch run two's state.
		await firstOnTransport?.(undefined);
		expect(transportEvents(firstEvents)).toEqual(["WS", undefined]);
	});

	it("a throwing onTransport observer cannot fail the request", async () => {
		const streamFn: StreamFn = (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await options?.onTransport?.("SSE", _model);
				const msg = createAssistantMessage("ok");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		};
		const config: AgentLoopConfig = {
			...loopConfig(),
			onTransport: () => {
				throw new Error("observer exploded");
			},
		};

		const events: AgentEvent[] = [];
		const messages = await runAgentLoop(
			[{ role: "user", content: "hi", timestamp: Date.now() }],
			{ messages: [] },
			config,
			async (event) => {
				events.push(event);
			},
			undefined,
			streamFn,
		);

		expect(transportEvents(events)).toEqual(["SSE", undefined]);
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant?.role === "assistant" && assistant.stopReason).toBe("stop");
	});

	it("abort retires a known transport before a delayed factory from the aborted request can emit", async () => {
		// Overlapping requests on one shared event consumer: request 1 reports WS,
		// aborts while its factory is still pending, then request 2 reports SSE.
		// Request 1's abort-time clear must land before request 2's SSE, and its
		// late-arriving factory can neither re-report nor re-clear.
		const sharedEvents: AgentEvent[] = [];
		const sharedEmit = async (event: AgentEvent) => {
			sharedEvents.push(event);
		};
		const firstFactoryGate = createDeferred();
		const firstStream = createAssistantMessageEventStream();
		const secondStream = createAssistantMessageEventStream();
		const secondReported = createDeferred();
		const firstAbort = new AbortController();
		const abortReason = new Error("Controlled delayed-factory cancellation");

		const firstRun = runAgentLoop(
			[{ role: "user", content: "one", timestamp: Date.now() }],
			{ messages: [] },
			loopConfig(),
			sharedEmit,
			firstAbort.signal,
			(_model, _context, options) =>
				(async () => {
					await options?.onTransport?.("WS", _model);
					await firstFactoryGate.promise;
					return firstStream;
				})(),
		).catch((error: unknown) => {
			if (!firstAbort.signal.aborted || !(error instanceof Error) || error.message !== abortReason.message) {
				throw error;
			}
		});
		await vi.waitFor(() => expect(transportEvents(sharedEvents)).toEqual(["WS"]));
		firstAbort.abort(abortReason);
		// Prompt abort clear retires request 1's transport immediately.
		await vi.waitFor(() => expect(transportEvents(sharedEvents)).toEqual(["WS", undefined]));

		// Request 2 reports SSE but stays open until request 1 fully unwinds.
		const secondRun = runAgentLoop(
			[{ role: "user", content: "two", timestamp: Date.now() }],
			{ messages: [] },
			loopConfig(),
			sharedEmit,
			undefined,
			(_model, _context, options) => {
				queueMicrotask(async () => {
					await options?.onTransport?.("SSE", _model);
					secondReported.resolve();
				});
				return secondStream;
			},
		);
		await vi.waitFor(() => expect(transportEvents(sharedEvents)).toEqual(["WS", undefined, "SSE"]));

		// Release request 1's factory mid-flight of request 2: its callbacks are dead.
		firstFactoryGate.resolve();
		const aborted = { ...createAssistantMessage(""), stopReason: "aborted" as const };
		firstStream.push({ type: "error", reason: "aborted", error: aborted });
		await firstRun;
		expect(transportEvents(sharedEvents)).toEqual(["WS", undefined, "SSE"]);

		const done = createAssistantMessage("ok");
		secondStream.push({ type: "start", partial: done });
		secondStream.push({ type: "done", reason: "stop", message: done });
		await secondRun;

		expect(transportEvents(sharedEvents)).toEqual(["WS", undefined, "SSE", undefined]);
	});

	it("does not leak model headers or secrets into serialized transport events", async () => {
		const secret = "Bearer test-tenant-secret";
		const secretModel = {
			...getModel("openai", "gpt-4o-mini")!,
			headers: { Authorization: secret },
		} satisfies Model<"openai-responses">;
		const config: AgentLoopConfig = { ...loopConfig(secretModel) };

		const events: AgentEvent[] = [];
		await runAgentLoop(
			[{ role: "user", content: "hi", timestamp: Date.now() }],
			{ messages: [] },
			config,
			async (event) => {
				events.push(event);
			},
			undefined,
			(_model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(async () => {
					await options?.onTransport?.("SSE", _model);
					const msg = createAssistantMessage("ok");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		);

		const statusEvents = events.filter((e) => e.type === "transport_status");
		expect(statusEvents).toHaveLength(2);
		for (const event of statusEvents) {
			const serialized = JSON.stringify(event);
			expect(serialized).not.toContain(secret);
			expect(serialized).not.toContain("headers");
			expect(serialized).not.toContain("Authorization");
			if (event.type === "transport_status") {
				expect(event.model).toEqual({
					id: secretModel.id,
					api: secretModel.api,
					provider: secretModel.provider,
				});
			}
		}
	});

	it("does not persist transport into assistant messages", async () => {
		const agent = createAgent((_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await options?.onTransport?.("SSE", _model);
				const msg = createAssistantMessage("ok");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		});

		await agent.prompt("hello");

		const assistant = agent.state.messages.filter((m) => m.role === "assistant");
		expect(assistant).toHaveLength(1);
		expect("transport" in assistant[0]).toBe(false);
		expect(JSON.stringify(assistant[0])).not.toContain("SSE");
	});
});
