import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getOpenAICodexWebSocketDebugStatsLazy,
	resetOpenAICodexWebSocketDebugStatsLazy,
} from "../src/api/openai-codex-responses.lazy.ts";
import {
	closeOpenAICodexWebSocketSessions,
	resetOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const completed = { type: "response.completed", response: { id: "resp", status: "completed", output: [] } };

describe("lazy Codex WebSocket state accessors", () => {
	it("observe and reset the session SSE fallback of the Codex module", async () => {
		const fetchMock = vi.fn(async () => new Response(`data: ${JSON.stringify(completed)}\n\n`, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		let failSends = true;
		let websocketRequests = 0;

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor() {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				const listeners = this.listeners.get(type) ?? new Set();
				listeners.add(listener);
				this.listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(): void {
				websocketRequests++;
				queueMicrotask(() =>
					failSends
						? this.dispatch("error", { message: "socket dropped" })
						: this.dispatch("message", { data: JSON.stringify(completed) }),
				);
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
		const run = () =>
			streamOpenAICodexResponses(model, context, {
				apiKey: mockToken(),
				sessionId: "lazy-session",
				transport: "auto",
			}).result();

		expect((await run()).stopReason).toBe("stop");
		expect(await getOpenAICodexWebSocketDebugStatsLazy("lazy-session")).toMatchObject({
			websocketFailures: 1,
			websocketFallbackActive: true,
		});

		// Without a reset the session stays on SSE.
		failSends = false;
		await run();
		expect(websocketRequests).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		await resetOpenAICodexWebSocketDebugStatsLazy("lazy-session");
		expect(await getOpenAICodexWebSocketDebugStatsLazy("lazy-session")).toBeUndefined();
		expect((await run()).stopReason).toBe("stop");
		expect(websocketRequests).toBe(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
