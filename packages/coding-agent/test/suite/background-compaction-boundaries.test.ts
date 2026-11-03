/**
 * Durable regression coverage for background compaction ownership, billing, suppression,
 * cancellation, and admission boundaries. Ported from the external reviewer probe
 * (logs/reviewer-final-safety.test.ts) so the repository itself establishes these
 * guarantees; the original external file stays unchanged.
 */
import type { PrepareInputContext } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { estimateProjectedContextTokens, prepareCompaction } from "../../src/core/compaction/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { SessionProjection, UsageEntry } from "../../src/core/session-manager.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

type Internals = {
	_advanceBackgroundCompaction(
		model: Model<string>,
		projection: SessionProjection,
		additionalTokens?: number,
	): Promise<boolean>;
	_runAutoCompaction(reason: "threshold" | "overflow", willRetry: boolean): Promise<boolean>;
	_backgroundCompaction?: { settled: Promise<void>; done: boolean; controller: AbortController };
};

const owned: Harness[] = [];
const internals = (h: Harness) => h.session as unknown as Internals;

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

function billed(text: string, error?: string): AssistantMessage {
	return {
		...fauxAssistantMessage(text, error ? { stopReason: "error", errorMessage: error } : {}),
		responseModel: "billed-model",
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
		},
	};
}

async function setup(
	factory: (call: number) => Promise<AssistantMessage> | AssistantMessage,
	split = false,
	extensionFactories?: HarnessOptions["extensionFactories"],
) {
	const h = await createHarness({
		extensionFactories,
		models: [{ id: "faux-1", contextWindow: 10000 }],
		tools: [],
		settings: {
			compaction: {
				enabled: true,
				background: true,
				backgroundStartRatio: 0.5,
				reserveTokens: 2000,
				keepRecentTokens: 150,
			},
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
		},
	});
	owned.push(h);
	const m = h.sessionManager;
	m.appendMessage({ role: "user", content: "old".repeat(300), timestamp: Date.now() });
	m.appendMessage(fauxAssistantMessage("answer".repeat(100)));
	m.appendMessage({ role: "user", content: "recent".repeat(200), timestamp: Date.now() });
	if (split) {
		m.appendMessage(fauxAssistantMessage("middle".repeat(200)));
		m.appendMessage(fauxAssistantMessage("tail".repeat(200)));
	}
	h.session.refreshContext();
	let calls = 0;
	h.session.agent.streamFunction = () => {
		const stream = createAssistantMessageEventStream();
		void Promise.resolve(factory(++calls)).then((r) => stream.end(r));
		return stream;
	};
	return { h, calls: () => calls };
}

async function start(h: Harness) {
	await internals(h)._advanceBackgroundCompaction(h.getModel(), h.sessionManager.buildSessionProjection(), 4000);
	const job = internals(h)._backgroundCompaction;
	expect(job).toBeDefined();
	return job!;
}

const usageEntries = (h: Harness) =>
	h.sessionManager
		.getEntries()
		.filter((e): e is UsageEntry => e.type === "usage" && e.kind === "background_compaction");

afterEach(() => {
	for (const h of owned.splice(0)) h.cleanup();
	vi.restoreAllMocks();
});

describe("background compaction billing ownership", () => {
	it("counts late usage after an ordinary appended message", async () => {
		const release = deferred();
		const { h } = await setup(async () => {
			await release.promise;
			return billed("summary");
		});
		const job = await start(h);
		h.sessionManager.appendMessage(fauxAssistantMessage("agent continued while summary ran"));
		release.resolve();
		await job.settled;
		expect(usageEntries(h)).toHaveLength(1);
	});

	it("counts both native retry attempts without duplicate adoption", async () => {
		const { h, calls } = await setup((n) => billed(n === 1 ? "" : "summary", n === 1 ? "overloaded" : undefined));
		const job = await start(h);
		await job.settled;
		await internals(h)._runAutoCompaction("threshold", false);
		expect(calls()).toBe(2);
		expect(usageEntries(h)).toHaveLength(2);
		expect(h.session.getSessionStats().cost).toBe(2);
	});

	it.each([false, true])("counts two stages, failed second stage=%s", async (fail) => {
		const { h, calls } = await setup(
			(n) => billed(n === 1 ? "history" : "prefix", n === 2 && fail ? "bad request" : undefined),
			true,
		);
		const preparation = prepareCompaction(
			h.sessionManager.getBranch(),
			h.settingsManager.getCompactionSettings(h.getModel()),
		)!;
		expect(preparation.isSplitTurn).toBe(true);
		expect(preparation.messagesToSummarize.length).toBeGreaterThan(0);
		const job = await start(h);
		await job.settled;
		expect(calls()).toBe(2);
		expect(usageEntries(h)).toHaveLength(2);
		// Exact billed totals: each attempt reports 110 tokens / $1.
		expect(usageEntries(h).reduce((sum, e) => sum + e.usage.totalTokens, 0)).toBe(220);
		expect(h.session.getSessionStats().cost).toBe(2);
	});

	it("does not expose provider secrets via background event or JSON", async () => {
		const marker = "FAKE_CREDENTIAL_TEST_ONLY";
		const { h } = await setup(() => billed("", `request failed Authorization: Bearer ${marker}`));
		const job = await start(h);
		await job.settled;
		const event = h.eventsOfType("background_compaction_end")[0];
		expect(JSON.stringify(toJsonEvent(event))).not.toContain(marker);
		expect(JSON.stringify(event)).not.toContain(marker);
	});
});

