import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage,
	type Context,
	type ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

const SYNTHETIC_RESULT_PATTERN =
	/no usable result was recorded.*executed or produced side effects is unknown.*not assume it is safe to repeat/is;

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function setBranch(harness: Harness, messages: AgentMessage[]): string[] {
	const ids = messages.map((message) => harness.sessionManager.appendMessage(message));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return ids;
}

function providerMessages(context: Context): AgentMessage[] {
	return context.messages as AgentMessage[];
}

describe("manual /retry continuation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harness(): Promise<Harness> {
		const created = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(created);
		return created;
	}

	it.each(["error", "aborted"] as const)(
		"creates a successful sibling after a terminal assistant %s without duplicating the request",
		async (stopReason) => {
			const created = await harness();
			const requestId = created.sessionManager.appendMessage(userMessage("original request"));
			const failureId = created.sessionManager.appendMessage(
				fauxAssistantMessage("failed tail", { stopReason, errorMessage: stopReason === "error" ? "boom" : undefined }),
			);
			created.session.agent.state.messages = created.sessionManager.buildSessionContext().messages;
			created.setResponses([fauxAssistantMessage("recovered")]);

			await created.session.retry();

			const leaf = created.sessionManager.getLeafEntry();
			expect(leaf).toMatchObject({ type: "message", parentId: requestId, message: { role: "assistant" } });
			expect(leaf?.id).not.toBe(failureId);
			expect(getUserTexts(created)).toEqual(["original request"]);
			expect(getAssistantTexts(created)).toEqual(["recovered"]);
			const failure = created.sessionManager.getEntry(failureId);
			expect(failure).toMatchObject({ type: "message", parentId: requestId, message: { stopReason } });
			expect(created.sessionManager.getChildren(requestId).map((entry) => entry.id)).toEqual(
				expect.arrayContaining([failureId, leaf?.id]),
			);
		},
	);

	it("continues after a complete tool result without executing a tool", async () => {
		let executions = 0;
		const tool: AgentTool = {
			name: "side_effect",
			label: "Side effect",
			description: "Must not run during retry",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "executed" }], details: undefined };
			},
		};
		const created = await createHarness({ tools: [tool], settings: { retry: { enabled: false } } });
		harnesses.push(created);
		setBranch(created, [
			userMessage("use result"),
			fauxAssistantMessage([fauxToolCall("side_effect", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			toolResult("call-1", "side_effect", "existing result"),
		]);
		let seenResult = false;
		created.setResponses([
			(context) => {
				seenResult = providerMessages(context).some(
					(message) =>
						message.role === "toolResult" &&
						message.toolCallId === "call-1" &&
						message.content.some((part) => part.type === "text" && part.text === "existing result"),
				);
				return fauxAssistantMessage("continued from result");
			},
		]);

		await created.session.retry();

		expect(executions).toBe(0);
		expect(seenResult).toBe(true);
		expect(getAssistantTexts(created).at(-1)).toBe("continued from result");
	});

	it("pairs an unresolved tool call with a neutral synthetic error and lets the AI decide", async () => {
		let executions = 0;
		const tool: AgentTool = {
			name: "side_effect",
			label: "Side effect",
			description: "Must not run during retry",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "executed" }], details: undefined };
			},
		};
		const created = await createHarness({ tools: [tool], settings: { retry: { enabled: false } } });
		harnesses.push(created);
		setBranch(created, [
			userMessage("attempt side effect"),
			fauxAssistantMessage([fauxToolCall("side_effect", {}, { id: "call-unknown" })], { stopReason: "toolUse" }),
		]);
		let synthetic: ToolResultMessage | undefined;
		created.setResponses([
			(context) => {
				synthetic = providerMessages(context).find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolCallId === "call-unknown",
				);
				return fauxAssistantMessage("AI chose the next action");
			},
		]);

		await created.session.retry();

		expect(executions).toBe(0);
		expect(synthetic?.isError).toBe(true);
		expect(synthetic?.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")).toMatch(
			SYNTHETIC_RESULT_PATTERN,
		);
	});

	it("preserves matched results and synthesizes only missing tool-call IDs", async () => {
		const created = await harness();
		setBranch(created, [
			userMessage("two calls"),
			fauxAssistantMessage(
				[
					fauxToolCall("first", {}, { id: "call-1" }),
					fauxToolCall("second", {}, { id: "call-2" }),
				],
				{ stopReason: "toolUse" },
			),
			toolResult("call-1", "first", "kept"),
		]);
		let results: ToolResultMessage[] = [];
		created.setResponses([
			(context) => {
				results = providerMessages(context).filter(
					(message): message is ToolResultMessage => message.role === "toolResult",
				);
				return fauxAssistantMessage("continued");
			},
		]);

		await created.session.retry();

		expect(results.map((result) => result.toolCallId)).toEqual(["call-1", "call-2"]);
		expect(results[0]).toMatchObject({ toolCallId: "call-1", isError: false });
		expect(results[1]).toMatchObject({ toolCallId: "call-2", isError: true });
	});

	it("continues from a /tree-selected tool protocol node", async () => {
		const created = await harness();
		const [, toolCallId] = setBranch(created, [
			userMessage("tree protocol"),
			fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "tree-call" })], { stopReason: "toolUse" }),
			toolResult("tree-call", "lookup", "tree result"),
		]);
		const resultId = created.sessionManager.getLeafId()!;
		await created.session.navigateTree(toolCallId!);
		created.setResponses([fauxAssistantMessage("from call node")]);
		await created.session.retry();
		expect(getAssistantTexts(created).at(-1)).toBe("from call node");

		await created.session.navigateTree(resultId);
		created.setResponses([fauxAssistantMessage("from result node")]);
		await created.session.retry();
		expect(getAssistantTexts(created).at(-1)).toBe("from result node");
	});

	it("reuses a /tree-selected original user entry without persisting a duplicate", async () => {
		const created = await harness();
		const [originalUserId] = setBranch(created, [userMessage("reuse me"), fauxAssistantMessage("old answer")]);
		await created.session.navigateTree(originalUserId!);
		created.setResponses([fauxAssistantMessage("regenerated")]);

		await created.session.retry();

		expect(getUserTexts(created)).toEqual(["reuse me"]);
		expect(created.sessionManager.getBranch().map((entry) => entry.id)).toEqual([
			originalUserId,
			created.sessionManager.getLeafId(),
		]);
	});

	it("survives JSONL reopen with both the failed side branch and new active branch", async () => {
		const created = await harness();
		const persisted = SessionManager.create(created.tempDir, created.tempDir, { id: "manual-retry-persisted" });
		const userId = persisted.appendMessage(userMessage("persist me"));
		const failureId = persisted.appendMessage(
			fauxAssistantMessage("old failure", { stopReason: "error", errorMessage: "failed" }),
		);
		created.sessionManager = persisted;
		created.session.sessionManager = persisted;
		created.session.agent.state.messages = persisted.buildSessionContext().messages;
		created.setResponses([fauxAssistantMessage("new success")]);

		await created.session.retry();

		const newLeafId = persisted.getLeafId();
		const file = persisted.getSessionFile();
		expect(file).toBeDefined();
		const reopened = SessionManager.open(file!, created.tempDir);
		expect(reopened.getLeafId()).toBe(newLeafId);
		expect(reopened.getEntry(failureId)).toMatchObject({ parentId: userId, message: { stopReason: "error" } });
		expect(reopened.getEntry(newLeafId!)).toMatchObject({ parentId: userId, message: { stopReason: "stop" } });
		expect(reopened.getChildren(userId).map((entry) => entry.id)).toEqual(
			expect.arrayContaining([failureId, newLeafId]),
		);
	});

	it.each([
		{
			name: "orphan tool result",
			messages: [userMessage("bad"), toolResult("orphan", "missing", "bad")],
		},
		{
			name: "malformed tool call",
			messages: [
				userMessage("bad"),
				fauxAssistantMessage([fauxToolCall("broken", {}, { id: "" })], { stopReason: "toolUse" }),
			],
		},
	])("refuses $name without mutation or provider call", async ({ messages }) => {
		const created = await harness();
		setBranch(created, messages);
		const beforeLeaf = created.sessionManager.getLeafId();
		const beforeEntries = created.sessionManager.getEntries();
		created.setResponses([fauxAssistantMessage("must not run")]);

		await expect(created.session.retry()).rejects.toThrow(/malformed|orphan|no matching assistant/i);

		expect(created.faux.state.callCount).toBe(0);
		expect(created.sessionManager.getLeafId()).toBe(beforeLeaf);
		expect(created.sessionManager.getEntries()).toEqual(beforeEntries);
	});

	it("refuses an ordinary completed assistant with an actionable Nothing to continue error", async () => {
		const created = await harness();
		setBranch(created, [userMessage("done"), fauxAssistantMessage("complete")]);
		created.setResponses([fauxAssistantMessage("must not run")]);

		await expect(created.session.retry()).rejects.toThrow(/Nothing to continue/);
		expect(created.faux.state.callCount).toBe(0);
	});

	it("refuses a concurrent retry without consuming queued work or mutating the tree", async () => {
		const created = await harness();
		setBranch(created, [
			userMessage("retry once"),
			fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "failed" }),
		]);
		let releaseProvider: (() => void) | undefined;
		created.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					releaseProvider = resolve;
				});
				return fauxAssistantMessage("finished");
			},
		]);
		const firstRetry = created.session.retry();
		await expect.poll(() => created.faux.state.callCount).toBe(1);
		await created.session.steer("queued work");
		const entryCount = created.sessionManager.getEntries().length;

		await expect(created.session.retry()).rejects.toThrow(/already processing|retry.*progress/i);
		expect(created.session.pendingMessageCount).toBe(1);
		expect(created.sessionManager.getEntries()).toHaveLength(entryCount);
		releaseProvider?.();
		await firstRetry;
	});
});
