import type { IncomingMessage } from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";

/** Decode the actual HTTP body before assertions about its provider JSON. */
export function jsonRequestBody(init?: RequestInit): Record<string, unknown> {
	if (typeof init?.body === "string") return JSON.parse(init.body) as Record<string, unknown>;
	const raw = init?.body;
	if (!(raw instanceof Uint8Array)) throw new Error("Expected a buffered JSON request body");
	const codec = new Headers(init?.headers).get("content-encoding");
	const body =
		codec === "zstd"
			? zstdDecompressSync(raw)
			: codec === "gzip"
				? gunzipSync(raw)
				: codec === "deflate"
					? inflateSync(raw)
					: codec === "br"
						? brotliDecompressSync(raw)
						: raw;
	return JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
}

export async function jsonHttpRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const encoding = request.headers["content-encoding"];
	return jsonRequestBody({
		body: Buffer.concat(chunks),
		headers: encoding ? { "content-encoding": String(encoding) } : undefined,
	});
}