describe("background compaction failure lifecycle", () => {
	it("clears and rearms the rendered warning without taking input or foreground ownership", async () => {
		initTheme("dark");
		const onEscape = vi.fn();
		const working = { kind: "working" };
		// Exercise the actual event handler and renderer without starting a terminal.
		const mode = Object.assign(
			Object.create(InteractiveMode.prototype) as { handleEvent(event: AgentSessionEvent): Promise<void> },
			{
				isInitialized: true,
				backgroundCompactionWarningShown: false,
				chatContainer: new Container(),
				footer: { invalidate: vi.fn() },
				programStatus: { handleEvent: vi.fn() },
				ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
				defaultEditor: { onEscape },
				autoCompactionEscapeHandler: undefined,
				retryEscapeHandler: undefined,
				workingVisible: true,
				activeStatusIndicator: working,
				submittedInput: "submitted text",
				showSubmittedInput: false,
				pendingUserInputs: ["pending input"],
				compactionQueuedMessages: [{ text: "queued text", mode: "steer" }],
				showStatusIndicator: vi.fn(),
				clearStatusIndicator: vi.fn(),
				flushCompactionQueue: vi.fn(),
				updatePendingMessagesDisplay: vi.fn(),
			},
		);
		const failure = { type: "background_compaction_end", errorMessage: "Background compaction failed" } as const;
		await mode.handleEvent(failure);
		await mode.handleEvent(failure);
		expect(
			mode.chatContainer
				.render(120)
				.join("\n")
				.match(/Warning: Background compaction failed/g),
		).toHaveLength(1);
		expect(mode.backgroundCompactionWarningShown).toBe(true);

		await mode.handleEvent({ type: "background_compaction_end" });
		await mode.handleEvent({ type: "background_compaction_end" });
		expect(
			mode.chatContainer
				.render(120)
				.join("\n")
				.match(/Background compaction cleared/g),
		).toHaveLength(1);
		expect(mode.backgroundCompactionWarningShown).toBe(false);
		await mode.handleEvent(failure);
		expect(
			mode.chatContainer
				.render(120)
				.join("\n")
				.match(/Warning: Background compaction failed/g),
		).toHaveLength(2);
		expect(mode.backgroundCompactionWarningShown).toBe(true);

		expect(mode.defaultEditor.onEscape).toBe(onEscape);
		expect(onEscape).not.toHaveBeenCalled();
		expect(mode.autoCompactionEscapeHandler).toBeUndefined();
		expect(mode.retryEscapeHandler).toBeUndefined();
		expect(mode.workingVisible).toBe(true);
		expect(mode.activeStatusIndicator).toBe(working);
		expect(mode.submittedInput).toBe("submitted text");
		expect(mode.showSubmittedInput).toBe(false);
		expect(mode.pendingUserInputs).toEqual(["pending input"]);
		expect(mode.compactionQueuedMessages).toEqual([{ text: "queued text", mode: "steer" }]);
		expect(mode.showStatusIndicator).not.toHaveBeenCalled();
		expect(mode.clearStatusIndicator).not.toHaveBeenCalled();
		expect(mode.flushCompactionQueue).not.toHaveBeenCalled();
		expect(mode.updatePendingMessagesDisplay).not.toHaveBeenCalled();
		expect(mode.ui.terminal.setProgress).not.toHaveBeenCalled();
	});

	it("keeps failed-history suppression through reload until a real compaction advances history", async () => {
		const { h, calls } = await setup((n) => billed("summary", n === 1 ? "bad request" : undefined));
		const failed = await start(h);
		await failed.settled;
		expect(calls()).toBe(1);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);

		await h.session.reload();
		expect(h.session.backgroundCompactionEnabled).toBe(true);
		expect(h.session.autoCompactionEnabled).toBe(true);
		await internals(h)._advanceBackgroundCompaction(h.getModel(), h.sessionManager.buildSessionProjection(), 4000);
		await internals(h)._backgroundCompaction?.settled;
		expect(calls()).toBe(1);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);

		await internals(h)._runAutoCompaction("threshold", false);
		expect(calls()).toBe(2);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		h.sessionManager.appendMessage(fauxAssistantMessage("recent answer".repeat(100)));
		h.sessionManager.appendMessage({ role: "user", content: "new tail".repeat(200), timestamp: Date.now() });
		h.session.refreshContext();
		const next = await start(h);
		await next.settled;
		expect(calls()).toBe(3);
		expect(h.session.getSessionStats().cost).toBe(3);
	});

	it("keeps final-failure suppression across Off/On without compaction", async () => {
		const { h, calls } = await setup(() => billed("", "bad request"));
		const first = await start(h);
		await first.settled;
		await internals(h)._advanceBackgroundCompaction(h.getModel(), h.sessionManager.buildSessionProjection(), 4000);
		expect(calls()).toBe(1);
		h.session.setBackgroundCompactionEnabled(false);
		h.session.setBackgroundCompactionEnabled(true);
		await internals(h)._advanceBackgroundCompaction(h.getModel(), h.sessionManager.buildSessionProjection(), 4000);
		await internals(h)._backgroundCompaction?.settled;
		expect(calls()).toBe(1);
	});

	it("clears failure diagnostic after successful foreground recovery", async () => {
		const { h } = await setup((n) => billed("summary", n === 1 ? "bad request" : undefined));
		const job = await start(h);
		await job.settled;
		await internals(h)._runAutoCompaction("threshold", false);
		expect(h.eventsOfType("background_compaction_end").at(-1)?.errorMessage).toBeUndefined();
	});

	it("same-branch navigation does not spend another failed background attempt", async () => {
		const { h, calls } = await setup(() => billed("", "bad request"));
		const job = await start(h);
		await job.settled;
		await h.session.navigateTree(h.sessionManager.getLeafId()!);
		await internals(h)._advanceBackgroundCompaction(h.getModel(), h.sessionManager.buildSessionProjection(), 4000);
		await internals(h)._backgroundCompaction?.settled;
		expect(calls()).toBe(1);
	});
});

