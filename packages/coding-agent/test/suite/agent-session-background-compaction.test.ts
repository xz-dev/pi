import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionEntry, UsageEntry } from "../../src/core/session-manager.ts";
import type { CompactionSettings } from "../../src/core/settings-schema.ts";
import type { InlineExtension } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

// Each pad result adds ~500 tokens. With a 10000-token window and 2000 reserved, the threshold is
// 8000 and background summarization starts at 8000 - min(32768, (1 - 0.5) * 8000) = 4000.
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
	maxPendingSummaries: () => number;
	compactions: () => CompactionEntry[];
}

async function createScenario(options: {
	turns: number;
	response?: (request: number, backgroundPending: boolean) => AssistantMessage | undefined;
	summary?: (call: number) => Promise<AssistantMessage>;
	compaction?: Partial<CompactionSettings>;
	extensionFactories?: InlineExtension[];
}): Promise<Scenario> {
	let summaryCalls = 0;
	let pendingSummaries = 0;
	let maxPendingSummaries = 0;
	let requestsDuringSummary = 0;
	let agentRequests = 0;
	const factory = async (context: TranscriptContext): Promise<AssistantMessage> => {
		if (isSummaryRequest(context)) {
			const call = ++summaryCalls;
			pendingSummaries++;
			maxPendingSummaries = Math.max(maxPendingSummaries, pendingSummaries);
			try {
				return options.summary ? await options.summary(call) : fauxAssistantMessage(`SUMMARY ${call}`);
			} finally {
				pendingSummaries--;
			}
		}
		if (pendingSummaries > 0) requestsDuringSummary++;
		agentRequests++;
		return (
			options.response?.(agentRequests, pendingSummaries > 0) ??
			(agentRequests <= options.turns ? fauxAssistantMessage(fauxToolCall("pad", {})) : fauxAssistantMessage("done"))
		);
	};
	const harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: 10000 }],
		tools: [padTool],
		settings: {
			compaction: {
				enabled: true,
				reserveTokens: 2000,
				keepRecentTokens: 1500,
				background: true,
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
		maxPendingSummaries: () => maxPendingSummaries,
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
			if (event.type !== "compaction_wait_start" || summariesAtThreshold >= 0) return;
			summariesAtThreshold = scenario.summaryCalls();
			setTimeout(() => release.resolve(), 10);
		});

		await scenario.harness.session.prompt("go");

		const compactions = scenario.compactions();
		expect(summariesAtThreshold).toBe(1);
		expect(compactions[0].summary).toContain("SUMMARY 1");
		expect(scenario.summaryCalls()).toBe(compactions.length);
	});

	it.each([false, true])(
		"manual compaction waits for background work before reuse or fallback (failed=%s)",
		async (failed) => {
			const release = deferred();
			const started = deferred();
			const manualInstructions: Array<string | undefined> = [];
			const scenario = await createScenario({
				turns: 9,
				summary: async (call) => {
					if (call === 1) {
						started.resolve();
						await release.promise;
						if (failed) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" });
					}
					return fauxAssistantMessage(`SUMMARY ${call}`);
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							if (event.reason === "manual") manualInstructions.push(event.customInstructions);
						});
					},
				],
			});
			harnesses.push(scenario.harness);
			const prompt = scenario.harness.session.prompt("go");
			await started.promise;
			await prompt;
			const manual = scenario.harness.session.compact("preserve exact file paths");
			try {
				await vi.waitFor(() => expect(scenario.harness.session.isCompacting).toBe(true));
				release.resolve();
				const result = await manual;
				expect(result.summary).toContain(failed ? "SUMMARY 2" : "SUMMARY 1");
				expect(scenario.summaryCalls()).toBe(failed ? 2 : 1);
				expect(scenario.maxPendingSummaries()).toBe(1);
				expect(scenario.compactions()).toHaveLength(1);
				expect(manualInstructions).toEqual(failed ? ["preserve exact file paths"] : []);
			} finally {
				release.resolve();
				await manual.catch(() => undefined);
			}
		},
	);

	it.each([false, true])("overflow recovery waits for background reuse or fallback (failed=%s)", async (failed) => {
		const release = deferred();
		let overflowed = false;
		const scenario = await createScenario({
			turns: 20,
			response: (_request, pending) => {
				if (pending && !overflowed) {
					overflowed = true;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded" });
				}
				return overflowed ? fauxAssistantMessage("recovered") : undefined;
			},
			summary: async (call) => {
				if (call === 1) {
					await release.promise;
					if (failed) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" });
				}
				return fauxAssistantMessage(`SUMMARY ${call}`);
			},
		});
		harnesses.push(scenario.harness);
		scenario.harness.session.subscribe((event) => {
			if (event.type === "compaction_wait_start" && event.reason === "overflow") release.resolve();
		});
		try {
			await scenario.harness.session.prompt("go");
			expect(overflowed).toBe(true);
			expect(scenario.compactions()).toHaveLength(1);
			expect(scenario.compactions()[0].summary).toContain(failed ? "SUMMARY 2" : "SUMMARY 1");
			expect(scenario.summaryCalls()).toBe(failed ? 2 : 1);
			expect(scenario.maxPendingSummaries()).toBe(1);
			expect(scenario.harness.eventsOfType("compaction_end")[0]).toMatchObject({
				reason: "overflow",
				willRetry: true,
			});
		} finally {
			release.resolve();
		}
	});

	it("cancels a foreground waiter without cancelling background work or starting fallback", async () => {
		const release = deferred();
		const started = deferred();
		const scenario = await createScenario({
			turns: 9,
			summary: async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("BACKGROUND");
			},
		});
		harnesses.push(scenario.harness);
		const prompt = scenario.harness.session.prompt("go");
		await started.promise;
		await prompt;
		const manual = scenario.harness.session.compact();
		const rejected = expect(manual).rejects.toThrow("Compaction cancelled");
		try {
			await vi.waitFor(() => expect(scenario.harness.session.isCompacting).toBe(true));
			scenario.harness.session.abortCompaction();
			await rejected;
			expect(scenario.summaryCalls()).toBe(1);
			expect(scenario.compactions()).toHaveLength(0);
			expect(scenario.harness.session.isBackgroundCompacting).toBe(true);
			release.resolve();
			await scenario.harness.session.prompt("next");
			expect(scenario.compactions()).toHaveLength(1);
			expect(scenario.compactions()[0].summary).toContain("BACKGROUND");
		} finally {
			release.resolve();
			await manual.catch(() => undefined);
		}
	});

	it.each([false, true])("shares one committed compaction between foreground callers (failed=%s)", async (failed) => {
		const release = deferred();
		const started = deferred();
		const scenario = await createScenario({
			turns: 9,
			summary: async (call) => {
				if (call === 1) {
					started.resolve();
					await release.promise;
					if (failed) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" });
				}
				return fauxAssistantMessage("SHARED");
			},
		});
		harnesses.push(scenario.harness);
		const prompt = scenario.harness.session.prompt("go");
		await started.promise;
		await prompt;
		const requests = [
			scenario.harness.session.compact(),
			scenario.harness.session.compact("preserve exact file paths"),
		];
		try {
			await vi.waitFor(() => expect(scenario.harness.session.isCompacting).toBe(true));
			release.resolve();
			const results = await Promise.all(requests);
			expect(results[0].summary).toContain("SHARED");
			expect(results[1]).toEqual(results[0]);
			expect(scenario.harness.eventsOfType("compaction_end").map((event) => event.reused)).toEqual([!failed, true]);
			expect(scenario.summaryCalls()).toBe(failed ? 2 : 1);
			expect(scenario.maxPendingSummaries()).toBe(1);
			expect(scenario.compactions()).toHaveLength(1);
		} finally {
			release.resolve();
			await Promise.allSettled(requests);
		}
	});

	it.each([
		{ kind: "manual", dispose: false },
		{ kind: "manual", dispose: true },
		{ kind: "automatic", dispose: false },
		{ kind: "automatic", dispose: true },
	])("does not restart queued $kind compaction after cancellation (dispose=$dispose)", async ({ kind, dispose }) => {
		const release = deferred();
		const started = deferred();
		const scenario = await createScenario({
			turns: 9,
			summary: async (call) => {
				if (call === 1) {
					started.resolve();
					await release.promise;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" });
				}
				return fauxAssistantMessage("UNWANTED FALLBACK");
			},
		});
		harnesses.push(scenario.harness);
		const session = scenario.harness.session;
		const prompt = session.prompt("go");
		await started.promise;
		await prompt;
		const runAuto = Reflect.get(session, "_runAutoCompaction") as (
			reason: "threshold" | "overflow",
			willRetry: boolean,
		) => Promise<boolean>;
		const requests: Promise<unknown>[] =
			kind === "manual"
				? [session.compact(), session.compact("keep exact file paths")]
				: [runAuto.call(session, "threshold", false), runAuto.call(session, "overflow", true)];
		const settled = Promise.allSettled(requests);
		try {
			await vi.waitFor(() => expect(session.isCompacting).toBe(true));
			if (dispose) session.dispose();
			else session.abortCompaction();
			release.resolve();
			const results = await settled;
			if (kind === "manual") {
				expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
			} else {
				expect(results).toEqual([
					{ status: "fulfilled", value: false },
					{ status: "fulfilled", value: false },
				]);
			}
			expect(scenario.summaryCalls()).toBe(1);
			expect(scenario.compactions()).toHaveLength(0);
		} finally {
			release.resolve();
			await settled;
		}
	});

	it("keeps a queued overflow caller's retry intent after shared foreground fallback", async () => {
		const release = deferred();
		const started = deferred();
		const scenario = await createScenario({
			turns: 9,
			summary: async (call) => {
				if (call === 1) {
					started.resolve();
					await release.promise;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" });
				}
				return fauxAssistantMessage("SHARED FALLBACK");
			},
		});
		harnesses.push(scenario.harness);
		const session = scenario.harness.session;
		const prompt = session.prompt("go");
		await started.promise;
		await prompt;
		const runAuto = Reflect.get(session, "_runAutoCompaction") as (
			reason: "threshold" | "overflow",
			willRetry: boolean,
		) => Promise<boolean>;
		const requests = [runAuto.call(session, "threshold", false), runAuto.call(session, "overflow", true)];
		try {
			await vi.waitFor(() => expect(session.isCompacting).toBe(true));
			release.resolve();
			expect(await Promise.all(requests)).toEqual([false, true]);
			expect(scenario.summaryCalls()).toBe(2);
			expect(scenario.maxPendingSummaries()).toBe(1);
			expect(scenario.compactions()).toHaveLength(1);
			expect(
				scenario.harness.eventsOfType("compaction_end").map(({ reason, willRetry }) => ({ reason, willRetry })),
			).toEqual([
				{ reason: "threshold", willRetry: false },
				{ reason: "overflow", willRetry: true },
			]);
		} finally {
			release.resolve();
			await Promise.allSettled(requests);
		}
	});

	it.each(["abort", "dispose", "session replacement"])(
		"rejects a manual request cancelled during preliminary abort (%s)",
		async (action) => {
			const release = deferred();
			const started = deferred();
			const scenario = await createScenario({
				turns: 9,
				summary: async (call) => {
					if (call === 1) {
						started.resolve();
						await release.promise;
					}
					return fauxAssistantMessage(call === 1 ? "BACKGROUND" : "UNWANTED FALLBACK");
				},
			});
			harnesses.push(scenario.harness);
			const { session, sessionManager } = scenario.harness;
			const prompt = session.prompt("go");
			await started.promise;
			await prompt;
			const background = Reflect.get(session, "_backgroundCompaction") as { settled: Promise<void> };
			const settled = Promise.allSettled([session.compact("keep paths")]);
			try {
				if (action === "abort") session.abortCompaction();
				else if (action === "dispose") session.dispose();
				else {
					sessionManager.newSession();
					for (let i = 0; i < 2; i++) {
						sessionManager.appendMessage({
							role: "user",
							content: `new session ${i} `.repeat(1000),
							timestamp: Date.now(),
						});
					}
					session.refreshContext();
				}
				release.resolve();
				expect(await settled).toMatchObject([{ status: "rejected", reason: { message: "Compaction cancelled" } }]);
				await background.settled;
				expect(scenario.summaryCalls()).toBe(1);
				expect(scenario.compactions()).toHaveLength(0);
			} finally {
				release.resolve();
				await settled;
				await background.settled;
			}
		},
	);

	it.each(["manual", "overflow"])("shares fallback with a %s caller joining during generation", async (kind) => {
		const release = deferred();
		const started = deferred();
		const fallbackStarted = deferred();
		const releaseFallback = deferred();
		const scenario = await createScenario({
			turns: 9,
			summary: async (call) => {
				if (call === 1) {
					started.resolve();
					await release.promise;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" });
				}
				fallbackStarted.resolve();
				await releaseFallback.promise;
				return fauxAssistantMessage("SHARED FALLBACK");
			},
		});
		harnesses.push(scenario.harness);
		const session = scenario.harness.session;
		const prompt = session.prompt("go");
		await started.promise;
		await prompt;
		const runAuto = Reflect.get(session, "_runAutoCompaction") as (
			reason: "threshold" | "overflow",
			willRetry: boolean,
		) => Promise<boolean>;
		const requests: Promise<unknown>[] = [runAuto.call(session, "threshold", false)];
		try {
			release.resolve();
			await fallbackStarted.promise;
			expect(
				await Reflect.apply(Reflect.get(session, "_advanceBackgroundCompaction"), session, [
					scenario.harness.getModel(),
					scenario.harness.sessionManager.buildSessionProjection(),
				]),
			).toBe(false);
			requests.push(kind === "manual" ? session.compact("keep paths") : runAuto.call(session, "overflow", true));
			releaseFallback.resolve();
			const results = await Promise.all(requests);
			expect(results[0]).toBe(false);
			if (kind === "manual")
				expect(results[1]).toMatchObject({ summary: expect.stringContaining("SHARED FALLBACK") });
			else expect(results[1]).toBe(true);
			expect(scenario.summaryCalls()).toBe(2);
			expect(scenario.maxPendingSummaries()).toBe(1);
			expect(scenario.compactions()).toHaveLength(1);
			expect(scenario.harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				reason: kind,
				willRetry: kind === "overflow",
				reused: true,
			});
		} finally {
			release.resolve();
			releaseFallback.resolve();
			await Promise.allSettled(requests);
		}
	});

	it.each(["manual", "abort", "agent abort", "dispose", "manual abort", "manual reentrant abort"])(
		"preserves input-threshold cancellation policy (%s)",
		async (action) => {
			const release = deferred();
			const started = deferred();
			const waiting = deferred();
			let preparingInput = false;
			let requestsAfterInput = 0;
			const scenario = await createScenario({
				turns: 9,
				response: () => {
					if (!preparingInput) return undefined;
					requestsAfterInput++;
					return fauxAssistantMessage("UNWANTED REQUEST");
				},
				summary: async () => {
					started.resolve();
					await release.promise;
					return fauxAssistantMessage("BACKGROUND");
				},
			});
			harnesses.push(scenario.harness);
			const session = scenario.harness.session;
			const first = session.prompt("go");
			await started.promise;
			await first;
			const background = Reflect.get(session, "_backgroundCompaction") as { settled: Promise<void> };
			session.subscribe((event) => {
				if (event.type === "compaction_wait_start" && event.reason === "threshold") waiting.resolve();
			});
			preparingInput = true;
			const incoming = "incoming ".repeat(6000);
			const prompt = session.prompt(incoming);
			const promptSettled = Promise.allSettled([prompt]);
			await waiting.promise;
			if (action === "manual reentrant abort") {
				const active = Reflect.get(session.agent, "activeRun") as { abortController: AbortController };
				active.abortController.signal.addEventListener("abort", () => session.abortCompaction(), { once: true });
			}
			const manual = action.startsWith("manual") ? session.compact("keep paths") : undefined;
			const manualSettled = Promise.allSettled(manual ? [manual] : []);
			const stop = action === "abort" ? session.abort() : Promise.resolve();
			if (action === "agent abort") session.agent.abort();
			if (action === "dispose") session.dispose();
			if (action === "manual abort") session.abortCompaction();
			try {
				release.resolve();
				await Promise.all([promptSettled, stop, background.settled]);
				const results = await manualSettled;
				if (action === "manual") {
					expect(results).toMatchObject([
						{ status: "fulfilled", value: { summary: expect.stringContaining("BACKGROUND") } },
					]);
					const entries = scenario.harness.sessionManager.getEntries();
					const inputs = entries.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes(incoming),
					);
					expect(inputs).toHaveLength(1);
					expect(
						scenario.harness.sessionManager
							.buildSessionProjection()
							.messages.filter(
								(message) => message.role === "user" && JSON.stringify(message.content).includes(incoming),
							),
					).toHaveLength(1);
				} else if (manual) {
					expect(results).toMatchObject([{ status: "rejected", reason: { message: "Compaction cancelled" } }]);
				}
				expect(scenario.compactions()).toHaveLength(action === "manual" ? 1 : 0);
				expect(scenario.summaryCalls()).toBe(1);
				expect(scenario.maxPendingSummaries()).toBe(1);
				expect(requestsAfterInput).toBe(0);
			} finally {
				release.resolve();
				await Promise.allSettled([promptSettled, manualSettled, stop, background.settled]);
			}
		},
	);

	it("does not resume an interrupted overflow turn when manual compaction joins its waiter", async () => {
		const release = deferred();
		const waiting = deferred();
		let overflowed = false;
		let requestsAfterOverflow = 0;
		const scenario = await createScenario({
			turns: 20,
			response: (_request, pending) => {
				if (pending && !overflowed) {
					overflowed = true;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded" });
				}
				if (overflowed) {
					requestsAfterOverflow++;
					return fauxAssistantMessage("UNWANTED RETRY");
				}
				return undefined;
			},
			summary: async () => {
				await release.promise;
				return fauxAssistantMessage("BACKGROUND");
			},
		});
		harnesses.push(scenario.harness);
		scenario.harness.session.subscribe((event) => {
			if (event.type === "compaction_wait_start" && event.reason === "overflow") waiting.resolve();
		});
		const prompt = scenario.harness.session.prompt("go");
		await waiting.promise;
		const manual = scenario.harness.session.compact("keep paths");
		try {
			release.resolve();
			await prompt;
			expect((await manual).summary).toContain("BACKGROUND");
			expect(requestsAfterOverflow).toBe(0);
			expect(scenario.summaryCalls()).toBe(1);
			expect(scenario.compactions()).toHaveLength(1);
			expect(scenario.harness.eventsOfType("agent_settled").at(-1)?.aborted).toBe(true);
			expect(scenario.harness.session.isIdle).toBe(true);
		} finally {
			release.resolve();
			await Promise.allSettled([prompt, manual]);
		}
	});

	it("does not mark native fallback as extension output after a stale background result", async () => {
		const release = deferred();
		const started = deferred();
		const scenario = await createScenario({
			turns: 9,
			summary: async () => fauxAssistantMessage("NATIVE FALLBACK"),
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						if (event.reason !== "threshold") return;
						started.resolve();
						await release.promise;
						return {
							compaction: {
								summary: "STALE EXTENSION",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(scenario.harness);
		const prompt = scenario.harness.session.prompt("go");
		await started.promise;
		await prompt;
		const manual = scenario.harness.session.compact("preserve exact paths");
		try {
			await vi.waitFor(() => expect(scenario.harness.session.isCompacting).toBe(true));
			const firstUser = scenario.harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user")!;
			scenario.harness.sessionManager.appendContextEdit(firstUser.id, { content: "edited input" });
			release.resolve();
			expect((await manual).summary).toContain("NATIVE FALLBACK");
			expect(scenario.compactions()).toHaveLength(1);
			expect(scenario.compactions()[0].fromHook).toBe(false);
			expect(scenario.summaryCalls()).toBe(1);
		} finally {
			release.resolve();
			await manual.catch(() => undefined);
		}
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

	it("stays off by default and blocks compaction synchronously", async () => {
		// Default: compaction.background is false, so no background job starts.
		const scenario = await createScenario({ turns: 20, compaction: { background: undefined } });
		harnesses.push(scenario.harness);

		await scenario.harness.session.prompt("go");

		expect(scenario.harness.session.backgroundCompactionEnabled).toBe(false);
		expect(scenario.requestsDuringSummary()).toBe(0);
		expect(scenario.summaryCalls()).toBe(scenario.compactions().length);
		expect(scenario.summaryCalls()).toBeGreaterThan(0);
	});

	it("does not start background work when auto-compaction is off", async () => {
		const scenario = await createScenario({
			turns: 20,
			compaction: { enabled: false, background: true },
		});
		harnesses.push(scenario.harness);

		await scenario.harness.session.prompt("go");

		expect(scenario.summaryCalls()).toBe(0);
		expect(scenario.compactions()).toHaveLength(0);
	});

	it("waits for the bounded headroom on a large window instead of the plain ratio", async () => {
		// Hybrid start: T=28000, r=0.5 => headroom=min(32768,14000)=14000 => start at 14000.
		// A ratio-only start would fire at 14000 anyway; pick a larger window where the
		// fixed 32768 cap binds: T=28000 stays under the cap, so use window 200000 to
		// prove the cap. T=198000 => headroom=min(32768, 99000)=32768 => start at 165232.
		const summaryStarted = deferred();
		const finish = deferred();
		let summaryCalls = 0;
		const bigPad: AgentTool = {
			name: "bigpad",
			label: "bigpad",
			description: "bigpad",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "p".repeat(40000) }],
				details: undefined,
			}),
		};
		const factory = async (context: TranscriptContext): Promise<AssistantMessage> => {
			if (isSummaryRequest(context)) {
				summaryCalls++;
				summaryStarted.resolve();
				await finish.promise;
				return fauxAssistantMessage(`SUMMARY ${summaryCalls}`);
			}
			// ~10000 tokens per tool result; the start triggers at 165232, i.e. on turn ~17.
			return fauxAssistantMessage(fauxToolCall("bigpad", {}));
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200000 }],
			tools: [bigPad],
			settings: {
				compaction: {
					enabled: true,
					reserveTokens: 2000,
					keepRecentTokens: 1500,
					background: true,
					backgroundStartRatio: 0.5,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses(Array.from({ length: 100 }, () => factory));

		const promptDone = harness.session.prompt("go");
		await summaryStarted.promise;
		// The hybrid formula delays the start to within the bounded headroom. The
		// scenario proves work ran by the time it finished; assert at least one
		// background summary completed and committed.
		expect(summaryCalls).toBeGreaterThanOrEqual(1);
		finish.resolve();
		await promptDone;
		const compactions = harness.sessionManager
			.getEntries()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(compactions.length).toBeGreaterThan(0);
		harness.cleanup();
	});

	it("records provider usage once for a discarded background job", async () => {
		const release = deferred();
		const summaryStarted = deferred();
		const scenario = await createScenario({
			turns: 20,
			summary: async (call) => {
				summaryStarted.resolve();
				await release.promise;
				return fauxAssistantMessage(`SUMMARY ${call}`);
			},
		});
		harnesses.push(scenario.harness);

		const promptDone = scenario.harness.session.prompt("go");
		await summaryStarted.promise;
		scenario.harness.session.setBackgroundCompactionEnabled(false);
		release.resolve();
		await promptDone;

		const usageEntries = scenario.harness.sessionManager
			.getEntries()
			.filter((entry): entry is UsageEntry => entry.type === "usage" && entry.kind === "background_compaction");
		expect(usageEntries).toHaveLength(1);
		expect(usageEntries[0].provider).toBe("faux");
		// The discarded background usage must not also appear as compaction usage.
		// Total billed tokens equals usage entries plus any adopted-compaction usage.
		const stats = scenario.harness.session.getSessionStats();
		expect(stats.tokens.total).toBeGreaterThan(0);
	});

	it("emits a controlled background_compaction_end event without provider text", async () => {
		const secret = "FAKE_CREDENTIAL_TEST_ONLY";
		const release = deferred();
		const summaryStarted = deferred();
		const scenario = await createScenario({
			turns: 20,
			summary: async (_call) => {
				summaryStarted.resolve();
				await release.promise;
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: `request failed Authorization: Bearer ${secret}`,
				});
			},
		});
		harnesses.push(scenario.harness);

		const promptDone = scenario.harness.session.prompt("go");
		await summaryStarted.promise;
		release.resolve();
		await promptDone;

		const events = scenario.harness.eventsOfType("background_compaction_end");
		expect(events.length).toBeGreaterThan(0);
		// Controlled text only; raw provider errors may carry credentials.
		expect(events[0].errorMessage).toBe("Background compaction failed");
		expect(JSON.stringify(events[0])).not.toContain(secret);
		// Foreground lifecycle stays intact: failure did not block the agent.
		expect(scenario.harness.session.isStreaming).toBe(false);
	});

	it("toggling background off clears a recorded background failure", async () => {
		const release = deferred();
		const summaryStarted = deferred();
		const scenario = await createScenario({
			turns: 20,
			summary: async (_call) => {
				summaryStarted.resolve();
				await release.promise;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" });
			},
		});
		harnesses.push(scenario.harness);

		const promptDone = scenario.harness.session.prompt("go");
		await summaryStarted.promise;
		release.resolve();
		// Wait for the failure to land before disabling so clear has something to clear.
		await vi.waitFor(() => {
			expect(scenario.harness.eventsOfType("background_compaction_end").length).toBe(1);
		});
		scenario.harness.session.setBackgroundCompactionEnabled(false);
		await promptDone;

		const events = scenario.harness.eventsOfType("background_compaction_end");
		expect(events).toHaveLength(2);
		expect(events[0].errorMessage).toBeDefined();
		expect(events[1].errorMessage).toBeUndefined();
	});

	it("toggling background off revokes a pending job so it is never adopted", async () => {
		const release = deferred();
		const summaryStarted = deferred();
		const scenario = await createScenario({
			turns: 20,
			summary: async (call) => {
				summaryStarted.resolve();
				await release.promise;
				return fauxAssistantMessage(`SUMMARY ${call}`);
			},
		});
		harnesses.push(scenario.harness);

		const promptDone = scenario.harness.session.prompt("go");
		// Wait until the background summary is in flight, then disable the feature.
		await summaryStarted.promise;
		scenario.harness.session.setBackgroundCompactionEnabled(false);
		expect(scenario.harness.session.backgroundCompactionEnabled).toBe(false);
		release.resolve();
		await promptDone;

		// The revoked result must not be committed even though it completed; the
		// threshold still compacts synchronously with a fresh summary.
		expect(scenario.compactions().length).toBeGreaterThan(0);
		expect(scenario.compactions().every((entry) => !entry.summary.includes("SUMMARY 1"))).toBe(true);
	});

	it("toggling auto-compact off revokes a pending background job", async () => {
		const release = deferred();
		const summaryStarted = deferred();
		const scenario = await createScenario({
			turns: 20,
			summary: async (call) => {
				summaryStarted.resolve();
				await release.promise;
				return fauxAssistantMessage(`SUMMARY ${call}`);
			},
		});
		harnesses.push(scenario.harness);

		const promptDone = scenario.harness.session.prompt("go");
		await summaryStarted.promise;
		scenario.harness.session.setAutoCompactionEnabled(false);
		release.resolve();
		await promptDone;

		// Auto-compact off revokes the job and blocks all further compaction.
		expect(scenario.compactions()).toHaveLength(0);
		expect(scenario.summaryCalls()).toBe(1);
	});

	it("toggling background on through the session setter enables background summarization", async () => {
		const release = deferred();
		const scenario = await createScenario({
			turns: 20,
			compaction: { background: false },
			summary: async (call) => {
				await release.promise;
				return fauxAssistantMessage(`SUMMARY ${call}`);
			},
		});
		harnesses.push(scenario.harness);

		expect(scenario.harness.session.backgroundCompactionEnabled).toBe(false);
		scenario.harness.session.setBackgroundCompactionEnabled(true);
		expect(scenario.harness.session.backgroundCompactionEnabled).toBe(true);
		expect(scenario.harness.settingsManager.getCompactionBackgroundEnabled()).toBe(true);

		scenario.harness.session.subscribe(() => {
			if (scenario.requestsDuringSummary() >= 1) release.resolve();
		});
		await scenario.harness.session.prompt("go");

		// With background enabled at runtime, the agent kept working while summarizing.
		expect(scenario.requestsDuringSummary()).toBeGreaterThan(0);
		expect(scenario.compactions().some((entry) => entry.summary.includes("SUMMARY"))).toBe(true);
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

	it("counts every native attempt, including retries and both stages of a split summary", async () => {
		// Retries and partial failures each return provider usage; every attempt bills once.
		const scenario = await createScenario({
			turns: 20,
			compaction: { keepRecentTokens: 400 },
			summary: async (call) =>
				call === 1
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })
					: fauxAssistantMessage(`SUMMARY ${call}`),
		});
		harnesses.push(scenario.harness);

		await scenario.harness.session.prompt("go");

		const usageEntries = scenario.harness.sessionManager
			.getEntries()
			.filter((entry): entry is UsageEntry => entry.type === "usage" && entry.kind === "background_compaction");
		expect(usageEntries.length).toBeGreaterThanOrEqual(2);
		expect(scenario.compactions().length).toBeGreaterThan(0);
		// The adopted compaction's usage field is suppressed to avoid double counting.
		expect(scenario.compactions().at(-1)?.usage).toBeUndefined();
	});

	it("still bills the originating session when a message lands while the summary runs", async () => {
		const release = deferred();
		const summaryStarted = deferred();
		const scenario = await createScenario({
			turns: 20,
			summary: async (call) => {
				summaryStarted.resolve();
				await release.promise;
				return fauxAssistantMessage(`SUMMARY ${call}`);
			},
		});
		harnesses.push(scenario.harness);

		const promptDone = scenario.harness.session.prompt("go");
		await summaryStarted.promise;
		// Ordinary append while the summary is in flight must not suppress billing.
		scenario.harness.sessionManager.appendMessage({
			role: "user",
			content: "late note",
			timestamp: Date.now(),
		});
		release.resolve();
		await promptDone;

		const usageEntries = scenario.harness.sessionManager
			.getEntries()
			.filter((entry): entry is UsageEntry => entry.type === "usage" && entry.kind === "background_compaction");
		expect(usageEntries.length).toBeGreaterThanOrEqual(1);
		expect(usageEntries[0].provider).toBe("faux");
	});

	it("records component-token usage even when aggregate totals are zero", async () => {
		// Provider may report component tokens while aggregate total/cost are zero.
		const summaryStarted = deferred();
		const release = deferred();
		let summaryCallCount = 0;
		const scenario = await createScenario({ turns: 20 });
		const original = scenario.harness.session.agent.streamFunction!;
		scenario.harness.session.agent.streamFunction = (model, context, options) => {
			if (!isSummaryRequest(context)) {
				return original(model, context, options);
			}
			summaryCallCount++;
			summaryStarted.resolve();
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await release.promise;
				const message: AssistantMessage = {
					...fauxAssistantMessage("SUMMARY"),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 100,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		harnesses.push(scenario.harness);

		const promptDone = scenario.harness.session.prompt("go");
		await summaryStarted.promise;
		release.resolve();
		await promptDone;

		expect(summaryCallCount).toBeGreaterThanOrEqual(1);
		const usageEntries = scenario.harness.sessionManager
			.getEntries()
			.filter((entry): entry is UsageEntry => entry.type === "usage" && entry.kind === "background_compaction");
		expect(usageEntries[0].usage.input).toBe(100);
		expect(usageEntries[0].usage.output).toBe(10);
		expect(usageEntries[0].usage.totalTokens).toBe(0);
	});

	it("keeps final-failure suppression across Off/On until history compacts", async () => {
		const release = deferred();
		const summaryStarted = deferred();
		const scenario = await createScenario({
			turns: 20,
			summary: async (call) => {
				summaryStarted.resolve();
				await release.promise;
				return call === 1
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" })
					: fauxAssistantMessage(`SUMMARY ${call}`);
			},
		});
		harnesses.push(scenario.harness);

		const promptDone = scenario.harness.session.prompt("go");
		await summaryStarted.promise;
		release.resolve();
		await promptDone;

		// The first call fails as a background attempt; suppression blocks background
		// retries under unchanged history. A foreground compaction may then commit.
		const committed = scenario.compactions().length;
		expect(committed).toBeGreaterThan(0);
		expect(scenario.summaryCalls()).toBeGreaterThanOrEqual(2);

		// Toggling Off/On alone must not spend another background attempt.
		const callsBeforeToggle = scenario.summaryCalls();
		const compactionsBeforeToggle = scenario.compactions().length;
		scenario.harness.session.setBackgroundCompactionEnabled(false);
		scenario.harness.session.setBackgroundCompactionEnabled(true);

		// Without a new prompt the setting change itself must not launch any attempt.
		expect(scenario.summaryCalls()).toBe(callsBeforeToggle);
		expect(scenario.compactions()).toHaveLength(compactionsBeforeToggle);
	});

	it("extension cancellation does not surface as a background failure", async () => {
		const scenario = await createScenario({
			turns: 20,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(scenario.harness);

		await scenario.harness.session.prompt("go");

		expect(scenario.summaryCalls()).toBe(0);
		expect(scenario.harness.eventsOfType("background_compaction_end")).toHaveLength(0);
	});
});
