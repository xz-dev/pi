import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OpenAIResponsesCheckpointIdentity } from "@earendil-works/pi-ai/api/openai-responses";
import { describe, expect, it } from "vitest";
import { mergePortableCheckpointProjection } from "../src/core/sdk.ts";

const identity: OpenAIResponsesCheckpointIdentity = {
	adapter: "openai-responses-compact-v1",
	realm: "provider-owned:test-account",
	provider: "openai",
	endpoint: "https://api.openai.com/v1",
	modelFamily: "gpt-5",
};

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function text(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

describe("provider checkpoint request projection", () => {
	it("retains the exact in-memory suffix after delayed persistence without duplicating the persisted frontier", () => {
		const persistedFrontier = user("same text", 1);
		const duplicateTextPrompt = user("same text", 2);
		const pendingSteering = user("pending steering", 3);
		const pendingFollowUp = user("pending follow-up", 4);
		const checkpointSuffix = user("checkpoint suffix", 10);

		const merged = mergePortableCheckpointProjection(
			[persistedFrontier],
			[checkpointSuffix],
			[persistedFrontier, duplicateTextPrompt, pendingSteering, pendingFollowUp],
		);

		expect(merged).toEqual({
			messages: [checkpointSuffix, duplicateTextPrompt, pendingSteering, pendingFollowUp],
			applied: true,
		});
		expect(merged.messages.map(text)).toEqual([
			"checkpoint suffix",
			"same text",
			"pending steering",
			"pending follow-up",
		]);
	});

	it("uses an ordered subsequence frontier when non-portable loop messages separate persisted messages", () => {
		const first = user("first persisted", 1);
		const hookOnly = { role: "notification", timestamp: 2 } as unknown as AgentMessage;
		const second = user("second persisted", 3);
		const pending = user("pending prompt", 4);
		const checkpointSuffix = user("checkpoint suffix", 10);

		expect(
			mergePortableCheckpointProjection([first, second], [checkpointSuffix], [first, hookOnly, second, pending]),
		).toEqual({ messages: [checkpointSuffix, pending], applied: true });
	});

	it("preserves the current loop projection unchanged when persisted history is not an ordered prefix or subsequence", () => {
		const persisted = user("persisted", 1);
		const current = user("current", 2);

		expect(mergePortableCheckpointProjection([persisted], [user("checkpoint suffix", 10)], [current])).toEqual({
			messages: [current],
			applied: false,
		});
	});

	it("does not collapse distinct same-text messages when stronger timestamp identity differs", () => {
		const persisted = user("same", 1);
		const distinctCurrent = user("same", 2);

		expect(
			mergePortableCheckpointProjection([persisted], [user("checkpoint suffix", 10)], [distinctCurrent]),
		).toEqual({ messages: [distinctCurrent], applied: false });
	});

	it("accepts cloned persisted messages by stable structure when object identity is unavailable", () => {
		const persisted = user("persisted", 1);
		const clonedPersisted = structuredClone(persisted);
		const pending = user("pending", 2);
		const checkpointSuffix = user("checkpoint suffix", 10);

		expect(mergePortableCheckpointProjection([persisted], [checkpointSuffix], [clonedPersisted, pending])).toEqual({
			messages: [checkpointSuffix, pending],
			applied: true,
		});
	});

	it("keeps provider identity fixtures complete", () => {
		expect(identity).toMatchObject({ provider: "openai", modelFamily: "gpt-5" });
	});
});
