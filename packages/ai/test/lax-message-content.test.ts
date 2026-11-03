/**
 * The Message types require `content` to always be present, but untyped
 * callers (custom tools, hand-built histories, old session files) can violate
 * that contract. `transformMessages` is the choke point before every provider
 * request and is intentionally lax: it normalizes null/missing content to an
 * empty array (issues #6259, #6276).
 */

import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";

// Text-only model so the image downgrade path (replaceImagesWithPlaceholder) runs,
// which was the primary crash site for null tool result content.
function makeTextOnlyModel(): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

describe("lax message content handling", () => {
	it("normalizes null/missing content to an empty array instead of crashing", () => {
		const messages = [
			{ role: "user", content: null, timestamp: Date.now() },
			{
				role: "assistant",
				content: null,
				api: "openai-completions",
				provider: "openai",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "web_search",
				isError: false,
				timestamp: Date.now(),
			},
		] as unknown as Message[];

		const result = transformMessages(messages, makeTextOnlyModel());

		// Normalized to [] without crashing; the empty user/assistant messages are then
		// dropped by the empty-content filter, while the toolResult must be kept.
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("toolResult");
		expect(result[0].content).toEqual([]);
	});
});

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("empty message filtering", () => {
	it("drops user messages with empty or whitespace-only content", () => {
		const messages: Message[] = [
			{ role: "user", content: "", timestamp: Date.now() },
			{ role: "user", content: "   \n\t ", timestamp: Date.now() },
			{ role: "user", content: [], timestamp: Date.now() },
			{ role: "user", content: [{ type: "text", text: "" }], timestamp: Date.now() },
			{ role: "user", content: [{ type: "text", text: "  " }], timestamp: Date.now() },
			{ role: "user", content: "hello", timestamp: Date.now() },
		];

		const result = transformMessages(messages, makeTextOnlyModel());

		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("hello");
	});

	it("keeps user messages that contain an image even with empty text", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "" },
					{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
				],
				timestamp: Date.now(),
			},
		];

		const model = makeTextOnlyModel();
		model.input = ["text", "image"];
		const result = transformMessages(messages, model);

		expect(result).toHaveLength(1);
	});

	it("drops empty assistant messages without tool calls", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: Date.now() },
			makeAssistant([]),
			makeAssistant([{ type: "text", text: "" }]),
			makeAssistant([{ type: "thinking", thinking: "  " }]),
			makeAssistant([{ type: "text", text: "answer" }]),
		];

		const result = transformMessages(messages, makeTextOnlyModel());

		expect(result).toHaveLength(2);
		expect(result[1].content).toEqual([{ type: "text", text: "answer" }]);
	});

	it("keeps assistant messages with tool calls even when text is empty", () => {
		const toolCall = {
			type: "toolCall" as const,
			id: "call_1",
			name: "web_search",
			arguments: {},
		};
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: Date.now() },
			makeAssistant([{ type: "text", text: "" }, toolCall]),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "web_search",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, makeTextOnlyModel());

		expect(result).toHaveLength(3);
		expect(result[1].role).toBe("assistant");
	});

	it("keeps empty-text assistant blocks that carry signatures", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: Date.now() },
			makeAssistant([{ type: "thinking", thinking: "", thinkingSignature: "sig" }]),
		];

		const result = transformMessages(messages, makeTextOnlyModel());

		expect(result).toHaveLength(2);
		expect(result[1].role).toBe("assistant");
	});

	it("keeps empty system messages as transcript control deltas", () => {
		const message: Message = {
			role: "system",
			content: "",
			sections: { tools: "<tools>\n(none)\n" },
			timestamp: Date.now(),
		};

		expect(transformMessages([message], makeTextOnlyModel())).toEqual([message]);
	});

	it("keeps empty tool results", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: Date.now() },
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "web_search",
				content: [],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, makeTextOnlyModel());

		expect(result).toHaveLength(2);
		expect(result[1].role).toBe("toolResult");
	});
});
