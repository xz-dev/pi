import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import {
	acquireWebSocket,
	closeResponsesWebSocketSessions,
	resetResponsesWebSocketDebugStats,
} from "../src/api/openai-responses-websocket.ts";
import type { Model } from "../src/types.ts";
import { probeTransportLabel, transportLabel } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { getWebSocketCompressionEncoding, getWebSocketCompressionPolicy } from "../src/utils/websocket-compression.ts";

describe("WebSocket compression", () => {
	it("remembers a declined extension without upgrading on stale success", async () => {
		const url = "wss://compression-policy.test/v1/responses";
		const headers = { authorization: "Bearer fake-a" };
		const first = await getWebSocketCompressionPolicy(url, headers);
		expect(first.perMessageDeflate).not.toBe(false);
		first.recordNegotiated("");
		first.recordNegotiated("permessage-deflate; client_no_context_takeover");
		expect((await getWebSocketCompressionPolicy(url, headers)).perMessageDeflate).toBe(false);
		expect((await getWebSocketCompressionPolicy(url, { authorization: "Bearer fake-b" })).perMessageDeflate).not.toBe(
			false,
		);
		expect((await getWebSocketCompressionPolicy(`${url}/other`, headers)).perMessageDeflate).not.toBe(false);
	});

	it("reads only accepted permessage-deflate extensions", () => {
		expect(getWebSocketCompressionEncoding(undefined)).toBeUndefined();
		expect(getWebSocketCompressionEncoding("")).toBeUndefined();
		expect(getWebSocketCompressionEncoding("x-permessage-deflate")).toBeUndefined();
		expect(getWebSocketCompressionEncoding("other, permessage-deflate; client_no_context_takeover")).toBe("deflate");
	});

	it("transportLabel appends only canonical names", () => {
		expect(transportLabel("WS/full", "deflate")).toBe("WS/full DEFLATE");
		expect(transportLabel("WS/continuation", "deflate")).toBe("WS/continuation DEFLATE");
		expect(transportLabel("SSE", "zstd")).toBe("SSE Zstd");
		expect(transportLabel("SSE", "gzip")).toBe("SSE gzip");
		expect(transportLabel("SSE", "br")).toBe("SSE Brotli");
		expect(transportLabel("SSE", undefined)).toBe("SSE");
		expect(transportLabel("SSE", "bogus")).toBe("SSE");
		expect(transportLabel("SSE", "constructor")).toBe("SSE");
		expect(probeTransportLabel("SSE", "gzip")).toBe("SSE try gzip");
		expect(probeTransportLabel("SSE", undefined)).toBe("SSE try plain");
		expect(transportLabel("SSE", "__proto__")).toBe("SSE");
	});

	it.each([true, false])("sends real compressed upload frames only when negotiated: %s", async (supported) => {
		const server = createServer();
		const wss = new WebSocketServer({ server, perMessageDeflate: supported });
		const offers: Array<string | undefined> = [];
		const rsv1: boolean[] = [];
		server.on("upgrade", (request, socket) => {
			offers.push(request.headers["sec-websocket-extensions"]);
			// No application data can precede this connection's completed upgrade.
			socket.once("data", (chunk: Buffer) => rsv1.push((chunk[0] & 0x40) !== 0));
		});
		const bodies: string[] = [];
		let arrived: (() => void) | undefined;
		wss.on("connection", (socket) => {
			socket.on("message", (data) => {
				bodies.push(data.toString());
				arrived?.();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		expect(address && typeof address === "object").toBe(true);
		if (!address || typeof address !== "object") throw new Error("Missing loopback address");
		const url = `ws://127.0.0.1:${address.port}/v1/responses`;
		const payload = JSON.stringify({ type: "response.create", input: "image/text exact bytes ".repeat(500) });
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const received = new Promise<void>((resolve) => {
					arrived = resolve;
				});
				const acquired = await acquireWebSocket({
					scope: "compression-loopback",
					url,
					headers: new Headers({ authorization: "Bearer loopback-only" }),
					sessionId: undefined,
					identityKey: "loopback",
					signal: undefined,
					connectTimeoutMs: 2000,
					env: { HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "*" },
					forceFresh: false,
				});
				expect(getWebSocketCompressionEncoding(acquired.socket.extensions)).toBe(supported ? "deflate" : undefined);
				acquired.socket.send(payload);
				await received;
				const closed = new Promise<void>((resolve) => acquired.socket.addEventListener("close", () => resolve()));
				acquired.release();
				await closed;
			}
			expect(bodies).toEqual([payload, payload]);
			expect(rsv1).toEqual([supported, supported]);
			expect(offers[0]).toContain("permessage-deflate");
			if (supported) expect(offers[1]).toContain("permessage-deflate");
			else expect(offers[1]).toBeUndefined();
		} finally {
			for (const socket of wss.clients) socket.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it.each([true, false])(
		"labels WS/full and a cached-connection WS/continuation only after real negotiation: %s",
		async (supported) => {
			const server = createServer();
			const wss = new WebSocketServer({ server, perMessageDeflate: supported });
			const frames: Record<string, unknown>[] = [];
			wss.on("connection", (socket) => {
				socket.on("message", (data) => {
					const frame = JSON.parse(data.toString()) as Record<string, unknown>;
					frames.push(frame);
					const id = `resp_${frames.length}`;
					socket.send(
						JSON.stringify({
							type: "response.completed",
							response: { id, status: "completed" },
						}),
					);
				});
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const transports: Array<string | undefined> = [];
			const sessionId = `ws-label-${supported}`;
			try {
				const address = server.address();
				if (!address || typeof address !== "object") throw new Error("Missing loopback address");
				const model: Model<"openai-responses"> = {
					id: "loopback-ws",
					name: "Loopback WS",
					api: "openai-responses",
					provider: "loopback-ws",
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 512,
				};
				const onTransport = (t: string | undefined) => void transports.push(t);
				const first = await streamResponses(
					model,
					normalizeContext({ messages: [{ role: "user", content: "one", timestamp: 1 }] }),
					{
						apiKey: "loopback-key",
						sessionId,
						transport: "websocket-cached",
						onTransport,
						env: { HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "*" },
					},
				).result();
				expect(first.stopReason).toBe("stop");
				const second = await streamResponses(
					model,
					normalizeContext({
						messages: [
							{ role: "user", content: "one", timestamp: 1 },
							first,
							{ role: "user", content: "two", timestamp: 2 },
						],
					}),
					{
						apiKey: "loopback-key",
						sessionId,
						transport: "websocket-cached",
						onTransport,
						env: { HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "*" },
					},
				).result();
				expect(second.stopReason).toBe("stop");
				const suffix = supported ? " DEFLATE" : "";
				expect(transports).toEqual([`WS/full${suffix}`, `WS/continuation${suffix}`]);
				expect(frames[1].previous_response_id).toBe(first.responseId);
			} finally {
				closeResponsesWebSocketSessions("openai-responses", sessionId);
				resetResponsesWebSocketDebugStats("openai-responses", sessionId);
				for (const socket of wss.clients) socket.terminate();
				await new Promise<void>((resolve) => wss.close(() => resolve()));
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	);
});
