import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { CompactedResponse } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntryBase, SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const STABLE_COMPACT_ADAPTER = "openai-responses-compact-v1" as const;

interface ProviderCheckpointIdentity {
	adapter: typeof STABLE_COMPACT_ADAPTER;
	realm: string;
	modelFamily: string;
}

interface PersistedProviderCheckpointIdentity extends ProviderCheckpointIdentity {
	provider: string;
	endpoint: string;
}

interface NativeCompactionModel extends Model<"openai-responses"> {
	compat?: Model<"openai-responses">["compat"] & {
		responsesCompaction?: ProviderCheckpointIdentity;
	};
}

interface CheckpointBoundarySessionEntry extends SessionEntryBase {
	type: "compaction_boundary";
	boundary: {
		version: 1;
		tokensBefore: number;
		primary: {
			kind: "checkpoint";
			checkpoint: {
				version: 1;
				identity: PersistedProviderCheckpointIdentity;
				frontierEntryId: string;
				payload: CompactedResponse;
			};
			usage?: ReturnType<typeof createUsage>;
		};
		projections: Array<{ customType: string; summary: string }>;
	};
}

interface SessionWithCompactionInternals {
	_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean>;
}

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
	headers: Headers;
	isTextSummary: boolean;
}

interface MockTransport {
	requests: CapturedRequest[];
	started: Promise<void>;
	release(): void;
}

const canonicalOutput = [
	{
		type: "message",
		id: "msg_retained_lifecycle",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "retained output", annotations: [] }],
	},
	{
		type: "compaction",
		id: "cmp_lifecycle",
		encrypted_content: "opaque-lifecycle",
	},
] as unknown as CompactedResponse["output"];

const compactResponse = {
	id: "resp_compact_lifecycle",
	created_at: 1_753_000_000,
	object: "response.compaction",
	output: canonicalOutput,
	usage: {
		input_tokens: 100,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: 10,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: 110,
	},
} as CompactedResponse;

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function nativeCompactionModel(
	harness: Harness,
	options: { contextWindow?: number; modelId?: string; realm?: string } = {},
): NativeCompactionModel {
	const base = options.modelId ? harness.getModel(options.modelId) : harness.getModel();
	if (!base) throw new Error(`Missing faux model: ${options.modelId}`);
	return {
		...base,
		api: "openai-responses",
		baseUrl: "https://native-compaction.example.test/v1",
		contextWindow: options.contextWindow ?? 200_000,
		compat: {
			responsesCompaction: {
				adapter: STABLE_COMPACT_ADAPTER,
				realm: options.realm ?? "provider-owned:faux-account-a:gpt-5",
				modelFamily: "gpt-5",
			},
		},
	};
}

function createNativeAssistant(
	model: NativeCompactionModel,
	text: string,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	} = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
		stopReason: options.stopReason ?? "stop",
		errorMessage: options.errorMessage,
		timestamp: options.timestamp ?? Date.now(),
	};
}

function seedNativeCompactableSession(harness: Harness, model: NativeCompactionModel, totalTokens: number): string {
	const now = Date.now();
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	harness.sessionManager.appendMessage({ role: "user", content: "history to compact", timestamp: now - 1000 });
	const frontierEntryId = harness.sessionManager.appendMessage(
		createNativeAssistant(model, "historical answer", { totalTokens, timestamp: now - 500 }),
	);
	harness.session.agent.state.model = model;
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return frontierEntryId;
}

function isCheckpointBoundaryEntry(entry: SessionEntryBase): entry is CheckpointBoundarySessionEntry {
	return (
		entry.type === "compaction_boundary" &&
		"boundary" in entry &&
		(entry as CheckpointBoundarySessionEntry).boundary.primary.kind === "checkpoint"
	);
}

function isSessionMessageEntry(entry: SessionEntryBase): entry is SessionMessageEntry {
	return entry.type === "message";
}

function checkpointBoundaryEntries(harness: Harness): CheckpointBoundarySessionEntry[] {
	return (harness.sessionManager.getEntries() as SessionEntryBase[]).filter(isCheckpointBoundaryEntry);
}

