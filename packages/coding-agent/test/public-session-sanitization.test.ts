import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { CompactionPreparation } from "../src/core/compaction/index.ts";
import { toPublicCompactionPreparation } from "../src/core/compaction/index.ts";
import { type ExtensionAPI, ExtensionRunner, type SessionBeforeCompactEvent } from "../src/core/extensions/index.ts";
import {
	createExtensionSessionManagerView,
	type SessionEntry,
	SessionManager,
	toPublicSessionEntry,
} from "../src/core/session-manager.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "./utilities.ts";

const usage: Usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

function privateAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "visible assistant text", textSignature: "private-text-signature" },
			{
				type: "thinking",
				thinking: "visible thinking text",
				thinkingSignature: "private-thinking-signature",
				redacted: false,
			},
			{
				type: "toolCall",
				id: "visible-tool-id",
				name: "visible-tool-name",
				arguments: {
					textSignature: "ordinary-user-tool-argument",
					details: { provider: "ordinary-user-tool-provider" },
				},
				thoughtSignature: "private-thought-signature",
			},
		],
		api: "private-api",
		provider: "private-provider",
		model: "private-model",
		responseModel: "private-response-model",
		responseId: "private-response-id",
		diagnostics: [{ type: "private-diagnostic", timestamp: 1, details: { opaque: "private-diagnostic-data" } }],
		usage,
		stopReason: "error",
		errorMessage: "visible error message",
		timestamp: 2,
	};
}

function toolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "visible-tool-id",
		toolName: "visible-tool-name",
		content: [{ type: "text", text: "visible tool result", textSignature: "ordinary-tool-result-signature-field" }],
		details: { provider: "ordinary-tool-result-provider", diagnostics: "ordinary tool details" },
		usage,
		isError: false,
		timestamp: 3,
	};
}

const privateSentinels = [
	"private-api",
	"private-provider",
	"private-model",
	"private-response-model",
	"private-response-id",
	"private-text-signature",
	"private-thinking-signature",
	"private-thought-signature",
	"private-diagnostic",
	"private-diagnostic-data",
];

function expectPublicPayload(
	payload: unknown,
	visibleValues = [
		"visible assistant text",
		"visible thinking text",
		"visible-tool-id",
		"visible-tool-name",
		"ordinary-user-tool-argument",
		"ordinary-user-tool-provider",
		"visible error message",
		"visible tool result",
		"ordinary-tool-result-signature-field",
		"ordinary-tool-result-provider",
		"ordinary tool details",
	],
): void {
	const serialized = JSON.stringify(payload);
	for (const sentinel of privateSentinels) expect(serialized).not.toContain(sentinel);
	for (const visible of visibleValues) {
		expect(serialized).toContain(visible);
	}
}

function seed(manager: SessionManager): { assistantId: string; resultId: string } {
	manager.appendMessage({ role: "user", content: "visible user text", timestamp: 1 });
	const assistantId = manager.appendMessage(privateAssistant());
	const resultId = manager.appendMessage(toolResult());
	return { assistantId, resultId };
}

describe("public session message sanitization", () => {
	it("sanitizes complete compaction preparation and branch event without mutating source messages", async () => {
		const assistant = privateAssistant();
		const result = toolResult();
		const manager = SessionManager.inMemory(process.cwd());
		seed(manager);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: manager.getLeafId()!,
			messagesToSummarize: [assistant, result],
			turnPrefixMessages: [structuredClone(assistant), structuredClone(result)],
			isSplitTurn: true,
			tokensBefore: 10,
			previousSummary: "visible previous summary",
			fileOps: { read: new Set(["visible-read"]), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		};
		let captured: SessionBeforeCompactEvent | undefined;
		const extensionResult = await createTestExtensionsResult([
			(pi: ExtensionAPI) =>
				pi.on("session_before_compact", (event) => {
					captured = event;
				}),
		]);
		const runner = new ExtensionRunner(
			extensionResult.extensions,
			extensionResult.runtime,
			process.cwd(),
			manager,
			await createModelRegistry(AuthStorage.inMemory()),
		);

		await runner.emitSessionBeforeCompact({
			type: "session_before_compact",
			preparation,
			branchEntries: manager.getBranch(),
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		});

		expectPublicPayload(captured);
		expect(JSON.stringify(captured)).toContain("visible user text");
		expect(JSON.stringify(captured)).toContain("visible previous summary");
		if (!captured) throw new Error("event was not captured");
		const capturedMessage = captured.preparation.messagesToSummarize[0];
		if (capturedMessage.role !== "assistant") throw new Error("assistant preparation message missing");
		capturedMessage.content = [];
		const publicAssistant = captured.branchEntries.find(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		if (!publicAssistant || publicAssistant.type !== "message" || publicAssistant.message.role !== "assistant") {
			throw new Error("assistant entry missing");
		}
		publicAssistant.message.content = [];
		expect(assistant.content).toHaveLength(3);
		const sourceEntry = manager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(
			sourceEntry?.type === "message" && sourceEntry.message.role === "assistant" && sourceEntry.message.content,
		).toHaveLength(3);
	});

	it("sanitizes every extension session manager message read and returns detached clones", () => {
		const manager = SessionManager.inMemory(process.cwd());
		const { assistantId } = seed(manager);
		const view = createExtensionSessionManagerView(manager);
		const payloads = [
			view.getLeafEntry(),
			view.getEntry(assistantId),
			view.getBranch(),
			view.buildContextEntries(),
			view.getEntries(),
			view.getTree(),
		];
		for (const payload of payloads) {
			const serialized = JSON.stringify(payload);
			for (const sentinel of privateSentinels) expect(serialized).not.toContain(sentinel);
		}
		expectPublicPayload(view.getEntries());
		const entry = view.getEntry(assistantId);
		if (!entry || entry.type !== "message" || entry.message.role !== "assistant")
			throw new Error("assistant missing");
		entry.message.content = [];
		const source = manager.getEntry(assistantId);
		expect(source?.type === "message" && source.message.role === "assistant" && source.message.content).toHaveLength(
			3,
		);
	});

	it("sanitizes ordinary public message entries while preserving custom projection details", () => {
		const manager = SessionManager.inMemory(process.cwd());
		const { assistantId } = seed(manager);
		const publicEntry = toPublicSessionEntry(manager.getEntry(assistantId)!);
		expectPublicPayload([
			publicEntry,
			toPublicCompactionPreparation({
				firstKeptEntryId: assistantId,
				messagesToSummarize: [privateAssistant(), toolResult()],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 1,
				previousSummary: "visible projection summary",
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
			}),
		]);
		const custom: SessionEntry = {
			type: "custom",
			id: "custom",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: "projection",
			data: { provider: "ordinary projection provider detail" },
		};
		expect(JSON.stringify(toPublicSessionEntry(custom))).toContain("ordinary projection provider detail");
	});
});
