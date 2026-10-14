import type { ResponseInput, ResponseStreamEvent } from "openai/resources/responses/responses.js";

import { registerSessionResourceCleanup } from "../session-resources.ts";
import type { Api, AssistantMessage, Model, ProviderEnv, StreamOptions } from "../types.ts";
import { formatThrownValue } from "../utils/diagnostics.ts";
import { type AssistantMessageEventStream, emitTransport } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { CODEX_AUTO_WEBSOCKET_RETRIES } from "../utils/retry.ts";

// ============================================================================
// Shared Responses WebSocket transport
//
// Connection pooling, continuation (previous_response_id + input delta) and
// auto→SSE recovery for the OpenAI Responses WebSocket protocol. Extracted
// from the Codex provider so the ordinary openai-responses adapter reuses the
// same safeguards: connect/idle timeouts, abort propagation, monotonic
// emitted-start replay protection, endpoint+credential pool partitioning and
// cooldown-probe recovery. Pools and recovery state are partitioned per
// provider scope so Codex and ordinary Responses never share sockets.
// ============================================================================

export const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;
const AUTO_SSE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

// ============================================================================
// Types
// ============================================================================

export type WebSocketEventType = "open" | "message" | "error" | "close";
export type WebSocketListener = (event: unknown) => void;

export interface WebSocketLike {
	close(code?: number, reason?: string): void;
	send(data: string): void;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

export interface WebSocketRequestBody {
	previous_response_id?: string;
	input?: ResponseInput;
	store?: boolean;
	[key: string]: unknown;
}

interface CachedWebSocketContinuationState {
	lastRequestBody: WebSocketRequestBody;
	lastResponseId: string;
	lastResponseItems: ResponseInput;
}

interface CachedWebSocketConnection {
	socket: WebSocketLike;
	busy: boolean;
	createdAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: CachedWebSocketContinuationState;
}

export interface ResponsesWebSocketDebugStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	websocketFailures: number;
	sseFallbacks: number;
	websocketFallbackActive?: boolean;
	lastWebSocketError?: string;
}

export interface WebSocketRecoveryState {
	failures: number;
	retryAt: number;
	recovering: boolean;
}

export class ResponsesApiError extends Error {
	readonly code?: string;
	readonly payload?: Record<string, unknown>;

	constructor(message: string, options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown }) {
		super(message);
		this.name = "ResponsesApiError";
		this.code = options?.code;
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

export class ResponsesProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "ResponsesProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

export class ProviderStreamEventCallbackError extends Error {
	constructor(cause: unknown) {
		super(formatThrownValue(cause));
		this.name = "ProviderStreamEventCallbackError";
		this.cause = cause;
	}
}

/**
 * Marks failures that happened at the real socket boundary: connect/handshake
 * refusal, close/error events, send failures, connect/idle timeouts, and
 * premature stream end. Only these consume the WS retry budget and SSE
 * cooldown. Arbitrary local exceptions (unserializable payloads, parser or
 * application errors) must stay unmarked so callers never promote them to
 * transport retries.
 */
export class ResponsesTransportError extends Error {
	readonly cause?: unknown;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.name = "ResponsesTransportError";
		this.cause = options?.cause;
	}
}

export function isResponsesTransportError(error: unknown): boolean {
	return error instanceof ResponsesTransportError;
}

class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
}

export function isResponsesNonTransportError(error: unknown): boolean {
	return !isResponsesTransportError(error);
}

export function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
	return error instanceof ResponsesApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

export function isPreviousResponseNotFoundError(error: unknown): boolean {
	return error instanceof ResponsesApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

export function extractEventError(event: Record<string, unknown>): { code?: string; message?: string } {
	const nested = event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>) : undefined;
	return {
		code: typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : undefined,
		message:
			typeof event.message === "string"
				? event.message
				: typeof nested?.message === "string"
					? nested.message
					: undefined,
	};
}

// ============================================================================
// Per-scope connection pools, debug stats and SSE fallback state
// ============================================================================

