import OpenAI from "openai";
import type {
	CompactedResponse,
	ResponseCompactParams,
	ResponseCreateParamsStreaming,
	ResponseInput,
} from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.ts";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	ProviderResponse,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";
import { OPENAI_RESPONSES_COMPACTION_ADAPTER } from "../types.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	getOpenAIResponsesCheckpointIdentity,
	normalizeOpenAIResponsesCompactionEndpoint,
} from "./openai-responses.lazy.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	mapOpenAIResponsesUsage,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

type ResolvedOpenAIResponsesCompat = Required<Omit<OpenAIResponsesCompat, "responsesCompaction">>;

function getCompat(model: Model<"openai-responses">): ResolvedOpenAIResponsesCompat {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
	};
}

function getPromptCacheRetention(
	compat: ResolvedOpenAIResponsesCompat,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

function formatOpenAIResponsesError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "OpenAI API error");
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

export interface OpenAIResponsesCompactionOptions {
	apiKey?: string;
	env?: ProviderEnv;
	headers?: ProviderHeaders;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	transformHeaders?: (headers: ProviderHeaders) => Promise<ProviderHeaders> | ProviderHeaders;
	onPayload?: (payload: ResponseCompactParams, model: Model<"openai-responses">) => Promise<unknown> | unknown;
	onResponse?: (response: ProviderResponse, model: Model<"openai-responses">) => void | Promise<void>;
}

export interface OpenAIResponsesCheckpointIdentity {
	readonly adapter: typeof OPENAI_RESPONSES_COMPACTION_ADAPTER;
	readonly realm: string;
	readonly provider: string;
	readonly endpoint: string;
	readonly modelFamily: string;
}

export interface OpenAIResponsesCheckpoint {
	type: "provider_checkpoint";
	version: 1;
	identity: OpenAIResponsesCheckpointIdentity;
	payload: CompactedResponse;
	usage?: Usage;
}

export interface OpenAIResponsesProviderState {
	type: "openai_responses_provider_state";
	checkpoint: OpenAIResponsesCheckpoint;
}

export interface OpenAIResponsesCompactionAdapter {
	readonly id: typeof OPENAI_RESPONSES_COMPACTION_ADAPTER;
	compact(
		model: Model<"openai-responses">,
		context: Context,
		options?: OpenAIResponsesCompactionOptions,
	): Promise<OpenAIResponsesCheckpoint>;
	renderCheckpoint(model: Model<"openai-responses">, checkpoint: OpenAIResponsesCheckpoint): ResponseInput;
}

