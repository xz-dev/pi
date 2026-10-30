import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { createRequestCompressionFetch } from "../src/utils/request-compression.ts";

it("actively probes and remembers codec refusal at a real HTTP boundary", async () => {
	const encodings: Array<string | undefined> = [];
	const decoded: string[] = [];
	const payload = JSON.stringify({
		text: "exact text ".repeat(600),
		image: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
	});
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const encoding = request.headers["content-encoding"];
		encodings.push(typeof encoding === "string" ? encoding : undefined);
		if (encoding === "zstd") {
			response.writeHead(415).end("unsupported content-encoding");
			return;
		}
		decoded.push(gunzipSync(Buffer.concat(chunks)).toString("utf8"));
		response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address !== "object") throw new Error("Missing loopback address");
		const url = `http://127.0.0.1:${address.port}/v1/responses`;
		for (let turn = 0; turn < 2; turn++) {
			const response = await createRequestCompressionFetch()(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: payload,
			});
			expect(response.headers.has("accept-encoding")).toBe(false);
			expect(await response.json()).toEqual({ ok: true });
		}
		expect(encodings).toEqual(["zstd", "gzip", "gzip"]);
		expect(decoded).toEqual([payload, payload]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
