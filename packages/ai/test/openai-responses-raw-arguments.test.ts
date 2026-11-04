import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const rawArguments = '{"command": "echo one"}';

async function* events(): AsyncIterable<ResponseStreamEvent> {
	const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash" } as const;
	yield { type: "response.output_item.added", sequence_number: 0, output_index: 0, item: { ...item, arguments: "" } };
	yield {
		type: "response.output_item.done",
		sequence_number: 1,
		output_index: 0,
		item: { ...item, arguments: rawArguments },
	};
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: { id: "resp_1", status: "completed" },
	} as ResponseStreamEvent;
}

async function receive(): Promise<AssistantMessage> {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
	await processResponsesStream(events(), output, new AssistantMessageEventStream(), model);
	return output;
}

function replayedArguments(output: AssistantMessage): string | undefined {
	const item = convertResponsesMessages(model, normalizeContext({ messages: [output] }), new Set(["openai"])).find(
		(entry) => entry.type === "function_call",
	);
	return item?.type === "function_call" ? item.arguments : undefined;
}

describe("OpenAI Responses tool-call argument replay", () => {
	it("replays the arguments text the model sent, not a re-encoding", async () => {
		expect(replayedArguments(await receive())).toBe(rawArguments);
	});

	it("re-encodes arguments changed after the response", async () => {
		const output = await receive();
		const toolCall = output.content[0];
		if (toolCall?.type !== "toolCall") throw new Error("Expected toolCall block");
		toolCall.arguments = { command: "echo two" };
		expect(replayedArguments(output)).toBe('{"command":"echo two"}');
	});
});