describe("background compaction runtime ownership", () => {
	it("reload does not emit old-job usage into reloaded listeners", async () => {
		const release = deferred();
		let attempts = 0;
		const { h } = await setup(async () => {
			attempts++;
			await release.promise;
			return billed("late");
		});
		const job = await start(h);
		await vi.waitFor(() => expect(attempts).toBe(1));
		await h.session.reload();
		const afterReload = h.events.length;
		release.resolve();
		await job.settled;
		const late = h.events.slice(afterReload).filter((e) => e.type === "entry_appended");
		expect(late).toHaveLength(0);
		// Late usage still bills the original session file exactly once.
		expect(usageEntries(h)).toHaveLength(1);
	});

	it("dispose leaves late billing on old manager but emits no UI events", async () => {
		const release = deferred();
		let attempts = 0;
		const { h } = await setup(async () => {
			attempts++;
			await release.promise;
			return billed("late");
		});
		const job = await start(h);
		await vi.waitFor(() => expect(attempts).toBe(1));
		h.session.dispose();
		const before = h.events.length;
		release.resolve();
		await job.settled;
		expect(usageEntries(h)).toHaveLength(1);
		expect(h.events).toHaveLength(before);
	});

	it("shared-manager new session receives no late bill or status", async () => {
		const release = deferred();
		let attempts = 0;
		const { h } = await setup(async () => {
			attempts++;
			await release.promise;
			return billed("late");
		});
		const job = await start(h);
		await vi.waitFor(() => expect(attempts).toBe(1));
		h.session.dispose();
		h.sessionManager.newSession();
		const before = h.events.length;
		release.resolve();
		await job.settled;
		expect(usageEntries(h)).toHaveLength(0);
		expect(h.events).toHaveLength(before);
	});

	it("ready disable revokes result; promoted foreground retains ownership", async () => {
		const { h } = await setup(() => billed("ready"));
		const job = await start(h);
		await job.settled;
		h.session.setBackgroundCompactionEnabled(false);
		expect(internals(h)._backgroundCompaction).toBeUndefined();
		expect(h.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(0);

		const release = deferred();
		const second = await setup(async () => {
			await release.promise;
			return billed("promoted");
		});
		const pending = await start(second.h);
		const foreground = internals(second.h)._runAutoCompaction("threshold", false);
		second.h.session.setAutoCompactionEnabled(false);
		expect(pending.controller.signal.aborted).toBe(false);
		release.resolve();
		await foreground;
		expect(second.h.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(1);
	});

	it("late discarded usage survives a same-session branch movement", async () => {
		const release = deferred();
		let attempts = 0;
		const { h } = await setup(async () => {
			attempts++;
			await release.promise;
			return billed("summary");
		});
		const job = await start(h);
		await vi.waitFor(() => expect(attempts).toBe(1));
		const target = h.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "assistant")!;
		await h.session.navigateTree(target.id);
		release.resolve();
		await job.settled;
		expect(usageEntries(h)).toHaveLength(1);
	});
});

describe("background compaction exact hybrid boundaries", () => {
	it.each([
		{ window: 10000, ratio: 0.8531, expected: 6824.8 },
		{ window: 200000, ratio: 0.5, expected: 165232 },
	])("exact hybrid lower boundary $expected", async ({ window, ratio, expected }) => {
		const { h, calls } = await setup(() => billed("summary"));
		h.settingsManager.applyOverrides({ compaction: { backgroundStartRatio: ratio } });
		const model = { ...h.getModel(), contextWindow: window };
		const projection = h.sessionManager.buildSessionProjection();
		const current = estimateProjectedContextTokens(projection, h.sessionManager.getBranch()).tokens;
		await internals(h)._advanceBackgroundCompaction(model, projection, expected - 0.01 - current);
		expect(internals(h)._backgroundCompaction).toBeUndefined();
		expect(calls()).toBe(0);
		await internals(h)._advanceBackgroundCompaction(model, projection, expected - current);
		const job = internals(h)._backgroundCompaction;
		expect(job).toBeDefined();
		await job?.settled;
	});

	it("no-cut preparation and reserve-equals-window admit zero new attempts", async () => {
		const { h, calls } = await setup(() => billed("summary"));
		const projection = h.sessionManager.buildSessionProjection();
		h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 100000000 } });
		await internals(h)._advanceBackgroundCompaction(h.getModel(), projection, 4000);
		expect(calls()).toBe(0);
		expect(internals(h)._backgroundCompaction).toBeUndefined();
		h.settingsManager.applyOverrides({
			compaction: { keepRecentTokens: 150, reserveTokens: 10000 },
		});
		await internals(h)._advanceBackgroundCompaction(h.getModel(), h.sessionManager.buildSessionProjection(), 4000);
		expect(calls()).toBe(0);
		expect(internals(h)._backgroundCompaction).toBeUndefined();
	});
});

