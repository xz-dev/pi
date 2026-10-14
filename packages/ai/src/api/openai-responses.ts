import OpenAI from "openai";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream, emitTransport } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getDeclaredTools, normalizeContext, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import {
	clearWebSocketSseFallbackIfOwned,
	closeResponsesWebSocketSessions,
	extractEventError,
	getResponsesWebSocketDebugStats,
	getWebSocketSseFallbackState,
	isPreviousResponseNotFoundError,
	isResponsesNonTransportError,
	isWebSocketConnectionLimitReachedError,
	normalizeWebSocketTimeoutMs,
	OPENAI_BETA_RESPONSES_WEBSOCKETS,
	ProviderStreamEventCallbackError,
	processResponsesWebSocket,
	ResponsesApiError,
	type ResponsesWebSocketDebugStats,
	recordWebSocketFailure,
	recordWebSocketSseFallback,
	resetResponsesWebSocketDebugStats,
} from "./openai-responses-websocket.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
// Fixed reasoning.effort while configuration_update items carry the thinking level.
const CONFIGURATION_UPDATE_REQUEST_EFFORT = "medium";
const OPENAI_RESPONSES_WEBSOCKET_SCOPE = "openai-responses";

/**
 * OpenAI API keys start with `sk-`; a different credential sent directly to OpenAI
 * is a Sign in with ChatGPT access token.
 */
function isChatGPTSignIn(model: Model<"openai-responses">, apiKey: string | undefined): boolean {
	return (
		model.provider === "openai" &&
		model.baseUrl === "https://api.openai.com/v1" &&
		apiKey !== undefined &&
		!apiKey.startsWith("sk-")
	);
}

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

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
		supportsMidConvoEffort: model.compat?.supportsMidConvoEffort ?? false,
	};
}

/** Effort to send in configuration_update items, or undefined to send it as reasoning.effort. */
function getConfigurationUpdateEffort(
	model: Model<"openai-responses">,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat>,
): string | undefined {
	if (
		!compat.supportsMidConvoEffort ||
		!options?.reasoningEffort ||
		// Sign in with ChatGPT rejects configuration_update items.
		isChatGPTSignIn(model, options.apiKey)
	) {
		return undefined;
	}
	return model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? "24h"
		: undefined;
}