interface WebSocketPoolScope {
	// sessionId -> identityKey -> connection
	connections: Map<string, Map<string, CachedWebSocketConnection>>;
	debugStats: Map<string, ResponsesWebSocketDebugStats>;
	// Pi's outer retry owner retries three times before an endpoint+credential
	// identity enters SSE cooldown, partitioned per session.
	sseFallbackSessions: Map<string, Map<string, WebSocketRecoveryState>>;
}

const poolScopes = new Map<string, WebSocketPoolScope>();

function getScope(scope: string): WebSocketPoolScope {
	let entry = poolScopes.get(scope);
	if (!entry) {
		entry = { connections: new Map(), debugStats: new Map(), sseFallbackSessions: new Map() };
		poolScopes.set(scope, entry);
	}
	return entry;
}

function getOrCreateWebSocketDebugStats(scope: WebSocketPoolScope, sessionId: string): ResponsesWebSocketDebugStats {
	let stats = scope.debugStats.get(sessionId);
	if (!stats) {
		stats = {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			cachedContextRequests: 0,
			storeTrueRequests: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		};
		scope.debugStats.set(sessionId, stats);
	}
	return stats;
}

export function getResponsesWebSocketDebugStats(
	scope: string,
	sessionId: string,
): ResponsesWebSocketDebugStats | undefined {
	const entry = poolScopes.get(scope);
	const stats = entry?.debugStats.get(sessionId);
	return stats && entry
		? { ...stats, websocketFallbackActive: findActiveFallbackState(entry, sessionId) !== undefined }
		: undefined;
}

export function resetResponsesWebSocketDebugStats(scope: string, sessionId?: string): void {
	const entry = poolScopes.get(scope);
	if (!entry) return;
	if (sessionId) {
		entry.debugStats.delete(sessionId);
		entry.sseFallbackSessions.delete(sessionId);
		return;
	}
	entry.debugStats.clear();
	entry.sseFallbackSessions.clear();
}

function getIdentityRecoveryMap(
	entry: WebSocketPoolScope,
	sessionId: string,
	create: boolean,
): Map<string, WebSocketRecoveryState> | undefined {
	let map = entry.sseFallbackSessions.get(sessionId);
	if (!map && create) {
		map = new Map();
		entry.sseFallbackSessions.set(sessionId, map);
	}
	return map;
}

function findActiveFallbackState(entry: WebSocketPoolScope, sessionId: string): WebSocketRecoveryState | undefined {
	const map = entry.sseFallbackSessions.get(sessionId);
	if (!map) return undefined;
	let active: WebSocketRecoveryState | undefined;
	for (const state of map.values()) {
		if (state.retryAt > 0 || state.recovering) {
			if (!active || state.retryAt > active.retryAt) active = state;
		}
	}
	return active;
}

function closeScopeSessions(scope: string, sessionId?: string): void {
	const entry = poolScopes.get(scope);
	if (!entry) return;
	const closeEntry = (conn: CachedWebSocketConnection) => {
		if (conn.idleTimer) clearTimeout(conn.idleTimer);
		closeWebSocketSilently(conn.socket, 1000, "debug_close");
	};
	if (sessionId) {
		for (const conn of entry.connections.get(sessionId)?.values() ?? []) closeEntry(conn);
		entry.connections.delete(sessionId);
		entry.sseFallbackSessions.delete(sessionId);
		return;
	}
	for (const sessionEntries of entry.connections.values()) {
		for (const conn of sessionEntries.values()) closeEntry(conn);
	}
	entry.connections.clear();
	entry.sseFallbackSessions.clear();
}

registerSessionResourceCleanup((sessionId?: string) => {
	for (const scope of poolScopes.keys()) closeScopeSessions(scope, sessionId);
});

export function closeResponsesWebSocketSessions(scope: string, sessionId?: string): void {
	closeScopeSessions(scope, sessionId);
}

