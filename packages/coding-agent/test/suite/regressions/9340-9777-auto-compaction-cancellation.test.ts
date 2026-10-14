import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function seedCompactableSession(harness: Harness): void {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "x".repeat(500) }],
		timestamp: 1,
	});
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("y".repeat(200), { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function runAutoCompaction(harness: Harness): Promise<boolean> {
	return (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);
}

describe("automatic compaction cancellation regressions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// Regression test for #9340.
	it("does not start post-run auto-compaction after abort", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 4000, maxTokens: 50 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 50, keepRecentTokens: 1 },
				retry: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			// Overflow recovery is the only compaction that still runs after a run ends.
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				harness.session.abortCompaction();
				void harness.session.abort();
			}
		});

		await harness.session.prompt("z");

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("does not restart compaction for an aborted next request", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [
				{
					name: "large_result",
					label: "Large result",
					description: "Returns a large result",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "x".repeat(16000) }], details: {} }),
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "summary that must not be saved after abort",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("a".repeat(800)),
			fauxAssistantMessage("b".repeat(800)),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unused next response"),
		]);
		await harness.session.prompt("old");
		await harness.session.prompt("recent");

		let abort: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start" && !abort) abort = harness.session.abort();
		});
		await harness.session.prompt("run tool");
		await abort;

		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]?.aborted).toBe(true);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.isIdle).toBe(true);
	});

	// Regression test for #9777.
	it("cancels summarization authentication", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);
		let markAuthStarted = () => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		let authSignal: AbortSignal | undefined;
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (_model, options) => {
			authSignal = options?.signal;
			markAuthStarted();
			if (!authSignal) throw new Error("Missing auth abort signal");
			return await new Promise<never>((_resolve, reject) => {
				authSignal?.addEventListener("abort", () => reject(authSignal?.reason), { once: true });
			});
		});

		const compaction = runAutoCompaction(harness);
		await authStarted;
		const started = harness.eventsOfType("compaction_start").length;
		const wasCompacting = harness.session.isCompacting;
		await Promise.all([compaction, harness.session.abort()]);

		expect({ started, wasCompacting, authAborted: authSignal?.aborted }).toEqual({
			started: 1,
			wasCompacting: true,
			authAborted: true,
		});
		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});

	// Regression test for #9777.
	it("cancels synchronously from compaction_start", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") harness.session.abortCompaction();
		});

		await runAutoCompaction(harness);

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});

	// Regression test for #9777.
	it.each([
		["matching error text", () => new Error("Compaction cancelled")],
		["an unrelated AbortError", () => Object.assign(new Error("auth failed"), { name: "AbortError" })],
	] as const)("reports %s as a failure", async (_label, createError) => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockRejectedValue(createError());

		await runAutoCompaction(harness);

		const event = harness.eventsOfType("compaction_end").at(-1);
		expect(event?.aborted).toBe(false);
		expect(event?.errorMessage).toContain(createError().message);
	});

	it("reports extension cancellation as aborted", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		await runAutoCompaction(harness);

		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});
});