describe("background compaction component usage and extension precedence", () => {
	it("counts component-token usage when aggregate total and cost are zero", async () => {
		const { h } = await setup(() => {
			const r = billed("summary");
			r.usage.totalTokens = 0;
			r.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
			return r;
		});
		const job = await start(h);
		await job.settled;
		expect(usageEntries(h)).toHaveLength(1);
		expect(usageEntries(h)[0].usage.input).toBe(100);
		expect(usageEntries(h)[0].usage.output).toBe(10);
	});

	it("keeps extension-provided usage on compaction without native attempt", async () => {
		const { h, calls } = await setup(() => billed("unexpected"), false, [
			(pi: ExtensionAPI) => {
				pi.on("session_before_compact", ({ preparation }) => ({
					compaction: {
						summary: "extension",
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						usage: billed("").usage,
					},
				}));
			},
		]);
		const job = await start(h);
		await job.settled;
		await internals(h)._runAutoCompaction("threshold", false);
		expect(calls()).toBe(0);
		expect(usageEntries(h)).toHaveLength(0);
		expect(h.sessionManager.getEntries().find((e) => e.type === "compaction")).toMatchObject({
			usage: { totalTokens: 110 },
		});
	});

	it("extension cancellation stays quiet, not a background provider failure", async () => {
		const { h, calls } = await setup(() => billed("unexpected"), false, [
			(pi: ExtensionAPI) => {
				pi.on("session_before_compact", () => ({ cancel: true }));
			},
		]);
		const job = await start(h);
		await job.settled;
		expect(calls()).toBe(0);
		expect(h.eventsOfType("background_compaction_end")).toHaveLength(0);
	});
});

