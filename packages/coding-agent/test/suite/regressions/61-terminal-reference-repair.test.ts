import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("#61 terminal reference repair reaches AgentSession retry admission", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	it("settles once with partial error retained, then retries an unrelated later transient", async () => {
		harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 }, compaction: { enabled: false } },
		});
		const model = harness.getModel();
		let calls = 0;
		harness.session.agent.streamFunction = () => {
			calls++;
			const message: AssistantMessage = {
				...fauxAssistantMessage(calls === 1 ? "partial repair" : calls === 2 ? "" : "later success", {
					stopReason: calls <= 2 ? "error" : "stop",
					...(calls <= 2 ? { errorMessage: "server_error: fixture failure" } : {}),
				}),
				api: "openai-responses",
				provider: model.provider,
				model: model.id,
				...(calls === 1 ? { diagnostics: [{ type: "provider_reference_repair_terminal", timestamp: 1 }] } : {}),
			};
			const response = createAssistantMessageEventStream();
			queueMicrotask(() => {
				response.push({ type: "start", partial: message });
				if (message.stopReason === "error") response.push({ type: "error", reason: "error", error: message });
				else response.push({ type: "done", reason: "stop", message });
			});
			return response;
		};

		await harness.session.prompt("One logical request whose accepted repair failed");

		expect(calls).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		const failed = harness.sessionManager.getBranch().findLast((entry) => entry.type === "message");
		expect(failed).toMatchObject({
			type: "message",
			message: {
				stopReason: "error",
				errorMessage: "server_error: fixture failure",
				content: [{ type: "text", text: "partial repair" }],
				diagnostics: [{ type: "provider_reference_repair_terminal", timestamp: 1 }],
			},
		});

		await harness.session.prompt("Separate later prompt");

		expect(calls).toBe(3);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "later success" }],
		});
		expect(harness.sessionManager.getBranch()).toContain(failed);
	});
});
