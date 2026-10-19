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
