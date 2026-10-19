import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import type { AssistantMessage, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const context: TranscriptContext = normalizeContext({
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
});

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const responsesModel: Model<"openai-responses"> = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const azureModel: Model<"azure-openai-responses"> = {
	id: "gpt-5.5",
	name: "Azure GPT-5.5",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const completionsModel: Model<"openai-completions"> = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const mistralModel: Model<"mistral-conversations"> = {
	id: "mistral-test",
	name: "Mistral Test",
	api: "mistral-conversations",
	provider: "mistral",
	baseUrl: "https://api.mistral.ai",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const piModel: Model<"pi-messages"> = {
	id: "pi-test",
	name: "Pi Test",
	api: "pi-messages",
	provider: "pi",
	baseUrl: "https://pi.example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

function anthropicSse(): string {
	return [
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
		'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
		'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
		'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
		'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
		'event: message_stop\ndata: {"type":"message_stop"}\n\n',
	].join("");
}

function responsesSse(): string {
	const item = {
		type: "message",
		id: "msg_1",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "Hi" }],
	};
	return [
		`data: ${JSON.stringify({ type: "response.output_item.added", item: { ...item, content: [], status: "in_progress" } })}\n\n`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
		`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed" } })}\n\n`,
	].join("");
}

function completionsSse(): string {
	const chunk = {
		id: "chatcmpl_1",
		choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
	};
	const done = { id: "chatcmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
	return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`;
}

function mistralSse(): string {
	const chunk = { choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] };
	return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

function piSse(): string {
	return [
		`data: ${JSON.stringify({ type: "start" })}\n\n`,
		`data: ${JSON.stringify({ type: "text_start", contentIndex: 0 })}\n\n`,
		`data: ${JSON.stringify({ type: "text_delta", contentIndex: 0, delta: "Hi" })}\n\n`,
		`data: ${JSON.stringify({ type: "text_end", contentIndex: 0, content: "Hi" })}\n\n`,
		`data: ${JSON.stringify({
			type: "done",
			reason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		})}\n\n`,
	].join("");
}

type Case = {
	name: string;
	label: string;
	run: (onTransport: (t: string | undefined) => void) => Promise<AssistantMessage>;
	validBody: () => string;
};

const cases: Case[] = [
	{
		name: "anthropic-messages",
		label: "SSE gzip",
		run: (onTransport) => streamAnthropic(anthropicModel, context, { apiKey: "sk-ant-test", onTransport }).result(),
		validBody: anthropicSse,
	},
	{
		name: "openai-responses (explicit sse)",
		label: "SSE Zstd",
		run: (onTransport) =>
			streamResponses(responsesModel, context, { apiKey: "sk-test", transport: "sse", onTransport }).result(),
		validBody: responsesSse,
	},
	{
		name: "azure-openai-responses",
		label: "SSE Zstd",
		run: (onTransport) => streamAzure(azureModel, context, { apiKey: "sk-test", onTransport }).result(),
		validBody: responsesSse,
	},
	{
		name: "openai-completions",
		label: "SSE Zstd",
		run: (onTransport) => streamCompletions(completionsModel, context, { apiKey: "sk-test", onTransport }).result(),
		validBody: completionsSse,
	},
	{
		name: "mistral-conversations",
		label: "SSE",
		run: (onTransport) => streamMistral(mistralModel, context, { apiKey: "sk-test", onTransport }).result(),
		validBody: mistralSse,
	},
	{
		name: "pi-messages",
		label: "SSE",
		run: (onTransport) => streamPiMessages(piModel, context, { apiKey: "sk-test", onTransport }).result(),
		validBody: piSse,
	},
];

describe("onTransport SSE reporting", () => {
	for (const testCase of cases) {
		it(`reports SSE for a valid ${testCase.name} stream`, async () => {
			const transports: Array<string | undefined> = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(testCase.validBody(), { headers: { "content-type": "text/event-stream" } })),
			);
			const result = await testCase.run((t) => void transports.push(t));
			expect(result.stopReason).toBe("stop");
			expect(transports).toEqual([testCase.label]);
		});

		it(`does not report SSE for an empty-body ${testCase.name} success response`, async () => {
			const transports: Array<string | undefined> = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } })),
			);
			await testCase.run((t) => void transports.push(t));
			expect(transports).toEqual([]);
		});

		it(`does not report SSE for a non-SSE ${testCase.name} success response`, async () => {
			const transports: Array<string | undefined> = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
				),
			);
			await testCase.run((t) => void transports.push(t));
			expect(transports).toEqual([]);
		});
	}
});