function getPromptCacheOptions(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): ResponseCreateParamsStreaming["prompt_cache_options"] {
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	if (cacheRetention === "none") return { mode: "explicit" };
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "30m" };
	return undefined;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);

	// Start async processing
	(async () => {
		const compat = getCompat(model);
		const configurationUpdateEffort = getConfigurationUpdateEffort(model, options, compat);
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			...(configurationUpdateEffort === undefined ? {} : { providerThinkingLevel: configurationUpdateEffort }),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		let recoveryState = undefined as ReturnType<typeof getWebSocketSseFallbackState> | undefined;
		try {
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				options?.fetch,
				cacheSessionId,
			);
			let params = buildParams(
				model,
				normalizedContext,
				options,
				compat,
				grammarToolInputProperties,
				configurationUpdateEffort,
			);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};

			const transport = options?.transport || "auto";
			const sessionId = options?.sessionId;
			const fallbackState = sessionId
				? getWebSocketSseFallbackState(OPENAI_RESPONSES_WEBSOCKET_SCOPE, sessionId)
				: undefined;
			const recoveryProbe = (fallbackState?.retryAt ?? 0) > 0;
			let startEmitted = false;
			const websocketDisabledForSession =
				transport === "auto" && fallbackState && (fallbackState.recovering || Date.now() < fallbackState.retryAt);
			if (websocketDisabledForSession) {
				recordWebSocketSseFallback(OPENAI_RESPONSES_WEBSOCKET_SCOPE, sessionId);
			}

			if (transport !== "sse" && !websocketDisabledForSession) {
				await emitTransport(options?.onTransport, "WS", model);
				if (transport === "auto" && fallbackState) {
					recoveryState = fallbackState;
					recoveryState.recovering = true;
				}
				let websocketStarted = false;
				let retriedWebSocketConnectionLimit = false;
				let retriedMissingWebSocketContinuation = false;
				const websocketHeaders = buildWebSocketHeaders(
					model,
					normalizedContext,
					apiKey,
					options?.headers,
					cacheSessionId,
				);
				while (true) {
					websocketStarted = false;
					try {
						await processResponsesWebSocket({
							scope: OPENAI_RESPONSES_WEBSOCKET_SCOPE,
							url: resolveResponsesWebSocketUrl(model.baseUrl),
							body: toWebSocketBody(params),
							headers: websocketHeaders,
							output,
							stream,
							model,
							onStart: () => {
								websocketStarted = true;
								if (!startEmitted) {
									startEmitted = true;
									stream.push({ type: "start", partial: output });
								}
							},
							idleTimeoutMs: normalizeWebSocketTimeoutMs(options?.timeoutMs),
							connectTimeoutMs: normalizeWebSocketTimeoutMs(options?.websocketConnectTimeoutMs),
							cacheSessionId,
							identityKey: websocketIdentityKey(model, apiKey, websocketHeaders),
							mapEvents: (events) => mapOrdinaryResponsesEvents(events, model, options?.onProviderStreamEvent),
							processStream: (events, out, s, m) =>
								processResponsesStream(events, out, s, m, {
									serviceTier: options?.serviceTier,
									grammarToolInputProperties,
									applyServiceTierPricing: (usage, serviceTier) =>
										applyServiceTierPricing(usage, serviceTier, m),
								}),
							getResponseItems: () =>
								convertResponsesMessages(
									model,
									normalizeContext({ messages: [output] }),
									OPENAI_TOOL_CALL_PROVIDERS,
									{
										includeSystemPrompt: false,
										grammarToolInputProperties,
										supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
										supportsAdditionalTools: compat.supportsAdditionalTools,
										supportsToolSearch: compat.supportsToolSearch,
										toolOptions: {
											supportsStrictMode: compat.supportsStrictMode,
											supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
										},
									},
								).filter(
									(item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output",
								),
							isTerminalError: (out) =>
								out.stopReason === "error" || out.stopReason === "aborted" || out.stopReason === "pending",
							forceFresh: recoveryState !== undefined,
							options,
						});

						if (options?.signal?.aborted) {
							throw new Error("Request was aborted");
						}
						if (output.stopReason === "pending") {
							throw new Error("OpenAI Responses stream ended without a stop reason");
						}
						if (output.stopReason === "aborted" || output.stopReason === "error") {
							throw new ResponsesApiError(output.errorMessage || "An unknown error occurred");
						}
						if (transport === "auto" && sessionId && recoveryState) {
							clearWebSocketSseFallbackIfOwned(OPENAI_RESPONSES_WEBSOCKET_SCOPE, sessionId, recoveryState);
						}
						stream.push({
							type: "done",
							reason: output.stopReason,
							message: output,
						});
						stream.end();
						return;
					} catch (error) {
						const aborted = options?.signal?.aborted;
						const connectionLimitBeforeStart = !websocketStarted && isWebSocketConnectionLimitReachedError(error);
						const previousResponseNotFound = isPreviousResponseNotFoundError(error);
						// A replacement socket would append to this same message; only repair before output.
						if (
							!aborted &&
							previousResponseNotFound &&
							output.content.length === 0 &&
							!retriedMissingWebSocketContinuation
						) {
							retriedMissingWebSocketContinuation = true;
							continue;
						}
						if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
							retriedWebSocketConnectionLimit = true;
							continue;
						}
						if (aborted || (isResponsesNonTransportError(error) && !connectionLimitBeforeStart)) {
							throw error;
						}
						const failureState = recordWebSocketFailure(
							OPENAI_RESPONSES_WEBSOCKET_SCOPE,
							sessionId,
							error,
							transport === "auto",
						);
						const fallbackToSse = transport === "auto" && (!failureState || failureState.retryAt > 0);
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic("provider_transport_failure", error, {
								configuredTransport: transport,
								...(fallbackToSse ? { fallbackTransport: "sse" } : {}),
								...(failureState ? { retryAttempt: fallbackToSse ? 0 : failureState.failures } : {}),
								...(failureState && fallbackToSse && !recoveryProbe ? { resetRetryBudget: true } : {}),
								eventsEmitted: startEmitted,
								phase: startEmitted ? "after_message_stream_start" : "before_message_stream_start",
								requestBytes: new TextEncoder().encode(JSON.stringify(toWebSocketBody(params))).byteLength,
							}),
						);
						// The outer retry owner applies the configured backoff and discards failed
						// assistant attempts. Never replay a started response in this stream.
						if (!fallbackToSse || startEmitted) {
							throw error;
						}
						recordWebSocketSseFallback(OPENAI_RESPONSES_WEBSOCKET_SCOPE, sessionId);
						await emitTransport(options?.onTransport, undefined, model);
						break;
					}
				}
			}

			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			await emitTransport(options?.onTransport, "SSE", model);
			if (!startEmitted) {
				startEmitted = true;
				stream.push({ type: "start", partial: output });
			}

			await processResponsesStream(openaiStream, output, stream, model, {
				onProviderStreamEvent: options?.onProviderStreamEvent,
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
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
			const errorMessage = formatProviderError(
				normalizeProviderError(error),
				`${model.provider === "openai" ? "OpenAI" : model.provider} API error`,
			);
			// Sign in with ChatGPT shares the subscription's usage limit with other apps.
			output.errorMessage = errorMessage.includes("subscription_sharing_usage_limit_exceeded")
				? `${errorMessage}\nCheck your ChatGPT usage: ${CHATGPT_USAGE_URL}`
				: errorMessage;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			if (recoveryState) recoveryState.recovering = false;
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

// ============================================================================
// WebSocket session state (shared Responses transport, ordinary scope)
// ============================================================================

export type OpenAIResponsesWebSocketDebugStats = ResponsesWebSocketDebugStats;

export function getOpenAIResponsesWebSocketDebugStats(sessionId: string): ResponsesWebSocketDebugStats | undefined {
	return getResponsesWebSocketDebugStats(OPENAI_RESPONSES_WEBSOCKET_SCOPE, sessionId);
}

export function resetOpenAIResponsesWebSocketDebugStats(sessionId?: string): void {
	resetResponsesWebSocketDebugStats(OPENAI_RESPONSES_WEBSOCKET_SCOPE, sessionId);
}

export function closeOpenAIResponsesWebSocketSessions(sessionId?: string): void {
	closeResponsesWebSocketSessions(OPENAI_RESPONSES_WEBSOCKET_SCOPE, sessionId);
}

// ============================================================================
// Request / transport plumbing
// ============================================================================

function createClient(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
) {
	const headers = buildMergedHeaders(model, context, sessionId, optionsHeaders);
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

/**
 * Default + model + session-affinity + option headers merged exactly like the SDK
 * client's defaultHeaders, including null suppression for provider/API defaults.
 */
function buildMergedHeaders(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	sessionId: string | undefined,
	optionsHeaders?: ProviderHeaders,
): ProviderHeaders {
	const compat = getCompat(model);
	const headers: ProviderHeaders = { "User-Agent": getPiUserAgent(), ...model.headers };
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

	// Merge options headers last so they can override defaults (null deletes).
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}
	return headers;
}

function buildWebSocketHeaders(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders: ProviderHeaders | undefined,
	sessionId: string | undefined,
): Headers {
	const merged = buildMergedHeaders(model, context, sessionId, optionsHeaders);
	const headers = new Headers();
	for (const [key, value] of Object.entries(providerHeadersToRecord(merged) ?? {})) {
		headers.set(key, value);
	}
	headers.delete("accept");
	headers.delete("content-type");
	// Responses WS auth: Authorization unless the caller supplied their own
	// credential header (mirrors getClientApiKey's "unused" path).
	if (!hasHeader(merged, "authorization") && !hasHeader(merged, "cf-aig-authorization")) {
		headers.set("Authorization", `Bearer ${apiKey}`);
	}
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	return headers;
}

function websocketIdentityKey(model: Model<"openai-responses">, apiKey: string, headers: Headers): string {
	const nonSecretHeaders = headersToRecord(headers);
	delete nonSecretHeaders.authorization;
	delete nonSecretHeaders["cf-aig-authorization"];
	// Partition by endpoint and effective credential/header identity. The
	// credential value itself never reaches diagnostics; it only scopes the
	// pool entry so a rotated key or header gets a fresh socket.
	const credential = headers.get("authorization") ?? headers.get("cf-aig-authorization") ?? apiKey;
	return `${model.baseUrl}\n${credential}\n${JSON.stringify(nonSecretHeaders)}`;
}

function resolveResponsesWebSocketUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : "https://api.openai.com/v1";
	const normalized = raw.replace(/\/+$/, "");
	const http = normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
	const url = new URL(http);
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

/** WS frame shape: no `stream` (the socket itself streams); keep store:false. */
function toWebSocketBody(params: ResponseCreateParamsStreaming): { [key: string]: unknown } {
	const { stream: _stream, ...rest } = params as unknown as Record<string, unknown>;
	return rest;
}

async function* mapOrdinaryResponsesEvents(
	events: AsyncIterable<Record<string, unknown>>,
	model: Model<"openai-responses">,
	onProviderStreamEvent: StreamOptions["onProviderStreamEvent"] | undefined,
): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		try {
			await onProviderStreamEvent?.(event, model);
		} catch (error) {
			// Keep callback failures out of the transport retry/fallback path.
			throw new ProviderStreamEventCallbackError(error);
		}
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			const { code, message } = extractEventError(event);
			throw new ResponsesApiError(message || code || "Responses WebSocket error", {
				code,
				payload: event,
			});
		}

		if (type === "response.failed") {
			const response = (event as { response?: { error?: { code?: string; message?: string } } }).response;
			const code = response?.error?.code;
			const message = response?.error?.message;
			throw new ResponsesApiError(message ? `${code || "unknown"}: ${message}` : "OpenAI response failed", {
				code,
				payload: event,
			});
		}

		yield event as unknown as ResponseStreamEvent;
	}
}

// ============================================================================
// Request Building
// ============================================================================

function buildParams(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat>,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	configurationUpdateEffort: string | undefined,
) {
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		compat.supportsAdditionalTools || compat.supportsToolSearch,
	);
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
		configurationUpdateEffort,
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	// Sign in with ChatGPT rejects these request fields.
	const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey);
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: omitUnsupportedFields ? undefined : getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: omitUnsupportedFields ? undefined : getPromptCacheOptions(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens && compat.supportsMaxOutputTokens && !omitUnsupportedFields) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined && !omitUnsupportedFields) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
	if (model.reasoning) {
		if (reasoningEffort) {
			const requestedEffort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: reasoningEffort;
			const effort = configurationUpdateEffort === undefined ? requestedEffort : CONFIGURATION_UPDATE_REQUEST_EFFORT;
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

	// Last so model and request sampling parameters override named request fields.
	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(params, samplingParams);
	}

	return params;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
		case "fast":
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