describe("background compaction revocation at shared choke point", () => {
	it("does not start the second stage after Off while first response is in flight", async () => {
		const release = deferred();
		const started = deferred();
		const calls: { attempt: number; signalAborted: boolean; backgroundEnabled: boolean }[] = [];
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10000 }],
			tools: [],
			settings: {
				compaction: {
					enabled: true,
					background: true,
					backgroundStartRatio: 0.5,
					reserveTokens: 2000,
					keepRecentTokens: 150,
				},
				retry: { enabled: false },
			},
		});
		owned.push(h);
		const m = h.sessionManager;
		m.appendMessage({ role: "user", content: "old".repeat(300), timestamp: Date.now() });
		m.appendMessage(fauxAssistantMessage("answer".repeat(100)));
		m.appendMessage({ role: "user", content: "recent".repeat(200), timestamp: Date.now() });
		m.appendMessage(fauxAssistantMessage("middle".repeat(200)));
		m.appendMessage(fauxAssistantMessage("tail".repeat(200)));
		h.session.refreshContext();
		const preparation = prepareCompaction(m.getBranch(), h.settingsManager.getCompactionSettings(h.getModel()))!;
		expect(preparation.isSplitTurn).toBe(true);
		h.session.agent.streamFunction = (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			const n = calls.length + 1;
			calls.push({
				attempt: n,
				signalAborted: options?.signal?.aborted ?? false,
				backgroundEnabled: h.session.backgroundCompactionEnabled,
			});
			if (n === 1) started.resolve();
			void (async () => {
				if (n === 1) await release.promise;
				stream.end(billed(`summary ${n}`));
			})();
			return stream;
		};
		await internals(h)._advanceBackgroundCompaction(h.getModel(), h.sessionManager.buildSessionProjection(), 4000);
		const job = internals(h)._backgroundCompaction!;
		await started.promise;
		h.session.setBackgroundCompactionEnabled(false);
		release.resolve();
		await job.settled;
		// Stage one already started and its usage is still billed once; stage two never ran.
		expect(calls).toHaveLength(1);
		expect(calls[0].signalAborted).toBe(false);
		expect(usageEntries(h)).toHaveLength(1);
		expect(m.getEntries().filter((e) => e.type === "compaction")).toHaveLength(0);
	});

	it("does not invoke a stream after abort for either custom or native route", async () => {
		// Delayed stream that never rejects; abort mid-flight must prevent the next attempt.
		for (const useCustomStream of [true, false]) {
			const release = deferred();
			let calls = 0;
			const h = await createHarness({
				models: [{ id: "faux-1", contextWindow: 10000 }],
				tools: [],
				settings: {
					compaction: {
						enabled: true,
						background: true,
						backgroundStartRatio: 0.5,
						reserveTokens: 2000,
						keepRecentTokens: 150,
					},
					retry: { enabled: false },
				},
			});
			owned.push(h);
			const m = h.sessionManager;
			m.appendMessage({ role: "user", content: "old".repeat(300), timestamp: Date.now() });
			m.appendMessage(fauxAssistantMessage("answer".repeat(100)));
			m.appendMessage({ role: "user", content: "recent".repeat(200), timestamp: Date.now() });
			m.appendMessage(fauxAssistantMessage("middle".repeat(200)));
			m.appendMessage(fauxAssistantMessage("tail".repeat(200)));
			h.session.refreshContext();
			if (useCustomStream) {
				h.session.agent.streamFunction = () => {
					calls++;
					const stream = createAssistantMessageEventStream();
					void (async () => {
						await release.promise;
						stream.end(billed(`summary ${calls}`));
					})();
					return stream;
				};
			} else {
				// Native route: streamSimple still enters produce, but throwIfAborted
				// stops it before it can call the provider; we count produce invocations
				// via the custom stream fallback path being absent.
				h.setResponses([
					async () => {
						calls++;
						await release.promise;
						return billed("summary 1");
					},
					async () => {
						calls++;
						return billed("summary 2");
					},
				]);
				h.session.agent.streamFunction = streamSimple;
			}
			await internals(h)._advanceBackgroundCompaction(h.getModel(), h.sessionManager.buildSessionProjection(), 4000);
			const job = internals(h)._backgroundCompaction!;
			// Let the first attempt enter its delayed produce before revoking.
			await vi.waitFor(() => expect(calls).toBe(1));
			job.controller.abort();
			release.resolve();
			await job.settled;
			expect(calls).toBe(1);
			expect(m.getEntries().filter((e) => e.type === "compaction")).toHaveLength(0);
		}
	});
});

