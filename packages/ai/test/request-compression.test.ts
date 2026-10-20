import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { createRequestCompressionFetch, getRequestCompressionEncoding } from "../src/utils/request-compression.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const ORIGIN_A = "https://gateway-a.test";
const ANTHROPIC = "https://api.anthropic.com";

function jsonInit(body: string, headers?: Record<string, string>): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	};
}

function decompress(encoding: string, bytes: Uint8Array): string {
	const buf = Buffer.from(bytes);
	switch (encoding) {
		case "zstd":
			return zstdDecompressSync(buf).toString("utf8");
		case "gzip":
			return gunzipSync(buf).toString("utf8");
		case "deflate":
			return inflateSync(buf).toString("utf8");
		case "br":
			return brotliDecompressSync(buf).toString("utf8");
		default:
			throw new Error(`unknown encoding ${encoding}`);
	}
}

type Captured = { encoding: string | null; body: Uint8Array | string | undefined; url: string };

function makeFetch(handler: (call: Captured, index: number) => Response | Promise<Response>) {
	const calls: Captured[] = [];
	const fn = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
		const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
		const headers = input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers);
		if (init?.headers) for (const [k, v] of new Headers(init.headers).entries()) headers.set(k, v);
		const rawBody =
			init?.body !== undefined ? init.body : input instanceof Request ? await input.arrayBuffer() : undefined;
		const captured: Captured = {
			url,
			encoding: headers.get("content-encoding"),
			body: (rawBody instanceof ArrayBuffer ? new Uint8Array(rawBody) : rawBody) as Uint8Array | string | undefined,
		};
		calls.push(captured);
		return handler(captured, calls.length - 1);
	});
	return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

const BIG_JSON = `{"messages":[{"role":"user","content":"${"compress me ".repeat(200)}"}]}`;

