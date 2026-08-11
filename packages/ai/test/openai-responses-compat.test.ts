import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compactAzureOpenAIResponses,
	getAzureOpenAIResponsesCompactionIdentity,
} from "../src/api/azure-openai-responses.ts";
import {
	compactOpenAICodexResponses,
	getOpenAICodexResponsesCompactionIdentity,
	replayOpenAICodexResponsesCompaction,
} from "../src/api/openai-codex-responses.ts";
import {
	compactOpenAIResponses,
	replayOpenAIResponsesCompaction,
	stream as streamOpenAIResponses,
} from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

interface CapturedResponsesPayload {
	input?: unknown[];
	prompt_cache_key?: string;
	session_id?: string;
	tools?: Array<{ name?: string; strict?: boolean }>;
}

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);

	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key?.toLowerCase() === lowerName);
		return match?.[1] ?? null;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

async function captureOpenAIResponseHeaders(
	options: Parameters<typeof streamOpenAIResponses>[2],
	model: Model<"openai-responses"> = getModel("openai", "gpt-5.4"),
): Promise<{
	sessionId: string | null;
	clientRequestId: string | null;
	xSessionId: string | null;
}> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		xSessionId: null as string | null,
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		captured.xSessionId = getHeader(init?.headers, "x-session-id");
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAIResponses(
		model,
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key", ...options },
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("compacts full input and replays the returned output as replacement history", async () => {
		const requests: Array<{ url: string; payload: CapturedResponsesPayload }> = [];
		const compactOutput = [
			{ role: "user", content: [{ type: "input_text", text: "retained" }] },
			{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			requests.push({ url, payload: JSON.parse(String(init?.body)) as CapturedResponsesPayload });
			if (url.endsWith("/responses/compact")) {
				return new Response(
					JSON.stringify({
						id: "resp_compact_1",
						created_at: 1,
						object: "response.compaction",
						output: compactOutput,
						usage: {
							input_tokens: 12,
							input_tokens_details: { cached_tokens: 2 },
							output_tokens: 3,
							output_tokens_details: { reasoning_tokens: 1 },
							total_tokens: 15,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				`data: ${JSON.stringify({
					type: "response.completed",
					sequence_number: 0,
					response: { id: "resp_1", status: "completed", output: [] },
				})}\n\ndata: [DONE]\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		const model = getModel("openai", "gpt-5.4");
		const compaction = await compactOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "old", timestamp: 1 }],
			},
			{ apiKey: "test-key" },
		);
		const stream = replayOpenAIResponsesCompaction(
			model,
			compaction,
			{ messages: [{ role: "user", content: "new", timestamp: 2 }] },
			{ apiKey: "test-key" },
		);
		await stream.result();

		expect(requests[0]).toMatchObject({
			url: "https://api.openai.com/v1/responses/compact",
			payload: {
				model: model.id,
				input: [
					{ role: "developer", content: "sys" },
					{ role: "user", content: [{ type: "input_text", text: "old" }] },
				],
			},
		});
		expect(requests[1]?.payload.input).toEqual([
			...compactOutput,
			{ role: "user", content: [{ type: "input_text", text: "new" }] },
		]);
		expect(compaction.identity).toEqual({
			api: "openai-responses",
			provider: "openai",
			model: model.id,
			endpoint: "https://api.openai.com/v1",
		});
		expect(compaction.usage).toMatchObject({ input: 10, output: 3, cacheRead: 2, totalTokens: 15 });

		await compactOpenAIResponses(
			model,
			{ messages: [{ role: "user", content: "later", timestamp: 3 }] },
			{ apiKey: "test-key", previous: compaction },
		);
		expect(requests[2]?.payload.input).toEqual([
			...compactOutput,
			{ role: "user", content: [{ type: "input_text", text: "later" }] },
		]);
	});

	it("constructs Azure compaction from effective env configuration", async () => {
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		let requestUrl = "";
		let requestHeaders: Headers | undefined;
		let responseCallbacks = 0;
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input instanceof Request ? input.url : String(input);
			requestHeaders = new Headers(init?.headers);
			return new Response(
				JSON.stringify({
					output: [],
					usage: {
						input_tokens: 1,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens: 1,
						output_tokens_details: { reasoning_tokens: 0 },
						total_tokens: 2,
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const env = {
			AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com/openai/v1",
			AZURE_OPENAI_API_VERSION: "2026-01-01-preview",
			AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=deployment-a`,
		};
		const result = await compactAzureOpenAIResponses(
			model,
			{ messages: [{ role: "user", content: "old", timestamp: 1 }] },
			{
				apiKey: "azure-key",
				env,
				fetch,
				onResponse: () => {
					responseCallbacks++;
				},
			},
		);

		expect(requestUrl).toBe(
			"https://resource.openai.azure.com/openai/v1/responses/compact?api-version=2026-01-01-preview",
		);
		expect(requestHeaders?.get("api-key")).toBe("azure-key");
		expect(requestHeaders?.get("authorization")).toBeNull();
		expect(result.identity).toEqual({
			api: "azure-openai-responses",
			provider: model.provider,
			model: model.id,
			endpoint: "https://resource.openai.azure.com/openai/v1/responses/compact",
			deployment: "deployment-a",
			apiVersion: "2026-01-01-preview",
		});
		expect(responseCallbacks).toBe(1);
		expect(
			getAzureOpenAIResponsesCompactionIdentity(model, { env: { ...env, AZURE_OPENAI_API_VERSION: "v2" } }),
		).not.toEqual(result.identity);
	});

	it("constructs Codex compaction with auth, callbacks, and bounded retry", async () => {
		const baseModel = getModel("openai", "gpt-5.4");
		const model: Model<"openai-codex-responses"> = {
			...baseModel,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://codex.example/backend-api",
		};
		const token = `x.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }))}.x`;
		const statuses: number[] = [];
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const attempt = fetch.mock.calls.length;
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${token}`);
			expect(headers.get("chatgpt-account-id")).toBe("acct");
			if (attempt === 1) return new Response("busy", { status: 503, headers: { "retry-after-ms": "1" } });
			return new Response(
				JSON.stringify({
					output: [],
					usage: {
						input_tokens: 1,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens: 1,
						output_tokens_details: { reasoning_tokens: 0 },
						total_tokens: 2,
					},
				}),
				{ status: 200 },
			);
		});
		const result = await compactOpenAICodexResponses(
			model,
			{ messages: [{ role: "user", content: "old", timestamp: 1 }] },
			{
				apiKey: token,
				fetch,
				maxRetries: 1,
				maxRetryDelayMs: 10,
				timeoutMs: 1000,
				onResponse: (response) => {
					statuses.push(response.status);
				},
			},
		);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(statuses).toEqual([503, 200]);
		expect(result.identity).toEqual(getOpenAICodexResponsesCompactionIdentity(model));
		expect(result.identity.endpoint).toBe("https://codex.example/backend-api/codex/responses/compact");
	});

	it("includes the real system prompt as Codex compact instructions and preserves it on replay", async () => {
		const baseModel = getModel("openai", "gpt-5.4");
		const model: Model<"openai-codex-responses"> = {
			...baseModel,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://codex.example/backend-api",
		};
		const token = `x.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }))}.x`;
		const agentSystemPrompt = "You are the real coding agent. Never use the helper default.";
		let compactBody: { instructions?: string; input?: unknown } | undefined;
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			compactBody = JSON.parse(String(init?.body ?? "{}")) as { instructions?: string; input?: unknown };
			return new Response(
				JSON.stringify({
					output: [{ role: "user", content: [{ type: "input_text", text: "kept" }] }],
					usage: {
						input_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens: 1,
						output_tokens_details: { reasoning_tokens: 0 },
						total_tokens: 3,
					},
				}),
				{ status: 200 },
			);
		});

		const compaction = await compactOpenAICodexResponses(
			model,
			{
				systemPrompt: agentSystemPrompt,
				messages: [{ role: "user", content: "old history", timestamp: 1 }],
			},
			{ apiKey: token, fetch },
		);

		expect(compactBody?.instructions).toBe(agentSystemPrompt);
		expect(compactBody?.instructions).not.toBe("You are a helpful assistant.");
		expect(JSON.stringify(compactBody?.input ?? [])).not.toContain(agentSystemPrompt);

		let replayPayload: { instructions?: string; input?: unknown[] } | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		const stream = replayOpenAICodexResponsesCompaction(
			model,
			compaction,
			{
				systemPrompt: agentSystemPrompt,
				messages: [{ role: "user", content: "after compact", timestamp: 2 }],
			},
			{
				apiKey: token,
				onPayload: (payload) => {
					replayPayload = payload as { instructions?: string; input?: unknown[] };
				},
			},
		);
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(replayPayload?.instructions).toBe(agentSystemPrompt);
		expect(replayPayload?.instructions).not.toBe("You are a helpful assistant.");
	});

	it("omits Codex compact instructions when systemPrompt is absent and does not invent the helper default", async () => {
		const baseModel = getModel("openai", "gpt-5.4");
		const model: Model<"openai-codex-responses"> = {
			...baseModel,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://codex.example/backend-api",
		};
		const token = `x.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }))}.x`;
		let compactBody: { instructions?: string } | undefined;
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			compactBody = JSON.parse(String(init?.body ?? "{}")) as { instructions?: string };
			return new Response(
				JSON.stringify({
					output: [],
					usage: {
						input_tokens: 1,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens: 0,
						output_tokens_details: { reasoning_tokens: 0 },
						total_tokens: 1,
					},
				}),
				{ status: 200 },
			);
		});

		await compactOpenAICodexResponses(
			model,
			{ messages: [{ role: "user", content: "old", timestamp: 1 }] },
			{ apiKey: token, fetch },
		);

		expect(compactBody).not.toHaveProperty("instructions");
	});

	it("rejects replay across a different compatible endpoint identity", async () => {
		const model = getModel("openai", "gpt-5.4");
		const compaction = {
			identity: {
				api: "openai-responses" as const,
				provider: model.provider,
				model: model.id,
				endpoint: "https://first.example/v1",
			},
			output: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		expect(() =>
			replayOpenAIResponsesCompaction({ ...model, baseUrl: "https://second.example/v1" }, compaction, {
				messages: [],
			}),
		).toThrow("provider identity");
	});

	it("propagates the caller's abort reason from remote compaction", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled by caller");
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			await new Promise((resolve) => init?.signal?.addEventListener("abort", resolve, { once: true }));
			throw new DOMException("aborted", "AbortError");
		});
		const pending = compactOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			{ messages: [{ role: "user", content: "old", timestamp: 1 }] },
			{ apiKey: "test-key", signal: controller.signal },
		);
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
	});

	it("propagates the caller's abort reason from Codex remote compaction", async () => {
		const baseModel = getModel("openai", "gpt-5.4");
		const model: Model<"openai-codex-responses"> = {
			...baseModel,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://codex.example/backend-api",
		};
		const token = `x.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }))}.x`;
		const controller = new AbortController();
		const reason = new Error("codex cancelled by caller");
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			await new Promise((resolve) => init?.signal?.addEventListener("abort", resolve, { once: true }));
			throw new DOMException("aborted", "AbortError");
		});
		const pending = compactOpenAICodexResponses(
			model,
			{ messages: [{ role: "user", content: "old", timestamp: 1 }] },
			{ apiKey: token, fetch, signal: controller.signal, maxRetries: 2 },
		);
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
		expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
	});

	it("omits reasoning when no reasoning is requested", async () => {
		const model = getModel("github-copilot", "gpt-5-mini");
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload).not.toMatchObject({
			reasoning: expect.anything(),
		});
	});

	it("forwards required tool choice", async () => {
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			{
				messages: [
					{
						role: "user",
						content: "Do not call ping. Respond with text instead.",
						timestamp: Date.now(),
					},
				],
				tools: [
					{
						name: "ping",
						description: "Ping",
						parameters: Type.Object({ value: Type.String() }),
					},
				],
			},
			{
				apiKey: "test-key",
				toolChoice: "required",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			tool_choice: "required",
			tools: [expect.objectContaining({ name: "ping" })],
		});
	});

	it("sets strict mode explicitly for Cloudflare OpenAI Responses tools", async () => {
		const model = getModel("cloudflare-ai-gateway", "gpt-5.6-sol");
		let capturedPayload: CapturedResponsesPayload | undefined;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				messages: [{ role: "user", content: "Use a tool.", timestamp: Date.now() }],
				tools: [
					{
						name: "ordinary",
						description: "An ordinary tool",
						parameters: Type.Object({
							path: Type.String(),
							offset: Type.Optional(Type.Number()),
						}),
					},
					{
						name: "constrained",
						description: "A constrained tool",
						parameters: Type.Object({ value: Type.String() }),
						constrainedSampling: { type: "json_schema", strict: "prefer" },
					},
				],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(model.compat?.supportsStrictMode).toBe(true);
		expect(capturedPayload?.tools).toEqual([
			expect.objectContaining({ name: "ordinary", strict: false }),
			expect.objectContaining({ name: "constrained", strict: true }),
		]);
	});

	it.each([
		"gpt-5.1",
		"gpt-5.2",
		"gpt-5.3-codex",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.4-nano",
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
	] as const)("sends none reasoning effort for OpenAI %s when no reasoning is requested", async (modelId) => {
		const model = getModel("openai", modelId);
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			reasoning: { effort: "none" },
		});
	});

	it.each(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"] as const)(
		"omits reasoning effort for OpenAI %s when off is unsupported",
		async (modelId) => {
			const model = getModel("openai", modelId);
			let capturedPayload: unknown;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			expect(capturedPayload).not.toMatchObject({
				reasoning: expect.anything(),
			});
		},
	);

	it("sets cache-affinity headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const sessionId = "x".repeat(67);
		let capturedPayload: Pick<CapturedResponsesPayload, "prompt_cache_key"> | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				sessionId,
				onPayload: (payload) => {
					capturedPayload = payload as Pick<CapturedResponsesPayload, "prompt_cache_key">;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("sets cache-affinity headers for proxy OpenAI Responses requests with a sessionId", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("uses OpenRouter session-affinity header when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openrouter" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-proxy");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("auto-detects OpenRouter session-affinity header for OpenRouter Responses endpoints", async () => {
		const openRouterModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-openrouter",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			openRouterModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-openrouter");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-openrouter");
	});

	it("uses OpenAI no-session format when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-proxy");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("uses OpenAI no-session format for OpenCode Responses models", async () => {
		const model = getModel("opencode", "gpt-5.4");
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-opencode",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			model,
		);

		expect(model.compat?.sessionAffinityFormat).toBe("openai-nosession");
		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-opencode");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.prompt_cache_key).toBe("session-opencode");
	});

	it("can omit OpenAI session_id header while preserving other affinity data", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-123",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-123");
		expect(capturedPayload?.prompt_cache_key).toBe("session-123");
	});

	it("lets explicit headers override the default OpenAI cache-affinity headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured.sessionId).toBe("override-session");
		expect(captured.clientRequestId).toBe("override-request");
	});

	it("omits OpenAI cache-affinity headers when cacheRetention is none", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it.each([
		["gpt-5.4", "priority", 2],
		["gpt-5.5", "priority", 2.5],
		["gpt-5.5", "flex", 0.5],
	] as const)("applies %s %s service-tier cost multiplier", async (modelId, serviceTier, multiplier) => {
		const model = getModel("openai", modelId);
		const tokenCount = 100_000;
		const tokenScale = tokenCount / 1_000_000;
		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: serviceTier,
					usage: {
						input_tokens: tokenCount,
						output_tokens: tokenCount,
						total_tokens: tokenCount * 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", serviceTier },
		);

		const result = await stream.result();

		expect(result.usage.cost.input).toBe(model.cost.input * multiplier * tokenScale);
		expect(result.usage.cost.output).toBe(model.cost.output * multiplier * tokenScale);
		expect(result.usage.cost.total).toBe((model.cost.input + model.cost.output) * multiplier * tokenScale);
	});
});
