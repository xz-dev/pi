import type { Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { TreePreparation } from "../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

describe("Branch summary extensions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("publishes detached provider-neutral tree preparation while preserving extension replacement", async () => {
		let captured: TreePreparation | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", (event) => {
						captured = structuredClone(event.preparation);
						const message = event.preparation.entriesToSummarize.find((entry) => entry.type === "message");
						if (message?.message.role === "assistant") message.message.content = [];
						return { summary: { summary: "replacement summary" } };
					});
				},
			],
		});
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg("target"));
		const sourceAssistant = assistantMsg("private assistant");
		(sourceAssistant as unknown as Record<string, unknown>).metadata = "assistant-metadata-sentinel";
		harness.sessionManager.appendMessage(sourceAssistant);
		const frontierId = harness.sessionManager.appendMessage(userMsg("checkpoint frontier"));
		harness.sessionManager.appendProviderCheckpoint({
			type: "provider_checkpoint",
			version: 1,
			identity: {
				adapter: "openai-responses-compact-v1",
				realm: "provider-realm-sentinel",
				provider: "provider-name-sentinel",
				endpoint: "https://provider-endpoint-sentinel.invalid/v1",
				modelFamily: "provider-model-sentinel",
			},
			frontierEntryId: frontierId,
			windowGeneration: 1,
			payload: {
				id: "resp_private",
				created_at: 1,
				object: "response.compaction",
				output: [{ type: "compaction", id: "cmp_private", encrypted_content: "checkpoint-payload-sentinel" }],
				usage: {
					input_tokens: 1,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 1,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 2,
				},
			},
		});
		harness.sessionManager.appendMessage(userMsg("after checkpoint"));

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.summaryEntry?.summary).toBe("replacement summary");
		const serialized = JSON.stringify(captured);
		expect(serialized).toContain("private assistant");
		for (const sentinel of [
			"assistant-metadata-sentinel",
			"provider-realm-sentinel",
			"provider-name-sentinel",
			"provider-endpoint-sentinel",
			"provider-model-sentinel",
			"checkpoint-payload-sentinel",
		]) {
			expect(serialized).not.toContain(sentinel);
		}
		expect(sourceAssistant.content).toEqual([{ type: "text", text: "private assistant" }]);
	});

	it("persists extension-provided summary usage in session totals", async () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({
						summary: {
							summary: "Summary provided by extension",
							usage,
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned branch work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		const result = await harness.session.navigateTree(targetId, { summarize: true });
		const summaryEntry = result.summaryEntry;

		expect(summaryEntry?.type).toBe("branch_summary");
		expect(summaryEntry?.fromHook).toBe(true);
		expect(summaryEntry?.summary).toBe("Summary provided by extension");
		expect(summaryEntry?.usage).toEqual(usage);

		const stats = harness.session.getSessionStats();
		expect(stats.tokens).toEqual({ input: 12, output: 22, cacheRead: 30, cacheWrite: 40, total: 104 });
		expect(stats.cost).toBe(1);
	});
});
