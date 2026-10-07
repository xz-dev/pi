import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	resetOpenAICodexWebSocketDebugStats,
} from "../src/api/openai-codex-responses.ts";
import {
	getOpenAICodexWebSocketDebugStatsLazy,
	openAICodexResponsesApi,
	resetOpenAICodexWebSocketDebugStatsLazy,
} from "../src/compat.ts";
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

// Regression coverage for xz-dev/pi#8.
describe("lazy Codex WebSocket state accessors", () => {
	it.each(["session", "all"])("observes fallback and resets %s through the public compat entry", async (scope) => {
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
		const api = openAICodexResponsesApi();
		const run = (sessionId = "lazy-session") =>
			api
				.stream(model, context, {
					apiKey: mockToken(),
					sessionId,
					transport: "auto",
				})
				.result();

		expect((await run()).stopReason).toBe("stop");
		expect((await run("other-session")).stopReason).toBe("stop");
		for (const sessionId of ["lazy-session", "other-session"]) {
			expect(await getOpenAICodexWebSocketDebugStatsLazy(sessionId)).toMatchObject({
				websocketFailures: 1,
				websocketFallbackActive: true,
			});
		}

		// Without a reset the session stays on SSE, even after the transport recovers.
		failSends = false;
		expect((await run()).stopReason).toBe("stop");
		expect(websocketRequests).toBe(2);
		expect(fetchMock).toHaveBeenCalledTimes(3);

		if (scope === "all") {
			await resetOpenAICodexWebSocketDebugStatsLazy();
		} else {
			await resetOpenAICodexWebSocketDebugStatsLazy("lazy-session");
		}
		expect(await getOpenAICodexWebSocketDebugStatsLazy("lazy-session")).toBeUndefined();
		expect((await run()).stopReason).toBe("stop");
		expect(websocketRequests).toBe(3);
		expect(fetchMock).toHaveBeenCalledTimes(3);

		// A scoped reset preserves the other session's fallback; reset-all clears it.
		expect((await run("other-session")).stopReason).toBe("stop");
		expect(websocketRequests).toBe(scope === "all" ? 4 : 3);
		expect(fetchMock).toHaveBeenCalledTimes(scope === "all" ? 3 : 4);
	});
});
