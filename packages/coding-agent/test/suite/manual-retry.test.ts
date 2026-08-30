import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
	type ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createManualRetryRecoveryCue } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

const SYNTHETIC_RESULT_PATTERN =
	/no usable result was recorded.*executed or produced side effects is unknown.*not assume it is safe to repeat/is;

function userMessage(text: string): Message {
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

function setBranch(harness: Harness, messages: Message[]): string[] {
	const ids = messages.map((message) => harness.sessionManager.appendMessage(message));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return ids;
}

function providerMessages(context: Context): Message[] {
	return context.messages;
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
		"recovers interrupted assistant %s with an internal cue and preserved partial text",
		async (stopReason) => {
			const created = await harness();
			const requestId = created.sessionManager.appendMessage(userMessage("original request"));
			const failureId = created.sessionManager.appendMessage(
				fauxAssistantMessage("safe partial", {
					stopReason,
					errorMessage: stopReason === "error" ? "boom" : undefined,
				}),
			);
			created.session.agent.state.messages = created.sessionManager.buildSessionContext().messages;
			let requestMessages: Message[] = [];
			created.setResponses([
				(context) => {
					requestMessages = providerMessages(context);
					return fauxAssistantMessage("recovered continuation");
				},
			]);

			await created.session.retry();

			const leaf = created.sessionManager.getLeafEntry();
			expect(leaf).toMatchObject({ type: "message", parentId: requestId, message: { role: "assistant" } });
			expect(getUserTexts(created)).toEqual(["original request"]);
			expect(getAssistantTexts(created)).toEqual(["recovered continuation"]);
			expect(requestMessages.map((message) => message.role)).toEqual(["user", "user"]);
			expect(requestMessages.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "text", text: createManualRetryRecoveryCue("safe partial") }],
			});
			expect(created.sessionManager.getEntries()).toHaveLength(3);
			expect(created.sessionManager.getEntry(failureId)).toMatchObject({
				type: "message",
				parentId: requestId,
				message: { stopReason },
			});
		},
	);

	it("closes an interrupted tool call with an unknown result without replaying it", async () => {
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
			fauxAssistantMessage([fauxToolCall("side_effect", {}, { id: "interrupted-call" })], {
				stopReason: "error",
				errorMessage: "network failed",
			}),
		]);
		let seenRecovery = false;
		created.setResponses([
			(context) => {
				const messages = providerMessages(context);
				seenRecovery =
					messages.some((message) => message.role === "assistant" && message.stopReason === "toolUse") &&
					messages.some(
						(message) =>
							message.role === "toolResult" &&
							message.toolCallId === "interrupted-call" &&
							message.isError === true,
					);
				return fauxAssistantMessage("continued safely");
			},
		]);

		await created.session.retry();

		expect(executions).toBe(0);
		expect(seenRecovery).toBe(true);
		expect(getAssistantTexts(created)).toEqual(["continued safely"]);
		expect(getUserTexts(created)).toEqual(["attempt side effect"]);
	});

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
				[fauxToolCall("first", {}, { id: "call-1" }), fauxToolCall("second", {}, { id: "call-2" })],
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

	it("creates a sibling when retrying an interrupted assistant selected through /tree", async () => {
		const created = await harness();
		const [userId, failureId] = setBranch(created, [
			userMessage("tree retry"),
			fauxAssistantMessage("partial", { stopReason: "aborted" }),
			userMessage("later branch"),
			fauxAssistantMessage("later answer"),
		]);
		await created.session.navigateTree(failureId!);
		created.setResponses([fauxAssistantMessage("recovered sibling")]);

		await created.session.retry();

		const leaf = created.sessionManager.getLeafEntry();
		expect(leaf).toMatchObject({ parentId: userId, message: { role: "assistant" } });
		expect(getAssistantTexts(created)).toEqual(["recovered sibling"]);
		expect(created.sessionManager.getChildren(userId!).map((entry) => entry.id)).toEqual(
			expect.arrayContaining([failureId, leaf?.id]),
		);
	});

	it("preserves an explicit root user selection after retry preflight rejection", async () => {
		const created = await harness();
		const [userId] = setBranch(created, [userMessage("reuse me"), fauxAssistantMessage("old answer")]);
		await created.session.navigateTree(userId!);
		await created.session.followUp("queued work");

		await expect(created.session.retry()).rejects.toThrow(/queued messages/);
		created.session.clearQueue();
		created.setResponses([fauxAssistantMessage("regenerated")]);
		await created.session.retry();

		expect(getUserTexts(created)).toEqual(["reuse me"]);
		expect(getAssistantTexts(created)).toEqual(["regenerated"]);
		expect(created.sessionManager.getBranch().map((entry) => entry.id)).toEqual([
			userId,
			created.sessionManager.getLeafId(),
		]);
	});

	it("keeps a completed tool result when retrying the selected tool-call assistant", async () => {
		const created = await harness();
		const [, assistantId] = setBranch(created, [
			userMessage("tree protocol"),
			fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "tree-call" })], { stopReason: "toolUse" }),
			toolResult("tree-call", "lookup", "tree result"),
		]);
		await created.session.navigateTree(assistantId!);
		let seenResult: ToolResultMessage | undefined;
		created.setResponses([
			(context) => {
				seenResult = providerMessages(context).find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolCallId === "tree-call",
				);
				return fauxAssistantMessage("continued");
			},
		]);

		await created.session.retry();

		expect(seenResult).toMatchObject({
			role: "toolResult",
			toolCallId: "tree-call",
			isError: false,
			content: [{ type: "text", text: "tree result" }],
		});
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
		const created = await createHarness({
			settings: { retry: { enabled: false } },
			sessionManagerFactory: (tempDir) => SessionManager.create(tempDir, tempDir, { id: "manual-retry-persisted" }),
		});
		harnesses.push(created);
		const persisted = created.sessionManager;
		const userId = persisted.appendMessage(userMessage("persist me"));
		const failureId = persisted.appendMessage(
			fauxAssistantMessage("old failure", { stopReason: "error", errorMessage: "failed" }),
		);
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
		expect(reopened.getChildren(userId).map((entry) => entry.id)).toEqual([failureId, newLeafId]);
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

	it.each([
		["stop", /Assistant EOF.*Send a new message/i],
		["length", /Assistant EOF.*length-continuation command/i],
	] as const)("refuses deliberate assistant %s with novice-facing guidance", async (stopReason, message) => {
		const created = await harness();
		setBranch(created, [userMessage("done"), fauxAssistantMessage("complete", { stopReason })]);
		created.setResponses([fauxAssistantMessage("must not run")]);

		await expect(created.session.retry()).rejects.toThrow(message);
		expect(created.faux.state.callCount).toBe(0);
	});

	it("ignores trailing plugin output without persisting the internal recovery cue", async () => {
		const created = await createHarness({
			settings: { retry: { enabled: false } },
			sessionManagerFactory: (tempDir) =>
				SessionManager.create(tempDir, tempDir, { id: "manual-retry-trailing-plugin" }),
		});
		harnesses.push(created);
		setBranch(created, [
			userMessage("retry once"),
			fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "network failed" }),
		]);
		created.sessionManager.appendCustomMessageEntry("notice", "trailing plugin output", true);
		created.session.agent.state.messages = created.sessionManager.buildSessionContext().messages;
		created.setResponses([fauxAssistantMessage("continued")]);

		await created.session.retry();

		expect(getAssistantTexts(created)).toEqual(["continued"]);
		expect(getUserTexts(created)).toEqual(["retry once"]);
		const persisted = readFileSync(created.sessionManager.getSessionFile()!, "utf8");
		expect(persisted).not.toContain("manualRetryRecovery");
		expect(persisted).not.toContain("The previous assistant response was interrupted");
	});

	it("rolls back when the provider throws before producing an assistant", async () => {
		const created = await harness();
		setBranch(created, [
			userMessage("retry once"),
			fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "failed" }),
		]);
		const beforeLeaf = created.sessionManager.getLeafId();
		const beforeEntries = structuredClone(created.sessionManager.getEntries());
		const beforeMessages = created.session.agent.state.messages;
		created.session.agent.streamFunction = async () => {
			throw new Error("provider failed before assistant");
		};

		await expect(created.session.retry()).rejects.toThrow(/provider failed before assistant/);

		expect(created.sessionManager.getLeafId()).toBe(beforeLeaf);
		expect(created.sessionManager.getEntries()).toEqual(beforeEntries);
		expect(created.session.agent.state.messages).toEqual(beforeMessages);
	});

	it("rolls back when aborted before the first retry assistant", async () => {
		const created = await harness();
		setBranch(created, [
			userMessage("retry once"),
			fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "failed" }),
		]);
		const beforeLeaf = created.sessionManager.getLeafId();
		const beforeEntries = structuredClone(created.sessionManager.getEntries());
		const beforeMessages = structuredClone(created.session.agent.state.messages);
		const file = created.sessionManager.getSessionFile();
		const beforeFile = file ? readFileSync(file) : undefined;
		let providerStarted = () => {};
		let releaseProvider = () => {};
		const providerStart = new Promise<void>((resolve) => {
			providerStarted = resolve;
		});
		const providerRelease = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		created.session.agent.streamFunction = async () => {
			providerStarted();
			await providerRelease;
			throw new Error("provider failed after abort");
		};

		const retryPromise = created.session.retry();
		await providerStart;
		const rejection = expect(retryPromise).rejects.toThrow(/abort/i);
		const abortPromise = created.session.abort();
		releaseProvider();
		await Promise.all([abortPromise, rejection]);

		expect(created.sessionManager.getLeafId()).toBe(beforeLeaf);
		expect(created.sessionManager.getEntries()).toEqual(beforeEntries);
		expect(created.session.agent.state.messages).toEqual(beforeMessages);
		if (file && beforeFile) expect(readFileSync(file)).toEqual(beforeFile);
	});

	it("rejects a stale continuation after branch-away and branch-back mutation", async () => {
		const created = await harness();
		const [userId] = setBranch(created, [
			userMessage("retry once"),
			fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "failed" }),
		]);
		const originalLeaf = created.sessionManager.getLeafId()!;
		created.setResponses([
			async () => {
				created.sessionManager.branch(userId!);
				created.sessionManager.branch(originalLeaf);
				return fauxAssistantMessage("stale");
			},
		]);

		await expect(created.session.retry()).rejects.toThrow(/Session changed/);
		expect(created.sessionManager.getLeafId()).toBe(originalLeaf);
		expect(getAssistantTexts(created)).toEqual(["failed"]);
	});

	it("prevents first-assistant tool execution when publication fails", async () => {
		let executions = 0;
		const tool: AgentTool = {
			name: "side_effect",
			label: "Side effect",
			description: "Must not run before retry publication",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "executed" }], details: undefined };
			},
		};
		const created = await createHarness({
			tools: [tool],
			initialActiveToolNames: ["side_effect"],
			settings: { retry: { enabled: false } },
			sessionManagerFactory: (tempDir) =>
				SessionManager.create(tempDir, tempDir, { id: "manual-retry-tool-publication-failure" }),
		});
		harnesses.push(created);
		setBranch(created, [
			userMessage("retry once"),
			fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "failed" }),
		]);
		const beforeLeaf = created.sessionManager.getLeafId();
		const beforeEntries = structuredClone(created.sessionManager.getEntries());
		created.sessionManager.continuationFileWriter = () => {
			throw new Error("injected publication failure");
		};
		created.setResponses([
			fauxAssistantMessage([fauxToolCall("side_effect", {}, { id: "new-call" })], { stopReason: "toolUse" }),
		]);
		expect(created.sessionManager.continuationFileWriter).toBeTypeOf("function");
		expect(created.session.agent.state.tools.map((activeTool) => activeTool.name)).toContain("side_effect");
		await expect(created.session.retry()).rejects.toThrow(/injected publication failure/);

		expect(executions).toBe(0);
		expect(created.sessionManager.getLeafId()).toBe(beforeLeaf);
		expect(created.sessionManager.getEntries()).toEqual(beforeEntries);
	});

	it("leaves durable and in-memory state unchanged when atomic publication fails", async () => {
		const created = await createHarness({
			settings: { retry: { enabled: false } },
			sessionManagerFactory: (tempDir) =>
				SessionManager.create(tempDir, tempDir, { id: "manual-retry-atomic-failure" }),
		});
		harnesses.push(created);
		const userId = created.sessionManager.appendMessage(userMessage("persist me"));
		const failureId = created.sessionManager.appendMessage(
			fauxAssistantMessage("old failure", { stopReason: "error", errorMessage: "failed" }),
		);
		created.session.agent.state.messages = created.sessionManager.buildSessionContext().messages;
		const file = created.sessionManager.getSessionFile()!;
		const beforeFile = readFileSync(file);
		const beforeEntries = structuredClone(created.sessionManager.getEntries());
		const beforeGeneration = created.sessionManager.getGeneration();
		created.sessionManager.continuationFileWriter = () => {
			throw new Error("injected publication failure");
		};
		created.setResponses([fauxAssistantMessage("must not publish")]);

		await expect(created.session.retry()).rejects.toThrow(/injected publication failure/);

		expect(readFileSync(file)).toEqual(beforeFile);
		expect(created.sessionManager.getEntries()).toEqual(beforeEntries);
		expect(created.sessionManager.getGeneration()).toBe(beforeGeneration);
		expect(created.sessionManager.getLeafId()).toBe(failureId);
		const reopened = SessionManager.open(file, created.tempDir);
		expect(reopened.getLeafId()).toBe(failureId);
		expect(reopened.getChildren(userId).map((entry) => entry.id)).toEqual([failureId]);
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
