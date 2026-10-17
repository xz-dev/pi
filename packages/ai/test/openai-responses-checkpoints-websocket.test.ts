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
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Model, ProviderHeaders } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

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
		for (const responseCheckpointExclude of [undefined, ["*"]]) {
			const out = await streamSimple(model, ctx1, { ...OPTS, responseCheckpointExclude }).result();
			expect(out.responseCheckpoint).toBeUndefined();
		}
		expect(sent.slice(2).map((frame) => frame.store)).toEqual([false, false]);
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
		now += 6 * 60 * 1000;
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

	it.each(["missing policy", "excluded policy", "hook store:false", "complete local"])(
		"policy transition preserves reconstruction provenance: %s",
		async (mode) => {
			let turns = 0;
			const { sent, generations } = checkpointServer({
				events: (events) => (++turns === 1 && mode !== "complete local" ? [events[0], events[3]] : events),
			});
			const model = makeModel(OFFICIAL_URL);
			const first = await stream(model, ctx1, {
				apiKey,
				sessionId,
				...(mode === "excluded policy" ? { responseCheckpointExclude: ["*"] } : {}),
				...(mode === "hook store:false" ? { responseCheckpointExclude: [] } : {}),
				onPayload: (payload) => ({
					...(payload as Record<string, unknown>),
					store: mode !== "hook store:false",
				}),
			}).result();
			expect(first.stopReason).toBe("stop");
			expect(first.responseCheckpoint).toBeUndefined();
			if (mode !== "complete local") expect(first.content).toEqual([]);
			const nextContext = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
			const second = await stream(model, nextContext, OPTS).result();
			expect(second.stopReason).toBe("stop");
			// Provenance tracking must not change legacy connection-local wire behavior.
			expect(sent[1].previous_response_id).toBe(mode === "hook store:false" ? undefined : first.responseId);
			const proven = mode === "complete local" || mode === "hook store:false";
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
	it("default off: no store:true, no checkpoint, no cross-connection delta", async () => {
		const { sent, sockets } = checkpointServer();
		const model = makeModel(OFFICIAL_URL);
		const first = await stream(model, ctx1, { apiKey, sessionId }).result();
		expect(first.stopReason).toBe("stop");
		expect(sent[0].store).toBe(false);
		expect(first.responseCheckpoint).toBeUndefined();
		closeOpenAIResponsesWebSocketSessions();
		const ctx2 = normalizeContext({ messages: [...ctx1.messages, first, userMsg("Next", 2)] });
		const second = await stream(model, ctx2, { apiKey, sessionId }).result();
		expect(second.stopReason).toBe("stop");
		expect(sockets.length).toBe(2);
		expect(sent[1].previous_response_id).toBeUndefined();
		expect((sent[1].input as unknown[]).length).toBeGreaterThan(1);
	});

	it("custom endpoint needs explicit capability declaration", async () => {
		const { sent } = checkpointServer();
		const model = makeModel(CUSTOM_URL); // no compat flag => not capable
		const first = await stream(model, ctx1, { apiKey, sessionId, responseCheckpointExclude: [] }).result();
		expect(sent[0].store).toBe(false);
		expect(first.responseCheckpoint).toBeUndefined();
		// Declared capable endpoint: store:true and checkpoint.
		const declared = makeModel(CUSTOM_URL, { supportsResponseCheckpoints: true });
		const second = await stream(declared, ctx1, { apiKey, sessionId, responseCheckpointExclude: [] }).result();
		expect(sent[1].store).toBe(true);
		expect(second.responseCheckpoint).toBeDefined();
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
