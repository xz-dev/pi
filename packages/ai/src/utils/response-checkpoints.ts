/**
 * Adapter-neutral Response checkpoint kernel (v1).
 *
 * Contract: see CONTRACT-v1.md ("Response checkpoint contract v1"). This file
 * is deliberately free of Pi SDK, Node, filesystem and socket dependencies so
 * the same implementation can be copied into the standalone plugin without a
 * fork runtime dependency. Hashing uses browser-compatible Web Crypto SHA-256.
 *
 * A checkpoint binds an `AssistantMessage.responseId` to the exact encoded
 * input prefix (full request input + the SDK-encoded items of that response)
 * plus the request envelope and destination/account scope. On a later request
 * — including a new connection or reloaded session — a still-valid checkpoint
 * turns the full local history into `previous_response_id` plus only the new
 * trailing input items.
 *
 * The full local history stays canonical: checkpoint metadata is an expendable
 * optimization. Any malformed, stale, mismatched or incomplete candidate simply
 * yields no plan and the caller sends its unchanged full request.
 */

// ============================================================================
// Persisted v1 metadata (stored on AssistantMessage.responseCheckpoint)
// ============================================================================

export const RESPONSE_CHECKPOINT_VERSION = 1;

export interface ResponseCheckpoint {
	version: 1;
	/** SHA-256 hex of the effective origin/protocol/account/adapter identity. */
	scopeHash: string;
	/** SHA-256 hex of the canonical request envelope (everything except input/parent/stream/type). */
	requestHash: string;
	/** SHA-256 hex of [responseId, complete encoded input prefix]. */
	prefixHash: string;
	/** Length of that complete encoded prefix (full request input + encoded response items). */
	inputCount: number;
	/** Local Unix milliseconds when the completed capture happened. */
	createdAt: number;
	/** Known service/receipt expiry in Unix milliseconds; not an invented universal TTL. */
	expiresAt?: number;
}

// ============================================================================
// Canonical JSON + SHA-256
// ============================================================================

/**
 * Deterministic JSON: object keys sorted recursively, array order and every
 * semantic value preserved. Non-JSON values (functions, symbols, bigint) are
 * rendered through their typeof tag so hashing never throws and stays
 * deterministic for caller-provided envelopes.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	const type = typeof value;
	if (type === "number") {
		// Canonicalize NaN/Infinity to null like JSON.stringify does, so the
		// digest matches what would actually be sent on the wire.
		return Number.isFinite(value as number) ? value : null;
	}
	if (type === "string" || type === "boolean") return value;
	if (type === "bigint") return { $bigint: (value as bigint).toString() };
	if (type === "function" || type === "symbol" || type === "undefined") return null;
	if (Array.isArray(value)) return value.map(canonicalize);
	if (type === "object") {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			const item = record[key];
			if (item === undefined) continue;
			out[key] = canonicalize(item);
		}
		return out;
	}
	return null;
}

/** SHA-256 hex of a string via Web Crypto (works in Node >= 20 and browsers). */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashCanonical(value: unknown): Promise<string> {
	return sha256Hex(canonicalJson(value));
}

// ============================================================================
// Scope and request-envelope fingerprints
// ============================================================================

/** Request fields excluded from the envelope fingerprint (wire framing + the varying input). */
const ENVELOPE_EXCLUDED_KEYS = new Set(["input", "previous_response_id", "stream", "type"]);

/**
 * SHA-256 of the request envelope: the canonical full request except `input`,
 * `previous_response_id`, `stream` and `type`. Model, instructions, tools,
 * reasoning/sampling settings, `store` and all other request parameters are
 * included conservatively — changing any of them invalidates the checkpoint.
 */
export async function requestEnvelopeHash(request: Record<string, unknown>): Promise<string> {
	const envelope: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(request)) {
		if (!ENVELOPE_EXCLUDED_KEYS.has(key)) envelope[key] = value;
	}
	return hashCanonical(envelope);
}

/**
 * SHA-256 of the prefix binding: `[responseId, [...encodedInputPrefix]]`.
 * The responseId element binds the existing message field without duplicating
 * its value inside the persisted metadata.
 */
export async function checkpointPrefixHash(responseId: string, encodedPrefix: readonly unknown[]): Promise<string> {
	return hashCanonical([responseId, encodedPrefix]);
}

// ============================================================================
// Metadata shape validation (fail-closed)
// ============================================================================

const HEX_64 = /^[0-9a-f]{64}$/;

