import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",

	// Sign in with ChatGPT: the subscription's shared usage limit, which resets
	// after hours rather than seconds.
	"subscription_sharing_usage_limit_exceeded",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"server_busy",
	"servers are currently busy",
	"currently experiencing high demand",
	"model is at capacity",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"520",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
	// Node ERR_HTTP2_STREAM_CANCEL: the HTTP/2 session died before the request was
	// sent, e.g. after the Bedrock SDK's 5-minute session timeout (#10379).
	"pending stream has been canceled",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",

	// Sign in with ChatGPT: usage or user data temporarily unavailable. Usage
	// failures can arrive mid-stream without an HTTP 503 in the message.
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * `maxAgentDelayMs` caps each computed delay and defaults to 60 seconds.
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`, `maxAgentDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
	/** Optional cap for agent-level retry delays in ms. Defaults to 60 seconds. */
	maxAgentDelayMs?: number;
	/**
	 * Additional case-insensitive substrings that make an error non-retryable.
	 * Matched against `AssistantMessage.errorMessage` after the built-in limit patterns.
	 */
	nonRetryableErrorPatterns?: readonly string[];
}

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;
export const CODEX_AUTO_WEBSOCKET_RETRIES = 3;

export interface AssistantRetryPlan {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	/** Agent-level budget consumed; transport recovery does not consume this budget. */
	globalAttempt: number;
}

/** Shared by agent turns and summarization so transport recovery cannot multiply their budgets. */
export function getAssistantRetryPlan(
	message: AssistantMessage,
	policy: RetryPolicy | undefined,
	globalAttempt: number,
): AssistantRetryPlan | undefined {
	if (!policy || !isRetryableAssistantError(message, policy)) return undefined;
	const failure =
		message.api === "openai-codex-responses"
			? message.diagnostics?.findLast((diagnostic) => diagnostic.type === "provider_transport_failure")?.details
			: undefined;
	if (failure?.configuredTransport === "auto") {
		if (failure.resetRetryBudget === true) globalAttempt = 0;
		const attempt = failure.retryAttempt;
		if (
			typeof attempt === "number" &&
			Number.isInteger(attempt) &&
			attempt > 0 &&
			attempt <= CODEX_AUTO_WEBSOCKET_RETRIES
		) {
			return {
				attempt,
				maxAttempts: CODEX_AUTO_WEBSOCKET_RETRIES,
				delayMs: retryDelayMs(policy, attempt),
				globalAttempt,
			};
		}
		// A started response cannot be replayed inside the provider stream. Start a new
		// assistant attempt on SSE immediately, even when ordinary retry is disabled.
		if (attempt === 0 && failure.fallbackTransport === "sse" && failure.eventsEmitted === true) {
			return { attempt: 1, maxAttempts: 1, delayMs: 0, globalAttempt };
		}
	}
	const attempt = globalAttempt + 1;
	if (!policy.enabled || attempt > policy.maxRetries) return undefined;
	return { attempt, maxAttempts: policy.maxRetries, delayMs: retryDelayMs(policy, attempt), globalAttempt: attempt };
}

export function retryDelayMs(policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}

export interface RetryClassificationOptions {
	/** Additional case-insensitive substrings that make an error non-retryable. */
	nonRetryableErrorPatterns?: readonly string[];
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined, the first response is returned unchanged. A disabled
 * policy suppresses ordinary retries, but Codex auto transport recovery with a stable
 * producer sessionId still uses its fixed WS allowance and a new SSE attempt after
 * transport exhaustion. Sessionless producers do not participate in that allowance.
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	let globalAttempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		const plan = getAssistantRetryPlan(response, policy, globalAttempt);
		if (!plan) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		globalAttempt = plan.globalAttempt;
		const { attempt, maxAttempts, delayMs } = plan;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				const { errorMessage: _errorMessage, ...rest } = response;
				return { ...rest, stopReason: "aborted" };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
function matchesNonRetryableErrorPatterns(errorMessage: string, patterns: readonly string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	const haystack = errorMessage.toLowerCase();
	for (const pattern of patterns) {
		if (typeof pattern !== "string") continue;
		const needle = pattern.trim().toLowerCase();
		if (needle.length > 0 && haystack.includes(needle)) return true;
	}
	return false;
}

export function isRetryableAssistantError(message: AssistantMessage, options?: RetryClassificationOptions): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	if (matchesNonRetryableErrorPatterns(errorMessage, options?.nonRetryableErrorPatterns)) return false;
	if (message.api === "openai-codex-responses") {
		const failure = message.diagnostics?.findLast((diagnostic) => diagnostic.type === "provider_transport_failure");
		// A prior WS failure must not classify a subsequent, possibly terminal SSE error.
		if (failure && (failure.details?.fallbackTransport !== "sse" || failure.details.eventsEmitted === true))
			return true;
	}
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