describe("request-compression fetch wrapper", () => {
	it("compresses a buffered JSON POST even when the endpoint does not advertise encodings", async () => {
		const { fn, calls } = makeFetch(() => new Response("{}", { status: 200 }));
		const wrapped = createRequestCompressionFetch(fn);
		const res = await wrapped(`${ORIGIN_A}/v1/x`, jsonInit(BIG_JSON));
		expect(res.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0].encoding).toBe("zstd");
		expect(decompress("zstd", calls[0].body as Uint8Array)).toBe(BIG_JSON);
		expect(getRequestCompressionEncoding(res)).toBe("zstd");
	});

	it("reports the final actual upload codec after a refusal downgrade", async () => {
		const origin = "https://label-refusal.test";
		const { fn } = makeFetch((c) =>
			c.encoding === "zstd" ? new Response("unsupported content-encoding", { status: 415 }) : new Response("{}"),
		);
		const wrapped = createRequestCompressionFetch(fn);
		const response = await wrapped(`${origin}/x`, jsonInit(BIG_JSON));
		expect(getRequestCompressionEncoding(response)).toBe("gzip");
	});

	it("does not infer upload compression from response headers or a previous upload", async () => {
		const origin = "https://label-identity.test";
		const { fn } = makeFetch(() => new Response("{}", { headers: { "content-encoding": "br" } }));
		const wrapped = createRequestCompressionFetch(fn);
		const compressed = await wrapped(`${origin}/x`, jsonInit(BIG_JSON));
		const tiny = await wrapped(`${origin}/x`, jsonInit('{"a":1}'));
		const get = await wrapped(`${origin}/get`);
		expect(getRequestCompressionEncoding(compressed)).toBe("zstd");
		expect(getRequestCompressionEncoding(tiny)).toBeUndefined();
		expect(getRequestCompressionEncoding(get)).toBeUndefined();
	});

	it("keeps the caller's own content-encoding opaque", async () => {
		const { fn } = makeFetch(() => new Response("{}"));
		const wrapped = createRequestCompressionFetch(fn);
		const response = await wrapped(`${ORIGIN_A}/enc`, jsonInit(BIG_JSON, { "content-encoding": "custom" }));
		expect(getRequestCompressionEncoding(response)).toBeUndefined();
	});

	it("roundtrips exact bytes including base64-like content", async () => {
		const payload = JSON.stringify({ data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(50), n: 1 });
		const { fn, calls } = makeFetch(() => new Response("ok"));
		await createRequestCompressionFetch(fn)(`${ORIGIN_A}/rt`, jsonInit(payload));
		expect(decompress("zstd", calls[0].body as Uint8Array)).toBe(payload);
	});

	it("does not compress when custom Content-Encoding is already set", async () => {
		const { fn, calls } = makeFetch(() => new Response("ok"));
		await createRequestCompressionFetch(fn)(
			`${ORIGIN_A}/enc`,
			jsonInit(BIG_JSON, { "content-encoding": "identity" }),
		);
		expect(calls[0].encoding).toBe("identity");
		expect(calls[0].body).toBe(BIG_JSON);
	});

	it("passes through non-JSON bodies and GET unchanged", async () => {
		const { fn, calls } = makeFetch(() => new Response("ok"));
		const wrapped = createRequestCompressionFetch(fn);
		await wrapped(`${ORIGIN_A}/get`);
		await wrapped(`${ORIGIN_A}/form`, { method: "POST", body: new URLSearchParams({ a: "b" }) });
		await wrapped(`${ORIGIN_A}/text`, { method: "POST", headers: { "content-type": "text/plain" }, body: BIG_JSON });
		for (const c of calls) {
			expect(c.encoding).toBeNull();
		}
		expect(calls[1].body).toBeInstanceOf(URLSearchParams);
		expect(calls[2].body).toBe(BIG_JSON);
	});

	it("steps down the ladder only on explicit encoding refusal and memoizes per origin", async () => {
		const origin = "https://refusal.test";
		const refusal = (msg: string) => new Response(msg, { status: 415, statusText: "Unsupported Media Type" });
		const { fn, calls } = makeFetch((c) => {
			if (c.encoding === "zstd") return refusal("unsupported content-encoding");
			return new Response("{}", { status: 200 });
		});
		await createRequestCompressionFetch(fn)(`${origin}/x`, jsonInit(BIG_JSON));
		expect(calls.map((c) => c.encoding)).toEqual(["zstd", "gzip"]);
		expect(decompress("gzip", calls[1].body as Uint8Array)).toBe(BIG_JSON);

		// A fresh wrapper must not retry zstd on the same origin.
		const { fn: fn2, calls: calls2 } = makeFetch(() => new Response("{}", { status: 200 }));
		await createRequestCompressionFetch(fn2)(`${origin}/x`, jsonInit(BIG_JSON));
		expect(calls2[0].encoding).toBe("gzip");
	});

	it("walks to identity and stays there", async () => {
		const origin = "https://all-refuse.test";
		const { fn, calls } = makeFetch((c) =>
			c.encoding === null
				? new Response("{}", { status: 200 })
				: new Response("unsupported content-encoding", { status: 415 }),
		);
		const identity = await createRequestCompressionFetch(fn)(`${origin}/x`, jsonInit(BIG_JSON));
		expect(getRequestCompressionEncoding(identity)).toBeUndefined();
		expect(calls.map((c) => c.encoding)).toEqual(["zstd", "gzip", "deflate", "br", null]);
		expect(calls[calls.length - 1].body).toBe(BIG_JSON);

		const { fn: fn2, calls: calls2 } = makeFetch(() => new Response("{}", { status: 200 }));
		await createRequestCompressionFetch(fn2)(`${origin}/x`, jsonInit(BIG_JSON));
		expect(calls2.map((c) => c.encoding)).toEqual([null]);
	});

	it("judges an arbitrary 400 with one uncompressed resend and surfaces that error", async () => {
		const origin = "https://bad-json.test";
		const { fn, calls } = makeFetch(
			() => new Response(JSON.stringify({ error: { message: "invalid request: bad field" } }), { status: 400 }),
		);
		const res = await createRequestCompressionFetch(fn)(`${origin}/x`, jsonInit(BIG_JSON));
		expect(res.status).toBe(400);
		expect(calls.map((c) => c.encoding)).toEqual(["zstd", null]);
		expect(calls[1].body).toBe(BIG_JSON);
		expect(await res.json()).toEqual({ error: { message: "invalid request: bad field" } });
		// Both forms failed: no capability verdict, the next request probes again.
		const later = makeFetch(() => new Response("{}"));
		await createRequestCompressionFetch(later.fn)(`${origin}/x`, jsonInit(BIG_JSON));
		expect(later.calls[0].encoding).toBe("zstd");
	});

	it("stays uncompressed when a gateway blocks compressed bodies but accepts plain JSON", async () => {
		const origin = "https://waf.test";
		for (const block of [
			() => new Response("Forbidden", { status: 403 }),
			() => new Response("bad gateway", { status: 502 }),
			() => new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400 }),
			() => {
				throw new TypeError("fetch failed: connection reset");
			},
		]) {
			const path = `${origin}/${Math.random()}`;
			const { fn, calls } = makeFetch((c) => (c.encoding === null ? new Response("{}") : block()));
			const wrapped = createRequestCompressionFetch(fn);
			const res = await wrapped(path, jsonInit(BIG_JSON));
			expect(res.status).toBe(200);
			expect(getRequestCompressionEncoding(res)).toBeUndefined();
			await wrapped(path, jsonInit(BIG_JSON));
			expect(calls.map((c) => c.encoding)).toEqual(["zstd", null, null]);
		}
	});

	it("does not resend media-type-only 415 twice or poison later codec selection", async () => {
		const url = "https://media-type-only.test/v1/responses";
		const first = makeFetch(() => new Response("Only application/vnd.api+json is accepted", { status: 415 }));
		const response = await createRequestCompressionFetch(first.fn)(url, jsonInit(BIG_JSON));
		expect(first.calls.map((c) => c.encoding)).toEqual(["zstd", null]);
		expect(await response.text()).toBe("Only application/vnd.api+json is accepted");
		const later = makeFetch(() => new Response("{}"));
		await createRequestCompressionFetch(later.fn)(url, jsonInit(BIG_JSON));
		expect(later.calls[0].encoding).toBe("zstd");
	});

	it("accepts a 415 response's explicit request-encoding advertisement", async () => {
		const mock = makeFetch((call) =>
			call.encoding === "zstd"
				? new Response(null, { status: 415, headers: { "accept-encoding": "gzip" } })
				: new Response("{}"),
		);
		await createRequestCompressionFetch(mock.fn)("https://advertised-refusal.test/x", jsonInit(BIG_JSON));
		expect(mock.calls.map((call) => call.encoding)).toEqual(["zstd", "gzip"]);
	});

	it("treats a 400 naming content-encoding support as a refusal", async () => {
		const origin = "https://400-refusal.test";
		const { fn, calls } = makeFetch((c) =>
			c.encoding === "zstd"
				? new Response(JSON.stringify({ error: "unsupported content-encoding: zstd" }), { status: 400 })
				: new Response("{}", { status: 200 }),
		);
		const res = await createRequestCompressionFetch(fn)(`${origin}/x`, jsonInit(BIG_JSON));
		expect(res.status).toBe(200);
		expect(calls.map((c) => c.encoding)).toEqual(["zstd", "gzip"]);
	});

	it("never resends on auth, size, rate-limit, or overload failures", async () => {
		const origin = "https://no-replay.test";
		for (const status of [401, 413, 429, 503]) {
			const { fn, calls } = makeFetch(() => new Response("nope", { status }));
			const res = await createRequestCompressionFetch(fn)(`${origin}/s${status}`, jsonInit(BIG_JSON));
			expect(res.status).toBe(status);
			expect(calls).toHaveLength(1);
		}
	});

	it("surfaces the uncompressed error when both probe forms fail", async () => {
		const origin = "https://both-fail.test";
		const { fn, calls } = makeFetch((c) => {
			if (c.encoding === null) throw new Error("socket hangup");
			throw new Error("compressed hangup");
		});
		await expect(createRequestCompressionFetch(fn)(`${origin}/net`, jsonInit(BIG_JSON))).rejects.toThrow(
			"socket hangup",
		);
		expect(calls.map((c) => c.encoding)).toEqual(["zstd", null]);
	});

	it("returns later failures directly once the target accepted the codec", async () => {
		const url = "https://verified.test/x";
		let fail = false;
		const { fn, calls } = makeFetch(() => (fail ? new Response("bad field", { status: 400 }) : new Response("{}")));
		const wrapped = createRequestCompressionFetch(fn);
		await wrapped(url, jsonInit(BIG_JSON));
		fail = true;
		const res = await wrapped(url, jsonInit(BIG_JSON));
		expect(res.status).toBe(400);
		expect(calls.map((c) => c.encoding)).toEqual(["zstd", "zstd"]);
	});

	it("forwards abort errors and does not downgrade", async () => {
		const origin = "https://abort.test";
		const { fn, calls } = makeFetch(() => {
			const e = new Error("aborted");
			e.name = "AbortError";
			throw e;
		});
		await expect(createRequestCompressionFetch(fn)(`${origin}/x`, jsonInit(BIG_JSON))).rejects.toThrow("aborted");
		expect(calls).toHaveLength(1);
		const next = makeFetch(() => new Response("{}"));
		await createRequestCompressionFetch(next.fn)(`${origin}/x`, jsonInit(BIG_JSON));
		expect(next.calls[0].encoding).toBe("zstd");
	});

	it("keeps per-origin state isolated", async () => {
		const originX = "https://iso-x.test";
		const originY = "https://iso-y.test";
		const refuse = makeFetch((c) =>
			c.encoding === "zstd" ? new Response("unsupported content-encoding", { status: 415 }) : new Response("{}"),
		);
		await createRequestCompressionFetch(refuse.fn)(`${originX}/x`, jsonInit(BIG_JSON));
		const ok = makeFetch(() => new Response("{}"));
		await createRequestCompressionFetch(ok.fn)(`${originY}/x`, jsonInit(BIG_JSON));
		expect(ok.calls[0].encoding).toBe("zstd");
	});

	it("does not upgrade after downgrade even across wrapper recreation", async () => {
		const origin = "https://sticky-floor.test";
		const first = makeFetch((c) =>
			c.encoding === "zstd" ? new Response("unsupported content-encoding", { status: 415 }) : new Response("{}"),
		);
		await createRequestCompressionFetch(first.fn)(`${origin}/x`, jsonInit(BIG_JSON));
		// Later fresh wrapper sends at gzip or lower; no zstd retry.
		const second = makeFetch(() => new Response("{}"));
		await createRequestCompressionFetch(second.fn)(`${origin}/x`, jsonInit(BIG_JSON));
		expect(second.calls[0].encoding).not.toBe("zstd");
	});

	it("serializes probes per target: concurrent requests wait for the verdict", async () => {
		const origin = "https://race-floor.test";
		let admitFirst!: () => void;
		let finishFirst!: (response: Response) => void;
		const firstAdmitted = new Promise<void>((resolve) => {
			admitFirst = resolve;
		});
		const firstResponse = new Promise<Response>((resolve) => {
			finishFirst = resolve;
		});
		const { fn, calls } = makeFetch((c, index) => {
			if (index > 0) return new Response("{}");
			expect(c.encoding).toBe("zstd");
			admitFirst();
			return firstResponse;
		});
		const wrapped = createRequestCompressionFetch(fn);
		const first = wrapped(`${origin}/x`, jsonInit(BIG_JSON));
		await firstAdmitted;
		const second = wrapped(`${origin}/x`, jsonInit(BIG_JSON));
		const third = wrapped(`${origin}/x`, jsonInit(BIG_JSON));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls).toHaveLength(1);
		finishFirst(new Response("unsupported content-encoding", { status: 415 }));
		const responses = await Promise.all([first, second, third]);
		expect(responses.map(getRequestCompressionEncoding)).toEqual(["gzip", "gzip", "gzip"]);
		// zstd refused, one gzip probe verified, then waiters reuse gzip.
		expect(calls.map((c) => c.encoding)).toEqual(["zstd", "gzip", "gzip", "gzip"]);
	});

	it("lets a waiting request abort without waiting for the probe", async () => {
		const origin = "https://wait-abort.test";
		let finish!: (response: Response) => void;
		const { fn } = makeFetch(
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		const wrapped = createRequestCompressionFetch(fn);
		const first = wrapped(`${origin}/x`, jsonInit(BIG_JSON));
		await vi.waitFor(() => expect(finish).toBeDefined());
		const controller = new AbortController();
		const waiting = wrapped(`${origin}/x`, { ...jsonInit(BIG_JSON), signal: controller.signal });
		controller.abort();
		await expect(waiting).rejects.toThrow();
		finish(new Response("{}"));
		expect((await first).status).toBe(200);
	});

	it("starts api.anthropic.com at gzip", async () => {
		const { fn, calls } = makeFetch(() => new Response("{}"));
		await createRequestCompressionFetch(fn)(`${ANTHROPIC}/v1/messages`, jsonInit(BIG_JSON));
		expect(calls[0].encoding).toBe("gzip");
	});

	it("skips compression for tiny bodies without marking the origin incapable", async () => {
		const origin = "https://tiny.test";
		const { fn, calls } = makeFetch(() => new Response("{}"));
		await createRequestCompressionFetch(fn)(`${origin}/x`, jsonInit('{"a":1}'));
		expect(calls[0].encoding).toBeNull();
		expect(calls[0].body).toBe('{"a":1}');
		await createRequestCompressionFetch(fn)(`${origin}/x`, jsonInit(BIG_JSON));
		expect(calls[1].encoding).toBe("zstd");
	});

	it("compresses a Request object's buffered JSON body (plugin final-sender shape)", async () => {
		const { fn, calls } = makeFetch(() => new Response("{}"));
		const req = new Request(`${ORIGIN_A}/req`, jsonInit(BIG_JSON));
		await createRequestCompressionFetch(fn)(req);
		expect(calls[0].encoding).toBe("zstd");
		expect(decompress("zstd", calls[0].body as Uint8Array)).toBe(BIG_JSON);
		// Original request body must still be readable (clone consumed, not source).
		expect(await req.text()).toBe(BIG_JSON);
	});

	it("respects an init body override on a Request input", async () => {
		const { fn, calls } = makeFetch(() => new Response("{}"));
		const req = new Request(`${ORIGIN_A}/req2`, jsonInit(`{"orig":true}${"x".repeat(600)}`));
		const body = `{"override":"${"z".repeat(1200)}"}`;
		await createRequestCompressionFetch(fn)(req, { body, headers: { "content-type": "application/json" } });
		expect(decompress("zstd", calls[0].body as Uint8Array)).toBe(body);
	});

	it("does not consume a successful streaming response body", async () => {
		const { fn } = makeFetch(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(new TextEncoder().encode("data: hello\n\n"));
							c.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);
		const res = await createRequestCompressionFetch(fn)(`${ORIGIN_A}/sse`, jsonInit(BIG_JSON));
		expect(await res.text()).toBe("data: hello\n\n");
	});
	it("keeps paths and credential scopes isolated", async () => {
		const url = "https://scope.test/v1/responses";
		const first = makeFetch((c) =>
			c.encoding === "zstd" ? new Response("unsupported content-encoding", { status: 415 }) : new Response("{}"),
		);
		await createRequestCompressionFetch(first.fn)(url, jsonInit(BIG_JSON, { authorization: "Bearer first" }));
		for (const [target, key] of [
			[url, "Bearer second"],
			["https://scope.test/v1/messages", "Bearer first"],
		]) {
			const other = makeFetch(() => new Response("{}"));
			await createRequestCompressionFetch(other.fn)(target, jsonInit(BIG_JSON, { authorization: key }));
			expect(other.calls[0].encoding).toBe("zstd");
		}
	});

	it("preserves large unrelated 400 bodies after a verified codec", async () => {
		const url = "https://large-error.test/v1/responses";
		const body = JSON.stringify({ error: "unknown model", detail: "x".repeat(100_000) });
		const response = new Response(body, { status: 400 });
		const mock = makeFetch((_c, index) => (index === 0 ? new Response("{}") : response));
		const wrapped = createRequestCompressionFetch(mock.fn);
		await wrapped(url, jsonInit(BIG_JSON));
		const result = await wrapped(url, jsonInit(BIG_JSON));
		expect(result).toBe(response);
		expect(await result.text()).toBe(body);
		expect(mock.calls).toHaveLength(2);
	});

	it("passes signed JSON through without altering bytes", async () => {
		const mock = makeFetch(() => new Response("{}"));
		await createRequestCompressionFetch(mock.fn)(
			"https://signed.test/x",
			jsonInit(BIG_JSON, { authorization: "AWS4-HMAC-SHA256 signature" }),
		);
		expect(mock.calls[0].encoding).toBeNull();
		expect(mock.calls[0].body).toBe(BIG_JSON);
	});

	it("does not invoke fetch for an already aborted upload", async () => {
		const controller = new AbortController();
		controller.abort();
		const mock = makeFetch(() => new Response("{}"));
		await expect(
			createRequestCompressionFetch(mock.fn)("https://pre-abort.test/x", {
				...jsonInit(BIG_JSON),
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(mock.calls).toHaveLength(0);
	});
});

describe("native adapter default transport", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const completionsSse = [
		'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"}}]}',
		'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
		"data: [DONE]",
	]
		.map((l) => `${l}\n\n`)
		.join("");

	it("compresses the openai-completions wire body when no custom fetch is given", async () => {
		let captured: Captured | undefined;
		const fetchMock = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
			const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			const raw =
				init?.body !== undefined ? init.body : input instanceof Request ? await input.arrayBuffer() : undefined;
			captured = {
				url: input instanceof Request ? input.url : String(input),
				encoding: headers.get("content-encoding"),
				body: raw as Uint8Array | string | undefined,
			};
			return new Response(completionsSse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: "https://adapter-smoke.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};
		const context = normalizeContext({
			messages: [{ role: "user", content: `say ${"hello ".repeat(400)}`, timestamp: 1 }],
		});
		await streamOpenAICompletions(model, context, { apiKey: "test-key", maxRetries: 0 }).result();

		expect(fetchMock).toHaveBeenCalled();
		expect(captured?.encoding).toBe("zstd");
		const decoded = decompress("zstd", captured?.body as Uint8Array);
		expect(JSON.parse(decoded).model).toBe("test-model");
	});

	it("appends the canonical codec name to the SSE transport label", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () => new Response(completionsSse, { status: 200, headers: { "content-type": "text/event-stream" } }),
			),
		);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: "https://adapter-label.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};
		const context = normalizeContext({
			messages: [{ role: "user", content: `say ${"hello ".repeat(400)}`, timestamp: 1 }],
		});
		const transports: Array<string | undefined> = [];
		await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			maxRetries: 0,
			onTransport: (t) => void transports.push(t),
		}).result();
		expect(transports).toEqual(["SSE Zstd"]);
	});

	it("keeps the bare SSE label when a custom fetch owns the upload", async () => {
		const custom = vi.fn(
			async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
				new Response(completionsSse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: "https://adapter-custom.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};
		const context = normalizeContext({
			messages: [{ role: "user", content: `say ${"hello ".repeat(400)}`, timestamp: 1 }],
		});
		const transports: Array<string | undefined> = [];
		await streamOpenAICompletions(model, context, {
			apiKey: "k",
			fetch: custom,
			maxRetries: 0,
			onTransport: (t) => void transports.push(t),
		}).result();
		expect(transports).toEqual(["SSE"]);
	});

	it("labels the SSE transport with the final codec after an endpoint refusal", async () => {
		let refused = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
				const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
				if (headers.get("content-encoding") === "zstd") {
					refused = true;
					return new Response("unsupported content-encoding", { status: 415 });
				}
				return new Response(completionsSse, { status: 200, headers: { "content-type": "text/event-stream" } });
			}),
		);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: "https://label-downgrade.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};
		const context = normalizeContext({
			messages: [{ role: "user", content: `say ${"hello ".repeat(400)}`, timestamp: 1 }],
		});
		const transports: Array<string | undefined> = [];
		await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			maxRetries: 0,
			onTransport: (t) => void transports.push(t),
		}).result();
		expect(refused).toBe(true);
		expect(transports).toEqual(["SSE gzip"]);
	});

	it("keeps the bare SSE label for an uncompressed upload", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () => new Response(completionsSse, { status: 200, headers: { "content-type": "text/event-stream" } }),
			),
		);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: "https://label-plain.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
		const transports: Array<string | undefined> = [];
		await streamOpenAICompletions(model, context, {
			apiKey: "k",
			headers: { "content-encoding": "identity" },
			maxRetries: 0,
			onTransport: (t) => void transports.push(t),
		}).result();
		expect(transports).toEqual(["SSE"]);
	});

	it("leaves a custom options.fetch completely untouched", async () => {
		const ambient = vi.fn(async () => {
			throw new Error("ambient fetch must not be called");
		});
		vi.stubGlobal("fetch", ambient);
		const custom = vi.fn(
			async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
				new Response(completionsSse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: "https://adapter-smoke.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};
		const context = normalizeContext({
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		});
		await streamOpenAICompletions(model, context, { apiKey: "k", fetch: custom, maxRetries: 0 }).result();
		expect(custom).toHaveBeenCalled();
		const init = custom.mock.calls[0]?.[1];
		// Raw JSON body reaches the caller's fetch: plugin codec bridge sees JSON.
		expect(typeof init?.body).toBe("string");
		expect(new Headers(init?.headers).has("content-encoding")).toBe(false);
	});
});
