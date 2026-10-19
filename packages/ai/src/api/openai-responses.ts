import { minimatch } from "minimatch";
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
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { createRequestCompressionFetch } from "../utils/request-compression.ts";
import { getDeclaredTools, normalizeContext, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	getResponsesToolSupport,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import {
	type CheckpointCooldownProbe,
	clearCheckpointCooldownIfOwned,
	clearWebSocketSseFallbackIfOwned,
	closeResponsesWebSocketSessions,
	extractEventError,
	getCheckpointCooldownState,
	getResponsesWebSocketDebugStats,
	getWebSocketSseFallbackState,
	invalidateResponsesWebSocketContinuation,
	isCheckpointReferenceError,
	isResponsesNonTransportError,
	isStoredContinuationReferenceError,
	isWebSocketConnectionLimitReachedError,
	normalizeWebSocketTimeoutMs,
	OPENAI_BETA_RESPONSES_WEBSOCKETS,
	ProviderStreamEventCallbackError,
	processResponsesWebSocket,
	ResponsesApiError,
	type ResponsesWebSocketDebugStats,
	recordCheckpointCooldown,
	recordWebSocketFailure,
	recordWebSocketSseFallback,
	resetResponsesWebSocketDebugStats,
	resolveCheckpointCooldown,
	responsesCheckpointScopeHash,
} from "./openai-responses-websocket.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const CHATGPT_WORKSPACE_LIMIT_HINT =
	"You've reached your ChatGPT workspace's usage limit. Ask your workspace admin to increase it at admin.openai.com → Workspace → Usage limits.";
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

/**
 * ChatGPT backend endpoints (chatgpt.com and subdomains) never receive
 * durable-checkpoint requests: they are hard-gated in every mode, like the
 * Codex provider and ChatGPT sign-in credentials.
 */
function isChatGPTBackendUrl(baseUrl: string): boolean {
	try {
		const hostname = new URL(baseUrl).hostname.toLowerCase();
		return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com");
	} catch {
		return false;
	}
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
		supportsResponseCheckpoints:
			model.compat?.supportsResponseCheckpoints ?? isOfficialResponsesCheckpointService(model),
	};
}

/**
 * Narrowly documented official-service default for `declared` mode: the
 * documented OpenAI Responses WebSocket service persists response state with
 * store:true and can hydrate older response IDs across connections.
 */
function isOfficialResponsesCheckpointService(model: Model<"openai-responses">): boolean {
	return model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1";
}

/**
 * Whether durable response checkpoints are enabled for this request.
 * `responseCheckpointMode` selects capability policy: absent means `"always"`
 * (try `store: true` regardless of the declared capability), `"auto"` tries
 * unless `compat.supportsResponseCheckpoints === false`, and `"declared"`
 * requires explicit capability or the official service. Malformed values
 * disable checkpoints. `responseCheckpointExclude` stays the per-target
 * opt-out: absent means `[]`; any match or a malformed list disables the
 * feature. Policy: [Response checkpoints](../../README.md#response-checkpoints).
 * Paired plugin: https://github.com/xz-dev/openai-api-pi-extension/blob/main/responses-websocket-fetch.ts
 * The plugin owns its checkpoint policy and transport independently.
 */
