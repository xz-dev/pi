import type { CompactedResponse, ResponseInput } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	type OpenAIResponsesCheckpoint,
	type OpenAIResponsesCompactionAdapter,
	responsesCompactionAdapter,
	stream as streamOpenAIResponses,
} from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { OpenAIResponsesCompactionOptions as RootCompactionOptions } from "../src/index.ts";
import { type Context, type Model, OPENAI_RESPONSES_COMPACTION_ADAPTER } from "../src/types.ts";

const STABLE_COMPACT_ADAPTER = OPENAI_RESPONSES_COMPACTION_ADAPTER;

type NativeCompactionModel = Model<"openai-responses">;

function stableCompactionAdapter(): OpenAIResponsesCompactionAdapter {
	expect(responsesCompactionAdapter.id).toBe(STABLE_COMPACT_ADAPTER);
	return responsesCompactionAdapter;
}

function optedInModel(
	realm = "provider-owned:openai-primary",
	overrides: Partial<NativeCompactionModel> = {},
	modelFamily = "gpt-5",
): NativeCompactionModel {
	const base = getModel("openai", "gpt-5.4");
	return {
		...base,
		...overrides,
		compat: {
			...base.compat,
			...overrides.compat,
			responsesCompaction: { adapter: STABLE_COMPACT_ADAPTER, realm, modelFamily },
		},
	};
}

const canonicalOutput = [
	{
		type: "message",
		id: "msg_retained",
		role: "assistant",
		status: "completed",
		content: [
			{
				type: "output_text",
				text: "retained ordinary output",
				annotations: [],
				future_content_field: "preserved",
			},
		],
		future_item_field: { preserved: true },
	},
	{
		type: "compaction",
		id: "cmp_opaque_1",
		encrypted_content: "opaque-provider-checkpoint",
		created_by: "provider",
		extra_future_field: { preserved: true },
	},
] as unknown as CompactedResponse["output"];

const compactResponse = {
	id: "resp_compact_1",
	created_at: 1_753_000_000,
	object: "response.compaction",
	output: canonicalOutput,
	usage: {
		input_tokens: 1_000,
		input_tokens_details: { cached_tokens: 100 },
		output_tokens: 80,
		output_tokens_details: { reasoning_tokens: 12 },
		total_tokens: 1_080,
	},
	future_top_level_field: "preserved",
} as unknown as CompactedResponse;

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", "x-request-id": "req_compact_1", ...headers },
	});
}

function checkpoint(identity: OpenAIResponsesCheckpoint["identity"]): OpenAIResponsesCheckpoint {
	return {
		type: "provider_checkpoint",
		version: 1,
		identity,
		payload: structuredClone(compactResponse),
	};
}

function defaultCheckpointIdentity(): OpenAIResponsesCheckpoint["identity"] {
	return {
		adapter: STABLE_COMPACT_ADAPTER,
		realm: "provider-owned:openai-primary",
		provider: "openai",
		endpoint: "https://api.openai.com/v1",
		modelFamily: "gpt-5",
	};
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function consume(stream: ReturnType<typeof streamOpenAIResponses>): Promise<void> {
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") return;
	}
}

