// Decode an HTTP request body through its Content-Encoding so test/mock
// servers can parse JSON posted by hosts that transparently compress uploads.
// Supported codings match the product request-compression codec set.
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";

export function decodeRequestBody(bytes, contentEncoding) {
	const coding = (contentEncoding ?? "").trim().toLowerCase();
	if (coding === "" || coding === "identity") return bytes;
	switch (coding) {
		case "zstd":
			if (typeof zstdDecompressSync !== "function")
				throw new Error("unsupported content-encoding for this Node: zstd");
			return zstdDecompressSync(bytes);
		case "gzip":
			return gunzipSync(bytes);
		case "deflate":
			return inflateSync(bytes);
		case "br":
			return brotliDecompressSync(bytes);
		default:
			throw new Error(`unsupported content-encoding: ${coding}`);
	}
}

// Read a request stream fully, then decode. `maxEncodedBytes` bounds the wire
// bytes accepted before decompression; 0 disables the cap.
export async function readDecodedRequestBody(request, maxEncodedBytes = 0) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (maxEncodedBytes > 0 && size > maxEncodedBytes) {
			request.destroy();
			throw new Error(`request body exceeds ${maxEncodedBytes} bytes`);
		}
		chunks.push(chunk);
	}
	const body = decodeRequestBody(Buffer.concat(chunks), request.headers["content-encoding"]);
	return body.toString("utf8");
}