/**
 * Generate function for OpenAI Responses API
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
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

		try {
			// Create OpenAI client
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				context.tools,
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(model, context, apiKey, options?.headers, cacheSessionId);
			let params = buildParams(model, context, options, compat, grammarToolInputProperties);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model, {
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatOpenAIResponsesError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	sessionId?: string,
) {
	const compat = getCompat(model);
	const headers: ProviderHeaders = { ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers,
	});
}

function getOpenAIResponsesProviderState(value: unknown): OpenAIResponsesProviderState | undefined {
	if (!isRecord(value) || value.type !== "openai_responses_provider_state") return undefined;
	const checkpoint = value.checkpoint;
	if (!isRecord(checkpoint) || checkpoint.type !== "provider_checkpoint" || checkpoint.version !== 1) return undefined;
	return value as unknown as OpenAIResponsesProviderState;
}

function renderResponsesInput(
	model: Model<"openai-responses">,
	context: Context,
	compat: ResolvedOpenAIResponsesCompat,
	grammarToolInputProperties: ReadonlyMap<string, string>,
): { input: ResponseInput; immediateTools: ReturnType<typeof splitDeferredTools>["immediate"] } {
	const providerState = getOpenAIResponsesProviderState(context.providerState);
	const messageContext = providerState ? { ...context, systemPrompt: undefined } : context;
	const toolPlacement = splitDeferredTools(messageContext, compat.supportsToolSearch);
	const suffix = convertResponsesMessages(model, messageContext, OPENAI_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		deferredTools: toolPlacement.deferred,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
	});
	return {
		input: providerState
			? [...responsesCompactionAdapter.renderCheckpoint(model, providerState.checkpoint), ...suffix]
			: suffix,
		immediateTools: toolPlacement.immediate,
	};
}

function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	compat: ResolvedOpenAIResponsesCompat = getCompat(model),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		context.tools,
		compat.supportsOpenAIGrammarTools,
	),
) {
	const rendered = renderResponsesInput(model, context, compat, grammarToolInputProperties);

	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const disableImplicitPromptCache = cacheRetention === "none" && compat.supportsExplicitPromptCacheMode;
	const params: ResponseCreateParamsStreaming & { prompt_cache_options?: { mode: "explicit" } } = {
		model: model.id,
		input: rendered.input,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: disableImplicitPromptCache ? { mode: "explicit" } : undefined,
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (rendered.immediateTools.length > 0) {
		params.tools = convertResponsesTools(rendered.immediateTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}

	return params;
}

export { getOpenAIResponsesCheckpointIdentity, normalizeOpenAIResponsesCompactionEndpoint };

function snapshotCompactionIdentity(model: Model<"openai-responses">): OpenAIResponsesCheckpointIdentity {
	const declared = model.compat?.responsesCompaction;
	if (declared?.adapter !== OPENAI_RESPONSES_COMPACTION_ADAPTER) {
		throw new Error(
			`OpenAI Responses native compaction is not supported without explicit ${OPENAI_RESPONSES_COMPACTION_ADAPTER} compatibility`,
		);
	}
	const identity = getOpenAIResponsesCheckpointIdentity(model);
	if (!identity) {
		throw new Error(
			"OpenAI Responses native compaction requires non-empty realm and modelFamily compatibility identity",
		);
	}
	return identity;
}

function identitiesMatch(left: OpenAIResponsesCheckpointIdentity, right: OpenAIResponsesCheckpointIdentity): boolean {
	return (
		left.adapter === right.adapter &&
		left.realm === right.realm &&
		left.provider === right.provider &&
		left.endpoint === right.endpoint &&
		left.modelFamily === right.modelFamily
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateUsageObject(value: unknown): value is CompactedResponse["usage"] {
	if (!isRecord(value)) return false;
	if (
		!isNonNegativeFiniteNumber(value.input_tokens) ||
		!isNonNegativeFiniteNumber(value.output_tokens) ||
		!isNonNegativeFiniteNumber(value.total_tokens) ||
		!isRecord(value.input_tokens_details) ||
		!isNonNegativeFiniteNumber(value.input_tokens_details.cached_tokens) ||
		!isRecord(value.output_tokens_details) ||
		!isNonNegativeFiniteNumber(value.output_tokens_details.reasoning_tokens)
	) {
		return false;
	}
	const cacheWriteTokens = value.input_tokens_details.cache_write_tokens;
	return cacheWriteTokens === undefined || isNonNegativeFiniteNumber(cacheWriteTokens);
}

function validateCompactedResponse(value: unknown): asserts value is CompactedResponse {
	const invalid = (reason: string): never => {
		throw new Error(`Invalid Responses compact response: ${reason}`);
	};
	if (!isRecord(value)) invalid("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	if (typeof envelope.id !== "string" || envelope.id.trim().length === 0) invalid("expected a non-empty id");
	if (typeof envelope.created_at !== "number" || !Number.isFinite(envelope.created_at)) {
		invalid("expected a numeric created_at");
	}
	if (envelope.object !== "response.compaction") invalid('expected object "response.compaction"');
	if (!validateUsageObject(envelope.usage)) invalid("expected a usage object with numeric counters");
	if (!Array.isArray(envelope.output) || envelope.output.length === 0) invalid("expected non-empty output");
	const output = envelope.output as unknown[];
	for (const item of output) {
		if (!isRecord(item) || typeof item.type !== "string" || item.type.trim().length === 0) {
			invalid("expected every output item to be an object with a non-empty type");
		}
	}
}

function assertJsonValue(value: unknown, path = "checkpoint", ancestors = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (typeof value !== "object") {
		throw new Error(`Invalid Responses compact checkpoint: unsupported non-JSON value at ${path}`);
	}
	if (ancestors.has(value)) {
		throw new Error(`Invalid Responses compact checkpoint: circular value at ${path}`);
	}
	ancestors.add(value);
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			assertJsonValue(item, `${path}[${index}]`, ancestors);
		});
	} else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error(`Invalid Responses compact checkpoint: unsupported non-JSON object at ${path}`);
		}
		for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, ancestors);
	}
	ancestors.delete(value);
}

function cloneJson<T>(value: T): T {
	assertJsonValue(value);
	return JSON.parse(JSON.stringify(value)) as T;
}

function formatCompactionError(error: unknown, secrets: Array<string | null | undefined>): Error {
	const message = formatOpenAIResponsesError(error);
	const redact = secrets.filter((value): value is string => typeof value === "string" && value.length > 0);
	let redacted = message;
	for (const secret of redact) redacted = redacted.replaceAll(secret, "[redacted]");
	return new Error(redacted);
}

export const responsesCompactionAdapter: OpenAIResponsesCompactionAdapter = {
	id: OPENAI_RESPONSES_COMPACTION_ADAPTER,
	async compact(model, context, options) {
		const identity = snapshotCompactionIdentity(model);
		const compat = getCompat(model);
		const grammarToolInputProperties = createGrammarToolInputProperties(
			context.tools,
			compat.supportsOpenAIGrammarTools,
		);
		const input = renderResponsesInput(model, context, compat, grammarToolInputProperties).input;
		const configuredApiKey = options?.apiKey ?? getEnvApiKey(model.provider, options?.env);
		const requestHeaders = options?.transformHeaders
			? await options.transformHeaders(options.headers ?? {})
			: options?.headers;
		const apiKey = getClientApiKey(model.provider, configuredApiKey, requestHeaders);
		const client = createClient(model, context, apiKey, requestHeaders);
		let body: ResponseCompactParams = { model: model.id, input };
		const nextBody = await options?.onPayload?.(body, model);
		if (nextBody !== undefined) body = nextBody as ResponseCompactParams;
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: 0,
		};
		try {
			const { data, response } = await retryProviderRequest(
				() => client.responses.compact(body, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			validateCompactedResponse(data);
			const payload = cloneJson(data);
			return {
				type: "provider_checkpoint",
				version: 1,
				identity,
				payload,
				usage: mapOpenAIResponsesUsage(model, payload.usage),
			};
		} catch (error) {
			if (options?.signal?.aborted) throw options.signal.reason ?? error;
			if (error instanceof Error && error.message.startsWith("Invalid Responses compact response:")) throw error;
			throw formatCompactionError(error, [configuredApiKey, ...Object.values(requestHeaders ?? {})]);
		}
	},
	renderCheckpoint(model, checkpoint) {
		if (checkpoint.type !== "provider_checkpoint" || checkpoint.version !== 1) {
			throw new Error("Invalid Responses compact checkpoint version");
		}
		const expectedIdentity = snapshotCompactionIdentity(model);
		if (!identitiesMatch(checkpoint.identity, expectedIdentity)) {
			throw new Error("Responses compact checkpoint identity is not compatible with this model");
		}
		validateCompactedResponse(checkpoint.payload);
		return cloneJson(checkpoint.payload.output) as ResponseInput;
	},
};

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
