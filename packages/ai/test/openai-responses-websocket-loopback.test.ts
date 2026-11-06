import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	closeOpenAIResponsesWebSocketSessions,
	resetOpenAIResponsesWebSocketDebugStats,
	stream,
} from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * Real loopback regression for the native Node WebSocket constructor: the
 * adapter must not report the WS transport before the server completes the
 * upgrade handshake. No live provider or credentials are involved.
 */
describe("openai-responses native WebSocket loopback", () => {
	it("reports WS only after a real handshake completes", async () => {
		const events: string[] = [];
		const sockets = new Set<Duplex>();
		let authorization: string | undefined;
		const server = createServer((_request, response) => response.writeHead(500).end("Unexpected HTTP fallback"));
		server.on("upgrade", (request, socket) => {
			sockets.add(socket);
			events.push("handshake");
			authorization = request.headers.authorization;
			const key = request.headers["sec-websocket-key"];
			assert.equal(typeof key, "string");
			const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
			);
			socket.once("data", () => {
				const data = Buffer.from(
					JSON.stringify({
						type: "response.completed",
						response: {
							id: "resp_loopback",
							status: "completed",
							usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
						},
					}),
				);
				assert(data.length < 65536);
				const header = Buffer.alloc(4);
				header[0] = 0x81;
				header[1] = 126;
				header.writeUInt16BE(data.length, 2);
				socket.write(Buffer.concat([header, data]));
			});
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			assert(address && typeof address !== "string");
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			try {
				const model: Model<"openai-responses"> = {
					id: "loopback-probe",
					name: "Loopback probe",
					api: "openai-responses",
					provider: "loopback-probe",
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 512,
				};
				const result = await stream(
					model,
					normalizeContext({ messages: [{ role: "user", content: "loopback probe", timestamp: 0 }] }),
					{
						apiKey: "fake-local-key",
						transport: "websocket",
						signal: controller.signal,
						onTransport: (transport) => {
							events.push(`transport:${transport ?? "none"}`);
						},
					},
				).result();
				expect(result.stopReason).toBe("stop");
				expect(authorization).toBe("Bearer fake-local-key");
				expect(events.indexOf("handshake")).toBeGreaterThanOrEqual(0);
				expect(events.indexOf("transport:WS/full")).toBeGreaterThan(events.indexOf("handshake"));
			} finally {
				clearTimeout(timeout);
			}
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			closeOpenAIResponsesWebSocketSessions();
			resetOpenAIResponsesWebSocketDebugStats();
			vi.unstubAllGlobals();
		}
	});
});