describe("background compaction manual retry transaction", () => {
	it("commits the recovered answer while billed usage appends during the retry", async () => {
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10000 }],
			tools: [],
			settings: {
				compaction: {
					enabled: true,
					background: true,
					backgroundStartRatio: 0.5,
					reserveTokens: 2000,
					keepRecentTokens: 150,
				},
				retry: { enabled: false },
			},
		});
		owned.push(h);
		const m = h.sessionManager;
		m.appendMessage({ role: "user", content: "old".repeat(300), timestamp: Date.now() - 1000 });
		m.appendMessage(fauxAssistantMessage("prior".repeat(100)));
		m.appendMessage({ role: "user", content: "recent".repeat(200), timestamp: Date.now() - 100 });
		m.appendMessage(fauxAssistantMessage("partial answer", { stopReason: "aborted" }));
		h.session.refreshContext();

		const summaryGate = deferred();
		const agentGate = deferred();
		const agentStartedGate = deferred();
		h.session.agent.streamFunction = (_model, context) => {
			const isSummary = JSON.stringify(context.messages[0]).includes("context summarization assistant");
			const stream = createAssistantMessageEventStream();
			if (!isSummary) agentStartedGate.resolve();
			void (async () => {
				await (isSummary ? summaryGate.promise : agentGate.promise);
				const message: AssistantMessage = {
					...fauxAssistantMessage(isSummary ? "background summary" : "recovered answer"),
					usage: {
						input: 100,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 110,
						cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
					},
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			})();
			return stream;
		};

		await internals(h)._advanceBackgroundCompaction(h.getModel(), h.sessionManager.buildSessionProjection(), 4000);
		const retryBackground = internals(h)._backgroundCompaction!;
		let retryError: string | undefined;
		const retried = h.session.retry().catch((e: unknown) => {
			retryError = e instanceof Error ? e.message : String(e);
		});
		await agentStartedGate.promise;
		summaryGate.resolve();
		await retryBackground.settled;
		agentGate.resolve();
		await retried;

		expect(retryError).toBeUndefined();
		expect(h.session.getLastAssistantText()).toBe("recovered answer");
		// Native usage is billed once on the abandoned sibling; the recovered
		// assistant contributes its own $1 cost, and no usage is double-counted.
		expect(usageEntries(h)).toHaveLength(1);
		expect(usageEntries(h)[0].usage.totalTokens).toBe(110);
		expect(h.session.getSessionStats().cost).toBe(2);
	});

	it("still rejects real branch/message mutation during retry", async () => {
		const h = await createHarness({
			settings: { retry: { enabled: false } },
		});
		owned.push(h);
		const m = h.sessionManager;
		m.appendMessage({ role: "user", content: "q", timestamp: Date.now() });
		m.appendMessage(fauxAssistantMessage("partial", { stopReason: "aborted" }));
		h.session.refreshContext();
		const commit = {
			expectedSessionId: m.getSessionId(),
			expectedLeafId: m.getLeafId(),
			expectedGeneration: m.getGeneration(),
			expectedEntryCount: m.getEntryCount(),
			branchFromId: m.getLeafId(),
			messages: [fauxAssistantMessage("recovered")],
		};
		m.appendMessage({ role: "user", content: "mutating", timestamp: Date.now() });
		expect(() => m.commitContinuation(commit)).toThrow(/branch changed|Session changed/);
	});

	it("carries custom state but not usage entries onto the recovered branch", async () => {
		const h = await createHarness({
			settings: { retry: { enabled: false } },
		});
		owned.push(h);
		const m = h.sessionManager;
		m.appendMessage({ role: "user", content: "q", timestamp: Date.now() });
		m.appendMessage(fauxAssistantMessage("partial", { stopReason: "aborted" }));
		h.session.refreshContext();
		const commit = {
			expectedSessionId: m.getSessionId(),
			expectedLeafId: m.getLeafId(),
			expectedGeneration: m.getGeneration(),
			expectedEntryCount: m.getEntryCount(),
			branchFromId: m.getLeafId(),
			messages: [fauxAssistantMessage("recovered")],
		};
		m.appendCustomEntry("ext-state", { flag: true });
		m.appendUsage("background_compaction", "faux", "faux-1", {
			input: 5,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 6,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const leaf = m.commitContinuation(commit);
		const branch = m.getBranch();
		const usage = branch.filter((e) => e.type === "usage");
		const custom = branch.filter((e) => e.type === "custom");
		expect(usage).toHaveLength(0);
		expect(custom).toHaveLength(1);
		expect(branch.at(-1)!.id).toBe(leaf);
	});
});

describe("background compaction settings row", () => {
	it("renders On/Off and sits adjacent to Auto-compact after splices", () => {
		initTheme("dark");
		const config = {
			autoCompact: true,
			backgroundCompaction: false,
			supportsImages: true,
			autoResizeImages: true,
			blockImages: true,
			enableSkillCommands: true,
			showHardwareCursor: true,
			editorPaddingX: 1,
			outputPad: 0,
			autocompleteMaxVisible: 10,
			clearOnShrink: true,
			showTerminalProgress: true,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onBackgroundCompactionChange: () => {},
		} as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("background-compaction");
		for (const ch of "Background compaction") list.handleInput(ch);
		const strip = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "");
		const off = list
			.render(100)
			.map(strip)
			.find((x) => x.includes("Background compaction") && x.includes("Off"));
		list.handleInput("\r");
		const on = list
			.render(100)
			.map(strip)
			.find((x) => x.includes("Background compaction") && x.includes("On"));
		const items = (list as unknown as { items: { id: string }[] }).items;
		const autoIndex = items.findIndex((x) => x.id === "autocompact");
		const bgIndex = items.findIndex((x) => x.id === "background-compaction");
		expect(off).toMatch(/Off/);
		expect(on).toMatch(/On/);
		expect(bgIndex).toBe(autoIndex + 1);
	});
});

