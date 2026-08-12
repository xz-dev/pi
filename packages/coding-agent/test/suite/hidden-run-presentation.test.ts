import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall, type StopReason } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { Extension } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function assistantMessages(harness: Harness) {
	return harness.session.messages.filter((message) => message.role === "assistant");
}

function createEchoTool(onExecute: (text: string) => void): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			onExecute(text);
			return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
		},
	};
}

const privateResponse = [fauxThinking("private reasoning"), fauxToolCall("echo", { text: "private result" })];

describe("hidden run presentation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("hides assistant and tool presentation while preserving extension lifecycle and persisted metadata", async () => {
		const extensionEvents: string[] = [];
		const toolExecutions: string[] = [];
		const followUpToolResults: string[] = [];
		const harness = await createHarness({
			tools: [createEchoTool((text) => toolExecutions.push(text))],
			extensionFactories: [() => {}],
		});
		harnesses.push(harness);
		const [extension] = (harness.session.extensionRunner as unknown as { extensions: Extension[] }).extensions;
		if (!extension) throw new Error("missing test extension");
		for (const type of [
			"message_start",
			"message_update",
			"message_end",
			"agent_end",
			"agent_settled",
			"tool_execution_start",
			"tool_execution_end",
		]) {
			extension.handlers.set(type, [async () => extensionEvents.push(type)]);
		}
		harness.setResponses([
			fauxAssistantMessage(privateResponse, { stopReason: "toolUse" }),
			(context) => {
				followUpToolResults.push(
					...context.messages.flatMap((message) =>
						message.role === "toolResult"
							? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
							: [],
					),
				);
				return fauxAssistantMessage("private decision");
			},
		]);

		await harness.session.sendCustomMessage(
			{ customType: "internal", content: "decide", display: false },
			{ triggerTurn: true, presentation: "hidden" },
		);

		const publicRunEvents = harness.events.filter((event) => event.type !== "agent_settled");
		expect(publicRunEvents.map((event) => event.type)).toEqual(["agent_start", "agent_end"]);
		const publicAgentEnd = publicRunEvents[1];
		expect(publicAgentEnd?.type).toBe("agent_end");
		if (publicAgentEnd?.type === "agent_end") {
			expect(publicAgentEnd.messages.filter((message) => message.role === "custom")).toEqual([
				expect.objectContaining({ content: [] }),
			]);
			expect(publicAgentEnd.messages.filter((message) => message.role === "assistant")).toEqual([
				expect.objectContaining({ content: [], stopReason: "toolUse" }),
				expect.objectContaining({ content: [], stopReason: "stop" }),
			]);
			expect(publicAgentEnd.messages.filter((message) => message.role === "toolResult")).toEqual([
				expect.objectContaining({ content: [], details: undefined }),
			]);
			expect(JSON.stringify(publicAgentEnd)).not.toContain("private result");
			expect(JSON.stringify(publicAgentEnd)).not.toContain("decide");
		}
		expect(extensionEvents).toContain("message_update");
		expect(extensionEvents).toContain("tool_execution_start");
		expect(extensionEvents).toContain("tool_execution_end");
		expect(extensionEvents.at(-1)).toBe("agent_settled");
		expect(toolExecutions).toEqual(["private result"]);
		expect(followUpToolResults).toEqual(["echo:private result"]);

		const assistants = assistantMessages(harness);
		expect(assistants).toHaveLength(2);
		expect(assistants[0]?.content).toEqual(privateResponse);
		expect(assistants[1]?.content).toEqual([{ type: "text", text: "private decision" }]);
		expect(assistants.map((message) => message.stopReason)).toEqual(["toolUse", "stop"]);
		expect(assistants.every((message) => message.usage.totalTokens > 0)).toBe(true);
		const liveToolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(liveToolResult?.content).toEqual([{ type: "text", text: "echo:private result" }]);
		expect(liveToolResult?.details).toEqual({ text: "private result" });

		const persistedEntries = harness.sessionManager.getEntries();
		const persistedCustom = persistedEntries.find((entry) => entry.type === "custom_message");
		expect(persistedCustom?.type).toBe("custom_message");
		if (persistedCustom?.type === "custom_message") {
			expect(persistedCustom.content).toBe("decide");
		}
		const persistedMessages = persistedEntries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(
			persistedMessages
				.filter((message) => message.role === "assistant" || message.role === "toolResult")
				.map((message) => message.content),
		).toEqual([[], [], []]);
		expect(persistedMessages.find((message) => message.role === "toolResult")?.details).toBeUndefined();
		expect(JSON.stringify(persistedMessages)).not.toContain("private result");
		expect(
			persistedMessages.filter((message) => message.role === "assistant").map((message) => message.stopReason),
		).toEqual(["toolUse", "stop"]);
	});

	it.each(["stop", "error", "aborted"] satisfies StopReason[])(
		"retains %s metadata while redacting persisted assistant content",
		async (stopReason) => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage(`private ${stopReason}`, {
					stopReason,
					...(stopReason === "error" ? { errorMessage: "private error" } : {}),
				}),
			]);

			await harness.session.sendCustomMessage(
				{ customType: "internal", content: "decide", display: false },
				{ triggerTurn: true, presentation: "hidden" },
			);

			const assistant = assistantMessages(harness).at(-1);
			expect(assistant?.content).toEqual([{ type: "text", text: `private ${stopReason}` }]);
			expect(assistant?.stopReason).toBe(stopReason);
			expect(assistant?.usage).toBeDefined();
			const persisted = harness.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []))
				.at(-1);
			expect(persisted?.content).toEqual([]);
			expect(persisted?.stopReason).toBe(stopReason);
			expect(persisted?.usage).toBeDefined();
			if (stopReason === "error") {
				expect(persisted?.errorMessage).toBeUndefined();
				const publicAgentEnd = harness.events.find((event) => event.type === "agent_end");
				expect(JSON.stringify(publicAgentEnd)).not.toContain("private error");
			}
		},
	);

	it("hides a partial aborted assistant without changing its aborted outcome", async () => {
		let resolveFirstPrivateUpdate = () => {};
		const firstPrivateUpdate = new Promise<void>((resolve) => {
			resolveFirstPrivateUpdate = resolve;
		});
		let sawPrivateUpdate = false;
		const harness = await createHarness({
			fauxProviderOptions: { tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_update", () => {
						if (sawPrivateUpdate) return;
						sawPrivateUpdate = true;
						resolveFirstPrivateUpdate();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("private partial output ".repeat(200))]);

		const promptPromise = harness.session.sendCustomMessage(
			{ customType: "internal", content: "decide", display: false },
			{ triggerTurn: true, presentation: "hidden" },
		);
		await firstPrivateUpdate;
		await harness.session.abort();
		await promptPromise;

		expect(harness.events.some((event) => event.type === "message_update")).toBe(false);
		const assistant = assistantMessages(harness).at(-1);
		expect(assistant?.content).not.toEqual([]);
		expect(assistant?.stopReason).toBe("aborted");
		const persisted = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
			.at(-1);
		expect(persisted?.type).toBe("message");
		if (persisted?.type === "message" && persisted.message.role === "assistant") {
			expect(persisted.message.content).toEqual([]);
			expect(persisted.message.stopReason).toBe("aborted");
		}
	});

	it("keeps hidden presentation active through automatic retry", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("private failure", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("private recovery"),
		]);

		await harness.session.sendCustomMessage(
			{ customType: "internal", content: "decide", display: false },
			{ triggerTurn: true, presentation: "hidden" },
		);

		expect(harness.events.map((event) => event.type)).toEqual([
			"agent_start",
			"agent_end",
			"agent_start",
			"agent_end",
		]);
		expect(assistantMessages(harness).map((message) => message.content)).toEqual([
			[{ type: "text", text: "private recovery" }],
		]);
		expect(assistantMessages(harness).map((message) => message.stopReason)).toEqual(["stop"]);
		const persistedAssistants = harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		expect(persistedAssistants.map((message) => message.content)).toEqual([[], []]);
		expect(persistedAssistants.map((message) => message.stopReason)).toEqual(["error", "stop"]);
	});

	it("restores visible presentation when hidden settlement cleanup throws", async () => {
		const harness = await createHarness({ extensionFactories: [() => {}] });
		harnesses.push(harness);
		const [extension] = (harness.session.extensionRunner as unknown as { extensions: Extension[] }).extensions;
		if (!extension) throw new Error("missing test extension");
		extension.handlers.set("agent_settled", [async () => Promise.reject(new Error("settlement failed"))]);
		harness.setResponses([fauxAssistantMessage("private decision"), fauxAssistantMessage("visible recovery")]);

		await harness.session.sendCustomMessage(
			{ customType: "internal", content: "decide", display: false },
			{ triggerTurn: true, presentation: "hidden" },
		);
		await harness.session.prompt("normal");

		expect(harness.events.some((event) => event.type === "message_update")).toBe(true);
		const lastAssistant = assistantMessages(harness).at(-1);
		expect(lastAssistant?.content).toEqual([{ type: "text", text: "visible recovery" }]);
	});

	it("rejects hidden presentation outside an immediate idle trigger", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await expect(
			harness.session.sendCustomMessage(
				{ customType: "internal", content: "later", display: false },
				{ deliverAs: "nextTurn", presentation: "hidden" },
			),
		).rejects.toThrow("Hidden presentation requires an immediate triggerTurn while the agent is idle.");
		expect(harness.session.messages).toEqual([]);
	});

	it("keeps ordinary runs visible and unchanged", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("visible response")]);

		await harness.session.sendCustomMessage(
			{ customType: "ordinary", content: "respond", display: false },
			{ triggerTurn: true },
		);

		expect(harness.events.some((event) => event.type === "message_update")).toBe(true);
		const assistant = assistantMessages(harness).at(-1);
		expect(assistant?.content).toEqual([{ type: "text", text: "visible response" }]);
		expect(assistant?.stopReason).toBe("stop");
	});
});
