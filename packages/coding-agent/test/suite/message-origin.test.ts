import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type MessageOrigin } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	InputEvent,
	MessageEndEvent,
	MessageEndEventResult,
} from "../../src/core/extensions/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("message origin", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("distinguishes identical interactive and extension inputs in events, restored history and model context", async () => {
		const apis: ExtensionAPI[] = [];
		const inputs: InputEvent[] = [];
		const delivered: AgentMessage[] = [];
		const requests: string[][] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					apis.push(pi);
					pi.on("input", (event) => {
						inputs.push(event);
					});
					pi.on("message_end", (event) => {
						if (event.message.role === "user") delivered.push(event.message);
					});
				},
				(pi) => {
					apis.push(pi);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses(
			Array.from({ length: 3 }, () => (context) => {
				requests.push(context.messages.filter((m) => m.role === "user").map(getMessageText));
				return fauxAssistantMessage("ok");
			}),
		);
		await harness.session.prompt("continue", { source: "interactive" });
		for (const api of apis) {
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "agent_settled") {
						unsubscribe();
						resolve();
					}
				});
			});
			api.sendUserMessage("continue");
			await settled;
		}
		const origins = inputs.map((event) => event.origin);
		expect(origins[0]).toEqual({ type: "interactive" });
		expect(origins.slice(1).map((origin) => origin?.type)).toEqual(["extension", "extension"]);
		expect(origins[1]).not.toEqual(origins[2]);
		expect(delivered.map((m) => (m.role === "user" ? m.origin : undefined))).toEqual(origins);
		expect(delivered.map(getMessageText)).toEqual(["continue", "continue", "continue"]);

		const file = harness.session.exportToJsonl(`${harness.tempDir}/origin.jsonl`);
		const restored = SessionManager.open(file)
			.buildSessionContext()
			.messages.filter((m) => m.role === "user");
		expect(restored.map((m) => m.origin)).toEqual(origins);
		expect(requests[2][0]).toBe("continue");
		expect(requests[2][1]).toContain("extension");
		expect(requests[2][1]).not.toBe(requests[2][2]);
		expect(convertToLlm(restored).map(getMessageText)).toEqual(requests[2]);
		expect(restored.map(getMessageText)).toEqual(["continue", "continue", "continue"]);
	});

	// Regression for #9886: editing terminal drafts must not clear extension/custom queues.
	it("retrieves only interactive drafts and delivers identical plugin inputs and custom notices with provenance", async () => {
		let api: ExtensionAPI | undefined;
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
			tools: [
				{
					name: "wait",
					label: "wait",
					description: "wait",
					parameters: Type.Object({}),
					execute: async () => {
						started();
						await gate;
						return { content: [], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 6 }, () => fauxAssistantMessage("ok")),
		]);
		const run = harness.session.prompt("start", { source: "interactive" });
		await ready;
		try {
			await harness.session.steer("continue", undefined, { source: "interactive" });
			api!.sendUserMessage("continue", { deliverAs: "steer" });
			api!.sendUserMessage("continue", { deliverAs: "followUp" });
			api!.sendMessage({ customType: "notice", content: "notice", display: false }, { deliverAs: "followUp" });
			// Input hooks are asynchronous; wait for both API calls to reach the queues.
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			expect(harness.session.getQueuedInputs().steering.map((m) => m.origin?.type)).toEqual([
				"interactive",
				"extension",
			]);
			expect(harness.session.takeInteractiveDrafts()).toEqual({ steering: ["continue"], followUp: [] });
			expect(harness.session.getQueuedInputs().steering[0].origin?.type).toBe("extension");
		} finally {
			release();
			await run;
		}
		const delivered = harness.session.messages.filter((m) => m.role === "user" && getMessageText(m) === "continue");
		expect(delivered).toHaveLength(2);
		expect(delivered.every((m) => m.role === "user" && m.origin?.type === "extension")).toBe(true);
		const notice = harness.session.messages.find((m) => m.role === "custom");
		expect(notice).toMatchObject({ role: "custom", origin: { type: "extension" }, display: false });
		expect(harness.session.getQueuedInputs()).toEqual({ steering: [], followUp: [] });
	});

	it("attributes hook-produced custom context and keeps source through content replacement and context edits", async () => {
		const harness = await createHarness({
			extensionFactories: [
				{
					name: "hook-author",
					factory: (pi) => {
						pi.on("before_agent_start", () => ({
							message: { customType: "context", content: "hidden", display: false },
						}));
						pi.on("turn_end", (event) => ({
							entries: [
								...event.entries,
								{ type: "custom_message", customType: "boundary", content: "note", display: false },
							],
						}));
						pi.on("message_end", (event) => {
							if (event.message.role === "user")
								return {
									message: { role: "user", content: "replacement", timestamp: event.message.timestamp },
								};
						});
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("original", { source: "rpc" });
		const user = harness.session.messages.find((m) => m.role === "user");
		expect(user).toMatchObject({ origin: { type: "rpc" }, content: "replacement" });
		const entries = harness.sessionManager.getBranch().filter((e) => e.type === "custom_message");
		expect(entries).toHaveLength(2);
		expect(
			entries.every((e) => e.origin?.type === "extension" && e.origin.extensionName === "inline:hook-author"),
		).toBe(true);
		harness.sessionManager.appendContextEdit(entries[0].id, { content: "edited" });
		const projected = harness.sessionManager.buildSessionContext().messages.find((m) => m.role === "custom");
		expect(projected).toMatchObject({ content: "edited", origin: entries[0].origin });
	});

	it.each([
		{ uninterruptible: false, role: "user" as const },
		{ uninterruptible: true, role: "user" as const },
		{ uninterruptible: false, role: "custom" as const },
		{ uninterruptible: true, role: "custom" as const },
	])(
		"retains $role origin through replacement (uninterruptible=$uninterruptible)",
		async ({ uninterruptible, role }) => {
			let sender: ExtensionAPI | undefined;
			const observed: Array<MessageOrigin | undefined> = [];
			let modelText = "";
			const harness = await createHarness({
				extensionFactories: [
					{
						name: "sender",
						factory: (pi) => {
							sender = pi;
						},
					},
					{
						name: "redactor",
						factory: (pi) => {
							const replace = (event: MessageEndEvent): MessageEndEventResult | undefined => {
								if (event.message.role !== role) return;
								return {
									message:
										event.message.role === "user"
											? { role: "user", content: "redacted", timestamp: event.message.timestamp }
											: {
													role: "custom",
													customType: "notice",
													display: false,
													content: "redacted",
													timestamp: event.message.timestamp,
												},
								};
							};
							const observe = (event: MessageEndEvent): undefined => {
								if (event.message.role === role) observed.push(event.message.origin);
							};
							if (uninterruptible) {
								pi.on("message_end", replace, { uninterruptible: true });
								pi.on("message_end", observe, { uninterruptible: true });
							} else {
								pi.on("message_end", replace);
								pi.on("message_end", observe);
							}
						},
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				(context) => {
					modelText = context.messages
						.filter((entry) => entry.role === "user")
						.map(getMessageText)
						.join("\n");
					return fauxAssistantMessage("ok");
				},
			]);
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "agent_settled") {
						unsubscribe();
						resolve();
					}
				});
			});
			if (role === "user") sender!.sendUserMessage("original");
			else sender!.sendMessage({ customType: "notice", display: false, content: "original" }, { triggerTurn: true });
			await settled;
			const restored = SessionManager.open(harness.session.exportToJsonl(`${harness.tempDir}/replaced.jsonl`))
				.buildSessionContext()
				.messages.find((entry) => entry.role === role);
			const origin = { type: "extension", extensionName: "inline:sender", extensionId: expect.any(String) };
			expect(restored).toMatchObject({ origin, content: "redacted" });
			expect(observed).toEqual([origin]);
			expect(
				harness.eventsOfType("message_end").find((event) => event.message.role === role)?.message,
			).toMatchObject({ origin });
			expect(modelText).toContain('extension "inline:sender"');
			expect(modelText).toContain("not direct human input or new authorization");
			expect(modelText).toContain("redacted");
		},
	);

	it("keeps empty control content empty and preserves image-only input without mutating it", () => {
		const origin: MessageOrigin = { type: "extension", extensionId: "ext-a", extensionName: "A" };
		const messages: AgentMessage[] = [
			{ role: "custom", customType: "fold", content: "", display: false, origin, timestamp: 1 },
			{ role: "user", content: [{ type: "image", data: "image", mimeType: "image/png" }], origin, timestamp: 2 },
			{ role: "user", content: "legacy", timestamp: 3 },
		];
		const snapshot = structuredClone(messages);
		const first = convertToLlm(messages);
		expect(getMessageText(first[0])).toBe("");
		expect(first[1].content).toContainEqual({ type: "image", data: "image", mimeType: "image/png" });
		expect(getMessageText(first[1])).toContain("extension");
		expect(getMessageText(first[2])).toBe("legacy");
		expect(convertToLlm(messages)).toEqual(first);
		expect(convertToLlm(first)).toEqual(first);
		expect(messages).toEqual(snapshot);
	});
});
