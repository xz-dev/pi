import type * as NodeZlib from "node:zlib";
import { raceWithAbortSignal } from "./abort.ts";
import { sha256Hex } from "./response-checkpoints.ts";

const CODECS = ["zstd", "gzip", "deflate", "br"] as const;
type Codec = (typeof CODECS)[number];
// Process lifetime only: wrapper recreation and session cleanup must not retry rejected codecs.
const floors = new Map<string, number>();
// Rung that already produced a successful response for a target; only unverified rungs probe.
const verified = new Map<string, number>();
// One unverified compressed send per target: parallel probes can trip gateway concurrency limits.
const probes = new Map<string, Promise<void>>();
// Failures a byte-identical uncompressed resend cannot clarify, or would only add load to.
const NO_IDENTITY_JUDGE = new Set([401, 407, 408, 413, 429, 503, 529]);
const uploadEncodings = new WeakMap<Response, Codec>();
const AUTH_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "api-key", "auth-token"];
const ERROR_BYTES = 4096;

/** Upload encoding applied by this helper, not the response's Content-Encoding. */
export function getRequestCompressionEncoding(response: Response): Codec | undefined {
	return uploadEncodings.get(response);
}

type BuiltinProcess = typeof process & { getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib };

function nodeZlib(): typeof NodeZlib | undefined {
	return typeof process === "undefined" ? undefined : (process as BuiltinProcess).getBuiltinModule?.("node:zlib");
}

async function compress(
	zlib: typeof NodeZlib,
	codec: Codec,
	body: Uint8Array,
): Promise<Uint8Array<ArrayBuffer> | null> {
	try {
		return await new Promise((resolve) => {
			const done = (error: Error | null, bytes: Buffer) => resolve(error ? null : new Uint8Array(bytes));
			switch (codec) {
				case "zstd":
					if (typeof zlib.zstdCompress !== "function") return resolve(null);
					zlib.zstdCompress(body, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }, done);
					break;
				case "gzip":
					zlib.gzip(body, { level: 4 }, done);
					break;
				case "deflate":
					zlib.deflate(body, { level: 4 }, done);
					break;
				case "br":
					if (typeof zlib.brotliCompress !== "function") return resolve(null);
					zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, done);
					break;
			}
		});
	} catch {
		return null;
	}
}

async function encodingRefused(response: Response): Promise<boolean> {
	if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) return false;
	if (response.status !== 400 && response.status !== 415) return false;
	// RFC 9110 reserves Accept-Encoding on 415 for rejected request content codings.
	if (response.status === 415 && response.headers.has("accept-encoding")) return true;
	if (!response.body) return false;
	// Inspect a bounded clone: an unrelated error must retain its full original body and metadata.
	const reader = response.clone().body!.getReader();
	const bytes = new Uint8Array(ERROR_BYTES);
	let size = 0;
	try {
		while (size < bytes.length) {
			const { done, value } = await reader.read();
			if (done) break;
			const part = value.subarray(0, bytes.length - size);
			bytes.set(part, size);
			size += part.length;
		}
	} catch {
		return false;
	} finally {
		// Awaiting one tee branch's cancellation can deadlock while the caller owns the other.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const message = new TextDecoder().decode(bytes.subarray(0, size));
	return (
		/unsupported[_ -](?:content[_ -])?encoding|(?:unsupported|unknown|unrecognized|invalid|not supported|not allowed).{0,80}content[-_ ](?:encoding|coding)|content[-_ ](?:encoding|coding).{0,80}(?:unsupported|unknown|unrecognized|invalid|not supported|not allowed)/i.test(
			message,
		) ||
		/(?:cannot|failed|unable)(?: to)? decompress (?:the )?request(?: body)?|request(?: body)?.{0,32}decompression (?:failed|error)/i.test(
			message,
		)
	);
}

/**
 * Losslessly compress buffered JSON POST uploads; actively probe unknown targets.
 * Explicit encoding refusals advance a process-local, target/auth-scoped floor. Any other
 * failed probe is judged by one uncompressed resend: if that succeeds, the target stays
 * uncompressed (gateways may block or mangle encoded bodies without saying so).
 * Probes are serialized per target; concurrent requests wait for the verdict.
 * Custom codec bridges should opt in at their final HTTP sender, not before parsing JSON.
 */
