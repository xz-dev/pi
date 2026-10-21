/**
 * Durable response checkpoint integration: real SDK openai-responses stream →
 * v1 metadata on the assistant message → JSONL persistence → NEW WebSocket
 * connection → previous_response_id + exact trailing delta only.
 *
 * Fixtures emulate the documented official service: WS endpoint that honors
 * store:true by hydrating response state across connections. No live provider.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAIResponsesWebSocketSessions,
	resetOpenAIResponsesWebSocketDebugStats,
	stream,
	streamSimple,
} from "../src/api/openai-responses.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { recordCheckpointCooldown, resolveCheckpointCooldown } from "../src/api/openai-responses-websocket.ts";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Model, ProviderHeaders } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { jsonRequestBody } from "./utils/request-body.ts";

const OFFICIAL_URL = "https://api.openai.com/v1";
const CUSTOM_URL = "https://checkpoint-gateway.example.com/v1";

function makeModel(baseUrl: string, compat?: Model<"openai-responses">["compat"]): Model<"openai-responses"> {
	return {
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "openai-responses",
		provider: baseUrl === OFFICIAL_URL ? "openai" : "checkpoint-gw",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...(compat ? { compat } : {}),
	};
}

const apiKey = "sk-checkpoint-key";
const sessionId = "checkpoint-ws";

afterEach(() => {
	closeOpenAIResponsesWebSocketSessions();
	resetOpenAIResponsesWebSocketDebugStats();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

interface SentFrame {
	connection: number;
	input?: unknown[];
	previous_response_id?: string;
	store?: boolean;
	model?: string;
}

interface StoredResponse {
	id: string;
	output: unknown[];
}

/**
 * Server: keeps a store of completed responses keyed by account. Honors
 * previous_response_id by resolving it through stored state (across
 * connections) — the documented store:true hydration behavior.
 */
