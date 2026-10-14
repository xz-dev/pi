import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionEntry } from "../../src/core/session-manager.ts";
import type { CompactionSettings } from "../../src/core/settings-schema.ts";
import type { InlineExtension } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

// Each pad result adds ~500 tokens. With a 10000-token window and 2000 reserved, the threshold is
// 8000 and background summarization starts at 0.5 * 8000 = 4000.
const padTool: AgentTool = {
	name: "pad",
	label: "pad",
	description: "pad",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "p".repeat(2000) }], details: undefined }),
};

function isSummaryRequest(context: TranscriptContext): boolean {
	return JSON.stringify(context.messages[0] ?? "").includes("context summarization assistant");
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

interface Scenario {
	harness: Harness;
	summaryCalls: () => number;
	/** Agent requests made while a summary request was pending. */
	requestsDuringSummary: () => number;
	compactions: () => CompactionEntry[];
}

async function createScenario(options: {
	turns: number;
	summary?: (call: number) => Promise<AssistantMessage>;
	compaction?: Partial<CompactionSettings>;
	extensionFactories?: InlineExtension[];
}): Promise<Scenario> {
	let summaryCalls = 0;
	let pendingSummaries = 0;
	let requestsDuringSummary = 0;
	let agentRequests = 0;
	const factory = async (context: TranscriptContext): Promise<AssistantMessage> => {
		if (isSummaryRequest(context)) {
			const call = ++summaryCalls;
			pendingSummaries++;
			try {
				return options.summary ? await options.summary(call) : fauxAssistantMessage(`SUMMARY ${call}`);
			} finally {
				pendingSummaries--;
			}
		}
		if (pendingSummaries > 0) requestsDuringSummary++;
		agentRequests++;
		return agentRequests <= options.turns
			? fauxAssistantMessage(fauxToolCall("pad", {}))
			: fauxAssistantMessage("done");
	};
	const harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: 10000 }],
		tools: [padTool],
		settings: {
			compaction: {
				enabled: true,
				reserveTokens: 2000,
				keepRecentTokens: 1500,
				backgroundStartRatio: 0.5,
				...options.compaction,
			},
		},
		extensionFactories: options.extensionFactories,
	});
	harness.setResponses(Array.from({ length: 100 }, () => factory));
	return {
		harness,
		summaryCalls: () => summaryCalls,
		requestsDuringSummary: () => requestsDuringSummary,
		compactions: () =>
			harness.sessionManager.getEntries().filter((entry): entry is CompactionEntry => entry.type === "compaction"),
	};
}

describe("AgentSession background compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("summarizes while the agent keeps working and commits at the next turn", async () => {
		const release = deferred();
		const scenario = await createScenario({
			turns: 9,
			summary: async (call) => {
				await release.promise;
				return fauxAssistantMessage(`SUMMARY ${call}`);
			},
		});
		harnesses.push(scenario.harness);
		scenario.harness.session.subscribe(() => {
			if (scenario.requestsDuringSummary() >= 2) release.resolve();
		});

		await scenario.harness.session.prompt("go");

		const compactions = scenario.compactions();
		expect(scenario.requestsDuringSummary()).toBeGreaterThanOrEqual(2);
		expect(scenario.summaryCalls()).toBe(1);
		expect(compactions).toHaveLength(1);
		expect(compactions[0].summary).toContain("SUMMARY 1");
		expect(compactions[0].fromHook).toBe(false);
		// Messages appended while summarizing follow firstKeptEntryId and stay verbatim.
		const kept = scenario.harness.sessionManager.buildSessionProjection().messages;
		expect(kept.filter((message) => message.role === "toolResult").length).toBeGreaterThan(2);
		expect(scenario.harness.eventsOfType("compaction_end").map((event) => event.result?.summary)).toEqual([
			compactions[0].summary,
		]);
	});

	it("threshold compaction waits for the pending background summary instead of starting another", async () => {
		const release = deferred();
		const scenario = await createScenario({
			turns: 20,
			summary: async (call) => {
				if (call === 1) await release.promise;
				return fauxAssistantMessage(`SUMMARY ${call}`);
			},
		});
		harnesses.push(scenario.harness);
		let summariesAtThreshold = -1;
		scenario.harness.session.subscribe((event) => {
			if (event.type !== "compaction_start" || summariesAtThreshold >= 0) return;
			summariesAtThreshold = scenario.summaryCalls();
			setTimeout(() => release.resolve(), 10);
		});

		await scenario.harness.session.prompt("go");

		const compactions = scenario.compactions();
		expect(summariesAtThreshold).toBe(1);
		expect(compactions[0].summary).toContain("SUMMARY 1");
		expect(scenario.summaryCalls()).toBe(compactions.length);
	});

	it("falls back to blocking compaction when disabled", async () => {
		const scenario = await createScenario({ turns: 20, compaction: { background: false } });
		harnesses.push(scenario.harness);

		await scenario.harness.session.prompt("go");

		expect(scenario.requestsDuringSummary()).toBe(0);
		expect(scenario.compactions().length).toBeGreaterThan(0);
		expect(scenario.summaryCalls()).toBe(scenario.compactions().length);
	});

	it("does not retry a failed background summary until history compacts", async () => {
		const scenario = await createScenario({
			turns: 20,
			summary: async (call) =>
				call === 1
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" })
					: fauxAssistantMessage(`SUMMARY ${call}`),
		});
		harnesses.push(scenario.harness);
		let summariesAtThreshold = -1;
		scenario.harness.session.subscribe((event) => {
			if (event.type === "compaction_start" && summariesAtThreshold < 0)
				summariesAtThreshold = scenario.summaryCalls();
		});

		await scenario.harness.session.prompt("go");

		const compactions = scenario.compactions();
		expect(compactions.length).toBeGreaterThan(0);
		expect(summariesAtThreshold).toBe(1);
		// The failure is silent; the threshold then compacts synchronously with the second request.
		expect(compactions[0].summary).toContain("SUMMARY 2");
		expect(
			scenario.harness.eventsOfType("compaction_end").filter((event) => event.errorMessage !== undefined),
		).toHaveLength(0);
	});

	it("discards a background summary whose summarized entries were edited", async () => {
		const release = deferred();
		let edited = false;
		const scenario = await createScenario({
			turns: 9,
			summary: async (call) => {
				if (call === 1) await release.promise;
				return fauxAssistantMessage(`SUMMARY ${call}`);
			},
		});
		harnesses.push(scenario.harness);
		scenario.harness.session.subscribe((event) => {
			if (edited || event.type !== "turn_end" || scenario.summaryCalls() !== 1) return;
			// Edit the first user message, which the pending summary folds in.
			const firstUser = scenario.harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!firstUser) return;
			scenario.harness.sessionManager.appendContextEdit(firstUser.id, { content: "edited" });
			edited = true;
			release.resolve();
		});

		await scenario.harness.session.prompt("go");

		expect(edited).toBe(true);
		expect(scenario.compactions().every((entry) => !entry.summary.includes("SUMMARY 1"))).toBe(true);
	});

	it("passes background summarization through session_before_compact", async () => {
		const scenario = await createScenario({
			turns: 9,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "EXTENSION SUMMARY",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(scenario.harness);

		await scenario.harness.session.prompt("go");

		const compactions = scenario.compactions();
		expect(scenario.summaryCalls()).toBe(0);
		expect(compactions).toHaveLength(1);
		expect(compactions[0].summary).toBe("EXTENSION SUMMARY");
		expect(compactions[0].fromHook).toBe(true);
	});
});
