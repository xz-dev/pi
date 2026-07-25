import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { CompactionPreparation } from "../src/core/compaction/index.ts";
import { toPublicCompactionPreparation } from "../src/core/compaction/index.ts";
import {
	type ExtensionAPI,
	type ExtensionContext,
	ExtensionRunner,
	type SessionBeforeCompactEvent,
} from "../src/core/extensions/index.ts";
import {
	createExtensionSessionManagerView,
	type ExtensionSessionManagerView,
	type InternalSessionEntry,
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

function seed(manager: SessionManager): { assistantId: string; modelChangeId: string; resultId: string } {
	manager.appendMessage({ role: "user", content: "visible user text", timestamp: 1 });
	const assistantId = manager.appendMessage(privateAssistant());
	const modelChangeId = manager.appendModelChange("private-model-change-provider", "private-model-change-id");
	const resultId = manager.appendMessage(toolResult());
	return { assistantId, modelChangeId, resultId };
}

function expectNeutralModelChange(payload: unknown, timestamp: string): void {
	const serialized = JSON.stringify(payload);
	expect(serialized).not.toContain("private-model-change-provider");
	expect(serialized).not.toContain("private-model-change-id");
	expect(serialized).toContain('"type":"model_change"');
	expect(serialized).toContain(timestamp);
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
		const modelChange = manager.getEntries().find((entry) => entry.type === "model_change");
		if (!modelChange) throw new Error("model change missing");
		expectNeutralModelChange(captured, modelChange.timestamp);
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
		const { assistantId, modelChangeId } = seed(manager);
		const sourceModelChange = manager.getEntry(modelChangeId);
		if (!sourceModelChange || sourceModelChange.type !== "model_change") throw new Error("model change missing");
		manager.branch(modelChangeId);
		const view = createExtensionSessionManagerView(manager);
		const payloads = [
			view.getLeafEntry(),
			view.getEntry(modelChangeId),
			view.getBranch(),
			view.buildContextEntries(),
			view.getEntries(),
			view.getTree(),
		];
		for (const payload of payloads) {
			const serialized = JSON.stringify(payload);
			for (const sentinel of privateSentinels) expect(serialized).not.toContain(sentinel);
			expectNeutralModelChange(payload, sourceModelChange.timestamp);
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

	it("reparents visible descendants and visible leaf when an invalid private boundary is omitted", () => {
		const manager = SessionManager.inMemory(process.cwd());
		const rootId = manager.appendMessage({ role: "user", content: "visible root", timestamp: 1 });
		const malformedBoundary = {
			type: "compaction_boundary",
			id: "invalid-private-boundary",
			parentId: rootId,
			timestamp: new Date().toISOString(),
			boundary: { version: 2, private: "private-boundary-sentinel" },
		} as unknown as InternalSessionEntry;
		const managerInternals = manager as unknown as {
			fileEntries: unknown[];
			_buildIndex(): void;
		};
		managerInternals.fileEntries.push(malformedBoundary);
		managerInternals._buildIndex();
		const childId = manager.appendMessage({ role: "user", content: "visible child", timestamp: 2 });
		manager.branch("invalid-private-boundary");

		const view = createExtensionSessionManagerView(manager);
		const entries = view.getEntries();
		const child = entries.find((entry) => entry.id === childId);
		expect(child?.parentId).toBe(rootId);
		expect(view.getLeafId()).toBe(rootId);
		expect(view.getLeafEntry()?.id).toBe(rootId);
		expect(view.getBranch(childId).map((entry) => entry.id)).toEqual([rootId, childId]);
		expect(view.getTree()).toEqual([
			expect.objectContaining({
				entry: expect.objectContaining({ id: rootId }),
				children: [expect.objectContaining({ entry: expect.objectContaining({ id: childId }) })],
			}),
		]);
		expect(JSON.stringify([entries, view.getTree()])).not.toContain("private-boundary-sentinel");
	});

	it("exposes only the provider-neutral extension session manager contract", () => {
		expectTypeOf<ExtensionContext["sessionManager"]>().toEqualTypeOf<ExtensionSessionManagerView>();
		type ExtensionKeys = keyof ExtensionContext["sessionManager"];
		expectTypeOf<"captureProviderCheckpointAppendState">().not.toMatchTypeOf<ExtensionKeys>();
		expectTypeOf<"captureCompactionBoundaryAppendState">().not.toMatchTypeOf<ExtensionKeys>();
	});

	it("sanitizes model transitions without mutating the private source entry", () => {
		const manager = SessionManager.inMemory(process.cwd());
		const id = manager.appendModelChange("private-model-change-provider", "private-model-change-id");
		const source = manager.getEntry(id);
		if (!source || source.type !== "model_change") throw new Error("model change missing");

		const publicEntry = toPublicSessionEntry(source);

		expect(publicEntry).toEqual({
			type: "model_change",
			id: source.id,
			parentId: source.parentId,
			timestamp: source.timestamp,
		});
		expect(source).toMatchObject({
			provider: "private-model-change-provider",
			modelId: "private-model-change-id",
		});
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
		const custom: InternalSessionEntry = {
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