describe("OpenAI Responses stable native compaction", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exports only the supported compact request controls from the root type surface", () => {
		expectTypeOf<keyof RootCompactionOptions>().toEqualTypeOf<
			| "apiKey"
			| "env"
			| "headers"
			| "signal"
			| "timeoutMs"
			| "maxRetries"
			| "maxRetryDelayMs"
			| "transformHeaders"
			| "onPayload"
			| "onResponse"
		>();
	});

	it.each([
		["custom Responses proxy", { provider: "custom-proxy", baseUrl: "https://proxy.example.test/v1" }],
		["built-in OpenAI model", {}],
	])("requires explicit stable-adapter identity before contacting a %s", async (_name, overrides) => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const model: NativeCompactionModel = {
			...getModel("openai", "gpt-5.4"),
			...overrides,
			compat: {},
		};

		await expect(stableCompactionAdapter().compact(model, { messages: [] }, { apiKey: "proxy-key" })).rejects.toThrow(
			/openai-responses-compact-v1|native compaction|not supported/i,
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("posts complete rendered input, snapshots compatibility, and preserves opaque JSON", async () => {
		let capturedUrl: string | undefined;
		let capturedInit: RequestInit | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			capturedUrl = input instanceof Request ? input.url : String(input);
			capturedInit = init;
			return jsonResponse(compactResponse);
		});
		const model = optedInModel("provider-owned:proxy-account-a", {
			provider: "custom-proxy",
			baseUrl: "https://PROXY.example.test:443/v1/",
		});

		const result = await stableCompactionAdapter().compact(
			model,
			{
				systemPrompt: "system instructions",
				messages: [{ role: "user", content: "compact this", timestamp: 1 }],
			},
			{
				apiKey: "proxy-key",
				headers: { "x-proxy-route": "account-a" },
				maxRetries: 0,
			},
		);

		expect(capturedUrl).toBe("https://proxy.example.test/v1/responses/compact");
		expect(capturedInit?.method).toBe("POST");
		expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Bearer proxy-key");
		expect(new Headers(capturedInit?.headers).get("x-proxy-route")).toBe("account-a");
		expect(requestBody(capturedInit)).toEqual({
			model: model.id,
			input: [
				{ role: "developer", content: "system instructions" },
				{ role: "user", content: [{ type: "input_text", text: "compact this" }] },
			],
		});
		expect(requestBody(capturedInit)).not.toMatchObject({
			stream: expect.anything(),
			store: expect.anything(),
			context_management: expect.anything(),
			previous_response_id: expect.anything(),
		});
		expect(result).toMatchObject({
			type: "provider_checkpoint",
			version: 1,
			identity: {
				adapter: STABLE_COMPACT_ADAPTER,
				realm: "provider-owned:proxy-account-a",
				provider: "custom-proxy",
				endpoint: "https://proxy.example.test/v1",
				modelFamily: "gpt-5",
			},
			usage: {
				input: 900,
				output: 80,
				cacheRead: 100,
				cacheWrite: 0,
				totalTokens: 1_080,
				reasoning: 12,
			},
		});
		expect(result.payload).toEqual(compactResponse);
		expect(result.payload).not.toBe(compactResponse);
		expect(result.payload.output).toEqual(canonicalOutput);
		expect(result.payload.output).not.toBe(canonicalOutput);
		expect(JSON.stringify(result)).not.toContain("proxy-key");
	});

	it("supports header-only authorization and observes the final response", async () => {
		let authorization: string | null = null;
		const observed: Array<{ status: number; requestId: string | undefined }> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			authorization = new Headers(init?.headers).get("authorization");
			return jsonResponse(compactResponse);
		});

		await stableCompactionAdapter().compact(
			optedInModel(),
			{ messages: [] },
			{
				headers: { Authorization: "Bearer header-only-secret" },
				onResponse: (response) => {
					observed.push({ status: response.status, requestId: response.headers["x-request-id"] });
				},
			},
		);

		expect(authorization).toBe("Bearer header-only-secret");
		expect(observed).toEqual([{ status: 200, requestId: "req_compact_1" }]);
	});

	it("uses provider retry bounds with fresh SDK requests", async () => {
		const retryCounts: Array<string | null> = [];
		let calls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			calls += 1;
			retryCounts.push(new Headers(init?.headers).get("x-stainless-retry-count"));
			if (calls === 1) {
				return jsonResponse({ error: { message: "temporarily unavailable" } }, 503, { "retry-after-ms": "1" });
			}
			return jsonResponse(compactResponse);
		});

		const result = await stableCompactionAdapter().compact(
			optedInModel(),
			{ messages: [] },
			{ apiKey: "test-key", maxRetries: 1, maxRetryDelayMs: 100 },
		);

		expect(calls).toBe(2);
		expect(retryCounts).toEqual(["0", "0"]);
		expect(result.payload.output).toEqual(canonicalOutput);
	});

	it("rejects a provider-requested delay above maxRetryDelayMs without retrying", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({ error: { message: "slow down" } }, 503, { "retry-after-ms": "120000" }));

		await expect(
			stableCompactionAdapter().compact(
				optedInModel(),
				{ messages: [] },
				{
					apiKey: "test-key",
					maxRetries: 1,
					maxRetryDelayMs: 100,
				},
			),
		).rejects.toThrow(/requested 120s retry delay|max.*1s/i);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("applies timeoutMs to the compact request", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async (_input, init) =>
				await new Promise<Response>((_resolve, reject) => {
					const rejectForAbort = () => reject(init?.signal?.reason ?? new DOMException("Aborted", "AbortError"));
					if (init?.signal?.aborted) rejectForAbort();
					else init?.signal?.addEventListener("abort", rejectForAbort, { once: true });
				}),
		);

		await expect(
			stableCompactionAdapter().compact(
				optedInModel(),
				{ messages: [] },
				{
					apiKey: "test-key",
					maxRetries: 0,
					timeoutMs: 5,
				},
			),
		).rejects.toThrow(/timed? out|timeout/i);
	});

	it("normalizes final provider errors without retaining configured credentials", async () => {
		const secret = "Bearer header-only-secret";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ error: { message: `unavailable; reflected=${secret}` } }, 503),
		);

		let caught: unknown;
		try {
			await stableCompactionAdapter().compact(
				optedInModel(),
				{ messages: [] },
				{
					headers: { Authorization: secret },
					maxRetries: 0,
				},
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toMatch(/OpenAI API error|503|unavailable/i);
		expect((caught as Error).message).not.toContain(secret);
		expect((caught as Error).cause).toBeUndefined();
		expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught as object))).not.toContain(secret);
	});

	it("preserves the exact abort reason", async () => {
		const controller = new AbortController();
		const reason = new DOMException("Cancelled by caller", "AbortError");
		let observedSignal: AbortSignal | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async (_input, init) =>
				await new Promise<Response>((_resolve, reject) => {
					observedSignal = init?.signal ?? undefined;
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
						{ once: true },
					);
				}),
		);

		const pending = stableCompactionAdapter().compact(
			optedInModel(),
			{ messages: [{ role: "user", content: "do not commit", timestamp: 1 }] },
			{ apiKey: "test-key", signal: controller.signal, maxRetries: 0 },
		);
		await vi.waitFor(() => expect(observedSignal).toBeDefined());
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
		expect(observedSignal?.aborted).toBe(true);
	});

	it("snapshots compatibility before an in-flight request can mutate the model", async () => {
		let release: (() => void) | undefined;
		let fetchStarted = false;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			fetchStarted = true;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return jsonResponse(compactResponse);
		});
		const model = optedInModel("provider-owned:account-a", {
			provider: "custom-proxy",
			baseUrl: "https://proxy.example.test/v1",
		});

		const pending = stableCompactionAdapter().compact(model, { messages: [] }, { apiKey: "old-token" });
		await vi.waitFor(() => expect(fetchStarted).toBe(true));
		const declaredIdentity = model.compat?.responsesCompaction;
		expect(declaredIdentity).toBeDefined();
		declaredIdentity!.realm = "provider-owned:mutated";
		declaredIdentity!.modelFamily = "mutated-family";
		model.provider = "mutated-provider";
		model.baseUrl = "https://mutated.example.test/v9";
		release?.();

		const result = await pending;
		expect(result.identity).toEqual({
			adapter: STABLE_COMPACT_ADAPTER,
			realm: "provider-owned:account-a",
			provider: "custom-proxy",
			endpoint: "https://proxy.example.test/v1",
			modelFamily: "gpt-5",
		});
	});

	it.each([
		["provider", { provider: "another-provider" }, "gpt-5"],
		["endpoint", { baseUrl: "https://proxy.example.test/v2" }, "gpt-5"],
		["model family", {}, "gpt-6"],
	] as const)("rejects checkpoint replay after a %s mismatch", async (_name, overrides, modelFamily) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(compactResponse));
		const source = optedInModel("provider-owned:account-a", {
			provider: "custom-proxy",
			baseUrl: "https://proxy.example.test/v1/",
		});
		const created = await stableCompactionAdapter().compact(source, { messages: [] }, { apiKey: "test-key" });
		const target = optedInModel(
			"provider-owned:account-a",
			{
				provider: "custom-proxy",
				baseUrl: "https://proxy.example.test/v1////",
				...overrides,
			},
			modelFamily,
		);

		expect(() => stableCompactionAdapter().renderCheckpoint(target, created)).toThrow(/identity|compatible/i);
	});

	it("keeps credential rotation compatible but separates provider-owned realms", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(compactResponse));
		const accountA = optedInModel("provider-owned:account-a");
		const accountB = optedInModel("provider-owned:account-b");

		const beforeRotation = await stableCompactionAdapter().compact(
			accountA,
			{ messages: [] },
			{ apiKey: "old-token" },
		);
		vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(compactResponse));
		const afterRotation = await stableCompactionAdapter().compact(
			accountA,
			{ messages: [] },
			{ apiKey: "new-token" },
		);
		vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(compactResponse));
		const otherRealm = await stableCompactionAdapter().compact(accountB, { messages: [] }, { apiKey: "new-token" });

		expect(beforeRotation.identity).toEqual(afterRotation.identity);
		expect(otherRealm.identity).not.toEqual(afterRotation.identity);
		expect(JSON.stringify([beforeRotation, afterRotation, otherRealm])).not.toMatch(/old-token|new-token/);
	});

	it("prepends explicit provider state to a normal Responses request without a context message", async () => {
		let capturedInput: unknown;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedInput = requestBody(init).input;
			return new Response(
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						id: "resp_normal",
						status: "completed",
						output: [],
						usage: {
							input_tokens: 1,
							output_tokens: 0,
							total_tokens: 1,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		const model = optedInModel();
		const stored = checkpoint(defaultCheckpointIdentity());
		const context: Context = {
			messages: [{ role: "user", content: "suffix", timestamp: 1 }],
			providerState: { type: "openai_responses_provider_state", checkpoint: stored },
		};

		await consume(streamOpenAIResponses(model, context, { apiKey: "test-key", maxRetries: 0 }));

		expect(capturedInput).toEqual([
			...canonicalOutput,
			{ role: "user", content: [{ type: "input_text", text: "suffix" }] },
		]);
		expect(context.messages).toEqual([{ role: "user", content: "suffix", timestamp: 1 }]);
	});

	it("returns detached replay output without changing the canonical checkpoint", () => {
		const model = optedInModel();
		const stored = checkpoint(defaultCheckpointIdentity());

		const first = stableCompactionAdapter().renderCheckpoint(model, stored);
		(first[0] as unknown as Record<string, unknown>).type = "mutated";
		first.push({ type: "future_item", nested: { changed: true } } as unknown as ResponseInput[number]);
		const second = stableCompactionAdapter().renderCheckpoint(model, stored);

		expect(second).toEqual(canonicalOutput);
		expect(stored.payload.output).toEqual(canonicalOutput);
		expect(second).not.toBe(stored.payload.output);
	});

	it("rejects unsupported non-JSON checkpoint values instead of dropping them", () => {
		const model = optedInModel();
		const stored = checkpoint(defaultCheckpointIdentity());
		(stored.payload.output[0] as unknown as Record<string, unknown>).unsupported = undefined;

		expect(() => stableCompactionAdapter().renderCheckpoint(model, stored)).toThrow(/JSON|unsupported/i);
	});

	it.each([
		["null envelope", null],
		["primitive envelope", 42],
		["missing id", { ...compactResponse, id: undefined }],
		["invalid created_at", { ...compactResponse, created_at: "now" }],
		["wrong object", { ...compactResponse, object: "response" }],
		["missing usage", { ...compactResponse, usage: undefined }],
		[
			"missing required usage counter",
			{ ...compactResponse, usage: { ...compactResponse.usage, input_tokens: undefined } },
		],
		["invalid usage number", { ...compactResponse, usage: { ...compactResponse.usage, input_tokens: "100" } }],
		["negative usage number", { ...compactResponse, usage: { ...compactResponse.usage, output_tokens: -1 } }],
		[
			"missing usage details",
			{ ...compactResponse, usage: { ...compactResponse.usage, output_tokens_details: undefined } },
		],
		["empty output", { ...compactResponse, output: [] }],
		["null output item", { ...compactResponse, output: [null] }],
		["primitive output item", { ...compactResponse, output: ["message"] }],
		["missing output item type", { ...compactResponse, output: [{ id: "future" }] }],
		["empty output item type", { ...compactResponse, output: [{ type: "  " }] }],
	])("rejects malformed %s with a stable adapter error", async (_name, response) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(response));

		await expect(
			stableCompactionAdapter().compact(optedInModel(), { messages: [] }, { apiKey: "test-key", maxRetries: 0 }),
		).rejects.toThrow(/^Invalid Responses compact response:/);
	});

	it("accepts and preserves unknown JSON fields alongside complete usage counters", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				...compactResponse,
				usage: { ...compactResponse.usage, future_usage_field: { preserved: true } },
			}),
		);

		const result = await stableCompactionAdapter().compact(optedInModel(), { messages: [] }, { apiKey: "test-key" });

		expect(result.payload).toMatchObject({ usage: { future_usage_field: { preserved: true } } });
		expect(result.usage).toMatchObject({ input: 900, output: 80, cacheRead: 100, totalTokens: 1_080 });
	});

	it("uses system role when developer role is unsupported", async () => {
		let captured: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			captured = requestBody(init);
			return jsonResponse(compactResponse);
		});
		const model = optedInModel("provider-owned:no-developer", { compat: { supportsDeveloperRole: false } });

		await stableCompactionAdapter().compact(
			model,
			{ systemPrompt: "system instructions", messages: [] },
			{ apiKey: "test-key" },
		);

		expect(captured?.input).toEqual([{ role: "system", content: "system instructions" }]);
	});

	it("renders deferred and grammar-tool history identically to normal Responses input", async () => {
		const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			bodies.push({ url, body: requestBody(init) });
			if (url.endsWith("/responses/compact")) return jsonResponse(compactResponse);
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const model = optedInModel("provider-owned:grammar", {
			compat: { supportsOpenAIGrammarTools: true, supportsToolSearch: true },
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "run it", timestamp: 1 },
				{
					role: "assistant",
					api: "openai-responses",
					provider: model.provider,
					model: model.id,
					content: [
						{
							type: "toolCall",
							id: "call_1|ctc_1",
							name: "base_tool",
							arguments: { payload: "abc" },
						},
					],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1|ctc_1",
					toolName: "base_tool",
					content: [{ type: "text", text: "done" }],
					addedToolNames: ["late_tool"],
					isError: false,
					timestamp: 3,
				},
			],
			tools: ["base_tool", "late_tool"].map((name) => ({
				name,
				description: `${name} description`,
				parameters: Type.Object({ payload: Type.String() }),
				constrainedSampling: { type: "grammar" as const, variants: { openai_lark: "start: /[a-z]+/" } },
			})),
		};

		await consume(streamOpenAIResponses(model, context, { apiKey: "test-key", maxRetries: 0 }));
		await stableCompactionAdapter().compact(model, context, { apiKey: "test-key", maxRetries: 0 });

		const normal = bodies.find(({ url }) => url.endsWith("/responses"))?.body.input;
		const compact = bodies.find(({ url }) => url.endsWith("/responses/compact"))?.body.input;
		expect(compact).toEqual(normal);
		expect(compact).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "custom_tool_call", name: "base_tool", input: "abc" }),
				expect.objectContaining({ type: "custom_tool_call_output", call_id: "call_1" }),
				expect.objectContaining({ type: "tool_search_call" }),
				expect.objectContaining({ type: "tool_search_output" }),
			]),
		);
	});
});