function checkpointServer(opts?: {
	failStore?: boolean;
	expireIds?: boolean;
	connectError?: () => boolean;
	onRequest?: (
		socket: { emit: (event: Record<string, unknown>) => void; fail: () => void },
		frame: SentFrame,
	) => boolean;
	events?: (events: Record<string, unknown>[]) => Record<string, unknown>[];
}) {
	const sent: SentFrame[] = [];
	const sockets: MockSocket[] = [];
	const generations: string[] = [];
	const stored = new Map<string, Map<string, StoredResponse>>(); // account -> id -> response
	let counter = 0;

	const accountOf = (headers: Record<string, string>) =>
		(headers.authorization ?? headers["cf-aig-authorization"] ?? "anon").slice(-8);

	class MockSocket extends EventTarget {
		readyState = 1;
		readonly connection = sockets.length + 1;
		readonly account: string;
		readonly headers: Record<string, string>;
		constructor(_url: string, protocols?: string | string[] | { headers?: Record<string, string> }) {
			super();
			sockets.push(this);
			this.headers =
				protocols && typeof protocols === "object" && !Array.isArray(protocols) ? (protocols.headers ?? {}) : {};
			this.account = accountOf(this.headers);
			if (!stored.has(this.account)) stored.set(this.account, new Map());
			queueMicrotask(() => {
				if (opts?.connectError?.()) this.fail();
				else this.dispatchEvent(new Event("open"));
			});
		}
		send(data: string): void {
			const frame = JSON.parse(data) as SentFrame;
			frame.connection = this.connection;
			sent.push(frame);
			queueMicrotask(() => this.respond(frame));
		}
		respond(frame: SentFrame): void {
			if (opts?.onRequest?.(this, frame)) return;
			const accountStore = stored.get(this.account)!;
			if (frame.previous_response_id) {
				const parent = opts?.expireIds ? undefined : accountStore.get(frame.previous_response_id);
				if (!parent) {
					this.emit({
						type: "error",
						error: { code: "previous_response_not_found", message: "No such response" },
					});
					return;
				}
			}
			counter++;
			const id = `resp_srv_${counter}`;
			const generation = `gen_${counter}`;
			generations.push(generation);
			const item = {
				type: "message",
				id: `msg_srv_${counter}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: `assistant ${generation}`, annotations: [] }],
			};
			const events: Record<string, unknown>[] = [
				{ type: "response.created", response: { id } },
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...item, content: [], status: "in_progress" },
				},
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.completed",
					response: { id, status: "completed", output: [item], store: !opts?.failStore },
				},
			];
			for (const event of opts?.events?.(events) ?? events) this.emit(event);
			if (frame.store === true && !opts?.failStore) {
				accountStore.set(id, { id, output: [item] });
			}
		}
		emit(event: Record<string, unknown>): void {
			this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
		}
		fail(): void {
			this.dispatchEvent(Object.assign(new Event("error"), { message: "socket dropped" }));
		}
		close(): void {
			this.readyState = 3;
		}
	}

	vi.stubGlobal("WebSocket", MockSocket);
	const fetchMock = vi.fn<typeof fetch>(async () => new Response("unexpected", { status: 500 }));
	vi.stubGlobal("fetch", fetchMock);
	return { sent, sockets, generations, stored, fetchMock };
}

const userMsg = (text: string, timestamp: number) => ({ role: "user" as const, content: text, timestamp });
const ctx1 = normalizeContext({ messages: [userMsg("Hello", 1)] });

const OPTS = { apiKey, sessionId, responseCheckpointExclude: [] as string[] };

describe("durable response checkpoint entry policy", () => {
	it.each([
		["openai/{gpt-5.5,gpt-6}", "gpt-5.5", false],
		["OPENAI/GPT-[56].5", "gpt-5.5", false],
		["gpt-?.5", "gpt-5.5", false],
		["OPENAI", "gpt-5.5", false],
		["*", "nested/gpt-5.5", false],
		["openai/*", "nested/gpt-5.5", true],
		["openai/**", "nested/gpt-5.5", false],
		["nested/*", "nested/gpt-5.5", false],
	])("minimatch %s against %s gives store:%s", async (pattern, id, store) => {
		const { sent } = checkpointServer();
		const out = await stream({ ...makeModel(OFFICIAL_URL), id }, ctx1, {
			...OPTS,
			responseCheckpointExclude: [pattern],
		}).result();
		expect(out.stopReason).toBe("stop");
		expect(sent[0].store).toBe(store);
	});

	it.each([undefined, []])("absent/empty exclusion enables storage: %j", async (exclude) => {
		const { sent } = checkpointServer();
		const out = await stream(makeModel(OFFICIAL_URL), ctx1, {
			...OPTS,
			responseCheckpointExclude: exclude,
		}).result();
		expect(out.stopReason).toBe("stop");
		expect(sent[0].store).toBe(true);
	});

	it.each([null, "*", [null], ["unrelated", 1], [undefined], new Array(1), {}])(
		"malformed exclusion %j never enables storage",
		async (exclude) => {
			const { sent } = checkpointServer();
			const out = await stream(makeModel(OFFICIAL_URL), ctx1, {
				...OPTS,
				responseCheckpointExclude: exclude as unknown as string[],
			}).result();
			expect(out.stopReason).toBe("stop");
			expect(sent[0].store).toBe(false);
			expect(out.responseCheckpoint).toBeUndefined();
		},
	);

	for (const source of ["model", "options"] as const) {
		it.each(["session_id", "x-session-id", "x-client-request-id", "x-session-affinity", "user-agent"])(
			`${source} %s identifies tenant even when named like generated framing`,
			async (name) => {
				const { sent, sockets } = checkpointServer();
				const model = makeModel(CUSTOM_URL, { supportsResponseCheckpoints: true });
				const firstHeaders = { [name.toUpperCase()]: "tenant-A" };
				const secondHeaders = { [name.toUpperCase()]: "tenant-B" };
				const first = await stream({ ...model, ...(source === "model" ? { headers: firstHeaders } : {}) }, ctx1, {
					...OPTS,
					sessionId: undefined,
					...(source === "options" ? { headers: firstHeaders } : {}),
				}).result();
				expect(first.responseCheckpoint).toBeDefined();
				closeOpenAIResponsesWebSocketSessions();
				await stream(
					{ ...model, ...(source === "model" ? { headers: secondHeaders } : {}) },
					normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] }),
					{ ...OPTS, sessionId: undefined, ...(source === "options" ? { headers: secondHeaders } : {}) },
				).result();
				expect(sockets.map((socket) => socket.headers[name])).toEqual(["tenant-A", "tenant-B"]);
				expect(sent).toHaveLength(2);
				expect(sent[1].previous_response_id).toBeUndefined();
				expect(sent[1].input).toHaveLength(3);
			},
		);
	}

	it("caller affinity overrides remain identity even when equal to generated values", async () => {
		const { sent, sockets } = checkpointServer();
		const model = makeModel(CUSTOM_URL, { supportsResponseCheckpoints: true });
		const first = await stream(model, ctx1, { ...OPTS, headers: { SESSION_ID: sessionId } }).result();
		closeOpenAIResponsesWebSocketSessions();
		await stream(model, normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] }), {
			...OPTS,
			headers: { SESSION_ID: "tenant-B" },
		}).result();
		expect(sockets.map((socket) => socket.headers.session_id)).toEqual([sessionId, "tenant-B"]);
		expect(sent).toHaveLength(2);
		expect(sent[1].previous_response_id).toBeUndefined();
	});

	it("unused API-key changes do not invalidate an unchanged wire credential", async () => {
		const { sent } = checkpointServer();
		const model = makeModel(CUSTOM_URL, { supportsResponseCheckpoints: true });
		const headers = { Authorization: "Bearer opaque-account" };
		const first = await stream(model, ctx1, { ...OPTS, headers }).result();
		closeOpenAIResponsesWebSocketSessions();
		const second = await stream(
			model,
			normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] }),
			{
				...OPTS,
				headers,
				apiKey: "unused-other-key",
			},
		).result();
		expect(second.stopReason).toBe("stop");
		expect(sent[1].previous_response_id).toBe(first.responseId);
	});

	it.each(["Authorization", "cf-aig-authorization"])(
		"wire identity preserves pooled continuation across unused keys with %s",
		async (name) => {
			const { sent, sockets, fetchMock } = checkpointServer();
			const model = makeModel(CUSTOM_URL, { supportsResponseCheckpoints: true });
			const headers = { [name]: "Bearer opaque-account" };
			const first = await stream(model, ctx1, { ...OPTS, headers }).result();
			expect(first.responseCheckpoint).toBeDefined();
			const next = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
			const options = { ...OPTS, headers, apiKey: "unused-other-key" };
			const second = await stream(model, next, options).result();
			expect(second.stopReason).toBe("stop");
			expect(sockets).toHaveLength(1);
			expect(sent[1].connection).toBe(sent[0].connection);
			expect(sent[1].previous_response_id).toBe(first.responseId);
			expect(sent[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Next" }] }]);
			expect(sockets[0].headers[name.toLowerCase()]).toBe(headers[name]);
			if (name === "cf-aig-authorization") expect(sockets[0].headers.authorization).toBeUndefined();

			const changedHeaders = { [name]: "Bearer different-account" };
			const changed = await stream(model, next, { ...options, headers: changedHeaders }).result();
			expect(changed.stopReason).toBe("stop");
			expect(sockets).toHaveLength(2);
			expect(sockets[1].headers[name.toLowerCase()]).toBe(changedHeaders[name]);
			expect(sent[2].previous_response_id).toBeUndefined();
			expect(sent[2].input).toHaveLength(3);
			const routed = await stream(model, next, {
				...options,
				headers: { ...changedHeaders, "x-tenant": "other-tenant" },
			}).result();
			expect(routed.stopReason).toBe("stop");
			expect(sockets).toHaveLength(3);
			expect(sent[3].previous_response_id).toBeUndefined();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("wire identity still isolates automatic API-key Authorization without resetting sessions", async () => {
		const { sent, sockets } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		const second = await stream(
			model,
			normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] }),
			{ ...OPTS, apiKey: "sk-other-key" },
		).result();
		expect(second.stopReason).toBe("stop");
		expect(sockets.map((socket) => socket.headers.authorization)).toEqual([
			`Bearer ${apiKey}`,
			"Bearer sk-other-key",
		]);
		expect(sent[1].previous_response_id).toBeUndefined();
		expect(sent[1].input).toHaveLength(3);
	});

	it("wire identity preserves transport cooldown across unused keys but isolates Authorization", async () => {
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let failConnect = true;
		const { sent, sockets, fetchMock } = checkpointServer({ connectError: () => failConnect });
		fetchMock.mockImplementation(
			async () =>
				new Response('data: {"type":"response.completed","response":{"id":"resp_sse","status":"completed"}}\n\n', {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const model = makeModel(CUSTOM_URL, { supportsResponseCheckpoints: true });
		const options = { ...OPTS, headers: { Authorization: "Bearer opaque-account" }, maxRetries: 0 };
		for (let attempt = 0; attempt < 4; attempt++) await stream(model, ctx1, options).result();
		expect(sockets).toHaveLength(4);
		expect(fetchMock).toHaveBeenCalledOnce();
		const unusedChanged = { ...options, apiKey: "unused-other-key" };
		expect((await stream(model, ctx1, unusedChanged).result()).stopReason).toBe("stop");
		expect(sockets).toHaveLength(4);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const changed = await stream(model, ctx1, {
			...unusedChanged,
			headers: { Authorization: "Bearer different-account" },
		}).result();
		expect(changed.stopReason).toBe("error");
		expect(sockets).toHaveLength(5);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		now += 119_999;
		await stream(model, ctx1, unusedChanged).result();
		expect(sockets).toHaveLength(5);
		now++;
		failConnect = false;
		expect((await stream(model, ctx1, unusedChanged).result()).responseCheckpoint).toBeDefined();
		expect(sockets).toHaveLength(6);
		expect(sent).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it.each(["openai", "openrouter"] as const)("generated %s affinity changes do not change scope", async (format) => {
		const { sent, sockets } = checkpointServer();
		const model = makeModel(CUSTOM_URL, { supportsResponseCheckpoints: true, sessionAffinityFormat: format });
		const onPayload = (payload: unknown) => ({ ...(payload as Record<string, unknown>), prompt_cache_key: "stable" });
		const first = await stream(model, ctx1, { ...OPTS, onPayload }).result();
		closeOpenAIResponsesWebSocketSessions();
		const second = await stream(
			model,
			normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] }),
			{ ...OPTS, sessionId: "new-session", onPayload },
		).result();
		expect(second.stopReason).toBe("stop");
		expect(sockets[0].headers).not.toEqual(sockets[1].headers);
		expect(sent[1].previous_response_id).toBe(first.responseId);
	});

	it.each<{ key: string | undefined; headers: ProviderHeaders | undefined; store: boolean; wire: string | undefined }>(
		[
			{ key: "chatgpt-access-token", headers: undefined, store: false, wire: "Bearer chatgpt-access-token" },
			{
				key: "sk-option",
				headers: { Authorization: "Bearer chatgpt-access-token" },
				store: false,
				wire: "Bearer chatgpt-access-token",
			},
			{
				key: "chatgpt-access-token",
				headers: { Authorization: "Bearer sk-header" },
				store: true,
				wire: "Bearer sk-header",
			},
			{ key: undefined, headers: { Authorization: "Bearer sk-header" }, store: true, wire: "Bearer sk-header" },
			{
				key: "sk-option",
				headers: { Authorization: "Bearer chatgpt-access-token", authorization: "Bearer sk-final" },
				store: true,
				wire: "Bearer sk-final",
			},
			{
				key: "sk-option",
				headers: { Authorization: "Bearer sk-header", authorization: null },
				store: false,
				wire: undefined,
			},
		],
	)("official credential uses final WS Authorization: %j", async ({ key, headers, store, wire }) => {
		const { sent, sockets } = checkpointServer();
		const out = await stream(makeModel(OFFICIAL_URL), ctx1, { ...OPTS, apiKey: key, headers }).result();
		expect(out.stopReason).toBe("stop");
		expect(sockets[0].headers.authorization).toBe(wire);
		expect(sent[0].store).toBe(store);
		expect(!!out.responseCheckpoint).toBe(store);
	});

	it("model Authorization controls official mode; opaque verified custom tokens remain eligible", async () => {
		const { sent } = checkpointServer();
		await stream(
			{ ...makeModel(OFFICIAL_URL), headers: { Authorization: "Bearer chatgpt-token" } },
			ctx1,
			OPTS,
		).result();
		await stream(makeModel(CUSTOM_URL, { supportsResponseCheckpoints: true }), ctx1, {
			...OPTS,
			apiKey: "opaque",
		}).result();
		await stream(
			{ ...makeModel(CUSTOM_URL, { supportsResponseCheckpoints: true }), provider: "openai-codex" },
			ctx1,
			OPTS,
		).result();
		expect(sent.map((frame) => frame.store)).toEqual([false, true, false]);
	});

	it("Authorization overrides match actual OpenAI SDK HTTP precedence", async () => {
		const cases: ProviderHeaders[] = [
			{ Authorization: "Bearer header" },
			{ Authorization: "Bearer first", authorization: "Bearer last" },
			{ Authorization: "Bearer first", authorization: null },
		];
		for (const headers of cases) {
			const { sockets, fetchMock } = checkpointServer();
			await stream(makeModel(OFFICIAL_URL), ctx1, { ...OPTS, headers }).result();
			let httpAuthorization: string | null = null;
			fetchMock.mockImplementation(async (_input, init) => {
				httpAuthorization = new Headers(init?.headers).get("authorization");
				return new Response(
					'data: {"type":"response.completed","response":{"id":"resp_http","status":"completed"}}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			});
			await stream(makeModel(OFFICIAL_URL), ctx1, { ...OPTS, headers, transport: "sse" }).result();
			expect(httpAuthorization).toBe(sockets[0].headers.authorization ?? null);
			closeOpenAIResponsesWebSocketSessions();
		}
	});

	it("simple options preserve raw absence and array identity; simple API resumes exact delta", async () => {
		const model = makeModel(OFFICIAL_URL);
		const exclude: string[] = [];
		expect(buildBaseOptions(model, ctx1).responseCheckpointExclude).toBeUndefined();
		expect(buildBaseOptions(model, ctx1, { responseCheckpointExclude: exclude }).responseCheckpointExclude).toBe(
			exclude,
		);
		const { sent } = checkpointServer();
		const first = await streamSimple(model, ctx1, OPTS).result();
		expect(first.responseCheckpoint).toBeDefined();
		closeOpenAIResponsesWebSocketSessions();
		await streamSimple(
			model,
			normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] }),
			OPTS,
		).result();
		expect(sent[1].previous_response_id).toBe(first.responseId);
		expect(sent[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Next" }] }]);
		// Absent exclusion now enables checkpoints (default []); only ["*"] disables.
		const absentOut = await streamSimple(model, ctx1, OPTS).result();
		expect(absentOut.responseCheckpoint).toBeDefined();
		const excluded = await streamSimple(model, ctx1, { ...OPTS, responseCheckpointExclude: ["*"] }).result();
		expect(excluded.responseCheckpoint).toBeUndefined();
		expect(sent.slice(2).map((frame) => frame.store)).toEqual([true, false]);
	});
});

describe("checkpoint execution and capture safety", () => {
	it.each([undefined, sessionId])("sent unknown execution never replays (session %s)", async (session) => {
		let drop = false;
		const { sent, fetchMock } = checkpointServer({
			onRequest: (socket) => {
				if (!drop) return false;
				socket.fail();
				return true;
			},
		});
		const model = makeModel(OFFICIAL_URL);
		const options = { ...OPTS, sessionId: session };
		const first = await stream(model, ctx1, options).result();
		drop = true;
		const next = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
		const out = await stream(model, next, options).result();
		expect(out.stopReason).toBe("error");
		expect(sent).toHaveLength(2);
		expect(sent[1].previous_response_id).toBe(first.responseId);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(out.diagnostics?.some((d) => d.type === "provider_transport_failure")).not.toBe(true);
	});

	it.each(["drop", "connection-limit", "handshake"])("failed full-history repair is final: %s", async (failure) => {
		let attempts = 0;
		const { sent, fetchMock } = checkpointServer({
			expireIds: true,
			connectError: () => failure === "handshake" && attempts === 2,
			onRequest: (socket) => {
				if (++attempts !== 3) return false;
				if (failure === "connection-limit") {
					socket.emit({ type: "error", code: "websocket_connection_limit_reached" });
				} else socket.fail();
				return true;
			},
		});
		const model = makeModel(OFFICIAL_URL);
		const options = { ...OPTS, sessionId: undefined };
		const first = await stream(model, ctx1, options).result();
		const out = await stream(
			model,
			normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] }),
			options,
		).result();
		expect(out.stopReason).toBe("error");
		expect(sent).toHaveLength(failure === "handshake" ? 2 : 3);
		if (failure !== "handshake") {
			expect(sent[2].previous_response_id).toBeUndefined();
			expect(sent[2].input).toHaveLength(3);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("pre-send sessionless connection failure still falls back", async () => {
		const { sent, fetchMock } = checkpointServer({ connectError: () => true });
		fetchMock.mockImplementation(
			async () =>
				new Response('data: {"type":"response.completed","response":{"id":"resp_sse","status":"completed"}}\n\n', {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const out = await stream(makeModel(OFFICIAL_URL), ctx1, { ...OPTS, sessionId: undefined }).result();
		expect(out.stopReason).toBe("stop");
		expect(sent).toHaveLength(0);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("pre-send fallback survives; cooldown recovery cannot replay a sent request", async () => {
		let failConnect = true;
		const { sent, fetchMock } = checkpointServer({
			connectError: () => failConnect,
			onRequest: (socket) => {
				socket.fail();
				return true;
			},
		});
		fetchMock.mockImplementation(
			async () =>
				new Response('data: {"type":"response.completed","response":{"id":"resp_sse","status":"completed"}}\n\n', {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const model = makeModel(OFFICIAL_URL);
		for (let i = 0; i < 4; i++) await stream(model, ctx1, OPTS).result();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(sent).toHaveLength(0);
		expect((await stream(model, ctx1, OPTS).result()).stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		failConnect = false;
		now += 120_000;
		expect((await stream(model, ctx1, OPTS).result()).stopReason).toBe("error");
		expect(sent).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("caller parent wins over local checkpoint; descendants never acquire complete-history provenance", async () => {
		const { sent, stored, fetchMock } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		for (const account of stored.values()) account.set("resp_external", { id: "resp_external", output: [] });
		const context = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
		let callerInput: unknown;
		const caller = await stream(model, context, {
			...OPTS,
			onPayload: (payload) => {
				callerInput = (payload as Record<string, unknown>).input;
				return { ...(payload as Record<string, unknown>), previous_response_id: "resp_external" };
			},
		}).result();
		expect(sent[1].previous_response_id).toBe("resp_external");
		expect(sent[1].input).toEqual(callerInput);
		expect(caller.responseCheckpoint).toBeUndefined();
		const descendantContext = normalizeContext({ messages: [...context.messages, caller, userMsg("Descendant", 3)] });
		const descendant = await stream(model, descendantContext, OPTS).result();
		expect(sent[2].previous_response_id).toBe(caller.responseId);
		expect(descendant.responseCheckpoint).toBeUndefined();
		for (const account of stored.values()) account.clear();
		const failed = await stream(
			model,
			normalizeContext({
				messages: [...descendantContext.messages, descendant, userMsg("Missing", 4)],
			}),
			OPTS,
		).result();
		expect(failed.stopReason).toBe("error");
		// The caller-descendant lineage depends on history not held locally, so
		// the missing reference is never repaired (complete-history guard).
		expect(sent).toHaveLength(4);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("caller delta and missing caller parent are never replaced or repaired", async () => {
		const { sent, fetchMock } = checkpointServer();
		const input = [{ role: "user", content: "caller delta only" }];
		const out = await stream(makeModel(OFFICIAL_URL), ctx1, {
			...OPTS,
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				previous_response_id: "resp_external",
				input,
			}),
		}).result();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ previous_response_id: "resp_external", input });
		expect(out.stopReason).toBe("error");
		expect(out.responseCheckpoint).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("aborted output never captures a checkpoint", async () => {
		checkpointServer();
		const controller = new AbortController();
		const out = await stream(makeModel(OFFICIAL_URL), ctx1, {
			...OPTS,
			signal: controller.signal,
			onProviderStreamEvent: (event) => {
				if ((event as { type?: string }).type === "response.completed") controller.abort();
			},
		}).result();
		expect(out.stopReason).toBe("aborted");
		expect(out.responseCheckpoint).toBeUndefined();
	});

	it.each(["incomplete", "failed", "cancelled", "missing-status", "in_progress"])(
		"terminal %s preserves useful content without checkpoint",
		async (status) => {
			checkpointServer({
				events: (events) => {
					const terminal = events.at(-1)!;
					const response = terminal.response as Record<string, unknown>;
					response.status = status === "missing-status" ? undefined : status;
					if (status === "incomplete") {
						terminal.type = "response.incomplete";
						response.incomplete_details = { reason: "max_output_tokens" };
					}
					return events;
				},
			});
			const out = await stream(makeModel(OFFICIAL_URL), ctx1, OPTS).result();
			expect(out.content).toEqual([expect.objectContaining({ type: "text", text: "assistant gen_1" })]);
			if (status === "incomplete") expect(out.stopReason).toBe("length");
			expect(out.responseCheckpoint).toBeUndefined();
		},
	);

	it.each(["declared-off", "excluded policy", "hook store:false", "complete local"])(
		"policy transition preserves reconstruction provenance: %s",
		async (mode) => {
			let turns = 0;
			const { sent, generations } = checkpointServer({
				events: (events) => {
					// A first turn with no terminal output items (or a
					// checkpoint-disabled request) must not become a resumable
					// prefix for later provenance.
					if (++turns === 1 && (mode === "excluded policy" || mode === "hook store:false")) {
						return [events[0], events[3]];
					}
					return events;
				},
			});
			// "declared-off" uses an undeclared custom endpoint + declared mode to
			// keep turn 1 checkpoint-free while still storing turn-1 state.
			const model = mode === "declared-off" ? makeModel(CUSTOM_URL) : makeModel(OFFICIAL_URL);
			const disabledPolicy =
				mode === "declared-off"
					? { responseCheckpointMode: "declared" as const }
					: mode === "excluded policy"
						? { responseCheckpointExclude: ["*"] }
						: {};
			const first = await stream(model, ctx1, {
				apiKey,
				sessionId,
				...disabledPolicy,
				onPayload: (payload) => ({
					...(payload as Record<string, unknown>),
					...(mode === "hook store:false" ? { store: false } : { store: true }),
				}),
			}).result();
			expect(first.stopReason).toBe("stop");
			// Only "complete local" captures on turn 1; the other modes never do.
			if (mode === "complete local") expect(first.responseCheckpoint).toBeDefined();
			else expect(first.responseCheckpoint).toBeUndefined();
			if (mode === "excluded policy" || mode === "hook store:false") expect(first.content).toEqual([]);
			const nextContext = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
			const second = await stream(model, nextContext, OPTS).result();
			expect(second.stopReason).toBe("stop");
			// Provenance tracking must not change legacy connection-local wire behavior.
			expect(sent[1].previous_response_id).toBe(mode === "hook store:false" ? undefined : first.responseId);
			const proven = mode !== "excluded policy";
			if (proven) expect(second.responseCheckpoint).toBeDefined();
			else expect(second.responseCheckpoint).toBeUndefined();
			closeOpenAIResponsesWebSocketSessions();
			const reopenedContext = normalizeContext({
				messages: [...nextContext.messages, second, userMsg("Reopened", 3)],
			});
			const third = await stream(model, reopenedContext, OPTS).result();
			expect(third.stopReason).toBe("stop");
			expect(sent[2].previous_response_id).toBe(proven ? second.responseId : undefined);
			expect(sent[2].input).toEqual(
				proven
					? [{ role: "user", content: [{ type: "input_text", text: "Reopened" }] }]
					: convertResponsesMessages(model, reopenedContext, new Set([model.provider])),
			);
			expect(third.responseCheckpoint).toBeDefined();
			expect(sent).toHaveLength(3);
			expect(generations).toHaveLength(3);
		},
	);

	it.each(["missing-items", "partial-text", "different-text", "unsupported-nested", "annotations"])(
		"terminal output not represented locally declines capture: %s",
		async (mode) => {
			let turns = 0;
			const { sent } = checkpointServer({
				events: (events) => {
					if (++turns > 1) return events;
					if (mode === "missing-items") return [events[0], events[3]];
					if (mode === "partial-text")
						return [
							events[0],
							events[1],
							{
								type: "response.output_text.delta",
								output_index: 0,
								delta: "assistant",
							},
							events[3],
						];
					const response = events[3].response as { output: Array<{ content: unknown[] }> };
					response.output = JSON.parse(JSON.stringify(response.output));
					response.output[0].content =
						mode === "different-text"
							? [{ type: "output_text", text: "server-only text", annotations: [] }]
							: mode === "unsupported-nested"
								? [{ type: "output_audio", data: "opaque" }]
								: [
										{
											type: "output_text",
											text: "assistant gen_1",
											annotations: [{ type: "url_citation", url: "https://example.com" }],
										},
									];
					return events;
				},
			});
			const model = makeModel(OFFICIAL_URL);
			const first = await stream(model, ctx1, OPTS).result();
			expect(first.stopReason).toBe("stop");
			expect(first.responseCheckpoint).toBeUndefined();
			const nextContext = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
			const descendant = await stream(model, nextContext, OPTS).result();
			if (mode === "partial-text") {
				// Missing item signature changes the converter's fallback ID in
				// full context, so the local prefix check already sends full input.
				expect(sent[1].previous_response_id).toBeUndefined();
				expect(descendant.responseCheckpoint).toBeDefined();
			} else {
				expect(sent[1].previous_response_id).toBe(first.responseId);
				expect(descendant.responseCheckpoint).toBeUndefined();
			}
			closeOpenAIResponsesWebSocketSessions();
			await stream(
				model,
				normalizeContext({ messages: [...nextContext.messages, descendant, userMsg("Reconnect", 3)] }),
				OPTS,
			).result();
			expect(sent[2].previous_response_id).toBe(mode === "partial-text" ? descendant.responseId : undefined);
		},
	);
});

describe("durable response checkpoints over WS", () => {
	it("captures omitted output_text annotations and resumes exact delta on a new socket", async () => {
		const { sent, sockets } = checkpointServer({
			events: (events) => {
				const response = events[3].response as { output: Array<{ content: Array<{ annotations?: unknown }> }> };
				delete response.output[0].content[0].annotations;
				return events;
			},
		});
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		expect(first.stopReason).toBe("stop");
		expect(first.responseCheckpoint).toBeDefined();
		closeOpenAIResponsesWebSocketSessions();
		const next = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
		const second = await stream(model, next, OPTS).result();
		expect(second.stopReason).toBe("stop");
		expect(second.responseCheckpoint).toBeDefined();
		expect(sockets).toHaveLength(2);
		expect(sent[1].previous_response_id).toBe(first.responseId);
		expect(sent[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Next" }] }]);
	});
	it("checkpoint-eligible by default: store:true, capture, cross-connection delta", async () => {
		const { sent, sockets } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, { apiKey, sessionId }).result();
		expect(first.stopReason).toBe("stop");
		expect(sent[0].store).toBe(true);
		expect(first.responseCheckpoint).toBeDefined();
		closeOpenAIResponsesWebSocketSessions();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
		const second = await stream(model, ctx2, { apiKey, sessionId }).result();
		expect(second.stopReason).toBe("stop");
		expect(sockets.length).toBe(2);
		expect(sent[1].previous_response_id).toBe(first.responseId);
		expect(sent[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Next" }] }]);
	});

	it("custom endpoint also tries checkpoints under the default always mode", async () => {
		const { sent } = checkpointServer();
		const model = makeModel(CUSTOM_URL); // undeclared capability
		const first = await stream(model, ctx1, { apiKey, sessionId }).result();
		expect(sent[0].store).toBe(true);
		expect(first.responseCheckpoint).toBeDefined();
		// declared mode keeps the old capability gate.
		const declared = await stream(model, ctx1, {
			apiKey,
			sessionId,
			responseCheckpointMode: "declared",
		}).result();
		expect(sent[1].store).toBe(false);
		expect(declared.responseCheckpoint).toBeUndefined();
	});

	it.each([
		// mode x compat x official/non-official => store
		["always", undefined, false, true],
		["always", false, false, true],
		["always", true, false, true],
		["always", undefined, true, true],
		["always", false, true, true],
		["auto", undefined, false, true],
		["auto", true, false, true],
		["auto", false, false, false],
		["auto", undefined, true, true],
		["auto", false, true, false],
		["declared", undefined, false, false],
		["declared", false, false, false],
		["declared", true, false, true],
		["declared", undefined, true, true],
		["declared", false, true, false],
	] as const)("mode %s compat %s official %s => store %s", async (mode, capability, official, expected) => {
		const { sent } = checkpointServer();
		const model = official
			? makeModel(OFFICIAL_URL, capability === undefined ? {} : { supportsResponseCheckpoints: capability })
			: makeModel(CUSTOM_URL, capability === undefined ? {} : { supportsResponseCheckpoints: capability });
		const out = await stream(model, ctx1, { ...OPTS, responseCheckpointMode: mode }).result();
		expect(out.stopReason).toBe("stop");
		expect(sent[0].store).toBe(expected);
	});

	it.each(["no-such-mode", 3, null, {}])("malformed mode %j disables checkpoints", async (mode) => {
		const { sent } = checkpointServer();
		const out = await stream(makeModel(OFFICIAL_URL), ctx1, {
			...OPTS,
			responseCheckpointMode: mode as never,
		}).result();
		expect(out.stopReason).toBe("stop");
		expect(sent[0].store).toBe(false);
		expect(out.responseCheckpoint).toBeUndefined();
	});

	it.each(["sse", "websocket"] as const)(
		"hard gate transport %s blocks checkpoints in always mode",
		async (transport) => {
			const { sent, fetchMock } = checkpointServer();
			fetchMock.mockImplementation(
				async () =>
					new Response(
						'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
						{
							headers: { "content-type": "text/event-stream" },
						},
					),
			);
			const out = await stream(makeModel(OFFICIAL_URL), ctx1, { ...OPTS, transport }).result();
			expect(out.stopReason).toBe("stop");
			if (transport === "sse") expect(sent).toHaveLength(0);
			else expect(sent[0].store).toBe(false);
		},
	);

	it.each([
		["codex provider", { provider: "openai-codex" as const }, {}],
		["chatgpt sign-in", { provider: "openai" as const }, { apiKey: "chatgpt-access-token" }],
		["cache retention none", {}, { cacheRetention: "none" as const, sessionId: undefined }],
		["hook store:false", {}, { onPayload: (p: unknown) => ({ ...(p as Record<string, unknown>), store: false }) }],
	])("hard gate %s blocks checkpoints in always mode", async (_label, modelPatch, optionsPatch) => {
		const { sent } = checkpointServer();
		const out = await stream({ ...makeModel(OFFICIAL_URL), ...modelPatch }, ctx1, {
			...OPTS,
			responseCheckpointMode: "always",
			...optionsPatch,
		}).result();
		expect(out.stopReason).toBe("stop");
		expect(sent[0]?.store).not.toBe(true);
	});

	it("exclusion patterns disable; '**' and provider globs match (example: globs)", async () => {
		const { sent } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const r1 = await stream(model, ctx1, { apiKey, sessionId, responseCheckpointExclude: ["*"] }).result();
		expect(sent[0].store).toBe(false);
		expect(r1.responseCheckpoint).toBeUndefined();
		const r2 = await stream(model, ctx1, {
			apiKey,
			sessionId,
			responseCheckpointExclude: ["openai/*"],
		}).result();
		expect(sent[1].store).toBe(false);
		expect(r2.responseCheckpoint).toBeUndefined();
		const r3 = await stream(model, ctx1, {
			apiKey,
			sessionId,
			responseCheckpointExclude: ["openai"],
		}).result();
		expect(sent[2].store).toBe(false);
		expect(r3.responseCheckpoint).toBeUndefined();
		// Non-matching pattern keeps it enabled.
		const r4 = await stream(model, ctx1, {
			apiKey,
			sessionId,
			responseCheckpointExclude: ["anthropic/*"],
		}).result();
		expect(sent[3].store).toBe(true);
		expect(r4.responseCheckpoint).toBeDefined();
	});

	it("captures checkpoint and resumes on a NEW connection with exact delta + previous_response_id", async () => {
		const { sent, sockets, generations } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		expect(first.stopReason).toBe("stop");
		expect(sent[0].store).toBe(true);
		expect(first.responseId).toBe("resp_srv_1");
		expect(first.responseCheckpoint).toBeDefined();
		expect(first.responseCheckpoint!.version).toBe(1);
		expect(first.responseCheckpoint!.scopeHash).toMatch(/^[0-9a-f]{64}$/);
		// JSONL-style round trip: metadata survives serialize/parse.
		const restored = JSON.parse(JSON.stringify(first)) as AssistantMessage;
		expect(restored.responseCheckpoint).toEqual(first.responseCheckpoint);

		// New connection: close pooled sockets, feed restored history + new turn.
		closeOpenAIResponsesWebSocketSessions();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, restored, userMsg("Next turn", 2)] });
		const second = await stream(model, ctx2, OPTS).result();
		expect(second.stopReason).toBe("stop");
		expect(sockets.length).toBe(2);
		expect(sent).toHaveLength(2);
		expect(sent[1].connection).not.toBe(sent[0].connection);
		expect(sent[1].previous_response_id).toBe("resp_srv_1");
		// Exact delta: only the new user input item.
		expect(sent[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Next turn" }] }]);
		expect(generations).toHaveLength(2); // exactly one generation per request, no replay
	});

	it("resumes through the JSONL reread path (SessionManager-free file parse)", async () => {
		const { sent, sockets } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		// Simulate session reload: serialize the whole assistant like JSONL does.
		const line = JSON.stringify({ type: "message", message: first });
		const restoredEntry = JSON.parse(line) as { message: AssistantMessage };
		closeOpenAIResponsesWebSocketSessions();
		const ctx2 = normalizeContext({
			messages: [...ctx1.messages, restoredEntry.message, userMsg("Follow up", 2)],
		});
		await stream(model, ctx2, OPTS).result();
		expect(sockets.length).toBe(2);
		expect(sent[1].previous_response_id).toBe("resp_srv_1");
		expect(sent[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Follow up" }] }]);
	});

	it("rollback to old active-branch response reuses its checkpoint suffix", async () => {
		const { sent, sockets } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		// Turn 2 on the same branch.
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, first, userMsg("second", 2)] });
		const second = await stream(model, ctx2, OPTS).result();
		expect(second.responseId).toBe("resp_srv_2");
		closeOpenAIResponsesWebSocketSessions();
		// Rollback: branch back to `first` assistant then a different user turn.
		const ctxRollback = normalizeContext({
			messages: [...ctx1.messages, first, userMsg("alternate tail", 3)],
		});
		const third = await stream(model, ctxRollback, OPTS).result();
		expect(third.stopReason).toBe("stop");
		expect(sockets.length).toBe(2); // fresh socket after close, then durable delta
		expect(sent[2].previous_response_id).toBe("resp_srv_1");
		expect(sent[2].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "alternate tail" }] }]);
	});

	it("function_call → tool_result loop: tool output travels as the exact delta", async () => {
		const sent: SentFrame[] = [];
		const sockets: { connection: number }[] = [];
		const stored = new Map<string, unknown[]>();
		let counter = 0;

		class ToolSocket extends EventTarget {
			readyState = 1;
			readonly connection = sockets.length + 1;
			constructor() {
				super();
				sockets.push(this);
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			send(data: string): void {
				const frame = JSON.parse(data) as SentFrame;
				frame.connection = this.connection;
				sent.push(frame);
				queueMicrotask(() => this.respond(frame));
			}
			respond(frame: SentFrame): void {
				counter++;
				const id = `resp_srv_${counter}`;
				const isToolAnswer = sent.length > 1;
				const items = isToolAnswer
					? [
							{
								type: "message",
								id: `msg_srv_${counter}`,
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "final answer", annotations: [] }],
							},
						]
					: [
							{
								type: "function_call",
								id: "fc_srv_1",
								call_id: "call_server_1",
								name: "lookup",
								arguments: '{"q":"v"}',
								status: "completed",
							},
						];
				this.emit({ type: "response.created", response: { id } });
				for (const item of items) {
					this.emit({ type: "response.output_item.done", item });
				}
				this.emit({
					type: "response.completed",
					response: { id, status: "completed", output: items, store: true },
				});
				if (frame.store === true) stored.set(id, items);
			}
			emit(event: Record<string, unknown>): void {
				this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
			}
			close(): void {
				this.readyState = 3;
			}
		}
		vi.stubGlobal("WebSocket", ToolSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("no", { status: 500 })),
		);

		const model = makeModel(OFFICIAL_URL);
		const tools = [
			{
				name: "lookup",
				description: "look things up",
				parameters: { type: "object", properties: { q: { type: "string" } } } as never,
			},
		];
		const ctxTool = normalizeContext({ messages: [userMsg("use the tool", 1)] as never, tools });
		const first = await stream(model, ctxTool, OPTS).result();
		expect(first.stopReason).toBe("toolUse");
		// Server call id is authoritative, not SDK renormalization.
		const toolCall = first.content.find((b) => b.type === "toolCall") as { id: string; name: string };
		expect(toolCall.id.split("|")[0]).toBe("call_server_1");
		expect(first.responseCheckpoint).toBeDefined();

		// Tool result appended; new connection resumes with function_call_output only.
		closeOpenAIResponsesWebSocketSessions();
		const ctxNext = normalizeContext({
			messages: [
				...ctxTool.messages,
				first,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "lookup",
					content: [{ type: "text", text: "tool says 42" }],
					isError: false,
					timestamp: 2,
				},
			] as never,
			tools,
		});
		const second = await stream(model, ctxNext, OPTS).result();
		expect(second.stopReason).toBe("stop");
		expect(sockets.length).toBe(2);
		expect(sent).toHaveLength(2);
		expect(sent[1].previous_response_id).toBe("resp_srv_1");
		expect(sent[1].input).toEqual([
			{ type: "function_call_output", call_id: "call_server_1", output: "tool says 42" },
		]);
	});

	it("encrypted reasoning fidelity: reasoning + signature stay inside the bound prefix", async () => {
		const sent: SentFrame[] = [];
		const sockets: { connection: number }[] = [];
		let counter = 0;
		class ReasoningSocket extends EventTarget {
			readyState = 1;
			readonly connection = sockets.length + 1;
			constructor() {
				super();
				sockets.push(this);
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			send(data: string): void {
				const frame = JSON.parse(data) as SentFrame;
				frame.connection = this.connection;
				sent.push(frame);
				queueMicrotask(() => this.respond());
			}
			respond(): void {
				counter++;
				const id = `resp_srv_${counter}`;
				const items = [
					{ type: "reasoning", id: `rs_srv_${counter}`, summary: [], encrypted_content: `enc_${counter}` },
					{
						type: "message",
						id: `msg_srv_${counter}`,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "thought and spoke", annotations: [] }],
					},
				];
				this.emit({ type: "response.created", response: { id } });
				for (const item of items) this.emit({ type: "response.output_item.done", item });
				this.emit({
					type: "response.completed",
					response: { id, status: "completed", output: items, store: true },
				});
			}
			emit(event: Record<string, unknown>): void {
				this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
			}
			close(): void {
				this.readyState = 3;
			}
		}
		vi.stubGlobal("WebSocket", ReasoningSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("no", { status: 500 })),
		);
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, { ...OPTS, reasoningEffort: "medium" }).result();
		expect(first.stopReason).toBe("stop");
		const thinking = first.content.find((b) => b.type === "thinking") as { thinkingSignature?: string };
		expect(thinking.thinkingSignature).toContain("rs_srv_1");
		expect(first.responseCheckpoint).toBeDefined();

		closeOpenAIResponsesWebSocketSessions();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, first, userMsg("again", 2)] });
		await stream(model, ctx2, { ...OPTS, reasoningEffort: "medium" }).result();
		expect(sockets.length).toBe(2);
		expect(sent[1].previous_response_id).toBe("resp_srv_1");
		expect(sent[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "again" }] }]);
		// The encrypted reasoning item itself is covered by the prefix hash, not sent again.
		expect(JSON.stringify(sent[1].input)).not.toContain("enc_1");
	});

	it("changed scope (different credential) never resumes", async () => {
		const { sent, sockets } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		closeOpenAIResponsesWebSocketSessions();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
		await stream(model, ctx2, { ...OPTS, apiKey: "sk-other-key" }).result();
		expect(sockets.length).toBe(2);
		expect(sent[1].previous_response_id).toBeUndefined();
		expect((sent[1].input as unknown[]).length).toBeGreaterThan(1);
	});

	it("expired checkpoint falls back to full input", async () => {
		const { sent, sockets } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		// Forge expiry into the past through the JSONL path.
		const tampered = JSON.parse(JSON.stringify(first)) as AssistantMessage;
		tampered.responseCheckpoint!.expiresAt = Date.now() - 1;
		closeOpenAIResponsesWebSocketSessions();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, tampered, userMsg("Next", 2)] });
		await stream(model, ctx2, OPTS).result();
		expect(sockets.length).toBe(2);
		expect(sent[1].previous_response_id).toBeUndefined();
	});

	it("tampered prefix content invalidates and sends full input", async () => {
		const { sent, sockets } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		const edited = JSON.parse(JSON.stringify(first)) as AssistantMessage;
		const text = edited.content.find((b) => b.type === "text") as { text: string };
		text.text = "edited assistant text";
		closeOpenAIResponsesWebSocketSessions();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, edited, userMsg("Next", 2)] });
		await stream(model, ctx2, OPTS).result();
		expect(sockets.length).toBe(2);
		expect(sent[1].previous_response_id).toBeUndefined();
	});

	it("unknown/expired server ref repairs once with full body, never double-truncates", async () => {
		const { sent, generations } = checkpointServer({ expireIds: true });
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		expect(first.responseCheckpoint).toBeDefined();
		closeOpenAIResponsesWebSocketSessions();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
		const second = await stream(model, ctx2, OPTS).result();
		expect(second.stopReason).toBe("stop");
		// Sends: turn1 full, delta attempt rejected pre-execution, full-body repair.
		expect(sent).toHaveLength(3);
		expect(sent[1].previous_response_id).toBe("resp_srv_1");
		expect(sent[2].previous_response_id).toBeUndefined();
		expect((sent[2].input as unknown[]).length).toBe(ctx2.messages.length);
		expect(generations).toHaveLength(2); // generation only once for turn 2
	});

	it("store:false from a payload hook prevents request store:true and capture", async () => {
		const { sent } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, {
			...OPTS,
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), store: false }),
		}).result();
		expect(sent[0].store).toBe(false);
		expect(first.responseCheckpoint).toBeUndefined();
	});

	it("explicit websocket (uncached) mode does not request store or checkpoint", async () => {
		const { sent } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		await stream(model, ctx1, { ...OPTS, transport: "websocket" }).result();
		expect(sent[0].store).toBe(false);
		// explicit sse too
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						[
							{
								type: "response.output_item.done",
								item: {
									type: "message",
									id: "msg_sse",
									role: "assistant",
									status: "completed",
									content: [{ type: "output_text", text: "sse", annotations: [] }],
								},
							},
							{ type: "response.completed", response: { id: "resp_sse", status: "completed" } },
						]
							.map((e) => `data: ${JSON.stringify(e)}\n\n`)
							.join(""),
						{ headers: { "content-type": "text/event-stream" } },
					),
			),
		);
		await stream(model, ctx1, { ...OPTS, transport: "sse" }).result();
		expect(sent).toHaveLength(1); // still only the WS request; no extra WS store:true
	});
});

describe("checkpoint failure cooldown", () => {
	const serverFail = (mode: "coded" | "uncoded" | "store" | "unsupported") => {
		const health = { failing: true };
		const server = checkpointServer({
			onRequest: (socket, frame) => {
				if (!health.failing) return false;
				if (!frame.previous_response_id && frame.store !== true) return false;
				if (frame.previous_response_id) {
					if (mode === "coded") {
						socket.emit({
							type: "error",
							error: { code: "previous_response_not_found", message: "No such response" },
						});
					} else if (mode === "uncoded") {
						socket.emit({
							type: "error",
							error: {
								type: "invalid_request_error",
								message: "previous_response_id is not available for this user",
							},
						});
					} else if (mode === "unsupported") {
						socket.emit({
							type: "error",
							error: {
								type: "invalid_request_error",
								param: "previous_response_id",
								message: "previous_response_id is unsupported by this endpoint",
							},
						});
					}
				} else if (mode === "store") {
					socket.emit({
						type: "error",
						error: { type: "invalid_request_error", param: "store", message: "store is not allowed" },
					});
				}
				return false;
			},
		});
		return {
			...server,
			heal: () => {
				health.failing = false;
			},
		};
	};

	it.each(["coded", "uncoded", "store", "unsupported"] as const)(
		"signal %s repairs once without store/previous_response_id and cools the endpoint",
		async (mode) => {
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const { sent, fetchMock, heal } = serverFail(mode);
			const model = makeModel(OFFICIAL_URL);
			const history = [...ctx1.messages];
			const next = async (text: string) => {
				history.push(userMsg(text, history.length));
				const out = await stream(model, normalizeContext({ messages: history }), OPTS).result();
				history.push(out);
				return out;
			};
			const first = await stream(model, ctx1, OPTS).result();
			history.push(first);
			expect(first.stopReason).toBe("stop");
			// A store-param rejection hits turn 1 itself (store:true, full body);
			// the other signals only fire on the turn-2 delta.
			const turnsBeforeDelta = mode === "store" ? 2 : 1;
			expect(sent).toHaveLength(turnsBeforeDelta);
			if (mode === "store") {
				expect(sent[0].store).toBe(true);
				expect(sent[1].store).toBeUndefined();
				expect(first.responseCheckpoint).toBeUndefined();
			}

			// Delta rejected by the signal, repair resends full body without
			// store/previous_response_id, and the endpoint enters cooldown.
			const second = await next("Next");
			expect(second.stopReason).toBe("stop");
			const expectedFrames = mode === "store" ? 3 : 3;
			expect(sent).toHaveLength(expectedFrames);
			if (mode === "store") {
				// Turn 1 already cooled the endpoint; turn 2 stays checkpoint-free.
				expect(sent[2].store).toBeUndefined();
				expect(sent[2].previous_response_id).toBeUndefined();
			} else {
				expect(sent[expectedFrames - 2].previous_response_id).toBe(first.responseId);
			}
			expect(sent[expectedFrames - 1].store).toBeUndefined();
			expect(sent[expectedFrames - 1].previous_response_id).toBeUndefined();
			expect((sent[expectedFrames - 1].input as unknown[]).length).toBe(history.length - 1);
			expect(fetchMock).not.toHaveBeenCalled();

			// Cooldown: no store, no delta, no checkpoint capture.
			const third = await next("Cooled");
			expect(third.errorMessage).toBeUndefined();
			expect(third.stopReason).toBe("stop");
			expect(sent).toHaveLength(expectedFrames + 1);
			expect(sent[expectedFrames].store).toBeUndefined();
			expect(sent[expectedFrames].previous_response_id).toBeUndefined();
			expect(third.responseCheckpoint).toBeUndefined();

			// After the deadline the next request is the single store:true probe on
			// full history; success clears the cooldown so the next turn deltas again.
			now += 120_000;
			heal();
			const fourth = await next("Probe");
			expect(fourth.stopReason).toBe("stop");
			expect(sent).toHaveLength(expectedFrames + 2);
			expect(sent[expectedFrames + 1].store).toBe(true);
			expect(sent[expectedFrames + 1].previous_response_id).toBeUndefined();
			expect((sent[expectedFrames + 1].input as unknown[]).length).toBe(history.length - 1);
			expect(fourth.responseCheckpoint).toBeDefined();
			const fifth = await next("Resumed");
			expect(fifth.stopReason).toBe("stop");
			expect(sent).toHaveLength(expectedFrames + 3);
			expect(sent[expectedFrames + 2].store).toBe(true);
			expect(sent[expectedFrames + 2].previous_response_id).toBe(fourth.responseId);
		},
	);

	it("wire identity preserves checkpoint cooldown across unused keys but isolates Authorization", async () => {
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const { sent, sockets, fetchMock, heal } = serverFail("store");
		const model = makeModel(CUSTOM_URL, { supportsResponseCheckpoints: true });
		const options = { ...OPTS, headers: { Authorization: "Bearer opaque-account" } };
		expect((await stream(model, ctx1, options).result()).stopReason).toBe("stop");
		expect(sent.map((frame) => frame.store)).toEqual([true, undefined]);
		const repairedConnection = sent[1].connection;
		heal();
		const unusedChanged = { ...options, apiKey: "unused-other-key" };
		const cooled = await stream(model, ctx1, unusedChanged).result();
		expect(cooled.stopReason).toBe("stop");
		expect(cooled.responseCheckpoint).toBeUndefined();
		expect(sent).toHaveLength(3);
		expect(sent[2].store).toBeUndefined();
		expect(sent[2].connection).toBe(repairedConnection);
		const changed = await stream(model, ctx1, {
			...unusedChanged,
			headers: { Authorization: "Bearer different-account" },
		}).result();
		expect(changed.responseCheckpoint).toBeDefined();
		expect(sent[3].store).toBe(true);
		expect(sent[3].connection).not.toBe(repairedConnection);
		expect(sockets.at(-1)!.headers.authorization).toBe("Bearer different-account");
		now += 119_999;
		await stream(model, ctx1, unusedChanged).result();
		expect(sent.at(-1)!.store).toBeUndefined();
		now++;
		expect((await stream(model, ctx1, unusedChanged).result()).responseCheckpoint).toBeDefined();
		expect(sent.at(-1)!.store).toBe(true);
		expect(sent.at(-1)!.previous_response_id).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["session", "endpoint", "credential"] as const)(
		"keeps storage progression isolated by %s",
		async (identity) => {
			let now = 1000;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const { sent } = serverFail("store");
			const model = makeModel(OFFICIAL_URL);
			const otherModel = identity === "endpoint" ? makeModel(CUSTOM_URL) : model;
			const otherOptions = {
				...OPTS,
				...(identity === "session" ? { sessionId: "other-session" } : {}),
				...(identity === "credential" ? { apiKey: "sk-other-key" } : {}),
			};
			const run = () => stream(model, ctx1, OPTS).result();
			const other = () => stream(otherModel, ctx1, otherOptions).result();
			await run();
			now += 120_000;
			await run(); // Original identity advances to three minutes.
			await other(); // New identity starts at two minutes.
			now += 119_999;
			await other();
			expect(sent.at(-1)!.store).toBeUndefined();
			now++;
			await other();
			expect(sent.at(-2)!.store).toBe(true);
			await run();
			expect(sent.at(-1)!.store).toBeUndefined();
			now += 59_999;
			await run();
			expect(sent.at(-1)!.store).toBeUndefined();
			now++;
			await run();
			expect(sent.at(-2)!.store).toBe(true);
		},
	);

	it("sessionless failure repairs once but keeps no cooldown state", async () => {
		const { sent } = serverFail("coded");
		const model = makeModel(OFFICIAL_URL);
		const options = { ...OPTS, sessionId: undefined };
		const first = await stream(model, ctx1, options).result();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
		const second = await stream(model, ctx2, options).result();
		expect(second.stopReason).toBe("stop");
		expect(sent).toHaveLength(3);
		expect(sent[2].store).toBeUndefined();
		// A fresh sessionless request still tries store:true — no state survived.
		const third = await stream(model, ctx1, options).result();
		expect(third.stopReason).toBe("stop");
		expect(sent).toHaveLength(4);
		expect(sent[3].store).toBe(true);
	});

	it("checkpoint rejection unrelated to checkpoints does not cool the endpoint", async () => {
		// A coded non-checkpoint error (e.g. invalid model) is not a checkpoint
		// signal: it errors out and never starts a cooldown.
		const { sent } = checkpointServer({
			onRequest: (socket) => {
				socket.emit({ type: "error", error: { code: "model_not_found", message: "bad model" } });
				return true;
			},
		});
		const model = makeModel(OFFICIAL_URL);
		const out = await stream(model, ctx1, OPTS).result();
		expect(out.stopReason).toBe("error");
		const next = await stream(model, ctx1, OPTS).result();
		expect(next.stopReason).toBe("error");
		expect(sent).toHaveLength(2);
		expect(sent[1].store).toBe(true);
	});

	it("authentication rejection with param store is never replayed", async () => {
		// A 401 invalid_api_key that happens to carry param:"store" must not be
		// classified as a checkpoint signal: replaying a sent request after an
		// auth failure is unsafe.
		let rejections = 0;
		const { sent, fetchMock } = checkpointServer({
			onRequest: (socket) => {
				rejections++;
				socket.emit({
					type: "error",
					error: { code: "invalid_api_key", message: "Incorrect API key", param: "store", status: 401 },
				});
				return true;
			},
		});
		const model = makeModel(OFFICIAL_URL);
		const out = await stream(model, ctx1, OPTS).result();
		expect(out.stopReason).toBe("error");
		expect(rejections).toBe(1);
		expect(sent).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		[
			"server error 500",
			{ type: "server_error", param: "store", status: 500, message: "Invalid response from upstream" },
		],
		["server_error type", { type: "server_error", param: "store", message: "store is invalid upstream" }],
		["untyped message", { message: "previous_response_id is not available for this user" }],
		["429 not found", { code: "previous_response_not_found", status: 429, message: "slow down" }],
		[
			"500 server_error not found",
			{ code: "previous_response_not_found", status: 500, type: "server_error", message: "gone" },
		],
		[
			"400 internal_error store",
			{ code: "internal_error", status: 400, type: "server_error", param: "store", message: "store invalid" },
		],
		[
			"400 authentication_error store",
			{ status: 400, type: "authentication_error", param: "store", message: "store invalid" },
		],
		["coded unrelated with store param", { code: "model_not_found", param: "store", message: "store invalid" }],
	])("%s is not a checkpoint signal and is never replayed", async (_name, error) => {
		const { sent, fetchMock } = checkpointServer({
			onRequest: (socket) => {
				socket.emit({ type: "error", error });
				return true;
			},
		});
		const out = await stream(makeModel(OFFICIAL_URL), ctx1, OPTS).result();
		expect(out.stopReason).toBe("error");
		expect(sent).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		[
			"unsupported_parameter",
			{
				type: "error",
				error: {
					type: "invalid_request_error",
					code: "unsupported_parameter",
					param: "store",
					message: "Unsupported parameter: 'store'.",
				},
				status: 400,
			},
		],
		[
			"unknown_parameter",
			{
				type: "error",
				error: {
					type: "invalid_request_error",
					code: "unknown_parameter",
					param: "store",
					message: "Unknown parameter: 'store'.",
				},
			},
		],
		[
			"response.failed param-only",
			{
				type: "response.failed",
				response: { error: { type: "invalid_request_error", param: "store", message: "Unsupported parameter" } },
			},
		],
	])("OpenAI-shaped %s store rejection repairs once without store", async (_name, event) => {
		const { sent } = checkpointServer({
			onRequest: (socket, frame) => {
				if (frame.store !== true) return false;
				socket.emit(event);
				return true;
			},
		});
		const out = await stream(makeModel(OFFICIAL_URL), ctx1, OPTS).result();
		expect(out.stopReason).toBe("stop");
		expect(sent).toHaveLength(2);
		expect("store" in sent[1]).toBe(false);
	});

	it("non-signal probe failure renews the cooldown without replay", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let probeFails = false;
		const { sent } = checkpointServer({
			onRequest: (socket, frame) => {
				if (frame.store === true && sent.length === 1) {
					socket.emit({
						type: "error",
						error: { type: "invalid_request_error", param: "store", message: "store is not allowed" },
					});
					return true;
				}
				if (frame.store === true && probeFails) {
					socket.emit({ type: "error", error: { type: "server_error", message: "boom" }, status: 500 });
					return true;
				}
				return false;
			},
		});
		const model = makeModel(OFFICIAL_URL);
		await stream(model, ctx1, OPTS).result(); // [store:true rejected, repair without store]
		expect(sent).toHaveLength(2);
		now += 120_000;
		probeFails = true;
		const probe = await stream(model, ctx1, OPTS).result();
		expect(probe.stopReason).toBe("error");
		expect(sent).toHaveLength(3); // probe sent once, never replayed
		expect(sent[2].store).toBe(true);
		probeFails = false;
		const next = await stream(model, ctx1, OPTS).result();
		expect(next.stopReason).toBe("stop");
		expect("store" in sent[3]).toBe(false); // renewed cooldown
	});

	it.each([
		[
			"response.failed nested status 500",
			{
				type: "response.failed",
				response: {
					error: { status: 500, type: "invalid_request_error", param: "store", message: "store invalid" },
				},
			},
		],
		[
			"top-level 400 with nested 500",
			{
				type: "error",
				status: 400,
				error: { status: 500, type: "invalid_request_error", param: "store", message: "store invalid" },
			},
		],
		[
			"coded not-found hiding nested invalid_api_key",
			{
				type: "error",
				code: "previous_response_not_found",
				error: { code: "invalid_api_key", type: "invalid_request_error", message: "bad key" },
			},
		],
	])("conflicting envelope %s is never replayed", async (_name, event) => {
		const { sent, fetchMock } = checkpointServer({
			onRequest: (socket) => {
				socket.emit(event);
				return true;
			},
		});
		const out = await stream(makeModel(OFFICIAL_URL), ctx1, OPTS).result();
		expect(out.stopReason).toBe("error");
		expect(sent).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("cooldown keeps chaining a caller-rooted descendant and never captures it", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const chained = new Set<string>();
		const { sent } = checkpointServer({
			onRequest: (socket, frame) => {
				if (frame.store === true && sent.length === 1) {
					socket.emit({
						type: "error",
						error: { type: "invalid_request_error", param: "store", message: "store is not allowed" },
					});
					return true;
				}
				// Connection-local chain on the caller-rooted lineage (store omitted).
				if (frame.previous_response_id === "external" || chained.has(frame.previous_response_id ?? "")) {
					(socket as unknown as { respond: (f: SentFrame) => void }).respond({
						...frame,
						previous_response_id: undefined,
					});
					return true;
				}
				return false;
			},
		});
		const model = makeModel(OFFICIAL_URL);
		await stream(model, ctx1, OPTS).result(); // store rejected -> repair -> cooldown
		const onPayload = (payload: unknown) => ({
			...(payload as Record<string, unknown>),
			previous_response_id: "external",
		});
		const callerCtx = normalizeContext({ messages: [userMsg("delta", 2)] });
		const caller = await stream(model, callerCtx, { ...OPTS, onPayload }).result();
		expect(caller.stopReason).toBe("stop");
		expect(sent[2].previous_response_id).toBe("external");
		chained.add(caller.responseId!);
		const descendantCtx = normalizeContext({ messages: [...callerCtx.messages, caller, userMsg("two", 3)] });
		const descendant = await stream(model, descendantCtx, OPTS).result();
		expect(descendant.stopReason).toBe("stop");
		// The descendant chains the caller-rooted response instead of dropping external history.
		expect(sent[3].previous_response_id).toBe(caller.responseId);
		expect(sent[3].input).toHaveLength(1);
		expect("store" in sent[3]).toBe(false);
		expect(descendant.responseCheckpoint).toBeUndefined();
		chained.add(descendant.responseId!);
		// A hook store:false descendant during cooldown still chains the lineage.
		const vetoCtx = normalizeContext({ messages: [...descendantCtx.messages, descendant, userMsg("veto", 4)] });
		const vetoed = await stream(model, vetoCtx, {
			...OPTS,
			onPayload: (payload: unknown) => ({ ...(payload as Record<string, unknown>), store: false }),
		}).result();
		expect(vetoed.stopReason).toBe("stop");
		expect(sent[4].previous_response_id).toBe(descendant.responseId);
		expect(sent[4].store).toBe(false);
		chained.add(vetoed.responseId!);
		// After expiry the probe keeps chaining the caller-rooted lineage and captures nothing.
		now += 120_000;
		const probeCtx = normalizeContext({ messages: [...vetoCtx.messages, vetoed, userMsg("probe", 5)] });
		const probe = await stream(model, probeCtx, OPTS).result();
		expect(probe.stopReason).toBe("stop");
		expect(sent[5].previous_response_id).toBe(vetoed.responseId);
		expect(sent[5].input).toHaveLength(1);
		expect(probe.responseCheckpoint).toBeUndefined();
	});

	it.each(["auto", "websocket-cached"] as const)(
		"%s: unchainable caller-rooted request fails closed without sending; lineage survives",
		async (transport) => {
			const chained = new Set<string>();
			const { sent, fetchMock } = checkpointServer({
				onRequest: (socket, frame) => {
					if (frame.store === true && sent.length === 1) {
						socket.emit({
							type: "error",
							error: { type: "invalid_request_error", param: "store", message: "store is not allowed" },
						});
						return true;
					}
					if (frame.previous_response_id === "external" || chained.has(frame.previous_response_id ?? "")) {
						(socket as unknown as { respond: (f: SentFrame) => void }).respond({
							...frame,
							previous_response_id: undefined,
						});
						return true;
					}
					return false;
				},
			});
			const model = makeModel(OFFICIAL_URL);
			const opts = { ...OPTS, transport };
			await stream(model, ctx1, opts).result();
			const callerCtx = normalizeContext({ messages: [userMsg("delta", 2)] });
			const caller = await stream(model, callerCtx, {
				...opts,
				onPayload: (payload: unknown) => ({
					...(payload as Record<string, unknown>),
					previous_response_id: "external",
				}),
			}).result();
			chained.add(caller.responseId!);
			const before = sent.length;
			const next = normalizeContext({ messages: [...callerCtx.messages, caller, userMsg("two", 3)] });
			const changed = await stream({ ...model, maxTokens: 128 }, next, { ...opts, maxTokens: 128 }).result();
			expect(changed.stopReason).toBe("error");
			expect(sent).toHaveLength(before);
			expect(fetchMock).not.toHaveBeenCalled();
			const retried = await stream(model, next, opts).result();
			expect(retried.stopReason).toBe("stop");
			expect(sent.at(-1)!.previous_response_id).toBe(caller.responseId);
		},
	);

	it("prod gateway output (logprobs: []) still repairs a keeper miss after a successful continuation", async () => {
		let continuations = 0;
		const withLogprobs = (events: Record<string, unknown>[]) =>
			JSON.parse(JSON.stringify(events).replaceAll('"annotations":[]', '"annotations":[],"logprobs":[]'));
		const { sent, fetchMock } = checkpointServer({
			events: withLogprobs,
			onRequest: (socket, frame) => {
				// Keeper restart: the second chained reference is gone.
				if (frame.previous_response_id && ++continuations === 2) {
					socket.emit({
						type: "error",
						status: 400,
						error: {
							code: "previous_response_not_found",
							message: `Previous response with id '${frame.previous_response_id}' not found.`,
							param: "previous_response_id",
							type: "invalid_request_error",
						},
					});
					return true;
				}
				return false;
			},
		});
		const model = makeModel(CUSTOM_URL);
		let context = ctx1;
		const outs: AssistantMessage[] = [];
		for (let turn = 0; turn < 3; turn++) {
			const out = await stream(model, context, OPTS).result();
			outs.push(out);
			context = normalizeContext({ messages: [...context.messages, out, userMsg(`next ${turn}`, turn + 2)] });
		}
		expect(outs.map((out) => out.stopReason)).toEqual(["stop", "stop", "stop"]);
		expect(fetchMock).not.toHaveBeenCalled();
		const repair = sent.at(-1)!;
		expect(repair.previous_response_id).toBeUndefined();
		expect(repair.store).toBeUndefined();
		expect(repair.input).toHaveLength(5);
	});

	it("cooldown never strips a caller-owned previous_response_id", async () => {
		const { sent } = serverFail("store");
		const model = makeModel(OFFICIAL_URL);
		await stream(model, ctx1, OPTS).result(); // store rejected -> repaired -> cooldown
		expect(sent).toHaveLength(2);
		const onPayload = (payload: unknown) => ({
			...(payload as Record<string, unknown>),
			previous_response_id: "external-parent",
		});
		await stream(model, ctx1, { ...OPTS, onPayload }).result();
		expect(sent[2].previous_response_id).toBe("external-parent");
		expect("store" in sent[2]).toBe(false);
	});

	it("parameter-only unsupported wording on previous_response_id is a signal", async () => {
		const { sent } = checkpointServer({
			onRequest: (socket, frame) => {
				if (!frame.previous_response_id) return false;
				socket.emit({
					type: "error",
					error: {
						type: "invalid_request_error",
						param: "previous_response_id",
						message: "Unsupported parameter",
					},
				});
				return true;
			},
		});
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
		const second = await stream(model, ctx2, OPTS).result();
		expect(second.stopReason).toBe("stop");
		expect(sent).toHaveLength(3);
		expect(sent[1].previous_response_id).toBe(first.responseId);
		expect(sent[2].previous_response_id).toBeUndefined();
		expect("store" in sent[2]).toBe(false);
		expect(sent[2].input).toHaveLength(3);
	});

	it("checkpoint opt-out keeps the connection-local missing-reference repair", async () => {
		let dropped = false;
		const { sent } = checkpointServer({
			onRequest: (socket, frame) => {
				if (!frame.previous_response_id || dropped) return false;
				dropped = true;
				socket.emit({ type: "error", error: { code: "previous_response_not_found", message: "gone" } });
				return true;
			},
		});
		const model = makeModel(OFFICIAL_URL);
		const opts = { ...OPTS, responseCheckpointExclude: ["*"] };
		const first = await stream(model, ctx1, opts).result();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
		const second = await stream(model, ctx2, opts).result();
		expect(second.stopReason).toBe("stop");
		expect(sent).toHaveLength(3);
		expect(sent[1].previous_response_id).toBeDefined();
		expect(sent[2].previous_response_id).toBeUndefined();
		expect(sent[2].input).toHaveLength(3);
		expect(sent.every((frame) => frame.store === false)).toBe(true);
	});

	it("hook store:false survives cooldown and SSE fallback and never claims a probe", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const { sent } = serverFail("store");
		const model = makeModel(OFFICIAL_URL);
		const onPayload = (payload: unknown) => ({ ...(payload as Record<string, unknown>), store: false });
		// Turn 1: store rejected, repaired without store, endpoint cools down.
		await stream(model, ctx1, OPTS).result();
		expect(sent).toHaveLength(2);
		// During the cooldown the explicit hook false stays on the wire, and two
		// successive vetoed turns still send full context (no cached delta).
		const cooled = await stream(model, ctx1, { ...OPTS, onPayload }).result();
		expect(cooled.stopReason).toBe("stop");
		expect(sent[2].store).toBe(false);
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, cooled, userMsg("Next", 2)] });
		const cooled2 = await stream(model, ctx2, { ...OPTS, onPayload }).result();
		expect(cooled2.stopReason).toBe("stop");
		expect(sent[3].store).toBe(false);
		expect(sent[3].previous_response_id).toBeUndefined();
		expect(sent[3].input).toHaveLength(3);
		// After the deadline a vetoed request does not consume the probe claim...
		now += 120_000;
		await stream(model, ctx1, { ...OPTS, onPayload }).result();
		expect(sent[4].store).toBe(false);
		// ...so the next policy request is still the store:true probe.
		await stream(model, ctx1, OPTS).result();
		expect(sent[5].store).toBe(true);
		// SSE fallback keeps the explicit false too.
		const bodies: Record<string, unknown>[] = [];
		class FailSocket extends EventTarget {
			readyState = 1;
			constructor() {
				super();
				queueMicrotask(() => this.dispatchEvent(new Event("error")));
			}
			send(): void {
				throw new Error("unreachable");
			}
			close(): void {
				this.readyState = 3;
			}
		}
		vi.stubGlobal("WebSocket", FailSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				bodies.push(jsonRequestBody(init));
				return new Response(
					'data: {"type":"response.completed","response":{"id":"resp_sse","status":"completed"}}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			}),
		);
		const sse = await stream(model, ctx1, { ...OPTS, sessionId: undefined, onPayload }).result();
		expect(sse.stopReason).toBe("stop");
		expect(bodies[0].store).toBe(false);
	});

	it("chatgpt.com baseUrl is hard-gated in always mode", async () => {
		const { sent } = checkpointServer();
		const model = makeModel("https://chatgpt.com/backend-api/codex/v1");
		const out = await stream(model, ctx1, OPTS).result();
		expect(out.stopReason).toBe("stop");
		expect(sent[0].store).toBe(false);
		expect(out.responseCheckpoint).toBeUndefined();
		// A chatgpt.com subdomain is gated too.
		const sub = await stream(makeModel("https://api.chatgpt.com/v1"), ctx1, OPTS).result();
		expect(sent[1].store).toBe(false);
		expect(sub.responseCheckpoint).toBeUndefined();
	});

	it("SSE fallback requests never carry the policy store", async () => {
		const bodies: unknown[] = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			bodies.push(init?.body ? jsonRequestBody(init) : undefined);
			return new Response(
				'data: {"type":"response.completed","response":{"id":"resp_sse","status":"completed"}}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		class FailSocket extends EventTarget {
			readyState = 1;
			constructor() {
				super();
				// Connection-level failure before the request is sent: auto falls back to SSE.
				queueMicrotask(() => this.dispatchEvent(new Event("error")));
			}
			send(): void {
				throw new Error("unreachable");
			}
			close(): void {
				this.readyState = 3;
			}
		}
		vi.stubGlobal("WebSocket", FailSocket);
		vi.stubGlobal("fetch", fetchMock);
		// Sessionless: no WS retry budget bookkeeping, immediate auto fallback.
		const out = await stream(makeModel(OFFICIAL_URL), ctx1, { ...OPTS, sessionId: undefined }).result();
		expect(out.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect("store" in (bodies[0] as object)).toBe(false);
		expect("previous_response_id" in (bodies[0] as object)).toBe(false);
	});

	it.each(["signal", "server-error", "uncaptured"] as const)(
		"steps failed %s probes through two, three, four, five minutes; only a valid checkpoint resets",
		async (failure) => {
			let now = 1000;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			let healthy = false;
			let rejectNext = true;
			const { sent, fetchMock } = checkpointServer({
				onRequest: (socket, frame) => {
					if (healthy || frame.store !== true) return false;
					const initialRejection = rejectNext;
					rejectNext = false;
					if (!initialRejection && failure === "uncaptured") return false;
					socket.emit({
						type: "error",
						error:
							!initialRejection && failure === "server-error"
								? { type: "server_error", message: "boom" }
								: { type: "invalid_request_error", param: "store", message: "store is not allowed" },
					});
					return true;
				},
				events: (events) => {
					if (!healthy && failure === "uncaptured") {
						(events.at(-1)!.response as Record<string, unknown>).store = false;
					}
					return events;
				},
			});
			const model = makeModel(OFFICIAL_URL);
			const run = () => stream(model, ctx1, OPTS).result();
			await run(); // Initial rejection, then successful store-disabled repair.
			expect(sent).toHaveLength(2);
			for (const [index, cooldown] of [120_000, 180_000, 240_000, 300_000, 300_000].entries()) {
				now += cooldown - 1;
				const fallback = await run();
				expect(fallback.stopReason).toBe("stop");
				expect(fallback.responseCheckpoint).toBeUndefined();
				expect(sent.at(-1)!.store).toBeUndefined();
				const attempts = sent.length;
				now++;
				healthy = index === 4;
				const probe = await run();
				expect(sent[attempts].store).toBe(true);
				if (healthy) expect(probe.responseCheckpoint).toBeDefined();
				else expect(probe.responseCheckpoint).toBeUndefined();
			}
			healthy = false;
			rejectNext = true;
			await run(); // A new rejection after checkpoint success must restart at two minutes.
			now += 119_999;
			await run();
			expect(sent.at(-1)!.store).toBeUndefined();
			now++;
			healthy = true;
			expect((await run()).responseCheckpoint).toBeDefined();
			expect(sent.at(-1)!.store).toBe(true);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each(["complete", "error"] as const)(
		"counts a rejected store probe once when its store-off repair ends late with %s",
		async (finish) => {
			let now = 1000;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			let storeAttempts = 0;
			let slowRepair = true;
			const { sent, fetchMock } = checkpointServer({
				onRequest: (socket, frame) => {
					if (frame.store === true) {
						storeAttempts++;
						socket.emit({
							type: "error",
							error: { type: "invalid_request_error", param: "store", message: "store is not allowed" },
						});
						return true;
					}
					if (storeAttempts === 2 && slowRepair) {
						slowRepair = false;
						now = 301_001; // Repair outlives the renewed three-minute cooldown.
						if (finish === "error") {
							socket.emit({ type: "error", error: { type: "server_error", message: "repair failed" } });
							return true;
						}
					}
					return false;
				},
			});
			const run = () => stream(makeModel(OFFICIAL_URL), ctx1, { ...OPTS, timeoutMs: 0 }).result();
			await run();
			now = 121_000;
			expect((await run()).stopReason).toBe(finish === "error" ? "error" : "stop");
			expect(now).toBe(301_001);
			now = 481_000;
			await run();
			expect(sent.at(-1)!.store).toBeUndefined();
			const attempts = sent.length;
			now = 481_001;
			await run();
			expect(sent[attempts].store).toBe(true);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([false, true])("SSE-only fallback failure=%s never consumes an expired store probe", async (fails) => {
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let drop = false;
		const { sent, fetchMock } = checkpointServer({
			onRequest: (socket, frame) => {
				if (drop) {
					socket.fail();
					return true;
				}
				if (frame.store !== true) return false;
				socket.emit({
					type: "error",
					error: { type: "invalid_request_error", param: "store", message: "store is not allowed" },
				});
				return true;
			},
		});
		const sse = () =>
			new Response('data: {"type":"response.completed","response":{"id":"sse","status":"completed"}}\n\n', {
				headers: { "content-type": "text/event-stream" },
			});
		fetchMock.mockImplementation(async () => sse());
		// The HTTP SDK treats timeout:0 as immediate cancellation, not disabled timeout.
		const run = () => stream(makeModel(OFFICIAL_URL), ctx1, { ...OPTS, maxRetries: 0 }).result();
		await run(); // Store deadline 121000.
		now = 61_000;
		drop = true;
		for (let index = 0; index < 4; index++) await run(); // WS deadline 181000.
		const attempts = sent.length;
		now = 121_000;
		fetchMock.mockImplementation(async () => (fails ? new Response("SSE outage", { status: 503 }) : sse()));
		expect((await run()).stopReason).toBe(fails ? "error" : "stop");
		expect(sent).toHaveLength(attempts);
		now = 181_000;
		drop = false;
		fetchMock.mockImplementation(async () => sse());
		await run();
		expect(sent[attempts].store).toBe(true);
	});

	it("WS success resets transport progression without resetting store failure progression", async () => {
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let drop = false;
		const { sent, fetchMock } = checkpointServer({
			onRequest: (socket, frame) => {
				if (drop) {
					socket.fail();
					return true;
				}
				if (frame.store !== true) return false;
				socket.emit({
					type: "error",
					error: { type: "invalid_request_error", param: "store", message: "store is not allowed" },
				});
				return true;
			},
		});
		fetchMock.mockImplementation(
			async () =>
				new Response('data: {"type":"response.completed","response":{"id":"sse","status":"completed"}}\n\n', {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const run = () => stream(makeModel(OFFICIAL_URL), ctx1, OPTS).result();
		await run(); // Store cooldown: two minutes.
		now += 120_000;
		await run(); // Store probe rejected, WS repair succeeds; store now cools for three minutes.
		drop = true;
		for (let index = 0; index < 4; index++) await run();
		const attempts = sent.length;
		now += 119_999;
		await run();
		expect(sent).toHaveLength(attempts);
		now++;
		drop = false;
		await run(); // WS probe succeeds while store remains off.
		expect(sent).toHaveLength(attempts + 1);
		expect(sent.at(-1)!.store).toBeUndefined();
		now += 59_999;
		await run();
		expect(sent.at(-1)!.store).toBeUndefined();
		now++;
		await run(); // Store probe still fires at its own deadline; successful WS did not reset it.
		expect(sent.at(-2)!.store).toBe(true);
		expect(sent.at(-1)!.store).toBeUndefined();
		drop = true;
		for (let index = 0; index < 4; index++) await run();
		const afterSuccess = sent.length;
		now += 119_999;
		await run();
		expect(sent).toHaveLength(afterSuccess);
		now++;
		drop = false;
		await run(); // WS restarted at two minutes, not three.
		expect(sent).toHaveLength(afterSuccess + 1);
		now += 119_999;
		await run();
		expect(sent.at(-1)!.store).toBeUndefined();
		now++;
		await run(); // Store's next failed-probe window was four minutes, not two.
		expect(sent.at(-2)!.store).toBe(true);
	});

	it("probe completion without a captured checkpoint keeps the cooldown", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		// Store is accepted but the terminal event declares store:false, so no
		// checkpoint is captured: the cooldown must survive the probe.
		const { sent } = checkpointServer({
			failStore: true,
			onRequest: (socket, frame) => {
				if (frame.previous_response_id) {
					socket.emit({
						type: "error",
						error: { code: "previous_response_not_found", message: "No such response" },
					});
					return true;
				}
				return false;
			},
		});
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, OPTS).result();
		expect(first.responseCheckpoint).toBeUndefined();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
		const second = await stream(model, ctx2, OPTS).result();
		expect(second.stopReason).toBe("stop");
		// Delta rejected -> repair without store; cooldown starts.
		expect(sent[2].store).toBeUndefined();
		now += 120_000;
		const ctx3 = normalizeContext({ messages: [...ctx2.messages, second, userMsg("Probe", 3)] });
		const third = await stream(model, ctx3, OPTS).result();
		expect(third.stopReason).toBe("stop");
		// The probe sent store:true but captured nothing (failStore).
		expect(sent[3].store).toBe(true);
		expect(third.responseCheckpoint).toBeUndefined();
		const ctx4 = normalizeContext({ messages: [...ctx3.messages, third, userMsg("After", 4)] });
		await stream(model, ctx4, OPTS).result();
		// No checkpoint captured -> cooldown persists -> next request has no store.
		expect(sent[4].store).toBeUndefined();
	});

	it(
		"overlapping requests: only one probe, the other stays full and checkpoint-free",
		{ timeout: 10_000 },
		async () => {
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			let held: (() => void) | undefined;
			let probeSeen!: () => void;
			const probeArrived = new Promise<void>((resolve) => {
				probeSeen = resolve;
			});
			let cooledDown = false;
			const { sent } = checkpointServer({
				onRequest: (socket, frame) => {
					if (!cooledDown && frame.store === true) {
						socket.emit({
							type: "error",
							error: { type: "invalid_request_error", param: "store", message: "store is not allowed" },
						});
						return true;
					}
					if (cooledDown && frame.store === true && !held) {
						// Hold the probe until the overlapping request has finished.
						held = () => (socket as unknown as { respond: (f: SentFrame) => void }).respond(frame);
						probeSeen();
						return true;
					}
					return false;
				},
			});
			const model = makeModel(OFFICIAL_URL);
			const ctx2 = normalizeContext({ messages: [...ctx1.messages, { ...userMsg("More", 2) }] });
			await stream(model, ctx1, OPTS).result(); // store rejected -> repaired -> cooldown
			cooledDown = true;
			now += 120_000;
			const probe = stream(model, ctx2, OPTS).result();
			await probeArrived;
			const concurrent = await stream(model, ctx2, OPTS).result();
			expect(concurrent.stopReason).toBe("stop");
			expect(concurrent.responseCheckpoint).toBeUndefined();
			const concurrentFrame = sent.at(-1)!;
			expect("store" in concurrentFrame).toBe(false);
			expect(concurrentFrame.previous_response_id).toBeUndefined();
			expect(concurrentFrame.input).toHaveLength(2);
			held!();
			const probeOut = await probe;
			expect(probeOut.stopReason).toBe("stop");
			expect(probeOut.responseCheckpoint).toBeDefined();
			expect(sent.filter((frame) => frame.store === true)).toHaveLength(2); // rejected turn 1 + one probe
		},
	);

	it("one probe per session: a concurrent request stays checkpoint-free", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		// The concurrency gate is pure state; exercise it through the exported API.
		recordCheckpointCooldown("openai-responses", sessionId, "probe-identity");
		now += 120_000;
		const firstProbe = resolveCheckpointCooldown("openai-responses", sessionId, "probe-identity");
		expect(firstProbe.allowed).toBe(true);
		expect(firstProbe.probe).toBeDefined();
		const concurrent = resolveCheckpointCooldown("openai-responses", sessionId, "probe-identity");
		expect(concurrent.allowed).toBe(false);
		expect(concurrent.probe).toBeUndefined();
		// A sent probe opens the next step; a second in-flight failure only renews it.
		firstProbe.probe!.attempted = true;
		now += 100;
		recordCheckpointCooldown("openai-responses", sessionId, "probe-identity", firstProbe.probe);
		now += 100;
		recordCheckpointCooldown("openai-responses", sessionId, "probe-identity");
		now += 179_999;
		expect(resolveCheckpointCooldown("openai-responses", sessionId, "probe-identity").allowed).toBe(false);
		now++;
		// Even beyond the renewed deadline, the original probe still owns recovery.
		expect(resolveCheckpointCooldown("openai-responses", sessionId, "probe-identity").allowed).toBe(false);
		// Releasing the claim lets a later request probe again.
		firstProbe.probe!.state.probing = false;
		const renewed = resolveCheckpointCooldown("openai-responses", sessionId, "probe-identity");
		expect(renewed.allowed).toBe(true);
		expect(renewed.probe).toBeDefined();
	});
});