function responseCheckpointsEnabled(
	model: Model<"openai-responses">,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat>,
): boolean {
	const mode = options?.responseCheckpointMode;
	if (mode === "declared") {
		if (!compat.supportsResponseCheckpoints) return false;
	} else if (mode === "auto") {
		if (model.compat?.supportsResponseCheckpoints === false) return false;
	} else if (mode !== undefined && mode !== "always") {
		return false; // malformed mode: disabled, never enabled
	}
	const exclude = options?.responseCheckpointExclude;
	if (exclude !== undefined && (!Array.isArray(exclude) || !Array.from(exclude).every((p) => typeof p === "string"))) {
		return false;
	}
	const providerTarget = model.provider;
	const modelTarget = model.id;
	const combinedTarget = `${model.provider}/${model.id}`;
	for (const pattern of exclude ?? []) {
		if (
			pattern === "*" ||
			minimatch(combinedTarget, pattern, { nocase: true }) ||
			minimatch(providerTarget, pattern, { nocase: true }) ||
			minimatch(modelTarget, pattern, { nocase: true })
		) {
			return false;
		}
	}
	return true;
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

/** Resolve before encoding/filtering; only structured projection can adopt preceding history as local. */
function getResponseAncestry(
	messages: TranscriptContext["messages"],
): "local" | "legacy" | "server-dependent" | "unknown" {
	let ancestry: "local" | "legacy" | "server-dependent" | "unknown" = "local";
	for (const message of messages) {
		if (message.role !== "assistant" && message.role !== "user") continue;
		if (!("responseAncestry" in message)) {
			if (message.role === "assistant" && ancestry === "local") ancestry = "legacy";
			continue;
		}
		if (message.responseAncestry === "server-dependent") ancestry = "server-dependent";
		else if (message.responseAncestry !== "local" && ancestry !== "server-dependent") ancestry = "unknown";
	}
	return ancestry;
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
	const responseAncestry = getResponseAncestry(normalizedContext.messages);
	let lastResponseId: string | undefined;
	for (const message of normalizedContext.messages) {
		if (message.role === "assistant") lastResponseId = message.responseId;
	}

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
			...(responseAncestry === "local" || responseAncestry === "server-dependent" ? { responseAncestry } : {}),
		};

		let recoveryState = undefined as ReturnType<typeof getWebSocketSseFallbackState> | undefined;
		let checkpointProbe = undefined as CheckpointCooldownProbe | undefined;
		let checkpointIdentityKey = "";
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
				options?.identity,
				options?.fetch ?? createRequestCompressionFetch(),
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
			// Durable checkpoints extend WS cached modes only. Request persistent
			// state BEFORE the payload hook so an explicit caller store:false still
			// disables capture below.
			const requestTransport = options?.transport || "auto";
			const { headers: websocketHeaders, scopeHeaders } = buildWebSocketHeaders(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				cacheSessionId,
				options?.identity,
			);
			// Header overrides, not the unused API-key option, determine the WS credential.
			const authorization = websocketHeaders.get("authorization");
			const checkpointsEnabled =
				(requestTransport === "auto" || requestTransport === "websocket-cached") &&
				model.provider !== "openai-codex" &&
				!isChatGPTBackendUrl(model.baseUrl) &&
				cacheRetention !== "none" &&
				!isChatGPTSignIn(model, authorization?.replace(/^Bearer\s+/i, "") ?? "") &&
				responseCheckpointsEnabled(model, options, compat);
			if (checkpointsEnabled) {
				params.store = true;
			}
			// Read mutable per-send options after the caller hook, not when the client was created.
			const sendOptions = () => ({
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			});
			const nextParams = await options?.onPayload?.(params, model, async (payload) => {
				const { req, url } = await client.buildRequest({
					method: "post",
					path: "/responses",
					body: payload,
					...sendOptions(),
					stream: true,
					__security: { bearerAuth: true },
				});
				return new Request(url, req);
			});
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			// An explicit store:false from the payload hook is a privacy choice we
			// never override; it also disables durable capture for this request.
			// The checkpoint-cooldown check below may still strip a policy-requested
			// store:true; the effective flag is computed there.
			const requestOptions = sendOptions();

			const transport = options?.transport || "auto";
			const sessionId = options?.sessionId;
			const identityKey = websocketIdentityKey(model, websocketHeaders);
			const fallbackState =
				sessionId && transport !== "sse"
					? getWebSocketSseFallbackState(OPENAI_RESPONSES_WEBSOCKET_SCOPE, sessionId, identityKey)
					: undefined;
			const recoveryProbe = (fallbackState?.retryAt ?? 0) > 0;
			let startEmitted = false;
			const websocketDisabledForSession =
				transport === "auto" && fallbackState && (fallbackState.recovering || Date.now() < fallbackState.retryAt);
			if (websocketDisabledForSession) {
				recordWebSocketSseFallback(OPENAI_RESPONSES_WEBSOCKET_SCOPE, sessionId);
			}
			// Checkpoint failure cooldown (separate from WS→SSE recovery): while a
			// verified store/continuation rejection is fresh, requests go without
			// store or deltas; the first request after the deadline owns the probe.
			// A hook store:false veto keeps the explicit false and never claims the
			// probe, but an existing cooldown still forces full context (allowed:false).
			const policyStore = checkpointsEnabled && params.store === true;
			// SSE-only fallback must not claim or settle a storage probe.
			const checkpointCooldown =
				policyStore && !websocketDisabledForSession
					? resolveCheckpointCooldown(OPENAI_RESPONSES_WEBSOCKET_SCOPE, sessionId, identityKey)
					: {
							allowed:
								checkpointsEnabled &&
								!(
									sessionId &&
									getCheckpointCooldownState(OPENAI_RESPONSES_WEBSOCKET_SCOPE, sessionId, identityKey)
								),
						};
			checkpointProbe = checkpointCooldown.probe;
			checkpointIdentityKey = identityKey;
			// A cooldown in force (or an already-claimed probe) keeps this request
			// checkpoint-free by OMITTING the policy-owned store field (an endpoint
			// may reject the parameter itself); a caller's own hook store stays.
			if (policyStore && !checkpointCooldown.allowed) {
				delete (params as { store?: boolean }).store;
			}
			const checkpointsActive = checkpointsEnabled && checkpointCooldown.allowed && params.store === true;
			// A caller-injected previous_response_id owns its lineage; the
			// checkpoint repair must never discard it.
			const callerOwnedParent =
				typeof params.previous_response_id === "string" && params.previous_response_id.length > 0;
			// Only generated transport values are absent from the durable identity.
			const checkpointScope = checkpointsActive
				? () =>
						responsesCheckpointScopeHash({
							url: model.baseUrl,
							apiFamily: "openai-responses",
							credential: authorization ?? websocketHeaders.get("cf-aig-authorization") ?? "",
							headers: scopeHeaders,
						})
				: undefined;
			if (transport !== "sse" && !websocketDisabledForSession) {
				if (transport === "auto" && fallbackState) {
					recoveryState = fallbackState;
					recoveryState.recovering = true;
				}
				let websocketStarted = false;
				let retriedWebSocketConnectionLimit = false;
				let retriedMissingWebSocketContinuation = false;
				let referenceRepairConsumed = false;
				// A replacement socket must not erase this logical request's stored-reference fence.
				let storedReference = false;
				// The checkpoint probe re-verifies with store:true on a full body; a
				// stale delta would not prove the store path works.
				let suppressDurablePlanning = checkpointProbe !== undefined;
				let forceFullContext = checkpointsEnabled && (!checkpointCooldown.allowed || checkpointProbe !== undefined);
				while (true) {
					websocketStarted = false;
					let websocketSent = false;
					let fullHistory =
						!callerOwnedParent && responseAncestry !== "server-dependent" && responseAncestry !== "unknown";
					try {
						await processResponsesWebSocket({
							scope: OPENAI_RESPONSES_WEBSOCKET_SCOPE,
							url: resolveResponsesWebSocketUrl(model.baseUrl),
							body: toWebSocketBody(params),
							headers: websocketHeaders,
							output,
							stream,
							model,
							responseAncestry,
							lastResponseId,
							onPlanned: (completeHistory, stored) => {
								fullHistory = completeHistory;
								storedReference ||= stored;
							},
							onSent: (completeHistory) => {
								websocketSent = true;
								if (checkpointProbe && params.store === true) checkpointProbe.attempted = true;
								fullHistory = completeHistory;
							},
							onStart: () => {
								websocketStarted = true;
								if (!startEmitted) {
									startEmitted = true;
									stream.push({ type: "start", partial: output });
								}
							},
							onTransport: options?.onTransport,
							idleTimeoutMs: normalizeWebSocketTimeoutMs(options?.timeoutMs),
							connectTimeoutMs: normalizeWebSocketTimeoutMs(options?.websocketConnectTimeoutMs),
							cacheSessionId,
							identityKey,
							recoveryKey: identityKey,
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
							durableCheckpoints: checkpointScope
								? {
										getScopeHash: checkpointScope,
										getCandidate: () => {
											// Newest assistant on the active branch only — older
											// checkpoints stay unread, so no all-history scan. The
											// candidate must be the LAST assistant: any later
											// assistant without a checkpoint makes the lineage
											// ineligible.
											for (let i = normalizedContext.messages.length - 1; i >= 0; i--) {
												const msg = normalizedContext.messages[i];
												if (msg.role !== "assistant") continue;
												if (!msg.responseId || msg.responseCheckpoint === undefined) return undefined;
												return { responseId: msg.responseId, responseCheckpoint: msg.responseCheckpoint };
											}
											return undefined;
										},
										assign: (checkpoint) => {
											output.responseCheckpoint = checkpoint;
										},
									}
								: undefined,
							forceFresh: recoveryState !== undefined,
							// Cooled-down requests and the recovery probe send full context:
							// neither a connection-local continuation nor a durable delta
							// may exercise the suspect checkpoint path.
							forceFullContext,
							suppressDurablePlanning,
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
						if (sessionId) {
							clearWebSocketSseFallbackIfOwned(
								OPENAI_RESPONSES_WEBSOCKET_SCOPE,
								sessionId,
								identityKey,
								recoveryState,
							);
						}
						// A completed probe that captured nothing renews the cooldown
						// instead of clearing it: store:true is still unproven, and
						// releasing the claim alone would make every next request probe.
						if (checkpointProbe?.attempted && sessionId && output.responseCheckpoint === undefined) {
							recordCheckpointCooldown(
								OPENAI_RESPONSES_WEBSOCKET_SCOPE,
								sessionId,
								identityKey,
								checkpointProbe,
							);
						}
						// Only a valid checkpoint proves storage works and resets its progression.
						if (sessionId && output.responseCheckpoint !== undefined) {
							clearCheckpointCooldownIfOwned(
								OPENAI_RESPONSES_WEBSOCKET_SCOPE,
								sessionId,
								identityKey,
								checkpointProbe?.state,
							);
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
						const checkpointReferenceError =
							websocketSent &&
							!startEmitted &&
							output.content.length === 0 &&
							(isCheckpointReferenceError(error) ||
								(storedReference && isStoredContinuationReferenceError(error)));
						// A verified checkpoint rejection proves a failed store/delta before
						// execution: repair the turn once with the preserved full body minus
						// store/previous_response_id, then cool this endpoint down for the
						// session. With durable checkpoints opted out, the same coded error
						// keeps the base-branch connection-local repair: the WS cache
						// continuation still depends on that reference. A replacement socket
						// would append to this same message; only repair before start.
						const checkpointOwned = checkpointsActive || checkpointProbe !== undefined;
						if (!aborted && checkpointReferenceError && !retriedMissingWebSocketContinuation) {
							retriedMissingWebSocketContinuation = true;
							// Never repair a caller-owned parent or a lineage whose complete
							// history is not locally held: fullHistory is the provenance guard.
							if ((checkpointOwned || storedReference) && !callerOwnedParent && fullHistory) {
								if (checkpointOwned)
									recordCheckpointCooldown(
										OPENAI_RESPONSES_WEBSOCKET_SCOPE,
										sessionId,
										identityKey,
										checkpointProbe,
									);
								// Repair drops the checkpoint request: re-planning the same
								// stale reference or resending store would repeat the failure.
								if (params.store !== false) delete (params as { store?: boolean }).store;
								delete (params as { previous_response_id?: string }).previous_response_id;
								suppressDurablePlanning = true;
								forceFullContext = true;
								referenceRepairConsumed = true;
								continue;
							}
							if (!checkpointOwned && !callerOwnedParent && fullHistory) {
								// Base-branch connection-local recovery, unchanged.
								suppressDurablePlanning = true;
								referenceRepairConsumed = true;
								continue;
							}
						}
						// An explicit pre-output connection limit permits one fresh socket, not replay after repair.
						if (
							!aborted &&
							connectionLimitBeforeStart &&
							!startEmitted &&
							!retriedMissingWebSocketContinuation &&
							!retriedWebSocketConnectionLimit
						) {
							retriedWebSocketConnectionLimit = true;
							continue;
						}
						// A started repair is terminal across the outer retry owner, not just this stream.
						if (output.api === "openai-responses" && referenceRepairConsumed && startEmitted && !aborted) {
							// Classification only: raw errors can carry credentials outside top-level redaction.
							appendAssistantMessageDiagnostic(output, {
								type: "provider_reference_repair_terminal",
								timestamp: Date.now(),
							});
						}
						// A consumed full-history repair is the final attempt. A sent
						// request without an explicit rejection has unknown execution.
						if (
							retriedMissingWebSocketContinuation ||
							storedReference ||
							!fullHistory ||
							(checkpointsActive && websocketSent && !connectionLimitBeforeStart)
						) {
							throw error;
						}
						if (aborted || (isResponsesNonTransportError(error) && !connectionLimitBeforeStart)) {
							throw error;
						}
						const failureState = recordWebSocketFailure(
							OPENAI_RESPONSES_WEBSOCKET_SCOPE,
							sessionId,
							identityKey,
							error,
							transport === "auto",
							recoveryProbe ? recoveryState : undefined,
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

			// The SSE/HTTP path is a hard gate for checkpoints: it must never carry
			// a store:true request. An explicit hook store:false and a caller-owned
			// previous_response_id pass through unchanged.
			if (!callerOwnedParent && (responseAncestry === "server-dependent" || responseAncestry === "unknown")) {
				throw new ResponsesApiError("Cannot continue conversation without its server-owned ancestry", {
					code: "checkpoint_lineage_unavailable",
				});
			}
			if (callerOwnedParent) output.responseAncestry = "server-dependent";
			invalidateResponsesWebSocketContinuation(OPENAI_RESPONSES_WEBSOCKET_SCOPE, cacheSessionId, identityKey);
			const { store: _store, ...sseRest } = params;
			const sseParams =
				checkpointsEnabled && params.store === true ? (sseRest as ResponseCreateParamsStreaming) : params;
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(sseParams, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			let sseReported = false;
			const reportSseOnce = async () => {
				if (sseReported) return;
				sseReported = true;
				await emitTransport(options?.onTransport, "SSE", model);
			};
			if (response.body && isSseMediaType(response.headers.get("content-type"))) {
				await reportSseOnce();
			}
			if (!startEmitted) {
				startEmitted = true;
				stream.push({ type: "start", partial: output });
			}

			// The SDK picks its SSE decoder from the requested stream:true, not the
			// observed media type. When headers did not prove SSE (hidden headers,
			// gateway mislabeling), the first decoded event is the earliest proof.
			const proofedStream = (async function* () {
				for await (const event of openaiStream) {
					await reportSseOnce();
					yield event;
				}
			})();

			await processResponsesStream(proofedStream, output, stream, model, {
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
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			// A sent, non-aborted probe failure renews the cooldown: only a captured
			// checkpoint proves store:true works again.
			if (checkpointProbe?.attempted && output.stopReason === "error") {
				recordCheckpointCooldown(
					OPENAI_RESPONSES_WEBSOCKET_SCOPE,
					options?.sessionId,
					checkpointIdentityKey,
					checkpointProbe,
				);
			}
			const errorMessage = formatProviderError(
				normalizeProviderError(error),
				`${model.provider === "openai" ? "OpenAI" : model.provider} API error`,
			);
			// Sign in with ChatGPT shares the subscription's usage limit with other apps.
			// On ChatGPT Business plans, the workspace admin also sets a per-user limit.
			if (errorMessage.includes("subscription_sharing_usage_limit_exceeded")) {
				output.errorMessage = `${errorMessage}\nCheck your ChatGPT usage: ${CHATGPT_USAGE_URL}`;
			} else if (errorMessage.includes("subscription_sharing_workplace_individual_usage_limit_exceeded")) {
				output.errorMessage = `${errorMessage}\n${CHATGPT_WORKSPACE_LIMIT_HINT}`;
			} else {
				output.errorMessage = errorMessage;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			if (recoveryState) recoveryState.recovering = false;
			// An owned probe that ended without a clear releases the claim (an
			// aborted probe only releases; failures were renewed above).
			if (checkpointProbe) checkpointProbe.state.probing = false;
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
	identity?: ClientIdentity,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
) {
	const { headers } = buildMergedHeaders(model, context, sessionId, optionsHeaders, identity);
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
	identity?: ClientIdentity,
): { headers: ProviderHeaders; generated: Set<string> } {
	const compat = getCompat(model);
	const headers: ProviderHeaders = {};
	const provenance = new Map<string, boolean>();
	const merge = (source: ProviderHeaders | undefined, generated: boolean) => {
		for (const [name, value] of Object.entries(source ?? {})) {
			headers[name] = value;
			provenance.set(name, generated);
		}
	};
	merge(getIdentityHeaders(model, identity), identity === undefined);
	merge(model.headers, false);
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		merge(copilotHeaders, false);
	}

	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") {
			merge({ "x-session-id": sessionId }, true);
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				merge({ session_id: sessionId }, true);
			}
			merge({ "x-client-request-id": sessionId }, true);
		}
	}

	// Merge options headers last so they can override defaults (null deletes).
	merge(optionsHeaders, false);
	// Match the final case-insensitive wire merge, including differently cased keys.
	const generated = new Set<string>();
	for (const name of Object.keys(headers)) {
		if (provenance.get(name)) generated.add(name.toLowerCase());
		else generated.delete(name.toLowerCase());
	}
	return { headers, generated };
}

function buildWebSocketHeaders(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders: ProviderHeaders | undefined,
	sessionId: string | undefined,
	identity?: ClientIdentity,
): { headers: Headers; scopeHeaders: Record<string, string> } {
	const { headers: merged, generated } = buildMergedHeaders(model, context, sessionId, optionsHeaders, identity);
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
	generated.add("openai-beta");
	const scopeHeaders = headersToRecord(headers);
	for (const name of generated) delete scopeHeaders[name];
	return { headers, scopeHeaders };
}

function isSseMediaType(contentType: string | null | undefined): boolean {
	return contentType?.split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
}

function websocketIdentityKey(model: Model<"openai-responses">, headers: Headers): string {
	// Effective headers include automatic auth; an overridden API key is not part of the wire identity.
	return `${model.baseUrl}\n${JSON.stringify(headersToRecord(headers))}`;
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

/** WS frame shape: no `stream` (the socket itself streams); preserve the resolved store policy. */
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
	const transcriptTools = resolveTranscriptTools(context.messages, getResponsesToolSupport(compat));
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