function persistedUserMessages(harness: Harness, text: string): SessionMessageEntry[] {
	return (harness.sessionManager.getEntries() as SessionEntryBase[])
		.filter(isSessionMessageEntry)
		.filter((entry) => entry.message.role === "user" && JSON.stringify(entry.message).includes(text));
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function responseStream(text: string, usage: { inputTokens?: number; outputTokens?: number } = {}): Response {
	const inputTokens = usage.inputTokens ?? 20;
	const outputTokens = usage.outputTokens ?? 5;
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_test", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_test",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_test",
				status: "completed",
				usage: {
					input_tokens: inputTokens,
					output_tokens: outputTokens,
					total_tokens: inputTokens + outputTokens,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function mockTransport(
	options: {
		block?: boolean;
		compactStatus?: number;
		inferenceUsage?: { inputTokens?: number; outputTokens?: number };
		overflowFirstInference?: boolean;
		onCompactRequest?: () => void;
	} = {},
): MockTransport {
	const requests: CapturedRequest[] = [];
	let release = () => {};
	let markStarted = () => {};
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const blocked = options.block
		? new Promise<void>((resolve) => {
				release = resolve;
			})
		: Promise.resolve();
	let overflowPending = options.overflowFirstInference ?? false;

	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		const isTextSummary = JSON.stringify(body).includes("You are a context summarization assistant.");
		requests.push({ url, body, headers: new Headers(init?.headers), isTextSummary });
		markStarted();
		await blocked;

		if (url.endsWith("/responses/compact")) {
			options.onCompactRequest?.();
			if (options.compactStatus && options.compactStatus !== 200) {
				return jsonResponse({ error: { message: "compact unavailable" } }, options.compactStatus);
			}
			return jsonResponse(compactResponse);
		}
		if (isTextSummary) return responseStream("legacy textual summary");
		if (overflowPending) {
			overflowPending = false;
			return jsonResponse({ error: { message: "prompt is too long", code: "context_length_exceeded" } }, 400);
		}
		return responseStream("completed inference", options.inferenceUsage);
	});

	return { requests, started, release };
}

function nativeRequests(transport: MockTransport): CapturedRequest[] {
	return transport.requests.filter((request) => request.url.endsWith("/responses/compact"));
}

function inferenceRequests(transport: MockTransport): CapturedRequest[] {
	return transport.requests.filter((request) => request.url.endsWith("/responses") && !request.isTextSummary);
}

function summaryRequests(transport: MockTransport): CapturedRequest[] {
	return transport.requests.filter((request) => request.isTextSummary);
}

describe("#6492 OpenAI Responses native compaction lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("manual native compaction commits one first-class checkpoint and authorizes no inference", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = nativeCompactionModel(harness);
		const frontierEntryId = seedNativeCompactableSession(harness, model, 100);
		const transport = mockTransport();

		await harness.session.compact();

		expect(nativeRequests(transport)).toHaveLength(1);
		expect(summaryRequests(transport)).toHaveLength(0);
		expect(inferenceRequests(transport)).toHaveLength(0);
		const entries = checkpointBoundaryEntries(harness);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.boundary.primary.checkpoint.identity).toEqual({
			...model.compat?.responsesCompaction,
			provider: model.provider,
			endpoint: model.baseUrl,
		});
		expect(entries[0]?.boundary.primary.checkpoint.frontierEntryId).toBe(frontierEntryId);
		expect(entries[0]?.boundary.primary.checkpoint.payload).toEqual(compactResponse);
		expect(harness.session.messages.some((message) => message.role === "compactionSummary")).toBe(false);
	});

	it("keeps private native compaction payloads out of the public provider request hook", async () => {
		const hookCalls: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_headers", (event) => {
						hookCalls.push("headers");
						event.headers["x-native-hook"] = "enabled";
					});
					pi.on("before_provider_request", (event) => {
						hookCalls.push("payload");
						return { ...(event.payload as Record<string, unknown>), hook_marker: "seen" };
					});
					pi.on("after_provider_response", () => {
						hookCalls.push("response");
					});
				},
			],
		});
		harnesses.push(harness);
		const model = nativeCompactionModel(harness);
		seedNativeCompactableSession(harness, model, 100);
		const transport = mockTransport();

		await harness.session.compact();

		const request = nativeRequests(transport)[0];
		expect(hookCalls).toEqual(["headers", "response"]);
		expect(request?.headers.get("x-native-hook")).toBe("enabled");
		expect(request?.body.hook_marker).toBeUndefined();
	});

	it("manual native compaction reports operation accounting separately from the active estimate", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = nativeCompactionModel(harness);
		seedNativeCompactableSession(harness, model, 100);
		const transport = mockTransport();
		const statsBefore = harness.session.getSessionStats();
		const events: unknown[] = [];
		const unsubscribe = harness.session.subscribe((event) => events.push(event));

		const result = await harness.session.compact();

		unsubscribe();
		const compactionEnd = events.find(
			(event): event is { type: "compaction_end"; result: unknown } =>
				typeof event === "object" && event !== null && (event as { type?: unknown }).type === "compaction_end",
		);
		expect(compactionEnd).toMatchObject({ type: "compaction_end", result });
		expect(result).toEqual({
			kind: "checkpoint",
			boundaryEntryId: checkpointBoundaryEntries(harness)[0]?.id,
			tokensBefore: 100,
			estimatedTokensAfter: expect.any(Number),
			usage: expect.objectContaining({ input: 100, output: 10, totalTokens: 110 }),
			projectionCount: 0,
		});
		expect(result).not.toHaveProperty("summary");
		expect(result).not.toHaveProperty("firstKeptEntryId");
		expect(result).not.toHaveProperty("details");
		expect(result).not.toHaveProperty("checkpointEntry");
		expect(result.usage).toMatchObject({ input: 100, output: 10, totalTokens: 110 });
		const statsAfter = harness.session.getSessionStats();
		expect(statsAfter.tokens.input - statsBefore.tokens.input).toBe(100);
		expect(statsAfter.tokens.output - statsBefore.tokens.output).toBe(10);
		expect(statsAfter.cost).toBeGreaterThanOrEqual(statsBefore.cost);
		const estimatedTokensAfter = result.estimatedTokensAfter;
		expect(estimatedTokensAfter).toEqual(expect.any(Number));
		expect(estimatedTokensAfter).not.toBe(compactResponse.usage.input_tokens);
		expect(estimatedTokensAfter).not.toBe(compactResponse.usage.total_tokens);
		expect(nativeRequests(transport)).toHaveLength(1);
	});

	it("pre-prompt threshold compaction serializes checkpoint plus the pending real prompt exactly once", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 100 } },
		});
		harnesses.push(harness);
		const model = nativeCompactionModel(harness, { contextWindow: 200 });
		seedNativeCompactableSession(harness, model, 150);
		const transport = mockTransport();

		await harness.session.prompt("pending real prompt");

		expect(nativeRequests(transport)).toHaveLength(1);
		expect(summaryRequests(transport)).toHaveLength(0);
		expect(inferenceRequests(transport)).toHaveLength(1);
		expect(inferenceRequests(transport)[0]?.body.input).toEqual([
			...canonicalOutput,
			{ role: "user", content: [{ type: "input_text", text: "pending real prompt" }] },
		]);
		expect(JSON.stringify(inferenceRequests(transport)[0]?.body.input).match(/opaque-lifecycle/g)).toHaveLength(1);
		expect(persistedUserMessages(harness, "pending real prompt")).toHaveLength(1);
	});

	it("post-turn threshold native compaction does not authorize another inference", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 100 } },
		});
		harnesses.push(harness);
		const model = nativeCompactionModel(harness, { contextWindow: 200 });
		seedNativeCompactableSession(harness, model, 50);
		const transport = mockTransport({ inferenceUsage: { inputTokens: 150, outputTokens: 5 } });

		await harness.session.prompt("one completed real prompt");

		expect(transport.requests.map((request) => request.url)).toEqual([
			"https://native-compaction.example.test/v1/responses",
			"https://native-compaction.example.test/v1/responses/compact",
		]);
		expect(inferenceRequests(transport)).toHaveLength(1);
		expect(nativeRequests(transport)).toHaveLength(1);
		expect(summaryRequests(transport)).toHaveLength(0);
		expect(persistedUserMessages(harness, "one completed real prompt")).toHaveLength(1);
	});

	it("overflow native compaction retries the authorized run once without a synthetic user turn", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		const model = nativeCompactionModel(harness);
		seedNativeCompactableSession(harness, model, 100);
		const lifecycle: string[] = [];
		const harnessWithHooks = harness as Harness;
		const transport = mockTransport({
			overflowFirstInference: true,
			onCompactRequest: () => lifecycle.push("native execute"),
		});
		const appendBoundary = harnessWithHooks.sessionManager.appendCompactionBoundary.bind(
			harnessWithHooks.sessionManager,
		);
		vi.spyOn(harnessWithHooks.sessionManager, "appendCompactionBoundary").mockImplementation((...args) => {
			lifecycle.push("append boundary");
			return appendBoundary(...args);
		});
		harnessWithHooks.session.subscribe((event) => {
			if (event.type === "compaction_end") lifecycle.push("compaction_end");
		});

		await harness.session.prompt("unfinished real work");

		expect(inferenceRequests(transport)).toHaveLength(2);
		const retryInput = inferenceRequests(transport)[1]?.body.input;
		expect(retryInput).toEqual(canonicalOutput);
		expect(nativeRequests(transport)).toHaveLength(1);
		expect(summaryRequests(transport)).toHaveLength(0);
		expect(persistedUserMessages(harness, "unfinished real work")).toHaveLength(1);
		expect(lifecycle).toEqual(["native execute", "append boundary", "compaction_end"]);
		expect(
			(harness.sessionManager.getEntries() as SessionEntryBase[])
				.filter(isSessionMessageEntry)
				.filter((entry) => entry.message.role === "user")
				.some((entry) =>
					/Continue if you have next steps|continue the conversation/i.test(JSON.stringify(entry.message)),
				),
		).toBe(false);
	});

	it("native-only failure commits no checkpoint or summary and leaves the prior projection intact", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = nativeCompactionModel(harness);
		seedNativeCompactableSession(harness, model, 100);
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		const projectionBefore = structuredClone(harness.session.agent.state.messages);
		const transport = mockTransport({ compactStatus: 503 });

		await expect(harness.session.compact()).rejects.toThrow(/503|compact unavailable/i);

		expect(nativeRequests(transport)).toHaveLength(1);
		expect(summaryRequests(transport)).toHaveLength(0);
		expect(checkpointBoundaryEntries(harness)).toHaveLength(0);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(harness.session.agent.state.messages).toEqual(projectionBefore);
	});

	it("ignores a blocked compact completion after reload and provider identity change", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
		harnesses.push(harness);
		const originalModel = nativeCompactionModel(harness, {
			modelId: "faux-1",
			realm: "provider-owned:faux-account-a:gpt-5",
		});
		seedNativeCompactableSession(harness, originalModel, 100);
		const transport = mockTransport({ block: true });

		const pending = harness.session.compact();
		await transport.started;
		await harness.session.reload();
		const replacementModel = nativeCompactionModel(harness, {
			modelId: "faux-2",
			realm: "provider-owned:faux-account-b:gpt-5",
		});
		await harness.session.setModel(replacementModel);
		transport.release();
		await Promise.allSettled([pending]);

		expect(harness.session.model).toBe(replacementModel);
		expect(checkpointBoundaryEntries(harness)).toHaveLength(0);
		expect(
			(harness.sessionManager.getEntries() as SessionEntryBase[]).some(
				(entry) =>
					entry.type === "compaction" ||
					entry.type === "provider_checkpoint" ||
					entry.type === "compaction_boundary",
			),
		).toBe(false);
	});

	it("rejects an overlapping threshold request while one manual compact owns transport", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = nativeCompactionModel(harness);
		seedNativeCompactableSession(harness, model, 100);
		const transport = mockTransport({ block: true });
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		const manual = harness.session.compact();
		await transport.started;
		const threshold = internals._runAutoCompaction("threshold", false);
		await Promise.resolve();
		const ownersWhileBlocked = transport.requests.length;
		transport.release();
		const [manualResult, thresholdResult] = await Promise.allSettled([manual, threshold]);

		expect(ownersWhileBlocked).toBe(1);
		expect(manualResult.status).toBe("fulfilled");
		expect(thresholdResult).toEqual({ status: "fulfilled", value: false });
		expect(nativeRequests(transport)).toHaveLength(1);
		expect(checkpointBoundaryEntries(harness)).toHaveLength(1);
	});
});
