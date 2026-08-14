import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("session tree splice", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("rebuilds live agent context after splicing a mid-path entry", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const id1 = harness.sessionManager.appendMessage(userMsg("one"));
		const id2 = harness.sessionManager.appendMessage(assistantMsg("two"));
		harness.sessionManager.appendMessage(userMsg("three"));
		harness.sessionManager.appendMessage(assistantMsg("four"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		harness.session.spliceEntry(id2);

		expect(harness.sessionManager.getEntry(id2)).toBeUndefined();
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
		expect(harness.sessionManager.getLeafId()).not.toBe(id2);
		expect(harness.eventsOfType("session_entry_spliced")).toEqual([
			{
				type: "session_entry_spliced",
				entryId: id2,
				parentId: id1,
				newLeafId: harness.sessionManager.getLeafId(),
			},
		]);
	});

	it("exposes spliceEntry on ExtensionAPI and keeps ReadonlySessionManager read-only", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);

		const id1 = harness.sessionManager.appendMessage(userMsg("one"));
		const id2 = harness.sessionManager.appendMessage(assistantMsg("two"));
		harness.sessionManager.appendMessage(userMsg("three"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		expect(api).toBeDefined();
		expect(typeof api?.spliceEntry).toBe("function");
		api?.spliceEntry(id2);

		expect(harness.sessionManager.getEntry(id2)).toBeUndefined();
		expect(harness.sessionManager.getEntries()[1]?.parentId).toBe(id1);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "user"]);
	});

	it("rejects splice while a response is active", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		let spliceResult: unknown;
		let leafUnchanged = false;

		harness.setResponses([
			async () => {
				const activeLeafId = harness.sessionManager.getLeafId();
				spliceResult = (() => {
					try {
						harness.session.spliceEntry(targetId);
						return undefined;
					} catch (error) {
						return error;
					}
				})();
				leafUnchanged = harness.sessionManager.getLeafId() === activeLeafId;
				return fauxAssistantMessage("response");
			},
		]);
		await harness.session.prompt("second");

		expect(spliceResult).toEqual(
			new Error("Wait for the current response to finish before splicing a session entry."),
		);
		expect(leafUnchanged).toBe(true);
		expect(harness.sessionManager.getEntry(targetId)).toBeDefined();
	});

	it("splices the persisted assistant from agent_settled before public settlement", async () => {
		let settledCalls = 0;
		let targetId: string | undefined;
		let sawPersistedTarget = false;
		const harness = await createHarness({
			persist: true,
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", (_event, ctx) => {
						settledCalls += 1;
						const assistant = ctx.sessionManager
							.getEntries()
							.slice()
							.reverse()
							.find((entry) => entry.type === "message" && entry.message.role === "assistant");
						expect(assistant).toBeDefined();
						targetId = assistant?.id;
						sawPersistedTarget = targetId !== undefined && ctx.sessionManager.getEntry(targetId) !== undefined;
						const beforeCount = ctx.sessionManager.getEntries().length;
						const parentId = assistant?.parentId;
						pi.spliceEntry(targetId!);
						expect(ctx.sessionManager.getEntry(targetId!)).toBeUndefined();
						expect(ctx.sessionManager.getEntries()).toHaveLength(beforeCount - 1);
						expect(ctx.sessionManager.getLeafId()).toBe(parentId);
					});
				},
			],
		});
		harnesses.push(harness);

		const publicOrder: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "session_entry_spliced" || event.type === "agent_settled") {
				publicOrder.push(event.type);
			}
		});
		harness.setResponses([fauxAssistantMessage("hidden")]);
		await harness.session.prompt("keep");

		expect(settledCalls).toBe(1);
		expect(sawPersistedTarget).toBe(true);
		expect(targetId).toBeDefined();
		expect(harness.sessionManager.getEntry(targetId!)).toBeUndefined();
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user"]);
		expect(publicOrder).toEqual(["session_entry_spliced", "agent_settled"]);
		expect(harness.eventsOfType("session_entry_spliced")).toHaveLength(1);

		const file = harness.sessionManager.getSessionFile();
		expect(file).toBeDefined();
		const reopened = SessionManager.open(file!, harness.tempDir);
		expect(reopened.getEntry(targetId!)).toBeUndefined();
		const reopenedEntries = reopened.getEntries();
		expect(reopenedEntries.filter((entry) => entry.type === "message").map((entry) => entry.message.role)).toEqual([
			"user",
		]);
		expect(reopened.getLeafId()).toBe(reopenedEntries.at(-1)?.id);
	});
});