export function getWebSocketSseFallbackState(
	scope: string,
	sessionId: string,
	recoveryKey: string,
): WebSocketRecoveryState | undefined {
	return poolScopes.get(scope)?.sseFallbackSessions.get(sessionId)?.get(recoveryKey);
}

function isWebSocketSseFallbackActive(entry: WebSocketPoolScope, sessionId: string): boolean {
	return findActiveFallbackState(entry, sessionId) !== undefined;
}

export function recordWebSocketSseFallback(scope: string, sessionId: string | undefined): void {
	if (!sessionId) return;
	const entry = getScope(scope);
	const stats = getOrCreateWebSocketDebugStats(entry, sessionId);
	stats.sseFallbacks++;
	stats.websocketFallbackActive = isWebSocketSseFallbackActive(entry, sessionId);
}

export function recordWebSocketFailure(
	scope: string,
	sessionId: string | undefined,
	recoveryKey: string,
	error: unknown,
	autoFallback: boolean,
): WebSocketRecoveryState | undefined {
	if (!sessionId) return undefined;
	const entry = getScope(scope);
	let state: WebSocketRecoveryState | undefined;
	if (autoFallback) {
		const map = getIdentityRecoveryMap(entry, sessionId, true)!;
		state = map.get(recoveryKey);
		if (!state) {
			state = { failures: 0, retryAt: 0, recovering: false };
			map.set(recoveryKey, state);
		}
		state.failures++;
		if (state.retryAt > 0 || state.failures > CODEX_AUTO_WEBSOCKET_RETRIES) {
			// Preserve ownership when an older request fails during a recovery probe.
			state.retryAt = Date.now() + AUTO_SSE_COOLDOWN_MS;
		}
	}

	const stats = getOrCreateWebSocketDebugStats(entry, sessionId);
	stats.websocketFailures++;
	stats.lastWebSocketError = formatThrownValue(error);
	stats.websocketFallbackActive = isWebSocketSseFallbackActive(entry, sessionId);
	return state;
}

export function clearWebSocketSseFallbackIfOwned(
	scope: string,
	sessionId: string,
	recoveryKey: string,
	state: WebSocketRecoveryState,
): void {
	const map = poolScopes.get(scope)?.sseFallbackSessions.get(sessionId);
	if (map?.get(recoveryKey) === state) {
		map.delete(recoveryKey);
		if (map.size === 0) poolScopes.get(scope)?.sseFallbackSessions.delete(sessionId);
	}
}

// ============================================================================
// WebSocket primitives
// ============================================================================

type WebSocketConstructor = new (
	url: string,
	protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

let _cachedWebsocket: WebSocketConstructor | null = null;
async function getWebSocketConstructor(env?: ProviderEnv): Promise<WebSocketConstructor | null> {
	if (!env && _cachedWebsocket) return _cachedWebsocket;

	// bun doesn't respect http proxy envs, ref: https://github.com/oven-sh/bun/issues/15489
	// TODO: remove this when bun supports proxy envs in websocket.
	if (typeof process !== "undefined" && process.versions?.bun) {
		const WebSocketWithProxy = class extends WebSocket {
			constructor(url: string | URL, options?: string | string[] | Record<string, unknown>) {
				let _opts: Record<string, unknown> = {};
				if (Array.isArray(options) || typeof options === "string") {
					_opts = { protocols: options };
				} else {
					_opts = { ...options };
				}

				const proxyUrl = resolveHttpProxyUrlForTarget(
					url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
					env,
				);
				super(url, { ..._opts, ...(proxyUrl ? { proxy: proxyUrl.toString() } : {}) } as never);
			}
		};
		if (!env) {
			_cachedWebsocket = WebSocketWithProxy;
		}
		return WebSocketWithProxy;
	}

	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	if (typeof ctor !== "function") return null;
	return ctor as unknown as WebSocketConstructor;
}

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
	const readyState = (socket as { readyState?: unknown }).readyState;
	return typeof readyState === "number" ? readyState : undefined;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
	const readyState = getWebSocketReadyState(socket);
	// If readyState is unavailable, assume the runtime keeps it open/reusable.
	return readyState === undefined || readyState === 1;
}

