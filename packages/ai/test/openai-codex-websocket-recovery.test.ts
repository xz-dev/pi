import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	type OpenAICodexResponsesOptions,
	resetOpenAICodexWebSocketDebugStats,
	stream,
} from "../src/api/openai-codex-responses.ts";
import type { Model, TranscriptContext } from "../src/types.ts";
import { type RetryPolicy, retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};
const apiKey = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.bbb`;
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
const sessionId = "transport-recovery";

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function mockTransport() {
	const sent: Array<{ connection: number; input: unknown[]; previous_response_id?: string }> = [];
	const sockets: MockWebSocket[] = [];
	const onSend = vi.fn((socket: MockWebSocket) => socket.complete());
	const sseItem = {
		type: "message",
		id: "msg_sse",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "SSE response" }],
	};
	const fetchMock = vi.fn(
		async () =>
			new Response(
				[
					{ type: "response.output_item.added", item: { ...sseItem, content: [], status: "in_progress" } },
					{ type: "response.output_item.done", item: sseItem },
					{ type: "response.completed", response: { id: "sse", status: "completed" } },
				]
					.map((event) => `data: ${JSON.stringify(event)}\n\n`)
					.join(""),
				{ headers: { "content-type": "text/event-stream" } },
			),
	);

	class MockWebSocket extends EventTarget {
		readyState = 1;
		readonly connection = sockets.length + 1;
		constructor() {
			super();
			sockets.push(this);
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		send(data: string): void {
			sent.push({ ...JSON.parse(data), connection: this.connection });
			queueMicrotask(() => onSend(this));
		}
		emit(event: Record<string, unknown>): void {
			this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
		}
		complete(): void {
			const id = `resp_${sent.length}`;
			const item = {
				type: "message",
				id: `msg_${sent.length}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			};
			this.emit({ type: "response.created", response: { id } });
			this.emit({ type: "response.output_item.added", item: { ...item, content: [], status: "in_progress" } });
			this.emit({ type: "response.output_item.done", item });
			this.emit({ type: "response.completed", response: { id, status: "completed" } });
		}
		fail(): void {
			this.dispatchEvent(Object.assign(new Event("error"), { message: "socket dropped" }));
		}
		close(): void {
			this.readyState = 3;
		}
	}

	vi.stubGlobal("WebSocket", MockWebSocket);
	vi.stubGlobal("fetch", fetchMock);
	const run = (options: Partial<OpenAICodexResponsesOptions> = {}, input: TranscriptContext = context) =>
		stream(model, input, { apiKey, sessionId, ...options }).result();
	const recover = (options: Partial<OpenAICodexResponsesOptions> = {}, input: TranscriptContext = context) =>
		retryAssistantCall(() => run(options, input), { enabled: false, maxRetries: 0, baseDelayMs: 0 }, options.signal);
	return { run, recover, onSend, fetchMock, sent, sockets };
}

