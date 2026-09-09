/**
 * Regression: websocket-cached stored a continuation for a `length`
 * (max_output_tokens incomplete) response even when it carried zero output
 * items. Resubmitting the identical context (post-/tree rollback + /retry)
 * then sent an EMPTY delta with previous_response_id pointing at the dead
 * response, so the model resumed the abandoned node instead of regenerating.
 * Empty deltas must fall back to the full request body.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

function mockToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

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

describe("ws-cached continuation after empty length-stopped response", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		closeOpenAICodexWebSocketSessions();
		resetOpenAICodexWebSocketDebugStats();
	});

	it("does not reuse previous_response_id after an empty incomplete response", async () => {
		const sentBodies: Array<{ input: unknown[]; previous_response_id?: string }> = [];

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: unknown) {
				queueMicrotask(() => this.dispatch("open", {}));
			}
			addEventListener(type: string, listener: (event: unknown) => void): void {
				let set = this.listeners.get(type);
				if (!set) {
					set = new Set();
					this.listeners.set(type, set);
				}
				set.add(listener);
			}
			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}
			send(data: string): void {
				const body = JSON.parse(data) as { input: unknown[]; previous_response_id?: string };
				sentBodies.push(body);
				const n = sentBodies.length;
				const events =
					n === 1
						? [
								// Turn 1: truncated at max_output_tokens with NO output items.
								{ type: "response.created", response: { id: "resp_len" } },
								{
									type: "response.incomplete",
									response: {
										id: "resp_len",
										status: "incomplete",
										incomplete_details: { reason: "max_output_tokens" },
										usage: { input_tokens: 5, output_tokens: 100, total_tokens: 105 },
									},
								},
							]
						: [
								{ type: "response.created", response: { id: `resp_${n}` } },
								{
									type: "response.output_item.done",
									output_index: 0,
									item: {
										type: "message",
										id: `msg_${n}`,
										role: "assistant",
										status: "completed",
										content: [{ type: "output_text", text: "fresh answer" }],
									},
								},
								{
									type: "response.completed",
									response: {
										id: `resp_${n}`,
										status: "completed",
										usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
									},
								},
							];
				queueMicrotask(() => {
					for (const event of events) this.dispatch("message", { data: JSON.stringify(event) });
				});
			}
			close(): void {
				this.readyState = 3;
			}
			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};
		const first = await streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			sessionId: "stale-repro",
			transport: "websocket-cached",
		}).result();
		expect(first.stopReason).toBe("length");
		expect(first.content).toHaveLength(0);

		// /tree back to the same user message, then /retry: identical context.
		const second = await streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			sessionId: "stale-repro",
			transport: "websocket-cached",
		}).result();
		expect(second.stopReason).toBe("stop");

		expect(sentBodies).toHaveLength(2);
		// The retry must resend the full context, not an empty delta chained to
		// the dead response.
		expect(sentBodies[1].previous_response_id).toBeUndefined();
		expect(sentBodies[1].input).toEqual(sentBodies[0].input);
		expect(getOpenAICodexWebSocketDebugStats("stale-repro")).toMatchObject({
			fullContextRequests: 2,
			deltaRequests: 0,
		});
	});
});
