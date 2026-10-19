import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { acquireWebSocket } from "../src/api/openai-responses-websocket.ts";
import { getWebSocketCompressionPolicy } from "../src/utils/websocket-compression.ts";

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
});
