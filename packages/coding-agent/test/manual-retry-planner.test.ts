import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { ContinuationPlanError, planContinuation, SYNTHETIC_TOOL_RESULT_TEXT } from "../src/core/manual-retry.ts";
import type { SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";

function userMessage(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	};
}

function assistantEntry(id: string, parentId: string | null, message: AssistantMessage): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
}

function toolResultEntry(
	id: string,
	parentId: string,
	toolCallId: string,
	toolName: string,
	text: string,
	isError = false,
): SessionMessageEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
}

function modelChange(id: string, parentId: string): SessionEntry {
	return {
		type: "model_change",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		provider: "anthropic",
		modelId: "claude",
	};
}

function expectRejection(code: string, run: () => void): void {
	try {
		run();
		expect.fail(`expected ContinuationPlanError with code ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(ContinuationPlanError);
		expect((error as ContinuationPlanError).code).toBe(code);
		expect((error as ContinuationPlanError).message.length).toBeGreaterThan(0);
	}
}

describe("planContinuation", () => {
	test.each(["error", "aborted"] as const)(
		"classifies interrupted assistant %s while preserving safe partial text",
		(stopReason) => {
			const branch = [
				userMessage("user-1", null, "retry me"),
				assistantEntry(
					"fail-1",
					"user-1",
					fauxAssistantMessage("safe partial", {
						stopReason,
						errorMessage: stopReason === "error" ? "boom" : undefined,
					}),
				),
			];

			const plan = planContinuation({ branchEntries: branch, recoveryTimestamp: 123 });

			expect(plan.kind).toBe("interrupted_assistant");
			expect(plan.anchorEntryId).toBe("user-1");
			expect(plan.expectedLeafId).toBe("fail-1");
			expect(plan.recoveryMessages).toEqual([]);
			expect(plan.partialAssistantText).toBe("safe partial");
			expect(plan.contextMessages.map((message) => message.role)).toEqual(["user"]);
		},
	);

	test("normalizes a complete interrupted tool call for provider recovery without persisting it", () => {
		const branch = [
			userMessage("user-1", null, "attempt tool"),
			assistantEntry(
				"fail-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("side_effect", {}, { id: "call-1" })], {
					stopReason: "error",
					errorMessage: "failed",
				}),
			),
		];

		const plan = planContinuation({ branchEntries: branch, recoveryTimestamp: 123 });

		expect(plan.anchorEntryId).toBe("user-1");
		expect(plan.contextMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(plan.contextMessages[1]).toMatchObject({ role: "assistant", stopReason: "toolUse" });
		expect(plan.providerRecoveryMessages).toHaveLength(1);
		expect(plan.providerRecoveryMessages?.[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "call-1",
			isError: true,
		});
		expect(plan.recoveryMessages).toEqual([]);
	});

	test.each([
		[
			"malformed tool suffix after text",
			[
				fauxAssistantMessage([{ type: "text", text: "safe text" }, { type: "toolCall", id: "call-2" } as never], {
					stopReason: "aborted",
				}),
			],
		],
		[
			"malformed tool suffix after a complete call",
			[
				fauxAssistantMessage(
					[fauxToolCall("side_effect", {}, { id: "call-1" }), { type: "toolCall", id: "call-2" } as never],
					{ stopReason: "aborted" },
				),
			],
		],
	] as const)("rejects interrupted assistant with $0", (_name, messages) => {
		const branch = [userMessage("user-1", null, "bad"), assistantEntry("fail-1", "user-1", messages[0]!)];
		expectRejection("malformed_tool_call", () => planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }));
	});

	test("classifies an explicit user anchor without duplicating context", () => {
		const branch = [
			userMessage("user-1", null, "reuse me"),
			assistantEntry("ok-1", "user-1", fauxAssistantMessage("old answer")),
		];

		const plan = planContinuation({ branchEntries: branch, recoveryTimestamp: 123, selectedEntryId: "user-1" });

		expect(plan.kind).toBe("user_anchor");
		expect(plan.anchorEntryId).toBe("user-1");
		expect(plan.expectedLeafId).toBe("ok-1");
		expect(plan.recoveryMessages).toEqual([]);
		expect(plan.contextMessages).toEqual([branch[0]!.message]);
	});

	test("continues a complete toolResult batch without recovery messages", () => {
		const branch = [
			userMessage("user-1", null, "use result"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("side_effect", {}, { id: "call-1" })], {
					stopReason: "toolUse",
				}),
			),
			toolResultEntry("result-1", "assistant-1", "call-1", "side_effect", "existing result"),
		];

		const plan = planContinuation({ branchEntries: branch, recoveryTimestamp: 123 });

		expect(plan.kind).toBe("tool_batch");
		expect(plan.anchorEntryId).toBe("result-1");
		expect(plan.expectedLeafId).toBe("result-1");
		expect(plan.recoveryMessages).toEqual([]);
		expect(plan.contextMessages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		const result = plan.contextMessages[2] as ToolResultMessage;
		expect(result.toolCallId).toBe("call-1");
		expect(result.isError).toBe(false);
	});

	test("synthesizes a neutral error for a missing toolResult", () => {
		const branch = [
			userMessage("user-1", null, "attempt side effect"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("side_effect", {}, { id: "call-unknown" })], {
					stopReason: "toolUse",
				}),
			),
		];

		const plan = planContinuation({ branchEntries: branch, recoveryTimestamp: 123 });

		expect(plan.kind).toBe("tool_batch");
		expect(plan.anchorEntryId).toBe("assistant-1");
		expect(plan.expectedLeafId).toBe("assistant-1");
		expect(plan.contextMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(plan.recoveryMessages).toHaveLength(1);
		expect(plan.recoveryMessages[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "call-unknown",
			toolName: "side_effect",
			isError: true,
		});
		expect(plan.recoveryMessages[0]?.content).toEqual([{ type: "text", text: SYNTHETIC_TOOL_RESULT_TEXT }]);
		expect(typeof plan.recoveryMessages[0]?.timestamp).toBe("number");
	});

	test("preserves matched multi-call results and synthesizes only missing ids in call order", () => {
		const branch = [
			userMessage("user-1", null, "two calls"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage(
					[fauxToolCall("first", {}, { id: "call-1" }), fauxToolCall("second", {}, { id: "call-2" })],
					{ stopReason: "toolUse" },
				),
			),
			toolResultEntry("result-1", "assistant-1", "call-1", "first", "kept"),
		];

		const plan = planContinuation({ branchEntries: branch, recoveryTimestamp: 123 });

		expect(plan.kind).toBe("tool_batch");
		expect(plan.anchorEntryId).toBe("result-1");
		expect(plan.recoveryMessages.map((result) => result.toolCallId)).toEqual(["call-2"]);
		expect(plan.recoveryMessages[0]).toMatchObject({
			toolName: "second",
			isError: true,
		});
		expect(plan.contextMessages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect((plan.contextMessages[2] as ToolResultMessage).toolCallId).toBe("call-1");
	});

	test("plans from a selected tool-call assistant or toolResult protocol node", () => {
		const branch = [
			userMessage("user-1", null, "tree protocol"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "tree-call" })], {
					stopReason: "toolUse",
				}),
			),
			toolResultEntry("result-1", "assistant-1", "tree-call", "lookup", "tree result"),
		];

		const fromCall = planContinuation({
			branchEntries: branch,
			recoveryTimestamp: 123,
			selectedEntryId: "assistant-1",
		});
		expect(fromCall.kind).toBe("tool_batch");
		expect(fromCall.anchorEntryId).toBe("result-1");
		expect(fromCall.recoveryMessages).toEqual([]);

		const fromResult = planContinuation({
			branchEntries: branch,
			recoveryTimestamp: 123,
			selectedEntryId: "result-1",
		});
		expect(fromResult.kind).toBe("tool_batch");
		expect(fromResult.anchorEntryId).toBe("result-1");
		expect(fromResult.contextMessages.at(-1)).toMatchObject({
			role: "toolResult",
			toolCallId: "tree-call",
		});
	});

	test("keeps completed results after context-free metadata when selecting the tool-call assistant", () => {
		const branch = [
			userMessage("user-1", null, "tree protocol"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "tree-call" })], {
					stopReason: "toolUse",
				}),
			),
			modelChange("model-1", "assistant-1"),
			toolResultEntry("result-1", "model-1", "tree-call", "lookup", "tree result"),
		];

		const plan = planContinuation({
			branchEntries: branch,
			recoveryTimestamp: 123,
			selectedEntryId: "assistant-1",
		});

		expect(plan.kind).toBe("tool_batch");
		expect(plan.anchorEntryId).toBe("result-1");
		expect(plan.recoveryMessages).toEqual([]);
		expect(plan.contextMessages.at(-1)).toMatchObject({
			role: "toolResult",
			toolCallId: "tree-call",
			content: [{ type: "text", text: "tree result" }],
		});
	});

	test.each([
		["stop", "assistant_eof"],
		["length", "assistant_length_eof"],
	] as const)("rejects deliberate assistant %s as Assistant EOF", (stopReason, code) => {
		const branch = [
			userMessage("user-1", null, "done"),
			assistantEntry("ok-1", "user-1", fauxAssistantMessage("complete", { stopReason })),
		];
		expectRejection(code, () => planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }));
	});

	test("ignores trailing custom and plugin metadata when selecting the retry tail", () => {
		const branch: SessionEntry[] = [
			userMessage("user-1", null, "retry me"),
			assistantEntry(
				"fail-1",
				"user-1",
				fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "network failed" }),
			),
			{
				type: "message",
				id: "plugin-output",
				parentId: "fail-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "custom",
					customType: "notice",
					content: "trailing output",
					display: true,
					timestamp: Date.now(),
				},
			},
			{
				type: "custom_message",
				id: "plugin-message",
				parentId: "plugin-output",
				timestamp: new Date().toISOString(),
				customType: "notice",
				content: "another trailing output",
				display: true,
			},
			{
				type: "custom",
				id: "plugin-state",
				parentId: "plugin-message",
				timestamp: new Date().toISOString(),
				customType: "state",
				data: { trailing: true },
			},
		];

		const plan = planContinuation({ branchEntries: branch, recoveryTimestamp: 123 });
		expect(plan.kind).toBe("interrupted_assistant");
		expect(plan.anchorEntryId).toBe("user-1");
		expect(plan.expectedLeafId).toBe("plugin-state");
		expect(plan.partialAssistantText).toBe("partial");
	});

	test("rejects an orphan tool result", () => {
		const branch = [
			userMessage("user-1", null, "bad"),
			toolResultEntry("orphan-1", "user-1", "missing", "missing", "bad"),
		];
		expectRejection("orphan_tool_result", () => planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }));
	});

	test("rejects duplicate tool call ids in the assistant batch", () => {
		const branch = [
			userMessage("user-1", null, "bad"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage(
					[fauxToolCall("first", {}, { id: "dup" }), fauxToolCall("second", {}, { id: "dup" })],
					{ stopReason: "toolUse" },
				),
			),
		];
		expectRejection("duplicate_tool_call", () => planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }));
	});

	test("rejects duplicate tool results for the same call id", () => {
		const branch = [
			userMessage("user-1", null, "bad"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("first", {}, { id: "call-1" })], {
					stopReason: "toolUse",
				}),
			),
			toolResultEntry("result-1", "assistant-1", "call-1", "first", "one"),
			toolResultEntry("result-2", "result-1", "call-1", "first", "two"),
		];
		expectRejection("duplicate_tool_result", () =>
			planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }),
		);
	});

	test("rejects tool name mismatch between call and result", () => {
		const branch = [
			userMessage("user-1", null, "bad"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("first", {}, { id: "call-1" })], {
					stopReason: "toolUse",
				}),
			),
			toolResultEntry("result-1", "assistant-1", "call-1", "other", "nope"),
		];
		expectRejection("tool_name_mismatch", () => planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }));
	});

	test("does not absorb unrelated later protocol history from an old selected assistant", () => {
		const branch = [
			userMessage("user-1", null, "retry old tool batch"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage(
					[fauxToolCall("first", {}, { id: "call-1" }), fauxToolCall("second", {}, { id: "call-2" })],
					{ stopReason: "toolUse" },
				),
			),
			toolResultEntry("result-1", "assistant-1", "call-1", "first", "kept"),
			userMessage("user-2", "result-1", "later branch"),
			toolResultEntry("result-2", "user-2", "call-2", "second", "unrelated late result"),
		];
		const plan = planContinuation({
			branchEntries: branch,
			recoveryTimestamp: 123,
			selectedEntryId: "assistant-1",
		});
		expect(plan.anchorEntryId).toBe("result-1");
		expect(plan.recoveryMessages.map((message) => message.toolCallId)).toEqual(["call-2"]);
		expect(plan.contextMessages.some((message) => message.role === "user" && message !== branch[0]!.message)).toBe(
			false,
		);
	});

	test("rejects malformed empty tool call ids", () => {
		const branch = [
			userMessage("user-1", null, "bad"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("broken", {}, { id: "" })], { stopReason: "toolUse" }),
			),
		];
		expectRejection("malformed_tool_call", () => planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }));
	});

	test("rejects a tool result that does not belong to the assistant call set", () => {
		const branch = [
			userMessage("user-1", null, "bad"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("first", {}, { id: "call-1" })], {
					stopReason: "toolUse",
				}),
			),
			toolResultEntry("result-1", "assistant-1", "call-other", "first", "orphan-id"),
		];
		expectRejection("orphan_tool_result", () => planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }));
	});

	test("rejects non-message selected anchors with nothing_to_continue", () => {
		const branch = [userMessage("user-1", null, "hello"), modelChange("model-1", "user-1")];
		expectRejection("nothing_to_continue", () =>
			planContinuation({ branchEntries: branch, recoveryTimestamp: 123, selectedEntryId: "model-1" }),
		);
	});

	test("rejects a selected duplicate result even after plain metadata", () => {
		const branch = [
			userMessage("user-1", null, "bad"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("first", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			),
			toolResultEntry("result-1", "assistant-1", "call-1", "first", "one"),
			modelChange("model-1", "result-1"),
			toolResultEntry("result-2", "model-1", "call-1", "first", "two"),
		];
		expectRejection("duplicate_tool_result", () =>
			planContinuation({ branchEntries: branch, recoveryTimestamp: 123, selectedEntryId: "result-2" }),
		);
	});

	test("preserves model-visible custom context before an interrupted assistant", () => {
		const branch: SessionEntry[] = [
			userMessage("user-1", null, "context"),
			{
				type: "custom_message",
				id: "custom-message",
				parentId: "user-1",
				timestamp: new Date().toISOString(),
				customType: "notice",
				content: "keep me",
				display: false,
			},
			{
				type: "custom",
				id: "metadata",
				parentId: "custom-message",
				timestamp: new Date().toISOString(),
				customType: "metadata",
				data: { ignored: true },
			},
			assistantEntry(
				"failure",
				"metadata",
				fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "boom" }),
			),
		];
		const plan = planContinuation({ branchEntries: branch, recoveryTimestamp: 123 });
		expect(plan.anchorEntryId).toBe("metadata");
		expect(plan.contextMessages.map((message) => message.role)).toEqual(["user", "custom"]);
		expect(plan.contextMessages.at(-1)).toMatchObject({ customType: "notice", content: "keep me" });
	});

	test.each([
		["assistant content", { content: null }],
		["tool arguments", { content: [{ type: "toolCall", id: "call", name: "read", arguments: null }] }],
		["blank call id", { content: [{ type: "toolCall", id: "  ", name: "read", arguments: {} }] }],
	] as const)("rejects malformed %s", (_name, patch) => {
		const malformed = {
			...fauxAssistantMessage([fauxToolCall("read", {}, { id: "call" })], { stopReason: "toolUse" }),
			...patch,
		} as unknown as AssistantMessage;
		const branch = [userMessage("user-1", null, "bad"), assistantEntry("assistant-1", "user-1", malformed)];
		expectRejection("malformed_tool_call", () => planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }));
	});

	test("rejects malformed tool result content", () => {
		const malformedResult = toolResultEntry("result-1", "assistant-1", "call-1", "read", "ok");
		(malformedResult.message as ToolResultMessage).content = null as never;
		const branch = [
			userMessage("user-1", null, "bad"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("read", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			),
			malformedResult,
		];
		expectRejection("malformed_tool_result", () =>
			planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }),
		);
	});

	test.each(["", "   \n"])("rejects blank user content %j", (text) => {
		const branch = [userMessage("user-1", null, text)];
		expectRejection("invalid_anchor", () => planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }));
	});

	const blankToolResultContentCases = [
		{ content: [] },
		{ content: [{ type: "text", text: "  " }] },
		{ content: [{ type: "image", data: "", mimeType: "image/png" }] },
		{ content: [{ type: "image", data: "abc", mimeType: " " }] },
	] satisfies { content: ToolResultMessage["content"] }[];

	test.each(blankToolResultContentCases)("rejects blank tool result content %#", ({ content }) => {
		const result = toolResultEntry("result-1", "assistant-1", "call-1", "read", "ok");
		(result.message as ToolResultMessage).content = content;
		const branch = [
			userMessage("user-1", null, "bad"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("read", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			),
			result,
		];
		expectRejection("malformed_tool_result", () =>
			planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }),
		);
	});

	test("is deterministic for identical explicit inputs", () => {
		const branch = [
			userMessage("user-1", null, "attempt"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("side_effect", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			),
		];
		expect(planContinuation({ branchEntries: branch, recoveryTimestamp: 123 })).toEqual(
			planContinuation({ branchEntries: branch, recoveryTimestamp: 123 }),
		);
	});

	test("is pure: does not mutate branch entries or messages", () => {
		const branch = [
			userMessage("user-1", null, "attempt"),
			assistantEntry(
				"assistant-1",
				"user-1",
				fauxAssistantMessage([fauxToolCall("side_effect", {}, { id: "call-1" })], {
					stopReason: "toolUse",
				}),
			),
		];
		const before = structuredClone(branch) as SessionEntry[];

		const plan = planContinuation({ branchEntries: branch, recoveryTimestamp: 123 });
		expect(plan.recoveryMessages).toHaveLength(1);
		expect(branch).toEqual(before);
		expect(plan.contextMessages.every((message: AgentMessage) => message.role !== "toolResult")).toBe(true);
	});
});
