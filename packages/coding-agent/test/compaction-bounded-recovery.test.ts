import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { compactRawHistoryInBounds, estimateTokens } from "../src/core/compaction/compaction.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function usage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: totalTokens + 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const model: Model<"openai-responses"> = {
	id: "bounded-model",
	name: "Bounded model",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1200,
	maxTokens: 300,
};

function seed(markers: string[]) {
	const manager = SessionManager.inMemory();
	for (const [index, marker] of markers.entries()) {
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `${marker}:${"x".repeat(320)}` }],
			timestamp: index * 2,
		});
		manager.appendMessage({
			...fauxAssistantMessage(`assistant-${index}:${"y".repeat(320)}`, { timestamp: index * 2 + 1 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(400),
		});
	}
	return manager;
}

describe("bounded classic recovery", () => {
	it("bounds every summarization request and folds contiguous markers", async () => {
		const markers = ["BOUND_A", "BOUND_B", "BOUND_C", "BOUND_D", "BOUND_E", "BOUND_F"];
		const manager = seed(markers);
		const requestTokens: number[] = [];
		const seen: string[] = [];
		let pass = 0;
		const streamFn = (_model: Model<any>, context: Context) => {
			requestTokens.push(estimateTokens(context.messages[0]!));
			const serialized = JSON.stringify(context);
			for (const marker of markers) if (serialized.includes(marker)) seen.push(marker);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					...fauxAssistantMessage(`summary-pass-${++pass}`),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: usage(100),
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const result = await compactRawHistoryInBounds(
			manager.getBranch(),
			{ enabled: true, reserveTokens: 200, keepRecentTokens: 1 },
			model,
			"key",
			undefined,
			undefined,
			undefined,
			"off",
			streamFn,
		);

		expect(requestTokens.length).toBeGreaterThan(1);
		expect(requestTokens.every((tokens) => tokens <= model.contextWindow - 200)).toBe(true);
		expect(seen).toEqual(markers);
		expect(result.kind).toBe("classic");
		expect(result.firstKeptEntryId).toBeTruthy();
		const projected = manager
			.getBranch()
			.filter((entry) => entry.type !== "compaction")
			.slice(manager.getBranch().findIndex((entry) => entry.id === result.firstKeptEntryId))
			.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const finalContextTokens =
			estimateTokens({
				role: "compactionSummary",
				summary: result.summary,
				tokensBefore: result.tokensBefore,
				timestamp: Date.now(),
				kind: "classic",
			}) + projected.reduce((total, message) => total + estimateTokens(message), 0);
		expect(finalContextTokens).toBeLessThanOrEqual(model.contextWindow - 200);
	});

	it("rejects generated summaries that keep the final projected context oversized", async () => {
		const manager = seed(["FINAL_FIT_A", "FINAL_FIT_B", "FINAL_FIT_C"]);
		let providerCalls = 0;
		const streamFn = (requestModel: Model<any>) => {
			providerCalls++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage(`LARGE_GENERATED_SUMMARY:${"s".repeat(9_000)}`),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
						usage: usage(100),
					},
				});
			});
			return stream;
		};

		await expect(
			compactRawHistoryInBounds(
				manager.getBranch(),
				{ enabled: true, reserveTokens: 200, keepRecentTokens: 1 },
				model,
				"key",
				undefined,
				undefined,
				undefined,
				"off",
				streamFn,
			),
		).rejects.toThrow(/generated classic summary|no progress|destination context budget/i);
		expect(providerCalls).toBeGreaterThan(0);
	});

	it("fails at the 32-pass cap without returning a compaction", async () => {
		const manager = seed(Array.from({ length: 110 }, (_, index) => `PASS_CAP_${index}`));
		let providerCalls = 0;
		const streamFn = (requestModel: Model<any>) => {
			providerCalls++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("s"),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
						usage: usage(10),
					},
				});
			});
			return stream;
		};

		await expect(
			compactRawHistoryInBounds(
				manager.getBranch(),
				{ enabled: true, reserveTokens: 200, keepRecentTokens: 1 },
				model,
				"key",
				undefined,
				undefined,
				undefined,
				"off",
				streamFn,
			),
		).rejects.toThrow("Bounded classic recovery exceeded pass limit");
		expect(providerCalls).toBe(32);
	});

	it("rejects an indivisible oversized entry without running provider", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `OVERSIZED_MARKER:${"z".repeat(20_000)}` }],
			timestamp: 1,
		});
		manager.appendMessage({
			...fauxAssistantMessage("tail"),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(100),
		});
		let providerCalls = 0;

		await expect(
			compactRawHistoryInBounds(
				manager.getBranch(),
				{ enabled: true, reserveTokens: 200, keepRecentTokens: 1 },
				model,
				"key",
				undefined,
				undefined,
				undefined,
				"off",
				() => {
					providerCalls++;
					return createAssistantMessageEventStream();
				},
			),
		).rejects.toThrow(/indivisible entry|exceeds destination context budget/);
		expect(providerCalls).toBe(0);
	});
});