/** Type guard: structural validation of persisted v1 metadata. */
export function isResponseCheckpoint(value: unknown): value is ResponseCheckpoint {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== RESPONSE_CHECKPOINT_VERSION) return false;
	if (typeof candidate.scopeHash !== "string" || !HEX_64.test(candidate.scopeHash)) return false;
	if (typeof candidate.requestHash !== "string" || !HEX_64.test(candidate.requestHash)) return false;
	if (typeof candidate.prefixHash !== "string" || !HEX_64.test(candidate.prefixHash)) return false;
	if (typeof candidate.inputCount !== "number" || !Number.isInteger(candidate.inputCount)) return false;
	if (candidate.inputCount < 0) return false;
	if (typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt)) return false;
	if (candidate.createdAt < 0) return false;
	if (candidate.expiresAt !== undefined) {
		if (typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt)) return false;
	}
	return true;
}

// ============================================================================
// Capture
// ============================================================================

export interface CaptureCheckpointParams {
	/**
	 * The original FULL request the adapter sent (never the trimmed wire
	 * delta). Used for the envelope hash; its `input` is the prefix baseline.
	 */
	request: Record<string, unknown>;
	/** Provider response id carried on AssistantMessage.responseId. */
	responseId: string;
	/**
	 * The encoded input prefix the checkpoint covers. The adapter supplies
	 * exactly `[...request.input, ...encodedResponseItems]` — the same items
	 * its SDK will reconstruct for this assistant message next turn.
	 */
	encodedPrefix: readonly unknown[];
	/** Destination/account/adapter scope digest produced by the adapter. */
	scopeHash: string;
	/** Server-confirmed completion (non-error, non-aborted, non-incomplete). */
	completed: boolean;
	/**
	 * Server-side durable storage state. An explicit store:false (or a missing
	 * capability) means no cross-connection hydration; never capture.
	 */
	stored: boolean;
	/**
	 * Whether the caller's local encoded history is independently complete
	 * (contains the whole turn lineage, not a caller-owned parent-only delta).
	 */
	fullHistory: boolean;
	/** Local Unix milliseconds at capture time. */
	now: number;
	/** Known service/receipt expiry, if the adapter learned one. */
	expiresAt?: number;
}

/**
 * Build v1 checkpoint metadata for a completed stored response, or return
 * undefined when any eligibility condition fails. The returned object is small:
 * hashes, a count and times only — never input, output or credential material.
 */
export async function captureCheckpoint(params: CaptureCheckpointParams): Promise<ResponseCheckpoint | undefined> {
	if (!params.completed || !params.stored || !params.fullHistory) return undefined;
	if (typeof params.responseId !== "string" || params.responseId.length === 0) return undefined;
	const input = Array.isArray(params.request.input) ? (params.request.input as unknown[]) : undefined;
	if (!input || params.encodedPrefix.length < input.length) return undefined;
	const [requestHash, prefixHash] = await Promise.all([
		requestEnvelopeHash(params.request),
		checkpointPrefixHash(params.responseId, params.encodedPrefix),
	]);
	return {
		version: RESPONSE_CHECKPOINT_VERSION,
		scopeHash: params.scopeHash,
		requestHash,
		prefixHash,
		inputCount: params.encodedPrefix.length,
		createdAt: params.now,
		...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
	};
}

// ============================================================================
// Selection / planning
// ============================================================================

/**
 * Input item types that prove the item is new user/system/developer input or a
 * tool result rather than a partially reconstructed assistant output.
 * Encoded Responses input distinguishes assistant output by `role:"assistant"`
 * on message items plus output-only item types.
 */
function isAssistantOrOpaqueOutputItem(item: unknown): boolean {
	if (!item || typeof item !== "object") return true; // unknown shape: unsafe
	const record = item as Record<string, unknown>;
	const type = record.type;
	// Output-only / opaque items can never be fresh caller input.
	if (
		type === "reasoning" ||
		type === "function_call" ||
		type === "custom_tool_call" ||
		type === "local_shell_call" ||
		type === "computer_call" ||
		type === "mcp_call" ||
		type === "mcp_list_tools" ||
		type === "mcp_approval_request" ||
		type === "image_generation_call" ||
		type === "code_interpreter_call" ||
		type === "file_search_call" ||
		type === "web_search_call" ||
		type === "output_text" ||
		type === "refusal"
	) {
		return true;
	}
	if (type === "message" || type === undefined) {
		// Encoded assistant messages keep role:"assistant"; user/system/developer
		// messages are fresh input. Unknown roles are unsafe to continue from.
		return record.role === "assistant";
	}
	// function_call_output / custom_tool_call_output / item_reference and other
	// non-message input items are safe continuation tails.
	return false;
}

/** Output item types capture can encode faithfully; anything else declines. */
const CAPTURABLE_OUTPUT_TYPES = new Set(["message", "function_call", "custom_tool_call", "reasoning"]);