describe("background compaction admission and overflow", () => {
	it("records oversized giant tool tail at pre-input adoption", async () => {
		const { h } = await setup(() => billed("snapshot summary"));
		const job = await start(h);
		await job.settled;
		h.sessionManager.appendMessage(
			fauxAssistantMessage([{ type: "toolCall", id: "large", name: "read", arguments: {} }]),
		);
		h.sessionManager.appendMessage({
			role: "toolResult",
			toolName: "read",
			toolCallId: "large",
			content: [{ type: "text", text: `NEW_TOOL_OUTPUT_${"x".repeat(45000)}` }],
			isError: false,
			timestamp: Date.now(),
		});
		h.session.refreshContext();
		const incoming = { role: "user" as const, content: "continue", timestamp: Date.now() };
		const context = { messages: h.sessionManager.buildSessionProjection().messages, tools: [] };
		const prepared = await h.session.agent.prepareInput!(
			{ context, messages: [incoming], model: h.getModel(), thinkingLevel: "off" } satisfies PrepareInputContext,
			new AbortController().signal,
		);
		h.sessionManager.appendMessage(incoming);
		h.session.refreshContext();
		const result = await h.session.agent.prepareRequest!(
			{
				context: {
					...context,
					messages: h.sessionManager.buildSessionProjection().messages,
				},
				model: prepared?.model ?? h.getModel(),
				thinkingLevel: "off",
			},
			new AbortController().signal,
		);
		const estimate = estimateProjectedContextTokens(
			h.sessionManager.buildSessionProjection(),
			h.sessionManager.getBranch(),
		).tokens;
		expect(estimate).toBeGreaterThan(8000);
		expect(JSON.stringify(result?.context?.messages)).toContain("NEW_TOOL_OUTPUT_");
	});

	it("records oversized smaller-model tail after adoption", async () => {
		const routedFactories = [
			(pi: ExtensionAPI) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "auto",
					name: "auto",
					route(_request, ctx) {
						return {
							model: ctx.modelRegistry.find("faux", "faux-1")!,
							thinkingLevel: "off",
						};
					},
				});
			},
		];
		const { h } = await setup(() => billed("snapshot summary"), false, routedFactories);
		const larger = { ...h.getModel(), contextWindow: 20000 };
		h.session.agent.state.model = larger;
		await internals(h)._advanceBackgroundCompaction(larger, h.sessionManager.buildSessionProjection(), 10000);
		const job = internals(h)._backgroundCompaction!;
		expect(job).toBeDefined();
		await job.settled;
		h.sessionManager.appendMessage({
			role: "user",
			content: `NEW_INPUT_${"x".repeat(37000)}`,
			timestamp: Date.now(),
		});
		h.session.refreshContext();
		await h.session.setModel(h.session.modelRuntime.getModel("router", "auto")!);
		const incoming = { role: "user" as const, content: "continue", timestamp: Date.now() };
		const context = { messages: h.sessionManager.buildSessionProjection().messages, tools: [] };
		const prepared = await h.session.agent.prepareInput!(
			{ context, messages: [incoming], model: h.getModel(), thinkingLevel: "off" } satisfies PrepareInputContext,
			new AbortController().signal,
		);
		h.sessionManager.appendMessage(incoming);
		h.session.refreshContext();
		const result = await h.session.agent.prepareRequest!(
			{
				context: {
					...context,
					messages: h.sessionManager.buildSessionProjection().messages,
				},
				model: prepared?.model ?? h.getModel(),
				thinkingLevel: "off",
			},
			new AbortController().signal,
		);
		const estimate = estimateProjectedContextTokens(
			h.sessionManager.buildSessionProjection(),
			h.sessionManager.getBranch(),
		).tokens;
		expect(estimate).toBeGreaterThan(8000);
		expect(result?.model?.id).toBe("faux-1");
	});
});