function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
	return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

function scheduleSessionWebSocketExpiry(
	scope: WebSocketPoolScope,
	sessionId: string,
	identityKey: string,
	entry: CachedWebSocketConnection,
): void {
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) return;
		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		const sessionEntries = scope.connections.get(sessionId);
		if (sessionEntries?.get(identityKey) === entry) sessionEntries.delete(identityKey);
		if (sessionEntries?.size === 0) scope.connections.delete(sessionId);
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

export interface AcquireWebSocketOptions {
	scope: string;
	url: string;
	headers: Headers;
	/** Stable session id enabling connection reuse; undefined disables pooling. */
	sessionId: string | undefined;
	/**
	 * Partition key inside a session: provider-selected endpoint + effective
	 * credential/header identity. Never contains raw secret material beyond what
	 * already travels in the handshake headers.
	 */
	identityKey: string;
	signal: AbortSignal | undefined;
	connectTimeoutMs: number | undefined;
	env: ProviderEnv | undefined;
	forceFresh: boolean;
}

async function connectWebSocket(
	url: string,
	headers: Headers,
	signal?: AbortSignal,
	connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
	env?: ProviderEnv,
): Promise<WebSocketLike> {
	const WebSocketCtor = await getWebSocketConstructor(env);
	if (!WebSocketCtor) {
		// Missing WebSocket global is a runtime/environment limitation, not a
		// socket failure — leave it unmarked so callers fall back or fail fast
		// without consuming the transport retry budget.
		throw new ResponsesTransportError("WebSocket transport is not available in this runtime");
	}

	const wsHeaders = headersToRecord(headers);
	delete wsHeaders["OpenAI-Beta"];

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let socket: WebSocketLike;

		try {
			socket = new WebSocketCtor(url, { headers: wsHeaders });
		} catch (error) {
			// A synchronous ctor throw is usually a config/programming error
			// (bad URL, unsupported protocols arg), not a network failure — leave
			// it unmarked so it never consumes the transport retry budget.
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error, closeReason?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (closeReason) {
				closeWebSocketSilently(socket, 1000, closeReason);
			}
			reject(error);
		};
		const onOpen: WebSocketListener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: WebSocketListener = (event) => {
			fail(new ResponsesTransportError(extractWebSocketError(event).message, { cause: event }));
		};
		const onClose: WebSocketListener = (event) => {
			fail(new ResponsesTransportError(extractWebSocketCloseError(event).message, { cause: event }));
		};
		const onAbort = () => {
			fail(new Error("Request was aborted"), "aborted");
		};

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);

		if (connectTimeoutMs > 0) {
			timeout = setTimeout(() => {
				fail(
					new ResponsesTransportError(`WebSocket connect timeout after ${connectTimeoutMs}ms`),
					"connect_timeout",
				);
			}, connectTimeoutMs);
		}
		if (signal?.aborted) {
			onAbort();
		}
	});
}

