import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAIResponsesWebSocketSessions,
	getOpenAIResponsesWebSocketDebugStats,
	type OpenAIResponsesOptions,
	resetOpenAIResponsesWebSocketDebugStats,
	stream,
	streamSimple,
} from "../src/api/openai-responses.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";
import { retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "offline-background",
	name: "Offline background",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 10000,
	maxTokens: 1000,
};
const context = normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 1 }] });
const response = {
	id: "resp_background",
	object: "response",
	created_at: 1,
	status: "in_progress",
	background: true,
	store: true,
	model: model.id,
	output: [],
	error: null,
	incomplete_details: null,
};
const reasoning = {
	type: "reasoning",
	id: "rs_1",
	summary: [{ type: "summary_text", text: "Think" }],
	encrypted_content: "opaque",
};
const message = {
	type: "message",
	id: "msg_1",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text: "AB", annotations: [] }],
};
const tool = {
	type: "function_call",
	id: "fc_1",
	call_id: "call_1",
	name: "read",
	arguments: '{"path":"a"}',
	status: "completed",
};
function events(): Record<string, unknown>[] {
	return [
		{ type: "response.created", response },
		{ type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
		{ type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
		{ type: "response.output_item.added", output_index: 2, item: { ...tool, arguments: "" } },
		{
			type: "response.output_text.delta",
			output_index: 1,
			item_id: "msg_1",
			content_index: 0,
			delta: "A",
			future_field: { kept: true },
		},
		{
			type: "response.reasoning_summary_text.delta",
			output_index: 0,
			item_id: "rs_1",
			summary_index: 0,
			delta: "Think",
		},
		{ type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_1", delta: '{"path":' },
		{ type: "response.output_text.delta", output_index: 1, item_id: "msg_1", content_index: 0, delta: "B" },
		{ type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_1", delta: '"a"}' },
		{ type: "response.output_item.done", output_index: 0, item: reasoning },
		{ type: "response.output_item.done", output_index: 1, item: message },
		{ type: "response.function_call_arguments.done", output_index: 2, item_id: "fc_1", arguments: tool.arguments },
		{ type: "response.output_item.done", output_index: 2, item: tool },
		{
			type: "response.completed",
			response: {
				...response,
				status: "completed",
				output: [reasoning, message, tool],
				usage: {
					input_tokens: 20,
					output_tokens: 8,
					total_tokens: 28,
					input_tokens_details: { cached_tokens: 3 },
					output_tokens_details: { reasoning_tokens: 2 },
				},
			},
		},
	].map((event, sequence_number) => ({ ...event, sequence_number }));
}
function wire(items: Record<string, unknown>[]): string {
	return items.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
function sse(body: string): Response {
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
function background(payload: unknown): Record<string, unknown> {
	return { ...(payload as Record<string, unknown>), background: true, store: true };
}
async function consume(fetch: typeof globalThis.fetch, options: Partial<OpenAIResponsesOptions> = {}) {
	const seen: AssistantMessageEvent[] = [];
	const s = stream(model, context, {
		transport: "sse",
		apiKey: "sk-dummy",
		fetch,
		onPayload: background,
		responseReplay: true,
		...options,
	});
	for await (const event of s) seen.push(structuredClone(event));
	return { message: await s.result(), seen };
}
afterEach(() => {
	closeOpenAIResponsesWebSocketSessions();
	resetOpenAIResponsesWebSocketDebugStats();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("native standard background SSE replay", () => {
	it.each([false, true])(
		"continues mixed blocks in one parser after disconnect, partialFrame=%s",
		async (partialFrame) => {
			const all = events();
			const baseline = await consume(vi.fn<typeof fetch>().mockResolvedValue(sse(wire(all))));
			const requests: Request[] = [];
			const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				if (request.method === "POST") {
					expect(await request.json()).toMatchObject({ background: true, store: true, stream: true });
					return sse(
						wire(all.slice(0, 7)) + (partialFrame ? 'event: response.output_text.delta\ndata: {"type":' : ""),
					);
				}
				expect(request.method).toBe("GET");
				expect(new URL(request.url).pathname).toBe("/v1/responses/resp_background");
				expect(new URL(request.url).searchParams.get("starting_after")).toBe("6");
				expect(new URL(request.url).searchParams.get("stream")).toBe("true");
				return sse(wire(all.slice(6).concat(all.slice(-1))));
			});
			const observed: unknown[] = [];
			const result = await consume(fetchMock, {
				onProviderStreamEvent: (event) => {
					observed.push(event);
				},
			});
			expect(result.message.stopReason).toBe("toolUse");
			expect(result.message.content).toEqual(baseline.message.content);
			expect(result.message.usage).toEqual(baseline.message.usage);
			expect(result.message.responseId).toBe("resp_background");
			expect(result.seen.map((event) => event.type)).toEqual(baseline.seen.map((event) => event.type));
			expect(result.seen.filter((event) => event.type === "start")).toHaveLength(1);
			expect(result.seen.filter((event) => event.type === "done")).toHaveLength(1);
			expect(observed).toEqual(all);
			expect(requests.map((request) => request.method)).toEqual(["POST", "GET"]);
		},
	);

	it.each(["lost create", "missing cursor", "retrieve missing", "exhausted replay"])(
		"uses the ordinary retry owner after %s without mixing generations",
		async (failure) => {
			const requests: Request[] = [];
			let posts = 0;
			const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				if (request.method === "POST") {
					posts++;
					if (posts > 1)
						return sse(
							wire(
								events().map((event) =>
									"response" in event
										? { ...event, response: { ...(event.response as object), id: "resp_retry" } }
										: event,
								),
							),
						);
					if (failure === "lost create") throw new TypeError("fetch failed");
					return sse(failure === "missing cursor" ? "" : wire(events().slice(0, 7)));
				}
				return failure === "retrieve missing"
					? Response.json({ error: { message: "expired response", code: "task_unavailable" } }, { status: 404 })
					: sse(wire(events().slice(0, 7)));
			});
			const scheduled = vi.fn();
			const attempts: Awaited<ReturnType<typeof consume>>[] = [];
			const result = await retryAssistantCall(
				async () => {
					const attempt = await consume(fetchMock);
					attempts.push(attempt);
					return attempt.message;
				},
				{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
				undefined,
				{ onRetryScheduled: scheduled },
			);
			const baseline = await consume(vi.fn<typeof fetch>().mockResolvedValue(sse(wire(events()))));
			expect(result.stopReason).toBe("toolUse");
			expect(result.responseId).toBe("resp_retry");
			expect(result.content).toEqual(baseline.message.content);
			expect(result.usage).toEqual(baseline.message.usage);
			expect(posts).toBe(2);
			expect(attempts).toHaveLength(2);
			expect(attempts[0].message.stopReason).toBe("error");
			expect(scheduled).toHaveBeenCalledExactlyOnceWith(1, 1, 0, expect.any(String));
			expect(requests.map((request) => request.method)).toEqual(
				failure === "retrieve missing"
					? ["POST", "GET", "POST"]
					: failure === "exhausted replay"
						? ["POST", "GET", "GET", "POST"]
						: ["POST", "POST"],
			);
		},
	);

	it.each(["disabled", "exhausted", "custom pattern", "billing limit"])(
		"does not bypass the ordinary %s retry restriction",
		async (restriction) => {
			const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
				new Request(input, init).method === "POST"
					? sse(wire(events().slice(0, 7)))
					: Response.json(
							{
								error: {
									message: restriction === "billing limit" ? "billing unavailable" : "expired response",
								},
							},
							{ status: 404 },
						),
			);
			const scheduled = vi.fn();
			const result = await retryAssistantCall(
				async () => (await consume(fetchMock)).message,
				{
					enabled: restriction !== "disabled",
					maxRetries: restriction === "exhausted" ? 0 : 2,
					baseDelayMs: 0,
					nonRetryableErrorPatterns: restriction === "custom pattern" ? ["expired response"] : undefined,
				},
				undefined,
				{ onRetryScheduled: scheduled },
			);
			expect(result.stopReason).toBe("error");
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(scheduled).not.toHaveBeenCalled();
		},
	);

	it.each([401, 403, 404, 409])("preserves retrieve HTTP %s before the outer owner decides", async (status) => {
		const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
			new Request(input, init).method === "POST"
				? sse(wire(events().slice(0, 7)))
				: new Response(
						JSON.stringify({
							error: { message: `expired ${status}`, type: "invalid_request_error", code: "task_unavailable" },
						}),
						{ status, headers: { "content-type": "application/json" } },
					),
		);
		const result = await consume(fetchMock, { maxRetries: 3 });
		expect(result.message.stopReason).toBe("error");
		expect(result.message.errorMessage).toContain(`expired ${status}`);
		expect(result.message.content).toHaveLength(3);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each([401, 403])("does not turn retrieve HTTP %s into a retry hint", async (status) => {
		const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
			new Request(input, init).method === "POST"
				? sse(wire(events().slice(0, 7)))
				: Response.json({ error: { message: "access denied" } }, { status }),
		);
		const result = await retryAssistantCall(
			async () => (await consume(fetchMock)).message,
			{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
			undefined,
		);
		expect(result.stopReason).toBe("error");
		expect(
			result.diagnostics?.some((diagnostic) => diagnostic.type === "provider_response_replay_unavailable") ?? false,
		).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not replenish the ordinary retry budget after repeated unavailable responses", async () => {
		const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
			new Request(input, init).method === "POST"
				? sse(wire(events().slice(0, 7)))
				: Response.json({ error: { message: "expired response" } }, { status: 409 }),
		);
		const scheduled = vi.fn();
		const result = await retryAssistantCall(
			async () => (await consume(fetchMock)).message,
			{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
			undefined,
			{ onRetryScheduled: scheduled },
		);
		expect(result.stopReason).toBe("error");
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(scheduled.mock.calls.map((call) => call.slice(0, 3))).toEqual([
			[1, 2, 0],
			[2, 2, 0],
		]);
	});

	it.each(["changed ID", "invalid cursor", "sequence gap"])(
		"rejects unsafe replay %s before applying it",
		async (kind) => {
			const all = events();
			const bad =
				kind === "changed ID"
					? { ...all[0], sequence_number: 7, response: { ...response, id: "resp_other" } }
					: { ...all[7], sequence_number: kind === "invalid cursor" ? 7.5 : 8 };
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(sse(wire(all.slice(0, 7))))
				.mockResolvedValueOnce(sse(wire([bad])));
			const result = await consume(fetchMock);
			expect(result.message.stopReason).toBe("error");
			expect(result.message.content.find((block) => block.type === "text")).toMatchObject({ text: "A" });
			expect(
				result.message.diagnostics?.some(
					(diagnostic) => diagnostic.type === "provider_response_replay_unavailable",
				) ?? false,
			).toBe(false);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		},
	);

	it("refuses missing create identity without inventing a cursor or response ID", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				sse(wire([{ type: "response.created", sequence_number: 0, response: { status: "in_progress" } }])),
			);
		const result = await consume(fetchMock);
		expect(result.message.stopReason).toBe("error");
		expect(result.message.errorMessage).toContain("response ID");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])("bounds all reattachments together, malformedWire=%s", async (malformedWire) => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchMock = vi.fn<typeof fetch>(async () =>
			sse(wire(events().slice(0, 1)) + (malformedWire ? "data: {broken}\n\n" : "")),
		);
		const result = await consume(fetchMock);
		expect(result.message.stopReason).toBe("error");
		expect(result.message.errorMessage).toContain("exhausted its two reattachments");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const requests = fetchMock.mock.calls.map(([input, init]) => new Request(input, init));
		expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
		expect(requests.slice(1).map((request) => new URL(request.url).searchParams.get("starting_after"))).toEqual([
			"0",
			"0",
		]);
	});

	it.each(["failed", "incomplete"])("keeps a %s terminal authoritative without reattaching", async (kind) => {
		const terminal =
			kind === "failed"
				? { ...response, status: "failed", error: { code: "server_error", message: "503 after prefix" } }
				: { ...response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
		const fetchMock = vi.fn<typeof fetch>(async () =>
			sse(
				wire(
					events()
						.slice(0, 5)
						.concat([{ type: `response.${kind}`, sequence_number: 5, response: terminal }]),
				),
			),
		);
		const result = await consume(fetchMock);
		expect(result.message.stopReason).toBe(kind === "failed" ? "error" : "length");
		expect(
			result.message.diagnostics?.some((diagnostic) => diagnostic.type === "provider_response_replay_terminal") ??
				false,
		).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("never treats the application event callback as a transport decoder failure", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => sse(wire(events())));
		const result = await consume(fetchMock, {
			onProviderStreamEvent: (event) => {
				if ((event as { sequence_number: number }).sequence_number === 6)
					throw new SyntaxError("503 consumer parser failed");
			},
		});
		expect(result.message.errorMessage).toContain("503 consumer parser failed");
		expect(result.message.stopReason).toBe("error");
		expect(
			result.message.diagnostics?.some((diagnostic) => diagnostic.type === "provider_response_replay_unavailable") ??
				false,
		).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not classify a response callback failure as unavailable replay", async () => {
		let responses = 0;
		const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
			sse(wire(new Request(input, init).method === "POST" ? events().slice(0, 7) : events().slice(7))),
		);
		const result = await retryAssistantCall(
			async () =>
				(
					await consume(fetchMock, {
						onResponse: () => {
							if (++responses === 2)
								throw new OpenAI.APIError(
									404,
									{ message: "response callback failed" },
									"response callback failed",
									new Headers(),
								);
						},
					})
				).message,
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
			undefined,
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("response callback failed");
		expect(
			result.diagnostics?.some((diagnostic) => diagnostic.type === "provider_response_replay_unavailable") ?? false,
		).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not recover a parser invariant failure after a completed terminal", async () => {
		const all = events();
		const fetchMock = vi.fn<typeof fetch>(async () =>
			sse(wire(all.slice(0, 7).concat([{ ...all[13], sequence_number: 7 }]))),
		);
		const result = await consume(fetchMock);
		expect(result.message.errorMessage).toContain("unfinished tool call");
		expect(result.message.stopReason).toBe("error");
		expect(
			result.message.diagnostics?.some((diagnostic) => diagnostic.type === "provider_response_replay_unavailable") ??
				false,
		).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("preserves an SDK in-band error after a visible prefix", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			sse(
				wire(
					events()
						.slice(0, 7)
						.concat([
							{ type: "error", sequence_number: 7, code: "server_error", message: "503 original wire failure" },
						]),
				),
			),
		);
		const result = await consume(fetchMock);
		expect(result.message.errorMessage).toContain("503 original wire failure");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("resumes after an errored transport reader discards a half JSON frame", async () => {
		let sent = false;
		const brokenBody = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!sent) {
					sent = true;
					controller.enqueue(new TextEncoder().encode(`${wire(events().slice(0, 7))}data: {"type":`));
				} else controller.error(new TypeError("terminated", { cause: { code: "ECONNRESET" } }));
			},
		});
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(brokenBody, { headers: { "content-type": "text/event-stream" } }))
			.mockImplementationOnce(async (input, init) => {
				expect(new URL(new Request(input, init).url).searchParams.get("starting_after")).toBe("6");
				return sse(wire(events().slice(7)));
			});
		const result = await consume(fetchMock);
		expect(result.message.stopReason).toBe("toolUse");
		expect(result.message.content).toHaveLength(3);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not GET for ordinary nonbackground SSE", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => sse(wire(events().slice(0, 7))));
		const result = await consume(fetchMock, { onPayload: (payload) => payload });
		expect(result.message.stopReason).toBe("error");
		expect(result.message.diagnostics).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([undefined, false])(
		"leaves background wire requests without opt-in on the legacy path: %s",
		async (responseReplay) => {
			const fetchMock = vi.fn<typeof fetch>(async () => sse(wire(events().slice(0, 7))));
			const result = await consume(fetchMock, { responseReplay });
			expect(result.message.stopReason).toBe("error");
			expect(result.message.diagnostics).toBeUndefined();
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it("does not cancel a task it did not opt in to own", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn<typeof fetch>(async () => sse(wire(events())));
		const result = await consume(fetchMock, {
			responseReplay: undefined,
			signal: controller.signal,
			onProviderStreamEvent: () => controller.abort(),
		});
		expect(result.message.stopReason).toBe("aborted");
		expect(result.message.diagnostics).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not put the opt-in in actual HTTP or prepared requests", async () => {
		const actual: Array<{ body: string; headers: [string, string][] }> = [];
		const prepared: Array<{ body: string; headers: [string, string][] }> = [];
		for (const responseReplay of [undefined, true]) {
			const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
				const request = new Request(input, init);
				actual.push({ body: await request.text(), headers: [...request.headers] });
				return sse(wire(events()));
			});
			const result = await consume(fetchMock, {
				responseReplay,
				sessionId: "stable-replay-identity",
				onPayload: async (payload, _model, prepareRequest) => {
					const body = background(payload);
					expect(prepareRequest).toBeTypeOf("function");
					const request = await prepareRequest!(body);
					prepared.push({ body: await request.text(), headers: [...request.headers] });
					return body;
				},
			});
			expect(result.message.stopReason).toBe("toolUse");
		}
		expect(actual[1]).toEqual(actual[0]);
		expect(prepared[1]).toEqual(prepared[0]);
		expect(
			[...actual, ...prepared].every(
				(request) =>
					!request.body.includes("responseReplay") && !JSON.stringify(request.headers).includes("responseReplay"),
			),
		).toBe(true);
	});

	it("preserves replay opt-in through streamSimple's provider-only mapping", async () => {
		const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
			sse(wire(new Request(input, init).method === "POST" ? events().slice(0, 7) : events().slice(7))),
		);
		const result = await streamSimple(model, context, {
			apiKey: "sk-dummy",
			transport: "sse",
			responseReplay: true,
			fetch: fetchMock,
			onPayload: background,
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each(["auto", "websocket", "websocket-cached"] as const)(
		"leaves a requested replay option on %s at the existing WS path",
		async (transport) => {
			const frames: Array<Record<string, unknown>> = [];
			const sockets: EventTarget[] = [];
			class MockWebSocket extends EventTarget {
				readyState = 1;
				constructor() {
					super();
					sockets.push(this);
					queueMicrotask(() => this.dispatchEvent(new Event("open")));
				}
				send(data: string) {
					frames.push(JSON.parse(data));
					queueMicrotask(() => {
						for (const event of events())
							this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
					});
				}
				close() {
					this.readyState = 3;
				}
			}
			vi.stubGlobal("WebSocket", MockWebSocket);
			const fetchMock = vi.fn<typeof fetch>();
			const results = [];
			for (const responseReplay of [undefined, true]) {
				results.push(
					(
						await consume(fetchMock, {
							transport,
							responseReplay,
							sessionId: "stable-ws-replay-identity",
						})
					).message,
				);
			}
			expect(results.map((result) => result.stopReason)).toEqual(["toolUse", "toolUse"]);
			expect(frames).toHaveLength(2);
			expect(frames[1]).toEqual(frames[0]);
			expect(JSON.stringify(frames)).not.toContain("responseReplay");
			expect(sockets).toHaveLength(1);
			expect(getOpenAIResponsesWebSocketDebugStats("stable-ws-replay-identity")?.connectionsReused).toBe(1);
			if (transport !== "websocket") {
				expect(results[0].responseCheckpoint).toBeDefined();
				expect(results[1].responseCheckpoint?.scopeHash).toBe(results[0].responseCheckpoint?.scopeHash);
				expect(results[1].responseCheckpoint?.requestHash).toBe(results[0].responseCheckpoint?.requestHash);
			}
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("leaves a nonstreaming background body at the existing HTTP path", async () => {
		const bodies: unknown[] = [];
		for (const responseReplay of [undefined, true]) {
			const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
				bodies.push(await new Request(input, init).json());
				return Response.json({ ...response, status: "completed" });
			});
			const result = await consume(fetchMock, {
				responseReplay,
				onPayload: (payload) => ({ ...background(payload), stream: false }),
			});
			expect(result.message.stopReason).toBe("error");
			expect(result.message.errorMessage).not.toContain("require explicit SSE");
			expect(result.message.diagnostics).toBeUndefined();
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
		expect(bodies[1]).toEqual(bodies[0]);
	});

	it("preserves explicit background store:false and the configured HTTP POST retry", async () => {
		let posts = 0;
		const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
			expect(await new Request(input, init).json()).toMatchObject({ background: true, store: false });
			return ++posts === 1
				? new Response(JSON.stringify({ error: { message: "503 busy", type: "server_error" } }), {
						status: 503,
						headers: { "content-type": "application/json" },
					})
				: sse(wire(events()));
		});
		const result = await consume(fetchMock, {
			maxRetries: 1,
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), background: true, store: false }),
		});
		expect(result.message.stopReason).toBe("toolUse");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each(["create", "resume"])(
		"aborts during %s and cancels only an identified task with an independent signal",
		async (phase) => {
			const controller = new AbortController();
			let ready = () => {};
			const pending = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const requests: Request[] = [];
			const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				if (request.url.endsWith("/cancel")) {
					expect(controller.signal.aborted).toBe(true);
					expect(request.signal.aborted).toBe(false);
					return Response.json({ id: "resp_background", status: "cancelled" });
				}
				if (phase === "resume" && request.method === "POST") return sse(wire(events().slice(0, 7)));
				ready();
				return new Promise<Response>((_resolve, reject) => {
					request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
				});
			});
			let calls = 0;
			const resultPromise = retryAssistantCall(
				async () => {
					calls++;
					return (await consume(fetchMock, { signal: controller.signal, maxRetries: 3 })).message;
				},
				{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
				controller.signal,
			);
			await pending;
			controller.abort();
			const result = await resultPromise;
			expect(result.stopReason).toBe("aborted");
			expect(calls).toBe(1);
			expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual(
				phase === "create"
					? [["POST", "/v1/responses"]]
					: [
							["POST", "/v1/responses"],
							["GET", "/v1/responses/resp_background"],
							["POST", "/v1/responses/resp_background/cancel"],
						],
			);
		},
	);

	it("cancels when abort occurs in the first identity callback before parser acknowledgement", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
			const request = new Request(input, init);
			return request.url.endsWith("/cancel")
				? Response.json({ id: "resp_background", status: "cancelled" })
				: sse(wire(events()));
		});
		const result = await consume(fetchMock, {
			signal: controller.signal,
			onProviderStreamEvent: () => {
				controller.abort();
			},
		});
		expect(result.message.stopReason).toBe("aborted");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/resp_background/cancel");
	});

	it("reports an unconfirmed cancel without claiming remote cancellation", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
			new Request(input, init).url.endsWith("/cancel")
				? Response.json({ id: "resp_background", status: "in_progress" })
				: sse(wire(events())),
		);
		let calls = 0;
		const result = await retryAssistantCall(
			async () => {
				calls++;
				return (
					await consume(fetchMock, {
						signal: controller.signal,
						onProviderStreamEvent: () => {
							controller.abort();
						},
					})
				).message;
			},
			{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
			controller.signal,
		);
		expect(result.stopReason).toBe("aborted");
		expect(calls).toBe(1);
		expect(result.diagnostics).toContainEqual({
			type: "provider_response_cancel_failed",
			timestamp: expect.any(Number),
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("bounds failed cancellation without replacing the primary abort or retrying cancel", async () => {
		vi.useFakeTimers();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			expect(milliseconds).toBe(3000);
			const deadline = new AbortController();
			setTimeout(() => deadline.abort(), milliseconds);
			return deadline.signal;
		});
		const controller = new AbortController();
		let cancelReady = () => {};
		const pendingCancel = new Promise<void>((resolve) => {
			cancelReady = resolve;
		});
		const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.endsWith("/cancel")) return sse(wire(events()));
			expect(request.signal.aborted).toBe(false);
			cancelReady();
			return new Promise<Response>((_resolve, reject) => {
				request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
			});
		});
		let settled = false;
		const resultPromise = consume(fetchMock, {
			signal: controller.signal,
			onProviderStreamEvent: () => {
				controller.abort();
			},
		});
		void resultPromise.then(() => {
			settled = true;
		});
		await pendingCancel;
		await vi.advanceTimersByTimeAsync(2999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const result = await resultPromise;
		expect(result.message.stopReason).toBe("aborted");
		expect(result.message.errorMessage).toContain("aborted");
		expect(result.message.diagnostics).toContainEqual({
			type: "provider_response_cancel_failed",
			timestamp: expect.any(Number),
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
