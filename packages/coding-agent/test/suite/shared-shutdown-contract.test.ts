import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.ts";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function servicesFor(harness: Harness) {
	return {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
}

function seedBranch(harness: Harness): { targetId: string; leafId: string | null } {
	harness.sessionManager.appendMessage(userMsg("first prompt"));
	const targetId = harness.sessionManager.appendMessage(assistantMsg("first response"));
	harness.sessionManager.appendMessage(userMsg("abandoned prompt"));
	harness.sessionManager.appendMessage(assistantMsg("abandoned response"));
	harness.session.refreshContext();
	return { targetId, leafId: harness.sessionManager.getLeafId() };
}

describe("shared session shutdown contract", () => {
	const harnesses: Harness[] = [];
	const releases: Array<() => void> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const release of releases.splice(0)) release();
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	it("permanently rejects all work admissions without provider or shell work", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const { targetId } = seedBranch(h);
		const entries = h.sessionManager.getEntries().length;
		h.setResponses([fauxAssistantMessage("must not run")]);
		h.session.prepareForShutdown();
		await h.session.abort();
		for (const action of [
			() => h.session.prompt("late"),
			() => h.session.sendUserMessage("late"),
			() => h.session.sendCustomMessage({ customType: "late", content: "late", display: false }),
			() =>
				h.session.sendCustomMessage({ customType: "late", content: "late", display: false }, { triggerTurn: true }),
			() =>
				h.session.sendCustomMessage(
					{ customType: "late", content: "late", display: false },
					{ deliverAs: "nextTurn" },
				),
			() => h.session.steer("late"),
			() => h.session.followUp("late"),
			() => h.session.executeBash("must-not-run"),
			() => h.session.compact(),
			() => h.session.navigateTree(targetId, { summarize: true }),
			() => h.session.reload(),
		]) {
			await expect(action()).rejects.toThrow("Session is shutting down");
		}
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.session.pendingMessageCount).toBe(0);
		expect(h.sessionManager.getEntries()).toHaveLength(entries);
	});

	it.each(["prompt", "steer", "followUp"] as const)(
		"rejects %s across an input-handler suspension",
		async (action) => {
			const entered = deferred<void>();
			const release = deferred<void>();
			releases.push(() => release.resolve());
			const h = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", async () => {
							entered.resolve();
							await release.promise;
							return { action: "continue" };
						});
					},
				],
			});
			harnesses.push(h);
			const auth = vi.spyOn(h.session.modelRuntime, "checkAuth");
			const work = h.session[action]("late input");
			await entered.promise;
			h.session.prepareForShutdown();
			release.resolve();
			await expect(work).rejects.toThrow("Session is shutting down");
			expect(auth).not.toHaveBeenCalled();
			expect(h.session.pendingMessageCount).toBe(0);
			expect(h.session.messages).toEqual([]);
		},
	);

	it("rejects a prompt whose auth check resumes after shutdown", async () => {
		const h = await createHarness({ withConfiguredAuth: false });
		harnesses.push(h);
		const entered = deferred<void>();
		const release = deferred<void>();
		releases.push(() => release.resolve());
		vi.spyOn(h.session.modelRuntime, "checkAuth").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return undefined;
		});
		const work = h.session.prompt("auth suspended");
		await entered.promise;
		h.session.prepareForShutdown();
		release.resolve();
		await expect(work).rejects.toThrow("Session is shutting down");
		expect(h.session.messages).toEqual([]);
	});

	it.each(["prompt", "custom"] as const)(
		"does not consume pending messages when %s preparation crosses shutdown",
		async (kind) => {
			const entered = deferred<void>();
			const release = deferred<void>();
			releases.push(() => release.resolve());
			const h = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", async () => {
							entered.resolve();
							await release.promise;
						});
					},
				],
			});
			harnesses.push(h);
			await h.session.sendCustomMessage(
				{ customType: "pending", content: "keep me", display: false },
				{ deliverAs: "nextTurn" },
			);
			const pending = Reflect.get(h.session, "_pendingNextTurnMessages");
			h.setResponses([fauxAssistantMessage("must not run")]);
			const work =
				kind === "prompt"
					? h.session.prompt("preparing")
					: h.session.sendCustomMessage(
							{ customType: "start", content: "start", display: false },
							{ triggerTurn: true },
						);
			await entered.promise;
			await h.session.dispose();
			release.resolve();
			await expect(work).rejects.toThrow("Session is shutting down");
			expect(Reflect.get(h.session, "_pendingNextTurnMessages")).toBe(pending);
			expect(pending).toHaveLength(1);
			expect(h.getPendingResponseCount()).toBe(1);
			expect(h.session.messages).toEqual([]);
		},
	);

	it("uses the manual controller admission boundary after abort settles", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const entered = deferred<void>();
		const release = deferred<void>();
		releases.push(() => release.resolve());
		vi.spyOn(h.session, "waitForIdle").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
		});
		const work = h.session.compact();
		await entered.promise;
		h.session.prepareForShutdown();
		release.resolve();
		await expect(work).rejects.toThrow(/Session is shutting down|Compaction cancelled/);
		expect(h.eventsOfType("compaction_start")).toEqual([]);
		expect(h.session.isCompacting).toBe(false);
	});

	it("does not navigate when shutdown crosses the tree hook", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		releases.push(() => release.resolve());
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						entered.resolve();
						await release.promise;
						return { summary: { summary: "late summary" } };
					});
				},
			],
		});
		harnesses.push(h);
		const { targetId, leafId } = seedBranch(h);
		const count = h.sessionManager.getEntries().length;
		const work = h.session.navigateTree(targetId, { summarize: true });
		await entered.promise;
		h.session.prepareForShutdown();
		release.resolve();
		await expect(work).rejects.toThrow("Session is shutting down");
		expect(h.sessionManager.getLeafId()).toBe(leafId);
		expect(h.sessionManager.getEntries()).toHaveLength(count);
	});

	it("does not rebuild extensions when reload crosses resource loading", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const entered = deferred<void>();
		const release = deferred<void>();
		releases.push(() => release.resolve());
		vi.spyOn(h.session.resourceLoader, "reload").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
		});
		const runner = h.session.extensionRunner;
		const beforeStart = vi.fn();
		const work = h.session.reload({ beforeSessionStart: beforeStart });
		await entered.promise;
		h.session.prepareForShutdown();
		release.resolve();
		await expect(work).rejects.toThrow("Session is shutting down");
		expect(h.session.extensionRunner).toBe(runner);
		expect(beforeStart).not.toHaveBeenCalled();
	});

	it("isolates each synchronous cancellation and never awaits noncooperative tool code", async () => {
		const entered = deferred<void>();
		const release = deferred<AgentToolResult<unknown>>();
		releases.push(() => release.resolve({ content: [], details: {} }));
		let signal: AbortSignal | undefined;
		const tool: AgentTool = {
			name: "noncooperative",
			label: "noncooperative",
			description: "Controlled ignored abort",
			parameters: Type.Object({}),
			execute: (_id, _params, executionSignal) => {
				signal = executionSignal;
				entered.resolve();
				return release.promise;
			},
		};
		const h = await createHarness({ tools: [tool] });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage(fauxToolCall("noncooperative", {}), { stopReason: "toolUse" })]);
		const work = h.session.prompt("run tool");
		await entered.promise;
		vi.spyOn(h.session, "abortRetry").mockImplementation(() => {
			throw new Error("hook failed");
		});
		const compaction = vi.spyOn(h.session, "abortCompaction");
		const branch = vi.spyOn(h.session, "abortBranchSummary");
		const bash = vi.spyOn(h.session, "abortBash");
		const disposal = h.session.dispose();
		expect(signal?.aborted).toBe(true);
		expect(compaction).toHaveBeenCalledOnce();
		expect(branch).toHaveBeenCalledOnce();
		expect(bash).toHaveBeenCalledOnce();
		await disposal;
		release.resolve({ content: [], details: {} });
		await work;
	});

	it("ordinary abort leaves admission open", async () => {
		const h = await createHarness();
		harnesses.push(h);
		await h.session.abort();
		h.setResponses([fauxAssistantMessage("still open")]);
		await h.session.prompt("new work");
		expect(h.getPendingResponseCount()).toBe(0);
	});

	it.each(["quit", "replacement"] as const)(
		"prepares before abort and awaits disposal before %s follow-through",
		async (kind) => {
			const h = await createHarness();
			harnesses.push(h);
			const services = servicesFor(h);
			const factory: CreateAgentSessionRuntimeFactory = vi.fn(async ({ sessionManager }) => {
				const next = await createHarness({ sessionManager });
				harnesses.push(next);
				return {
					session: next.session,
					services: servicesFor(next),
					extensionsResult: next.session.resourceLoader.getExtensions(),
					diagnostics: [],
				};
			});
			const runtime = new AgentSessionRuntime(h.session, services, factory);
			const entered = deferred<void>();
			const release = deferred<void>();
			releases.push(() => release.resolve());
			const dispose = h.session.dispose.bind(h.session);
			vi.spyOn(h.session, "dispose").mockImplementation(async () => {
				await dispose();
				entered.resolve();
				await release.promise;
			});
			vi.spyOn(h.session, "abort").mockImplementation(async () => {
				await expect(h.session.prompt("late")).rejects.toThrow("Session is shutting down");
			});
			const settle = vi.spyOn(services.modelRuntime, "settleCredentialWrites");
			const work = kind === "quit" ? runtime.dispose() : runtime.newSession();
			await entered.promise;
			expect(factory).not.toHaveBeenCalled();
			expect(settle).not.toHaveBeenCalled();
			release.resolve();
			await work;
			if (kind === "quit") expect(settle).toHaveBeenCalledOnce();
			else expect(factory).toHaveBeenCalledOnce();
		},
	);

	it("settles credentials even if abort and final disposal fail", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const services = servicesFor(h);
		const factory: CreateAgentSessionRuntimeFactory = vi.fn();
		const runtime = new AgentSessionRuntime(h.session, services, factory);
		vi.spyOn(h.session, "abort").mockRejectedValue(new Error("abort failed"));
		const dispose = vi.spyOn(h.session, "dispose").mockRejectedValue(new Error("dispose failed"));
		const settle = vi.spyOn(services.modelRuntime, "settleCredentialWrites");
		await expect(runtime.dispose()).rejects.toThrow("dispose failed");
		expect(dispose).toHaveBeenCalledOnce();
		expect(settle).toHaveBeenCalledOnce();
	});
});
