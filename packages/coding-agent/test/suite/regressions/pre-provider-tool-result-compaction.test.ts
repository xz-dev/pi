import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

describe("pre-provider tool-result compaction", () => {
	it("compacts a large tool result before the next provider request in the same run", async () => {
		let toolRuns = 0;
		const largeResult = `tool-result-marker:${"x".repeat(40_000)}`;
		const tool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Return a result large enough to require compaction",
			parameters: Type.Object({}),
			execute: async () => {
				toolRuns++;
				return { content: [{ type: "text", text: largeResult }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [tool],
			models: [{ id: "faux-1", contextWindow: 12_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, reserveTokens: 11_000, keepRecentTokens: 10_006 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "compacted-before-follow-up",
							firstKeptEntryId: event.branchEntries.at(-1)!.id,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});

		try {
			const providerContexts: string[] = [];
			harness.setResponses([
				(context) => {
					providerContexts.push(JSON.stringify(context));
					return fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerContexts.push(JSON.stringify(context));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");

			expect(toolRuns).toBe(1);
			expect(harness.faux.state.callCount).toBe(2);
			expect(providerContexts).toHaveLength(2);
			expect(providerContexts[1]).toContain("compacted-before-follow-up");
			expect(
				JSON.parse(providerContexts[1]!).messages.find((message: { role: string }) => message.role === "user")
					.content[0].text,
			).not.toContain("tool-result-marker");
			expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "threshold")).toHaveLength(
				1,
			);
			expect(harness.eventsOfType("compaction_end").filter((event) => event.reason === "threshold")).toEqual([
				expect.objectContaining({ reason: "threshold", aborted: false, willRetry: false }),
			]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(harness.session.getLastAssistantText()).toBe("done");
		} finally {
			harness.cleanup();
		}
	});
});
