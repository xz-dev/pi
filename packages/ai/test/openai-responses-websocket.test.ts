import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAIResponsesWebSocketSessions,
	getOpenAIResponsesWebSocketDebugStats,
	type OpenAIResponsesOptions,
	resetOpenAIResponsesWebSocketDebugStats,
	stream,
} from "../src/api/openai-responses.ts";
import type { Model, TranscriptContext } from "../src/types.ts";
import { type RetryPolicy, retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { jsonRequestBody } from "./utils/request-body.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const apiKey = "sk-test-key";
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
const sessionId = "responses-ws";

afterEach(() => {
	closeOpenAIResponsesWebSocketSessions();
	resetOpenAIResponsesWebSocketDebugStats();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

interface SentFrame {
	connection: number;
	url: string;
	headers: Record<string, string>;
	type?: string;
	stream?: boolean;
	store?: boolean;
	input?: unknown[];
	previous_response_id?: string;
}

function mockTransport() {
	const sent: SentFrame[] = [];
	const sockets: MockWebSocket[] = [];
	const connectHeaders: Record<string, string>[] = [];
	const connectUrls: string[] = [];
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
		constructor(url: string, protocols?: string | string[] | { headers?: Record<string, string> }) {
			super();
			sockets.push(this);
			connectUrls.push(url);
			connectHeaders.push(
				protocols && typeof protocols === "object" && !Array.isArray(protocols) ? (protocols.headers ?? {}) : {},
			);
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		send(data: string): void {
			sent.push({ ...JSON.parse(data), connection: this.connection, url: connectUrls.at(-1)!, headers: {} });
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
	const run = (options: Partial<OpenAIResponsesOptions> = {}, input: TranscriptContext = context) =>
		stream(model, input, { apiKey, sessionId, ...options }).result();
	const recover = (options: Partial<OpenAIResponsesOptions> = {}, input: TranscriptContext = context) =>
		retryAssistantCall(() => run(options, input), { enabled: false, maxRetries: 0, baseDelayMs: 0 }, options.signal);
	return { run, recover, onSend, fetchMock, sent, sockets, connectHeaders, connectUrls };
}

describe("openai-responses WebSocket transport", () => {
	it("falls back to SSE in auto mode when the runtime has no WebSocket", async () => {
		const { recover, sockets, fetchMock } = mockTransport();
		vi.stubGlobal("WebSocket", undefined);
		const request = recover();
		expect((await request).stopReason).toBe("stop");
		expect(sockets).toHaveLength(0);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("opens the public /responses WS URL with bearer auth and no stream field", async () => {
		// Legacy transport fixture: default checkpoint mode is now always, so opt
		// out to keep asserting the pre-checkpoint wire shape.
		const { run, sent, connectHeaders, connectUrls, fetchMock } = mockTransport();
		const result = await run({ responseCheckpointExclude: ["*"] });
		expect(result.stopReason).toBe("stop");
		expect(connectUrls).toEqual(["wss://api.openai.com/v1/responses"]);
		expect(sent).toHaveLength(1);
		expect(sent[0].type).toBe("response.create");
		expect(sent[0].stream).toBeUndefined();
		expect(sent[0].store).toBe(false);
		expect(connectHeaders[0].authorization).toBe(`Bearer ${apiKey}`);
		expect(connectHeaders[0]["openai-beta"]).toContain("responses_websockets");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["sse", "websocket"] as const)(
		"preserves identity and caller header precedence over %s",
		async (transport) => {
			const { connectHeaders, fetchMock } = mockTransport();
			const httpHeaders: Headers[] = [];
			const fetch: typeof globalThis.fetch = async (_input, init) => {
				httpHeaders.push(new Headers(init?.headers));
				return fetchMock();
			};
			const target = { ...model, provider: "openrouter" };
			const identity = {
				userAgent: { custom: "identity-agent" },
				attribution: { name: "identity-app", url: "https://app.example" },
			};
			for (const headers of [
				undefined,
				{ "user-agent": "caller-agent", "x-openrouter-title": "caller-app" },
				{ "user-agent": null, "x-openrouter-title": null },
			]) {
				const result = await stream(target, context, { apiKey, transport, identity, headers, fetch }).result();
				expect(result.stopReason).toBe("stop");
			}
			const observed = transport === "sse" ? httpHeaders : connectHeaders.map((headers) => new Headers(headers));
			expect(observed.map((headers) => headers.get("user-agent"))).toEqual(["identity-agent", "caller-agent", null]);
			expect(observed.map((headers) => headers.get("x-openrouter-title"))).toEqual([
				"identity-app",
				"caller-app",
				null,
			]);
			expect(observed.every((headers) => headers.get("http-referer") === "https://app.example")).toBe(true);
		},
	);

	it("reuses the connection and sends only the delta with previous_response_id", async () => {
		const { run, sent, sockets } = mockTransport();
		const first = await run();
		const secondContext = normalizeContext({
			messages: [...context.messages, first, { role: "user", content: "Second", timestamp: 2 }],
		});
		const second = await run({}, secondContext);
		expect(second.stopReason).toBe("stop");
		expect(sent).toHaveLength(2);
		expect(sent[1].connection).toBe(sent[0].connection);
		expect(sockets).toHaveLength(1);
		expect(sent[1].previous_response_id).toBe(first.responseId);
		expect(sent[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Second" }] }]);
		expect(getOpenAIResponsesWebSocketDebugStats(sessionId)).toMatchObject({
			connectionsReused: 1,
			deltaRequests: 1,
		});
	});

	it("sends full context without previous_response_id when the credential changes", async () => {
		const { run, sent, sockets } = mockTransport();
		await run();
		const secondContext = normalizeContext({
			messages: [...context.messages, { role: "user", content: "Second", timestamp: 2 }],
		});
		await run({ apiKey: "sk-rotated-key" }, secondContext);
		expect(sent).toHaveLength(2);
		expect(sockets).toHaveLength(2);
		expect(sent[1].previous_response_id).toBeUndefined();
		expect(sent[1].input?.length).toBeGreaterThan(1);
	});

	it("sends full context without previous_response_id when the endpoint changes for the same account", async () => {
		const { run, sent, sockets } = mockTransport();
		await run();
		const secondContext = normalizeContext({
			messages: [...context.messages, { role: "user", content: "Second", timestamp: 2 }],
		});
		const movedModel = { ...model, baseUrl: "https://moved.example.com/v1" };
		await stream(movedModel, secondContext, { apiKey, sessionId }).result();
		expect(sent).toHaveLength(2);
		expect(sockets).toHaveLength(2);
		expect(sent[1].previous_response_id).toBeUndefined();
		expect(sent[1].input?.length).toBe(secondContext.messages.length);
	});

	it("sends full context without previous_response_id when effective headers change for the same account", async () => {
		const { run, sent, sockets } = mockTransport();
		await run();
		const secondContext = normalizeContext({
			messages: [...context.messages, { role: "user", content: "Second", timestamp: 2 }],
		});
		await run({ headers: { "x-tenant": "tenant-b" } }, secondContext);
		expect(sent).toHaveLength(2);
		expect(sockets).toHaveLength(2);
		expect(sent[1].previous_response_id).toBeUndefined();
		expect(sent[1].input?.length).toBe(secondContext.messages.length);
	});

	it("isolates SSE fallback cooldown per endpoint+identity for the same session", async () => {
		// Legacy transport fixture: checkpoints default to always, so opt out to
		// keep asserting the WS→SSE recovery budget in isolation.
		const { run, recover, onSend, sent, fetchMock } = mockTransport();
		const now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		onSend.mockImplementation((socket) => socket.fail());
		await recover({ responseCheckpointExclude: ["*"] });
		await run({ responseCheckpointExclude: ["*"] });
		expect(sent).toHaveLength(4); // initial + 3 WS retries, all failed
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// A different endpoint on the same session still gets its own WS probe.
		const movedModel = { ...model, baseUrl: "https://other.example.com/v1" };
		onSend.mockImplementation((socket) => socket.complete());
		await stream(movedModel, context, { apiKey, sessionId }).result();
		expect(sent).toHaveLength(5);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// The original identity stays in cooldown until its deadline.
		await run();
		expect(sent).toHaveLength(5);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps the fixed retry allowance with cacheRetention none and a stable session ID", async () => {
		const { recover, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementation((socket) => socket.fail());
		expect((await recover({ cacheRetention: "none" })).stopReason).toBe("stop");
		expect(sent).toHaveLength(4);
		expect(sent.every((request) => request.previous_response_id === undefined)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("sends full context when history no longer extends the cached baseline", async () => {
		const { run, sent } = mockTransport();
		await run();
		// Edited history: different content at the same position.
		const editedContext = normalizeContext({ messages: [{ role: "user", content: "Edited", timestamp: 2 }] });
		const transports: Array<string | undefined> = [];
		await run({ onTransport: (value) => void transports.push(value) }, editedContext);
		expect(transports).toEqual(["WS/full"]);
		expect(sent).toHaveLength(2);
		expect(sent[1].previous_response_id).toBeUndefined();
		expect(sent[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Edited" }] }]);
	});

	it("keeps explicit SSE on HTTP with stream:true and no continuation", async () => {
		const { run, sent, fetchMock } = mockTransport();
		const result = await run({ transport: "sse" });
		expect(result.stopReason).toBe("stop");
		expect(sent).toHaveLength(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const request = (fetchMock.mock.calls[0] as unknown[] | undefined)?.[1] as RequestInit | undefined;
		const body = jsonRequestBody(request);
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(body.previous_response_id).toBeUndefined();
	});

	it("never downgrades explicit websocket transport to SSE", async () => {
		const { run, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementation((socket) => socket.fail());
		const result = await run({ transport: "websocket" });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("socket dropped");
		expect(sent).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.diagnostics?.at(-1)?.details).not.toHaveProperty("fallbackTransport");
	});

	it("falls back to SSE after the fixed auto retry budget is exhausted", async () => {
		// Legacy transport fixture: opt out of checkpoints (now default always).
		const { recover, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementation((socket) => socket.fail());
		const result = await recover({ responseCheckpointExclude: ["*"] });
		expect(result.stopReason).toBe("stop");
		expect(sent).toHaveLength(4); // initial + 3 outer WS retries
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(getOpenAIResponsesWebSocketDebugStats(sessionId)?.websocketFallbackActive).toBe(true);
	});

	it.each(["auto", "websocket", "websocket-cached"] as const)(
		"progresses failed probes and resets only after a completed %s response",
		async (transport) => {
			const { run, recover, onSend, sent } = mockTransport();
			let now = 1000;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const options = { responseCheckpointExclude: ["*"] };
			onSend.mockImplementation((socket) => socket.fail());
			await recover(options);
			for (const cooldown of [120_000, 180_000, 240_000, 300_000, 300_000]) {
				const attempts = sent.length;
				now += cooldown - 1;
				await run(options);
				expect(sent).toHaveLength(attempts);
				now++;
				await run(options);
				expect(sent).toHaveLength(attempts + 1);
			}
			onSend.mockImplementation((socket) => socket.complete());
			if (transport === "auto") now += 300_000;
			expect((await run({ ...options, transport })).stopReason).toBe("stop");
			expect(getOpenAIResponsesWebSocketDebugStats(sessionId)?.websocketFallbackActive).toBe(transport !== "auto");
			const attempts = sent.length;
			if (transport !== "auto") {
				now += 299_999;
				await run(options);
				expect(sent).toHaveLength(attempts);
				now++;
			}
			onSend.mockImplementation((socket) => socket.fail());
			await recover(options);
			const failures = sent.length;
			now += 119_999;
			await run(options);
			expect(sent).toHaveLength(failures);
			now++;
			onSend.mockImplementation((socket) => socket.complete());
			await run(options);
			expect(sent).toHaveLength(failures + 1);
		},
	);

	it("keeps original in-flight WS failures at the same stage across expired deadlines", async () => {
		const { run, onSend, sockets, sent } = mockTransport();
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const options = { responseCheckpointExclude: ["*"], timeoutMs: 0 };
		let arrived!: () => void;
		const started = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		onSend.mockImplementation(() => {
			if (sent.length === 6) arrived();
		});
		const requests = Array.from({ length: 6 }, () => run(options));
		await started;
		for (let index = 0; index < 6; index++) {
			if (index >= 4) now += index === 4 ? 120_001 : 180_001;
			sockets[index].fail();
			await requests[index];
		}
		now += 119_999;
		await run(options);
		expect(sent).toHaveLength(6);
		now++;
		onSend.mockImplementation((socket) => socket.fail());
		await run(options);
		expect(sent).toHaveLength(7);
		now += 179_999;
		await run(options);
		expect(sent).toHaveLength(7);
		now++;
		onSend.mockImplementation((socket) => socket.complete());
		await run(options);
		expect(sent).toHaveLength(8);
	});

	it("does not replay a started response and recovers with full context", async () => {
		const { run, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementationOnce((socket) => {
			socket.emit({ type: "response.created", response: { id: "partial" } });
			socket.emit({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_partial", role: "assistant", content: [] },
			});
			socket.emit({ type: "response.output_text.delta", delta: "discarded" });
			socket.fail();
		});
		const first = await run();
		expect(first.stopReason).toBe("error");
		expect(fetchMock).not.toHaveBeenCalled();
		const second = await run();
		expect(second.stopReason).toBe("stop");
		expect(sent).toHaveLength(2);
		expect(sent[1].previous_response_id).toBeUndefined();
		expect(sent[1].input?.length).toBe(context.messages.length);
	});

	it("surfaces nested WS error envelopes with the provider message", async () => {
		const { run, onSend } = mockTransport();
		onSend.mockImplementation((socket) =>
			socket.emit({
				type: "error",
				error: { code: "session_closed", message: "session closed by server" },
			}),
		);
		const result = await run({ transport: "websocket" });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("session closed by server");
		expect(result.errorMessage).not.toContain("undefined");
	});

	it("isolates pooled sockets by baseUrl for the same session", async () => {
		const { run, sockets } = mockTransport();
		await run();
		const proxyModel = { ...model, baseUrl: "https://gateway.example.com/v1" };
		await stream(proxyModel, context, { apiKey: "gateway-key", sessionId }).result();
		expect(sockets).toHaveLength(2);
	});

	it("keeps caller routing headers even when they equal the session nonce", async () => {
		const { run, sent, sockets, connectHeaders } = mockTransport();
		const first = await run({ headers: { "x-session-affinity": sessionId } });
		const next = normalizeContext({
			messages: [...context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
		});
		await run({}, next);
		expect(sockets).toHaveLength(2);
		expect(connectHeaders[0]["x-session-affinity"]).toBe(sessionId);
		expect(connectHeaders[1]["x-session-affinity"]).toBeUndefined();
		expect(sent[1].previous_response_id).toBeUndefined();
	});

	it("partitions pooled connections by every effective auth header", async () => {
		const { run, sent, sockets, connectHeaders } = mockTransport();
		await run({ headers: { authorization: "Bearer upstream", "cf-aig-authorization": "Bearer gateway-a" } });
		const secondContext = normalizeContext({
			messages: [...context.messages, { role: "user", content: "Second", timestamp: 2 }],
		});
		await run(
			{ headers: { authorization: "Bearer upstream", "cf-aig-authorization": "Bearer gateway-b" } },
			secondContext,
		);
		expect(sockets).toHaveLength(2);
		expect(connectHeaders[0]["cf-aig-authorization"]).toBe("Bearer gateway-a");
		expect(connectHeaders[1]["cf-aig-authorization"]).toBe("Bearer gateway-b");
		expect(sent[1].previous_response_id).toBeUndefined();
		expect(sent[1].input?.length).toBe(secondContext.messages.length);
	});

	it("partitions pooled connections by caller-supplied session routing headers", async () => {
		const { run, sent, sockets, connectHeaders } = mockTransport();
		await run({ headers: { session_id: "route-a" } });
		const secondContext = normalizeContext({
			messages: [...context.messages, { role: "user", content: "Second", timestamp: 2 }],
		});
		await run({ headers: { session_id: "route-b" } }, secondContext);
		expect(sockets).toHaveLength(2);
		expect(connectHeaders[0].session_id).toBe("route-a");
		expect(connectHeaders[1].session_id).toBe("route-b");
		expect(sent[1].previous_response_id).toBeUndefined();
		expect(sent[1].input?.length).toBe(secondContext.messages.length);
	});

	it("does not share SSE cooldown across caller session routing identities", async () => {
		// Legacy transport fixture: opt out of checkpoints (now default always).
		const { run, recover, onSend, sent, fetchMock } = mockTransport();
		const now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		onSend.mockImplementation((socket) => socket.fail());
		await recover({ responseCheckpointExclude: ["*"], headers: { session_id: "route-a" } });
		await run({ headers: { session_id: "route-a" } });
		expect(sent).toHaveLength(4); // initial + 3 WS retries, all failed
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// A different caller session identity gets its own WS probe, not the cooldown.
		onSend.mockImplementation((socket) => socket.complete());
		await run({ headers: { session_id: "route-b" } });
		expect(sent).toHaveLength(5);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// The original identity stays in cooldown until its deadline.
		await run({ headers: { session_id: "route-a" } });
		expect(sent).toHaveLength(5);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("treats a malformed provider stream as a protocol failure, not transport", async () => {
		const { run, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementation((socket) => {
			socket.emit({ type: "response.created", response: { id: "resp_bad" } });
			socket.emit({
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "do_thing", arguments: "" },
			});
			socket.emit({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" });
			// No response.output_item.done: the call is unfinished at completion.
			socket.emit({ type: "response.completed", response: { id: "resp_bad", status: "completed" } });
		});
		const result = await run();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("unfinished tool call");
		expect(sent).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.diagnostics?.some((d) => d.type === "provider_transport_failure")).not.toBe(true);
		expect(getOpenAIResponsesWebSocketDebugStats(sessionId)?.websocketFailures ?? 0).toBe(0);
		expect(getOpenAIResponsesWebSocketDebugStats(sessionId)?.websocketFallbackActive ?? false).toBe(false);
	});

	it("repairs a missing continuation once before the first event", async () => {
		const { run, onSend, sent } = mockTransport();
		let attempts = 0;
		onSend.mockImplementation((socket) => {
			attempts++;
			if (attempts === 1) {
				socket.emit({
					type: "error",
					error: { code: "previous_response_not_found", message: "stale continuation" },
				});
				return;
			}
			socket.complete();
		});
		const result = await run();
		expect(result.stopReason).toBe("stop");
		expect(sent).toHaveLength(2);
		expect(sent[1].previous_response_id).toBeUndefined();
		expect(sent[1].input?.length).toBe(context.messages.length);
	});

	it("does not issue a second in-stream request after start when continuation is missing", async () => {
		const { run, onSend, sent } = mockTransport();
		onSend.mockImplementation((socket) => {
			socket.emit({ type: "response.created", response: { id: "resp_started" } });
			socket.emit({
				type: "error",
				error: { code: "previous_response_not_found", message: "stale continuation" },
			});
		});
		const result = await run();
		expect(result.stopReason).toBe("error");
		expect(sent).toHaveLength(1);
	});

	it("does not treat an unserializable caller payload as a transport failure", async () => {
		const { run, sent, fetchMock } = mockTransport();
		const inject = (params: unknown) => ({
			...(params as Record<string, unknown>),
			badValue: 10n,
		});
		const result = await run({ onPayload: inject });
		expect(result.stopReason).toBe("error");
		expect(sent).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.diagnostics?.some((d) => d.type === "provider_transport_failure")).not.toBe(true);
		expect(getOpenAIResponsesWebSocketDebugStats(sessionId)?.websocketFailures ?? 0).toBe(0);
		expect(getOpenAIResponsesWebSocketDebugStats(sessionId)?.websocketFallbackActive ?? false).toBe(false);
	});

	it("an unserializable caller payload stays nonretryable under the outer retry owner", async () => {
		const { recover, sent, fetchMock } = mockTransport();
		const inject = (params: unknown) => ({
			...(params as Record<string, unknown>),
			badValue: 10n,
		});
		const result = await recover({ onPayload: inject });
		expect(result.stopReason).toBe("error");
		expect(sent).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.diagnostics?.some((d) => d.type === "provider_transport_failure")).not.toBe(true);
	});

	it("never forwards a caller-injected previous_response_id on a new connection", async () => {
		// Legacy transport fixture: with checkpoints off, the caller parent must
		// still be stripped from the WS body on a fresh connection.
		const { run, sent, sockets } = mockTransport();
		const inject = (params: unknown) => ({
			...(params as Record<string, unknown>),
			previous_response_id: "resp_foreign",
		});
		await run({ responseCheckpointExclude: ["*"], onPayload: inject });
		expect(sent).toHaveLength(1);
		expect(sent[0].previous_response_id).toBeUndefined();
		const secondContext = normalizeContext({
			messages: [...context.messages, { role: "user", content: "Second", timestamp: 2 }],
		});
		await run({ apiKey: "sk-rotated-key", responseCheckpointExclude: ["*"], onPayload: inject }, secondContext);
		expect(sockets).toHaveLength(2);
		expect(sent[1].previous_response_id).toBeUndefined();
		expect(sent[1].input?.length).toBe(secondContext.messages.length);
	});
});

describe("openai-responses retry plan", () => {
	it("uses the transport recovery budget for auto failures", async () => {
		vi.useFakeTimers();
		// Legacy transport fixture: opt out of checkpoints (now default always).
		const { run, onSend, sent, fetchMock } = mockTransport();
		onSend.mockImplementation((socket) => socket.fail());
		const policy: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 10, maxAgentDelayMs: 15 };
		const request = retryAssistantCall(() => run({ responseCheckpointExclude: ["*"] }), policy, undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(10);
		expect(sent).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(15);
		expect(sent).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(15);
		expect((await request).stopReason).toBe("stop");
		expect(sent).toHaveLength(4);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("onTransport reporting", () => {
	it.each(["auto", "websocket-cached", "websocket"] as const)(
		"reports the actual request mode for %s, including a fresh connection",
		async (transport) => {
			const { run, sent } = mockTransport();
			const transports: Array<string | undefined> = [];
			const options = { transport, onTransport: (value: string | undefined) => void transports.push(value) };
			const first = await run(options);
			const secondContext = normalizeContext({
				messages: [...context.messages, first, { role: "user", content: "Second", timestamp: 2 }],
			});
			const second = await run(options, secondContext);
			closeOpenAIResponsesWebSocketSessions(sessionId);
			const thirdContext = normalizeContext({
				messages: [...secondContext.messages, second, { role: "user", content: "Third", timestamp: 3 }],
			});
			const third = await run(options, thirdContext);
			expect([first.stopReason, second.stopReason, third.stopReason]).toEqual(["stop", "stop", "stop"]);
			expect(transports).toEqual(["WS/full", transport === "websocket" ? "WS/full" : "WS/continuation", "WS/full"]);
			expect(sent[2].connection).not.toBe(sent[1].connection);
			expect(sent[2].previous_response_id).toBeUndefined();
		},
	);

	it("reports WS only after the socket opens", async () => {
		const { run } = mockTransport();
		const transports: Array<string | undefined> = [];
		await run({ onTransport: (t) => void transports.push(t) });
		expect(transports).toEqual(["WS/full"]);
	});

	it("never labels a pending handshake WS", async () => {
		const { run } = mockTransport();
		const transports: Array<string | undefined> = [];
		let sawOpen = false;
		class PendingWebSocket extends EventTarget {
			readyState = 0;
			constructor() {
				super();
				queueMicrotask(() => {
					this.readyState = 1;
					sawOpen = true;
					this.dispatchEvent(new Event("open"));
				});
			}
			send(data: string): void {
				const _parsed = JSON.parse(data) as { type?: string };
				queueMicrotask(() => {
					this.dispatchEvent(
						Object.assign(new Event("message"), {
							data: JSON.stringify({
								type: "response.completed",
								response: { id: "resp_delay", status: "completed" },
							}),
						}),
					);
				});
			}
			close(): void {}
		}
		vi.stubGlobal("WebSocket", PendingWebSocket);
		const result = await run({
			onTransport: (t) => {
				// Before the socket fires open, the hook must never be told WS.
				if (t !== undefined) expect(sawOpen).toBe(true);
				transports.push(t);
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(transports).toEqual(["WS/full"]);
	});

	it("never labels a failed handshake WS", async () => {
		const { run } = mockTransport();
		const transports: Array<string | undefined> = [];
		vi.stubGlobal(
			"WebSocket",
			class extends EventTarget {
				readyState = 0;
				constructor() {
					super();
					queueMicrotask(() =>
						this.dispatchEvent(Object.assign(new Event("error"), { message: "handshake refused" })),
					);
				}
				send(): void {
					throw new Error("send before open");
				}
				close(): void {
					this.readyState = 3;
				}
			},
		);
		const result = await run({ transport: "websocket", onTransport: (t) => void transports.push(t) });
		expect(result.stopReason).toBe("error");
		expect(transports).toEqual([]);
	});

	it("clears the label then reports SSE when auto falls back", async () => {
		// Legacy transport fixture: opt out of checkpoints (now default always).
		const { recover, onSend } = mockTransport();
		onSend.mockImplementation((socket) => socket.fail());
		const transports: Array<string | undefined> = [];
		await recover({ responseCheckpointExclude: ["*"], onTransport: (t) => void transports.push(t) });
		expect(transports.at(-2)).toBe(undefined);
		expect(transports.at(-1)).toBe("SSE");
	});

	it("a throwing hook does not become a transport failure", async () => {
		const { run, sent } = mockTransport();
		const result = await run({ onTransport: () => Promise.reject(new Error("hook boom")) });
		expect(result.stopReason).toBe("stop");
		expect(sent).toHaveLength(1);
		expect(result.errorMessage).toBeUndefined();
	});
});