describe("Codex retry policy", () => {
	it.each([false, true])("tries auto WS four times before SSE with retry.enabled=%s", async (enabled) => {
		vi.useFakeTimers();
		const { run, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementation((socket) => socket.fail());
		const policy: RetryPolicy = { enabled, maxRetries: 1, baseDelayMs: 10, maxAgentDelayMs: 15 };
		const request = retryAssistantCall(() => run(), policy, undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(9);
		expect(sent).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(15);
		expect(sent).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(15);
		expect((await request).stopReason).toBe("stop");
		expect(sent).toHaveLength(4);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each(["websocket", "websocket-cached"] as const)(
		"uses the global retry budget for explicit %s",
		async (transport) => {
			const { run, onSend, sent, fetchMock } = mockTransport();
			onSend.mockImplementation((socket) => socket.fail());
			const policy = { enabled: true, maxRetries: 2, baseDelayMs: 0 };
			const result = await retryAssistantCall(() => run({ transport }), policy, undefined);
			expect(result.stopReason).toBe("error");
			expect(sent).toHaveLength(3);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([false, true])(
		"retries partial WS attempts without replay, then resets SSE budget (enabled=%s)",
		async (enabled) => {
			vi.useFakeTimers();
			const { run, onSend, sent, fetchMock } = mockTransport();
			onSend.mockImplementation((socket) => {
				socket.emit({ type: "response.created", response: { id: "partial" } });
				socket.fail();
			});
			fetchMock.mockImplementation(async () => new Response("Service unavailable", { status: 503 }));
			const policy = { enabled, maxRetries: 1, baseDelayMs: 10, maxAgentDelayMs: 15 };
			const retries: number[] = [];
			const request = retryAssistantCall(() => run(), policy, undefined, {
				onRetryScheduled: (_attempt, _max, delay) => {
					retries.push(delay);
				},
			});
			await vi.advanceTimersByTimeAsync(100);
			expect((await request).stopReason).toBe("error");
			expect(sent).toHaveLength(4);
			expect(fetchMock).toHaveBeenCalledTimes(enabled ? 2 : 1);
			// The zero-delay transition is a new SSE attempt, not a fourth WS retry.
			expect(retries).toEqual(enabled ? [10, 15, 15, 0, 10] : [10, 15, 15, 0]);
		},
	);

	it("does not replenish the SSE budget when a long global backoff crosses the probe deadline", async () => {
		vi.useFakeTimers();
		const { run, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementation((socket) => socket.fail());
		fetchMock.mockImplementation(async () => new Response("Service unavailable", { status: 503 }));
		const policy = { enabled: true, maxRetries: 2, baseDelayMs: 300_000, maxAgentDelayMs: 300_000 };
		const request = retryAssistantCall(() => run(), policy, undefined);
		await vi.advanceTimersByTimeAsync(1_500_010);
		expect((await request).stopReason).toBe("error");
		expect(sent).toHaveLength(6); // Four initial WS attempts, then two single probes.
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("aborts the shared backoff without counting cancellation as a transport failure", async () => {
		const { run, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementation((socket) => socket.fail());
		const controller = new AbortController();
		const result = await retryAssistantCall(
			() => run({ signal: controller.signal }),
			{ enabled: false, maxRetries: 0, baseDelayMs: 60_000 },
			controller.signal,
			{ onRetryScheduled: () => controller.abort() },
		);
		expect(result.stopReason).toBe("aborted");
		expect(sent).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
			websocketFailures: 1,
			websocketFallbackActive: false,
		});
	});
});

describe("Codex transport recovery", () => {
	it.each([undefined, "auto"] as const)(
		"recovers %s with full context after cooldown, then resumes deltas",
		async (transport) => {
			const { run, recover, onSend, fetchMock, sent, sockets } = mockTransport();
			let now = 1000;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const first = await run({ transport });
			onSend.mockImplementation((socket) => socket.fail());
			const secondContext = normalizeContext({
				messages: [...context.messages, first, { role: "user", content: "Second", timestamp: 2 }],
			});
			const fallback = await recover({ transport }, secondContext);
			expect(fallback.stopReason).toBe("stop");
			expect(sent).toHaveLength(5);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const recoveryContext = normalizeContext({
				messages: [...secondContext.messages, fallback, { role: "user", content: "Third", timestamp: 3 }],
			});
			now += 300_000;
			onSend.mockImplementation((socket) => socket.complete());
			const recovered = await run({ transport }, recoveryContext);
			expect(recovered.stopReason).toBe("stop");
			expect(sent).toHaveLength(6);
			expect(sockets).toHaveLength(5);
			expect(sockets[0].readyState).toBe(3);
			expect(sent[1].previous_response_id).toBe(first.responseId);
			for (const request of sent.slice(2)) expect(request.previous_response_id).toBeUndefined();
			expect(sent[5].input).toEqual([
				{ role: "user", content: [{ type: "input_text", text: "Hello" }] },
				expect.objectContaining({
					role: "assistant",
					content: [{ type: "output_text", text: "Hello", annotations: [] }],
				}),
				{ role: "user", content: [{ type: "input_text", text: "Second" }] },
				expect.objectContaining({
					role: "assistant",
					content: [{ type: "output_text", text: "SSE response", annotations: [] }],
				}),
				{ role: "user", content: [{ type: "input_text", text: "Third" }] },
			]);
			await run(
				{ transport },
				normalizeContext({
					messages: [...recoveryContext.messages, recovered, { role: "user", content: "Fourth", timestamp: 4 }],
				}),
			);
			expect(sent[6].connection).toBe(sent[5].connection);
			expect(sent[6].previous_response_id).toBe(recovered.responseId);
			expect(sent[6].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Fourth" }] }]);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(getOpenAICodexWebSocketDebugStats(sessionId)?.websocketFallbackActive).toBe(false);
		},
	);

	it("recovers a transient WS failure without using SSE", async () => {
		const { recover, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementationOnce((socket) => socket.fail());
		expect((await recover()).stopReason).toBe("stop");
		expect(sent).toHaveLength(2);
		expect(sent[1].connection).not.toBe(sent[0].connection);
		expect(sent[1].previous_response_id).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("waits five minutes before a single probe, renews cooldown on failure, and resets after success", async () => {
		const { run, recover, onSend, sent, fetchMock } = mockTransport();
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		onSend.mockImplementation((socket) => socket.fail());
		await recover();
		await run();
		expect(sent).toHaveLength(4);
		now += 299_999;
		await run();
		expect(sent).toHaveLength(4);
		now++;
		await run();
		expect(sent).toHaveLength(5);
		now += 299_999;
		await run();
		expect(sent).toHaveLength(5);
		now++;
		onSend.mockImplementation((socket) => socket.complete());
		await run();
		expect(sent).toHaveLength(6);
		expect(fetchMock).toHaveBeenCalledTimes(5);
		onSend.mockImplementation((socket) => socket.fail());
		await recover();
		expect(sent).toHaveLength(10);
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it("allows only one recovery probe and keeps explicit SSE on HTTP", async () => {
		const { run, recover, onSend, sent, fetchMock } = mockTransport();
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		onSend.mockImplementation((socket) => socket.fail());
		await recover();
		now += 300_000;
		let finish: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			onSend.mockImplementationOnce((socket) => {
				finish = () => socket.complete();
				resolve();
			});
		});
		const recovery = run();
		await started;
		expect((await run()).stopReason).toBe("stop");
		expect(sent).toHaveLength(5);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		finish?.();
		expect((await recovery).stopReason).toBe("stop");
		await run({ transport: "sse" });
		expect(sent).toHaveLength(5);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it.each(["complete", "abort"] as const)(
		"keeps recovery exclusive after an older concurrent failure until it can %s",
		async (finish) => {
			const { run, onSend, sent, sockets, fetchMock } = mockTransport();
			let now = 1000;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const bothStarted = new Promise<void>((resolve) => {
				onSend.mockImplementation(() => {
					if (sent.length === 2) resolve();
				});
			});
			const first = run({ timeoutMs: 0 });
			const older = run({ timeoutMs: 0 });
			await bothStarted;
			sockets[0].fail();
			expect((await first).stopReason).toBe("error");
			const started = new Promise<void>((resolve) => {
				onSend.mockImplementationOnce(() => resolve());
			});
			const controller = new AbortController();
			const recovery = run({ timeoutMs: 0, signal: controller.signal });
			await started;
			try {
				// A late failure must mutate the existing state, not replace the active owner.
				sockets[1].fail();
				expect((await older).stopReason).toBe("error");
				now += 300_000;
				onSend.mockImplementation((socket) => socket.complete());
				expect((await run({ timeoutMs: 0 })).stopReason).toBe("stop");
				expect(sent).toHaveLength(3);
				expect(fetchMock).toHaveBeenCalledTimes(1);
			} finally {
				if (finish === "complete") sockets[2].complete();
				else controller.abort();
				expect((await recovery).stopReason).toBe(finish === "complete" ? "stop" : "aborted");
			}
			expect((await run()).stopReason).toBe("stop");
			expect(sent).toHaveLength(4);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["auto", "websocket", "websocket-cached"] as const)(
		"does not retry a content-filter outcome as a transport failure in %s",
		async (transport) => {
			const { run, onSend, sent, sockets, fetchMock } = mockTransport();
			onSend.mockImplementation((socket) =>
				socket.emit({
					type: "response.incomplete",
					response: { id: "filtered", status: "incomplete", incomplete_details: { reason: "content_filter" } },
				}),
			);
			const result = await retryAssistantCall(
				() => run({ transport }),
				{ enabled: true, maxRetries: 3, baseDelayMs: 0 },
				undefined,
			);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("Response incomplete: content_filter");
			expect(sent).toHaveLength(1);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(result.diagnostics?.some((entry) => entry.type === "provider_transport_failure")).not.toBe(true);
			expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
				websocketFailures: 0,
				websocketFallbackActive: false,
			});
			expect(sockets[0].readyState).toBe(3);
			onSend.mockImplementation((socket) => socket.complete());
			expect((await run({ transport })).stopReason).toBe("stop");
			expect(sent[1].previous_response_id).toBeUndefined();
		},
	);

	it.each([false, true])(
		"never replays SSE after a started probe and protocol repair (partial=%s)",
		async (partial) => {
			const { run, recover, onSend, sent, fetchMock } = mockTransport();
			let now = 1000;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			onSend.mockImplementation((socket) => socket.fail());
			await recover();
			now += 300_000;
			fetchMock.mockClear();
			onSend.mockImplementationOnce((socket) => {
				socket.emit({ type: "response.created", response: { id: "partial" } });
				if (partial) {
					socket.emit({
						type: "response.output_item.added",
						item: { type: "message", id: "msg_partial", role: "assistant", content: [] },
					});
					socket.emit({ type: "response.output_text.delta", delta: "discarded partial" });
				}
				socket.emit({ type: "error", code: "previous_response_not_found", message: "Previous response not found" });
			});
			const result = await run();
			expect(result.stopReason).toBe("error");
			expect(fetchMock).not.toHaveBeenCalled();
			// Partial content forbids internal repair; otherwise a safe repair may fail on a new socket.
			expect(sent).toHaveLength(partial ? 5 : 6);
			if (partial)
				expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "discarded partial" })]);
			else
				expect(result.diagnostics?.at(-1)?.details).toMatchObject({
					eventsEmitted: true,
					phase: "after_message_stream_start",
					fallbackTransport: "sse",
				});
		},
	);

	it("does not merge failed partial output with a successful internal WS repair", async () => {
		const { run, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementationOnce((socket) => {
			socket.emit({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_partial", role: "assistant", content: [] },
			});
			socket.emit({ type: "response.output_text.delta", delta: "discarded partial" });
			socket.emit({ type: "error", code: "previous_response_not_found", message: "Previous response not found" });
		});
		expect((await run()).stopReason).toBe("error");
		expect(sent).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([false, true])("retains bounded protocol repair inside one cooldown probe (success=%s)", async (success) => {
		const { run, recover, onSend, sent, fetchMock } = mockTransport();
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		onSend.mockImplementation((socket) => socket.fail());
		await recover();
		now += 300_000;
		onSend.mockImplementation((socket) => (success ? socket.complete() : socket.fail()));
		onSend.mockImplementationOnce((socket) =>
			socket.emit({ type: "error", code: "websocket_connection_limit_reached" }),
		);
		expect((await run()).stopReason).toBe("stop");
		expect(sent).toHaveLength(6);
		expect(fetchMock).toHaveBeenCalledTimes(success ? 1 : 2);
		expect(getOpenAICodexWebSocketDebugStats(sessionId)?.websocketFallbackActive).toBe(!success);
		await run();
		expect(sent).toHaveLength(success ? 7 : 6);
		expect(fetchMock).toHaveBeenCalledTimes(success ? 1 : 3);
	});

	it.each([false, true])("preserves the documented sessionless SDK behavior (started=%s)", async (started) => {
		const { recover, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementation((socket) => {
			if (started) socket.emit({ type: "response.created", response: { id: "partial" } });
			socket.fail();
		});
		expect((await recover({ sessionId: undefined })).stopReason).toBe(started ? "error" : "stop");
		expect(sent).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(started ? 0 : 1);
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toBeUndefined();
	});

	it("keeps the fixed retry allowance with cacheRetention none and a stable session ID", async () => {
		const { recover, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementation((socket) => socket.fail());
		expect((await recover({ cacheRetention: "none" })).stopReason).toBe("stop");
		expect(sent).toHaveLength(4);
		expect(sent.every((request) => request.previous_response_id === undefined)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not replay a started response inside the provider stream", async () => {
		const { run, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementationOnce((socket) => {
			socket.emit({ type: "response.created", response: { id: "partial" } });
			socket.fail();
		});
		expect((await run()).stopReason).toBe("error");
		expect(fetchMock).not.toHaveBeenCalled();
		expect((await run()).stopReason).toBe("stop");
		expect(sent).toHaveLength(2);
		expect(sent[1].connection).not.toBe(sent[0].connection);
		expect(sent[1].previous_response_id).toBeUndefined();
	});

	it("does not count a cancelled recovery as a failure or leave it in flight", async () => {
		const { run, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementationOnce((socket) => socket.fail());
		await run();
		const controller = new AbortController();
		onSend.mockImplementationOnce(() => controller.abort());
		expect((await run({ signal: controller.signal })).stopReason).toBe("aborted");
		expect(getOpenAICodexWebSocketDebugStats(sessionId)?.websocketFailures).toBe(1);
		expect((await run()).stopReason).toBe("stop");
		expect(sent).toHaveLength(3);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["session", "all"])("clears cooldown on %s session cleanup", async (scope) => {
		const { run, recover, onSend, sent } = mockTransport();
		onSend.mockImplementation((socket) => socket.fail());
		await recover();
		await run();
		expect(sent).toHaveLength(4);
		closeOpenAICodexWebSocketSessions(scope === "session" ? sessionId : undefined);
		onSend.mockImplementation((socket) => socket.complete());
		expect((await run()).stopReason).toBe("stop");
		expect(sent).toHaveLength(5);
		expect(getOpenAICodexWebSocketDebugStats(sessionId)?.websocketFallbackActive).toBe(false);
	});

	it("keeps explicitly requested provider-level SSE retries within the same request", async () => {
		vi.useFakeTimers();
		const { run, recover, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementation((socket) => socket.fail());
		fetchMock.mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }));
		const request = recover({ maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(2000);
		expect((await request).stopReason).toBe("stop");
		expect(sent).toHaveLength(4);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(300_000);
		onSend.mockImplementation((socket) => socket.complete());
		expect((await run()).stopReason).toBe("stop");
		expect(sent).toHaveLength(5);
	});

	it.each(["websocket", "websocket-cached"] as const)(
		"never downgrades explicit %s or clears auto cooldown",
		async (transport) => {
			const { run, recover, onSend, fetchMock, sent } = mockTransport();
			onSend.mockImplementation((socket) => socket.fail());
			await recover();
			fetchMock.mockClear();
			const attempts = sent.length;
			for (let i = 0; i < 2; i++) {
				const output = await run({ transport });
				expect(output.stopReason).toBe("error");
				expect(output.errorMessage).toBe("socket dropped");
				expect(output.diagnostics?.at(-1)?.details).not.toHaveProperty("fallbackTransport");
			}
			expect(sent).toHaveLength(attempts + 2);
			expect(fetchMock).not.toHaveBeenCalled();
			onSend.mockImplementation((socket) => socket.complete());
			expect((await run({ transport })).stopReason).toBe("stop");
			expect(getOpenAICodexWebSocketDebugStats(sessionId)?.websocketFallbackActive).toBe(true);
			await run();
			expect(sent).toHaveLength(attempts + 3);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);
});