describe("background compaction end-to-end provider admission", () => {
	it.each(["huge-tool", "smaller-route"] as const)("observes %s adoption before the faux request", async (kind) => {
		const routed = kind === "smaller-route";
		const routedFactories = [
			(pi: ExtensionAPI) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "auto",
					name: "auto",
					route(_r, ctx) {
						return {
							model: ctx.modelRegistry.find("faux", "faux-1")!,
							thinkingLevel: "off",
						};
					},
				});
			},
		];
		const { h } = await setup(() => billed("old snapshot"), false, routed ? routedFactories : undefined);
		if (routed) {
			const larger = { ...h.getModel(), contextWindow: 20000 };
			h.session.agent.state.model = larger;
			await internals(h)._advanceBackgroundCompaction(larger, h.sessionManager.buildSessionProjection(), 10000);
			await internals(h)._backgroundCompaction!.settled;
		} else {
			const job = await start(h);
			await job.settled;
		}
		for (let i = 0; i < 12; i++) {
			h.sessionManager.appendMessage(
				fauxAssistantMessage([{ type: "toolCall", id: `tool-${i}`, name: "read", arguments: {} }]),
			);
			h.sessionManager.appendMessage({
				role: "toolResult",
				toolName: "read",
				toolCallId: `tool-${i}`,
				content: [{ type: "text", text: `tail-${i}:${"x".repeat(4000)}` }],
				isError: false,
				timestamp: Date.now(),
			});
		}
		h.session.refreshContext();
		if (routed) await h.session.setModel(h.session.modelRuntime.getModel("router", "auto")!);
		h.session.agent.streamFunction = streamSimple;
		let sentTokens = 0;
		let requestModel = "";
		let sawTail = false;
		h.setResponses([
			(context, _options, _state, model) => {
				sentTokens = estimateProjectedContextTokens(
					h.sessionManager.buildSessionProjection(),
					h.sessionManager.getBranch(),
				).tokens;
				requestModel = model.id;
				sawTail = JSON.stringify(context.messages).includes("tail-11:");
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("continue");
		expect(sawTail).toBe(true);
		expect(sentTokens).toBeGreaterThan(10000);
		expect(requestModel).toBe("faux-1");
	});
});

describe("background compaction bounded overflow fallback", () => {
	it.each([false, true])("recovers adopted oversized tail once, virtual=%s", async (virtual) => {
		const virtualFactories = [
			(pi: ExtensionAPI) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "auto",
					name: "auto",
					route(_r, ctx) {
						return {
							model: ctx.modelRegistry.find("faux", "faux-1")!,
							thinkingLevel: "off",
						};
					},
				});
			},
		];
		const { h } = await setup(() => billed("old snapshot"), false, virtual ? virtualFactories : undefined);
		if (virtual) {
			const larger = { ...h.getModel(), contextWindow: 20000 };
			h.session.agent.state.model = larger;
			await internals(h)._advanceBackgroundCompaction(larger, h.sessionManager.buildSessionProjection(), 10000);
			await internals(h)._backgroundCompaction!.settled;
		} else {
			const job = await start(h);
			await job.settled;
		}
		for (let i = 0; i < 12; i++) {
			h.sessionManager.appendMessage(
				fauxAssistantMessage([{ type: "toolCall", id: `tool-${i}`, name: "read", arguments: {} }]),
			);
			h.sessionManager.appendMessage({
				role: "toolResult",
				toolName: "read",
				toolCallId: `tool-${i}`,
				content: [{ type: "text", text: `tail-${i}:${"x".repeat(4000)}` }],
				isError: false,
				timestamp: Date.now(),
			});
		}
		h.session.refreshContext();
		if (virtual) await h.session.setModel(h.session.modelRuntime.getModel("router", "auto")!);
		h.session.agent.streamFunction = streamSimple;
		let overflows = 0;
		let agentCalls = 0;
		let summaries = 0;
		const factory = async (context: { messages: unknown[] }) => {
			await new Promise((r) => setTimeout(r, 3));
			if (JSON.stringify(context.messages[0]).includes("context summarization assistant")) {
				summaries++;
				return fauxAssistantMessage("fresh summary");
			}
			agentCalls++;
			const tokens = estimateProjectedContextTokens(
				h.sessionManager.buildSessionProjection(),
				h.sessionManager.getBranch(),
			).tokens;
			if (tokens > 10000) {
				expect(JSON.stringify(context.messages)).toContain("PRESERVE_NEW_INPUT");
				overflows++;
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "prompt is too long",
				});
			}
			return fauxAssistantMessage("recovered");
		};
		h.setResponses(Array.from({ length: 5 }, () => factory));
		await h.session.prompt("PRESERVE_NEW_INPUT");
		expect(overflows).toBe(1);
		expect(agentCalls).toBe(2);
		expect(summaries).toBeGreaterThanOrEqual(1);
		expect(summaries).toBeLessThanOrEqual(2);
		expect(h.session.getLastAssistantText()).toBe("recovered");
	});
});