/** Compare terminal output to the actual next-turn SDK encoding, not item counts. */
export function responseOutputItemsCapturable(
	items: readonly unknown[] | undefined,
	encodedItems: readonly unknown[],
): boolean {
	if (!items || items.length === 0 || items.length !== encodedItems.length) return false;
	return items.every((item, index) => {
		if (!item || typeof item !== "object") return false;
		const record = item as Record<string, unknown>;
		if (typeof record.id !== "string" || record.id.length === 0) return false;
		if (typeof record.type !== "string" || !CAPTURABLE_OUTPUT_TYPES.has(record.type)) return false;
		if (record.type === "function_call" || record.type === "custom_tool_call") {
			// The converter omits only tool execution status; IDs, argument bytes,
			// namespace and custom input must survive unchanged.
			const { status, ...content } = record;
			if (status !== undefined && status !== "completed") return false;
			return canonicalJson(content) === canonicalJson(encodedItems[index]);
		}
		return canonicalJson(normalizeOutputText(record)) === canonicalJson(normalizeOutputText(encodedItems[index]));
	});
}

/** Ignore logprobs metadata and equate omitted annotations with the SDK's empty list. */
function normalizeOutputText(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (record.type !== "message" || !Array.isArray(record.content)) return record;
	return {
		...record,
		content: record.content.map((part) => {
			if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "output_text") return part;
			const { logprobs: _logprobs, ...rest } = part as Record<string, unknown>;
			return rest.annotations === undefined ? { ...rest, annotations: [] } : rest;
		}),
	};
}

/** Raw response.output of a completed response, as a generic record. */
export function responseEventOutput(
	event: Record<string, unknown>,
): { id: string; output: unknown[]; store: boolean | undefined } | undefined {
	if (event.type !== "response.completed") return undefined;
	const response = event.response;
	if (!response || typeof response !== "object") return undefined;
	const record = response as Record<string, unknown>;
	if (record.status !== "completed" || record.error != null || record.incomplete_details != null) return undefined;
	if (typeof record.id !== "string" || record.id.length === 0) return undefined;
	if (!Array.isArray(record.output)) return undefined;
	return {
		id: record.id,
		output: record.output,
		store: typeof record.store === "boolean" ? record.store : undefined,
	};
}

export interface CheckpointCandidate {
	/** AssistantMessage.responseId of the most recent assistant on the active branch. */
	responseId: string;
	/** Persisted metadata from the same message, opaque to this planner. */
	responseCheckpoint?: unknown;
}

export interface PlanCheckpointParams {
	/** Current FULL request body (original local history already encoded). */
	request: Record<string, unknown>;
	/** Active-branch candidate; prefer the most recent assistant checkpoint. */
	candidate: CheckpointCandidate;
	/** Scope digest for the current request. */
	scopeHash: string;
	/** Current time in Unix milliseconds. */
	now: number;
	/** Resolved feature eligibility (exclusion match, capability, transport). */
	eligible: boolean;
}

export interface CheckpointPlan {
	/** Request to send: same envelope, previous_response_id + trailing input only. */
	request: Record<string, unknown>;
	/** The response id placed on previous_response_id. */
	previousResponseId: string;
	/** Number of leading input items covered by the checkpoint. */
	matchedInputCount: number;
}

/**
 * Validate one active-branch candidate and, when everything matches, return a
 * continuation request carrying `previous_response_id` plus only the remaining
 * input items. Returns undefined on any mismatch — the caller sends its
 * unchanged full request.
 *
 * Never mutates the request or the candidate. An empty delta yields no plan
 * (existing behavior). A caller-injected `previous_response_id` owns the
 * request; the planner refuses to layer over it.
 */
export async function planCheckpoint(params: PlanCheckpointParams): Promise<CheckpointPlan | undefined> {
	if (!params.eligible) return undefined;
	const request = params.request;
	if (typeof request.previous_response_id === "string" && request.previous_response_id.length > 0) {
		// Caller-owned parent: never strip or layer another plan over it.
		return undefined;
	}
	const meta = params.candidate.responseCheckpoint;
	if (!isResponseCheckpoint(meta)) return undefined;
	if (meta.scopeHash !== params.scopeHash) return undefined;
	if (meta.expiresAt !== undefined && meta.expiresAt <= params.now) return undefined;
	const input = request.input;
	if (!Array.isArray(input)) return undefined;
	if (input.length <= meta.inputCount) return undefined; // empty or negative delta
	const requestHash = await requestEnvelopeHash(request);
	if (requestHash !== meta.requestHash) return undefined;
	const prefix = input.slice(0, meta.inputCount);
	const prefixHash = await checkpointPrefixHash(params.candidate.responseId, prefix);
	if (prefixHash !== meta.prefixHash) return undefined;
	const delta = input.slice(meta.inputCount);
	if (delta.some(isAssistantOrOpaqueOutputItem)) {
		// Partial SDK reconstruction guard: the next item after a matched prefix
		// is still assistant/opaque output, so this candidate did not capture a
		// complete turn. Fall back to the full request.
		return undefined;
	}
	return {
		request: { ...request, previous_response_id: params.candidate.responseId, input: delta },
		previousResponseId: params.candidate.responseId,
		matchedInputCount: meta.inputCount,
	};
}