export async function acquireWebSocket(options: AcquireWebSocketOptions): Promise<{
	socket: WebSocketLike;
	entry?: CachedWebSocketConnection;
	reused: boolean;
	release: (options?: { keep?: boolean }) => void;
}> {
	const {
		scope: scopeName,
		url,
		headers,
		sessionId,
		identityKey,
		signal,
		connectTimeoutMs,
		env,
		forceFresh,
	} = options;
	const scope = getScope(scopeName);
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
		return {
			socket,
			reused: false,
			release: () => closeWebSocketSilently(socket),
		};
	}

	let sessionEntries = scope.connections.get(sessionId);
	const cached = sessionEntries?.get(identityKey);
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = undefined;
		}
		if (!cached.busy && (forceFresh || isWebSocketSessionExpired(cached))) {
			closeWebSocketSilently(cached.socket, 1000, forceFresh ? "recovery" : "connection_age_limit");
			sessionEntries?.delete(identityKey);
			if (sessionEntries?.size === 0) scope.connections.delete(sessionId);
		} else if (!cached.busy && isWebSocketReusable(cached.socket)) {
			cached.busy = true;
			return {
				socket: cached.socket,
				entry: cached,
				reused: true,
				release: ({ keep } = {}) => {
					if (!keep || !isWebSocketReusable(cached.socket)) {
						closeWebSocketSilently(cached.socket);
						const currentEntries = scope.connections.get(sessionId);
						if (currentEntries?.get(identityKey) === cached) currentEntries.delete(identityKey);
						if (currentEntries?.size === 0) scope.connections.delete(sessionId);
						return;
					}
					cached.busy = false;
					scheduleSessionWebSocketExpiry(scope, sessionId, identityKey, cached);
				},
			};
		}
		if (cached.busy) {
			const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
			return {
				socket,
				reused: false,
				release: () => {
					closeWebSocketSilently(socket);
				},
			};
		}
		if (!isWebSocketReusable(cached.socket)) {
			closeWebSocketSilently(cached.socket);
			sessionEntries?.delete(identityKey);
			if (sessionEntries?.size === 0) scope.connections.delete(sessionId);
		}
	}

	const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
	const entry: CachedWebSocketConnection = { socket, busy: true, createdAt: Date.now() };
	sessionEntries = scope.connections.get(sessionId);
	if (!sessionEntries) {
		sessionEntries = new Map();
		scope.connections.set(sessionId, sessionEntries);
	}
	sessionEntries.set(identityKey, entry);
	return {
		socket,
		entry,
		reused: false,
		release: ({ keep } = {}) => {
			if (!keep || !isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				const currentEntries = scope.connections.get(sessionId);
				if (currentEntries?.get(identityKey) === entry) currentEntries.delete(identityKey);
				if (currentEntries?.size === 0) scope.connections.delete(sessionId);
				return;
			}
			entry.busy = false;
			scheduleSessionWebSocketExpiry(scope, sessionId, identityKey, entry);
		},
	};
}

function extractWebSocketError(event: unknown): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		if (typeof message === "string" && message.length > 0) {
			return new Error(message);
		}

		const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
		if (nestedError instanceof Error && nestedError.message.length > 0) {
			return nestedError;
		}
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			const nestedMessage = (nestedError as { message?: unknown }).message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
				return new Error(nestedMessage);
			}
		}
	}
	return new Error("WebSocket error");
}

function extractWebSocketCloseError(event: unknown): Error {
	if (event && typeof event === "object") {
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const wasClean = "wasClean" in event ? (event as { wasClean?: unknown }).wasClean : undefined;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
			reasonText = " message too big";
		}
		return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
			code: typeof code === "number" ? code : undefined,
			reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
			wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
		});
	}
	return new Error("WebSocket closed");
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
		const arrayBuffer = await blobLike.arrayBuffer();
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	return null;
}