export function createRequestCompressionFetch(
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
	return async (input, init) => {
		const request = input instanceof Request ? input : undefined;
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const headers = new Headers(init?.headers ?? request?.headers);
		const zlib = nodeZlib();
		const signal = init?.signal === null ? undefined : (init?.signal ?? request?.signal);
		signal?.throwIfAborted();
		if (
			!zlib ||
			method !== "POST" ||
			headers.has("content-encoding") ||
			headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" ||
			/^AWS4-/i.test(headers.get("authorization") ?? "") ||
			["x-amz-content-sha256", "signature", "signature-input", "content-digest", "digest"].some((name) =>
				headers.has(name),
			)
		)
			return fetchImpl(input, init);

		const url = new URL(request?.url ?? String(input));
		if (url.searchParams.has("X-Amz-Signature")) return fetchImpl(input, init);
		let body: Uint8Array<ArrayBuffer>;
		const suppliedBody = init?.body;
		if (typeof suppliedBody === "string") body = new TextEncoder().encode(suppliedBody);
		else if (suppliedBody instanceof ArrayBuffer) body = new Uint8Array(suppliedBody);
		else if (ArrayBuffer.isView(suppliedBody))
			body = new Uint8Array(new Uint8Array(suppliedBody.buffer, suppliedBody.byteOffset, suppliedBody.byteLength));
		else if (suppliedBody === undefined && request?.body) body = new Uint8Array(await request.clone().arrayBuffer());
		else return fetchImpl(input, init);

		const credentials = AUTH_HEADERS.map((name) => [name, headers.get(name)]);
		const key = `${method} ${url.origin}${url.pathname}|${await sha256Hex(JSON.stringify(credentials))}`;
		const initial = url.protocol === "https:" && url.hostname === "api.anthropic.com" ? 1 : 0;
		const floor = () => floors.get(key) ?? initial;
		const identity = async () => {
			const response = await fetchImpl(input, init);
			if (response.ok) floors.set(key, CODECS.length);
			return response;
		};
		for (;;) {
			signal?.throwIfAborted();
			const pending = probes.get(key);
			if (pending) {
				await (signal ? raceWithAbortSignal(pending, signal) : pending);
				continue;
			}
			const rung = floor();
			if (rung >= CODECS.length) return fetchImpl(input, init);
			const codec = CODECS[rung];
			const encoded = await compress(zlib, codec, body);
			signal?.throwIfAborted();
			if (floor() > rung || probes.has(key)) continue;
			if (encoded === null) {
				floors.set(key, Math.max(floor(), rung + 1));
				continue;
			}
			// An unprofitable payload says nothing about endpoint capability.
			if (encoded.byteLength >= body.byteLength) return fetchImpl(input, init);
			const probing = verified.get(key) !== rung;
			let release = () => {};
			if (probing)
				probes.set(
					key,
					new Promise((resolve) => {
						release = () => {
							probes.delete(key);
							resolve();
						};
					}),
				);
			try {
				const wireHeaders = new Headers(headers);
				wireHeaders.set("content-encoding", codec);
				wireHeaders.delete("content-length");
				let response: Response;
				try {
					response = request
						? await fetchImpl(new Request(request, { ...init, method, headers: wireHeaders, body: encoded }))
						: await fetchImpl(input, { ...init, method, headers: wireHeaders, body: encoded });
				} catch (error) {
					if (!probing || signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
					return await identity();
				}
				if (await encodingRefused(response)) {
					signal?.throwIfAborted();
					floors.set(key, Math.max(floor(), rung + 1));
					void response.body?.cancel().catch(() => {});
					continue;
				}
				if (response.ok || !probing || NO_IDENTITY_JUDGE.has(response.status)) {
					if (response.ok && floor() === rung) verified.set(key, rung);
					uploadEncodings.set(response, codec);
					return response;
				}
				void response.body?.cancel().catch(() => {});
				signal?.throwIfAborted();
				return await identity();
			} finally {
				release();
			}
		}
	};
}
