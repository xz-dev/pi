import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { decodeRequestBody, readDecodedRequestBody } from "./lib/request-body.mjs";

const json = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });

test("decodes every request-compression codec plus identity", () => {
	const cases = {
		identity: Buffer.from(json),
		undefined: Buffer.from(json),
		gzip: gzipSync(json),
		deflate: deflateSync(json),
		br: brotliCompressSync(json),
	};
	if (typeof zstdCompressSync === "function") cases.zstd = zstdCompressSync(json);
	for (const [coding, bytes] of Object.entries(cases)) {
		const decoded = decodeRequestBody(bytes, coding === "undefined" ? undefined : coding);
		assert.equal(decoded.toString("utf8"), json, coding);
	}
});

test("roundtrips an encoded request stream into parseable JSON", async () => {
	const encoded = gzipSync(json);
	const request = Readable.from([encoded]);
	request.headers = { "content-encoding": "gzip" };
	const body = await readDecodedRequestBody(request);
	assert.deepEqual(JSON.parse(body), JSON.parse(json));
});

test("refuses an unknown content-encoding instead of parsing compressed bytes", async () => {
	const request = Readable.from([Buffer.from(json)]);
	request.headers = { "content-encoding": "lz4" };
	await assert.rejects(readDecodedRequestBody(request), /unsupported content-encoding: lz4/);
});

test("enforces the encoded byte cap before decompression", async () => {
	const request = Readable.from([gzipSync(json)]);
	request.headers = { "content-encoding": "gzip" };
	await assert.rejects(readDecodedRequestBody(request, 4), /exceeds 4 bytes/);
});