export async function* parseWebSocket(
	socket: WebSocketLike,
	signal?: AbortSignal,
	idleTimeoutMs?: number,
): AsyncGenerator<Record<string, unknown>> {
	const queue: Record<string, unknown>[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawCompletion = false;

	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};

	const onMessage: WebSocketListener = (event) => {
		void (async () => {
			let text: string | null = null;
			try {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				text = await decodeWebSocketData((event as { data?: unknown }).data);
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				const type = typeof parsed.type === "string" ? parsed.type : "";
				if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
					sawCompletion = true;
					done = true;
				}
				queue.push(parsed);
				wake();
			} catch (cause) {
				failed = new ResponsesProtocolError(`Invalid Responses WebSocket JSON: ${formatThrownValue(cause)}`, {
					cause,
					payload: text,
				});
				done = true;
				wake();
			}
		})();
	};

	const onError: WebSocketListener = (event) => {
		failed = new ResponsesTransportError(extractWebSocketError(event).message, { cause: event });
		done = true;
		wake();
	};

	const onClose: WebSocketListener = (event) => {
		if (sawCompletion) {
			done = true;
			wake();
			return;
		}
		if (!failed) {
			failed = new ResponsesTransportError(extractWebSocketCloseError(event).message, { cause: event });
		}
		done = true;
		wake();
	};

	const onAbort = () => {
		failed = new Error("Request was aborted");
		done = true;
		wake();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (queue.length > 0) {
				yield queue.shift()!;
				continue;
			}
			if (done) break;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			await new Promise<void>((resolve, reject) => {
				pending = resolve;
				if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
					timeout = setTimeout(() => {
						const error = new ResponsesTransportError(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
						failed = error;
						done = true;
						pending = null;
						closeWebSocketSilently(socket, 1000, "idle_timeout");
						reject(error);
					}, idleTimeoutMs);
				}
			}).finally(() => {
				if (timeout) {
					clearTimeout(timeout);
				}
			});
		}

		if (failed) {
			throw failed;
		}
		if (!sawCompletion) {
			throw new ResponsesTransportError("WebSocket stream closed before response.completed");
		}
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}

// ============================================================================
// Continuation (cached-context) handling
// ============================================================================

function requestBodyWithoutInput(body: WebSocketRequestBody): WebSocketRequestBody {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function requestBodiesMatchExceptInput(a: WebSocketRequestBody, b: WebSocketRequestBody): boolean {
	return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

function getCachedWebSocketInputDelta(
	body: WebSocketRequestBody,
	continuation: CachedWebSocketContinuationState,
): ResponseInput | undefined {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		return undefined;
	}

	const currentInput = body.input ?? [];
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	if (currentInput.length < baseline.length) {
		return undefined;
	}

	const prefix = currentInput.slice(0, baseline.length);
	if (!responseInputsEqual(prefix, baseline)) {
		return undefined;
	}

	return currentInput.slice(baseline.length);
}

function buildCachedWebSocketRequestBody(
	entry: CachedWebSocketConnection,
	body: WebSocketRequestBody,
): WebSocketRequestBody {
	const continuation = entry.continuation;
	if (!continuation) {
		return body;
	}

	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (!delta || delta.length === 0 || !continuation.lastResponseId) {
		entry.continuation = undefined;
		return body;
	}

	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: delta,
	};
}

// ============================================================================
// Shared WebSocket request driver
// ============================================================================

export interface ProcessResponsesWebSocketOptions<TApi extends Api> {
	scope: string;
	url: string;
	body: WebSocketRequestBody;
	headers: Headers;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	model: Model<TApi>;
	/** Invoked when the first provider stream event arrives (before push of start). */
	onStart: () => void;
	/** Invoked when the actual transport becomes known: acquired socket, loss, or stream end. */
	onTransport?: (transport: string | undefined, model: Model<TApi>) => void | Promise<void>;
	/** Recovery/cooldown partition key used by callers when passing fallback
	 * state; recorded failures are keyed by the caller's own recoveryKey. */
	recoveryKey?: string;
	idleTimeoutMs: number | undefined;
	connectTimeoutMs: number | undefined;
	cacheSessionId: string | undefined;
	identityKey: string;
	/** Maps raw socket events into SDK-shaped ResponseStreamEvents. */
	mapEvents: (events: AsyncIterable<Record<string, unknown>>) => AsyncIterable<ResponseStreamEvent>;
	processStream: (
		events: AsyncIterable<ResponseStreamEvent>,
		output: AssistantMessage,
		stream: AssistantMessageEventStream,
		model: Model<TApi>,
	) => Promise<void>;
	/** Response items produced by this turn, appended to the continuation baseline. */
	getResponseItems: () => ResponseInput;
	/**
	 * Terminal non-success outcomes (error/aborted stop reasons, content-filter
	 * incompletes, provider-asserted failures). Responses that end this way never
	 * become the cached continuation baseline; the next request sends full input.
	 */
	isTerminalError?: (output: AssistantMessage) => boolean;
	forceFresh: boolean;
	options?: StreamOptions;
}

export async function processResponsesWebSocket<TApi extends Api>(
	config: ProcessResponsesWebSocketOptions<TApi>,
): Promise<void> {
	const {
		scope,
		url,
		body,
		headers,
		output,
		stream,
		model,
		onStart,
		onTransport,
		idleTimeoutMs,
		connectTimeoutMs,
		cacheSessionId,
		identityKey,
		mapEvents,
		processStream,
		getResponseItems,
		forceFresh,
		options,
	} = config;
	const { socket, entry, reused, release } = await acquireWebSocket({
		scope,
		url,
		headers,
		sessionId: cacheSessionId,
		identityKey,
		signal: options?.signal,
		connectTimeoutMs,
		env: options?.env,
		forceFresh,
	});
	let keepConnection = true;
	let transportCleared = true;
	const clearTransport = async () => {
		if (transportCleared) return;
		transportCleared = true;
		await emitTransport(onTransport, undefined, model);
	};
	await emitTransport(onTransport, "WS", model);
	transportCleared = false;
	const transport = options?.transport ?? "auto";
	const useCachedContext = transport === "websocket-cached" || transport === "auto";
	// A fresh socket never carries continuation state. Strip any
	// caller-injected previous_response_id unconditionally; only the
	// connection's own validated continuation may add it back below.
	const fullBody = { ...body };
	delete fullBody.previous_response_id;
	const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
	const stats = cacheSessionId ? getOrCreateWebSocketDebugStats(getScope(scope), cacheSessionId) : undefined;
	if (stats) {
		stats.requests++;
		if (reused) stats.connectionsReused++;
		else stats.connectionsCreated++;
		if (useCachedContext) stats.cachedContextRequests++;
		if (requestBody.store === true) stats.storeTrueRequests++;
		stats.lastInputItems = requestBody.input?.length ?? 0;
		if (requestBody.previous_response_id) {
			stats.deltaRequests++;
			stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
			stats.lastPreviousResponseId = requestBody.previous_response_id;
		} else {
			stats.fullContextRequests++;
			stats.lastDeltaInputItems = undefined;
			stats.lastPreviousResponseId = undefined;
		}
	}
	try {
		// Serialize outside the send boundary: an unserializable caller payload
		// (BigInt, circular refs) is a local application failure, not a socket
		// failure, and stays unmarked so it never consumes the transport budget.
		const frame = JSON.stringify({ type: "response.create", ...requestBody });
		try {
			socket.send(frame);
		} catch (error) {
			throw new ResponsesTransportError(formatThrownValue(error), { cause: error });
		}
		let started = false;
		const events = mapEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs));
		const startedEvents = (async function* (): AsyncGenerator<ResponseStreamEvent> {
			for await (const event of events) {
				if (!started) {
					started = true;
					onStart();
				}
				yield event;
			}
		})();
		await processStream(startedEvents, output, stream, model);
		if (options?.signal?.aborted) {
			keepConnection = false;
			await clearTransport();
		} else if (output.responseId) {
			if (config.isTerminalError?.(output)) {
				// Terminal failures never become the delta baseline, and the socket
				// is not retained: the connection-scoped server state is poisoned.
				if (entry) entry.continuation = undefined;
				keepConnection = false;
				await clearTransport();
			} else if (useCachedContext && entry) {
				entry.continuation = {
					lastRequestBody: fullBody,
					lastResponseId: output.responseId,
					lastResponseItems: getResponseItems(),
				};
			}
		}
	} catch (error) {
		if (entry) {
			entry.continuation = undefined;
		}
		keepConnection = false;
		await clearTransport();
		throw error;
	} finally {
		release({ keep: keepConnection });
	}
}

export function normalizeWebSocketTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid timeoutMs: ${String(value)}`);
	}
	return Math.floor(value);
}

export const DEFAULT_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
