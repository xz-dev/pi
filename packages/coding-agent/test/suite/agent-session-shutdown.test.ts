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

function noncooperativeTool() {
	const started = deferred<void>();
	const finish = deferred<AgentToolResult<unknown>>();
	let signal: AbortSignal | undefined;
	const tool: AgentTool = {
		name: "noncooperative",
		label: "noncooperative",
		description: "Waits for the test to release it, even after abort",
		parameters: Type.Object({}),
		execute: (_id, _params, executionSignal) => {
			signal = executionSignal;
			started.resolve();
			return finish.promise;
		},
	};
	return {
		tool,
		started: started.promise,
		get signal() {
			return signal;
		},
		finish: () => finish.resolve({ content: [{ type: "text", text: "late result" }], details: {} }),
	};
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

describe("permanent session shutdown", () => {
	const harnesses: Harness[] = [];
	const releaseTools: Array<() => void> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const release of releaseTools.splice(0)) release();
		vi.useRealTimers();
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	async function harnessWithTool() {
		const execution = noncooperativeTool();
		releaseTools.push(execution.finish);
		const harness = await createHarness({
			tools: [execution.tool],
			settings: { backgroundToolCalls: { noncooperative: { detachAfterSeconds: 1 } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noncooperative", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("detached"),
		]);
		return { harness, execution };
	}

	it("rejects new admissions permanently after prepare, including custom and queued runs", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.prepareForShutdown();
		await expect(harness.session.prompt("new run")).rejects.toThrow("Session is shutting down");
		await expect(harness.session.sendUserMessage("new user run")).rejects.toThrow("Session is shutting down");
		await expect(
			harness.session.sendCustomMessage(
				{ customType: "late", content: "late", display: false },
				{ triggerTurn: true },
			),
		).rejects.toThrow("Session is shutting down");
		await expect(harness.session.steer("late")).rejects.toThrow("Session is shutting down");
		await expect(harness.session.followUp("late")).rejects.toThrow("Session is shutting down");
		await expect(harness.session.executeBash("echo must-not-run")).rejects.toThrow("Session is shutting down");
		await expect(harness.session.compact()).rejects.toThrow("Session is shutting down");
		await expect(harness.session.reload()).rejects.toThrow("Session is shutting down");
		expect(harness.session.messages).toEqual([]);
	});

	function seedBranch(harness: Harness): { targetId: string; leafId: string | null } {
		harness.sessionManager.appendMessage(userMsg("first prompt"));
		const targetId = harness.sessionManager.appendMessage(assistantMsg("first response"));
		harness.sessionManager.appendMessage(userMsg("abandoned prompt"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned response"));
		harness.session.refreshContext();
		return { targetId, leafId: harness.sessionManager.getLeafId() };
	}

	it("rejects summarized tree navigation after prepare without provider work or branch changes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { targetId, leafId } = seedBranch(harness);
		harness.setResponses([fauxAssistantMessage("must not summarize")]);
		const entries = harness.sessionManager.getEntries().length;
		harness.session.prepareForShutdown();
		await expect(harness.session.navigateTree(targetId, { summarize: true })).rejects.toThrow(
			"Session is shutting down",
		);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getLeafId()).toBe(leafId);
		expect(harness.sessionManager.getEntries()).toHaveLength(entries);
	});

	it("rejects tree navigation when shutdown crosses session_before_tree", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						entered.resolve();
						await release.promise;
						return { summary: { summary: "late extension summary" } };
					});
				},
			],
		});
		harnesses.push(harness);
		const { targetId, leafId } = seedBranch(harness);
		harness.setResponses([fauxAssistantMessage("must not summarize")]);
		const entries = harness.sessionManager.getEntries().length;
		const navigation = harness.session.navigateTree(targetId, { summarize: true });
		await entered.promise;
		harness.session.prepareForShutdown();
		release.resolve();
		await expect(navigation).rejects.toThrow("Session is shutting down");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getLeafId()).toBe(leafId);
		expect(harness.sessionManager.getEntries()).toHaveLength(entries);
	});

	it.each(["prompt", "steer", "followUp"] as const)(
		"rejects %s when input preflight resumes after prepare",
		async (action) => {
			const entered = deferred<void>();
			const release = deferred<void>();
			const harness = await createHarness({
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
			harnesses.push(harness);
			const prompt = harness.session[action]("preflight");
			await entered.promise;
			harness.session.prepareForShutdown();
			release.resolve();
			await expect(prompt).rejects.toThrow("Session is shutting down");
			expect(harness.session.messages).toEqual([]);
		},
	);

	it("stops a prepared run before the first provider request when shutdown crosses before_agent_start", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		const prompt = harness.session.prompt("preparing");
		await entered.promise;
		await harness.session.dispose();
		release.resolve();
		await expect(prompt).rejects.toThrow("Session is shutting down");
		expect(harness.session.messages).toEqual([]);
	});

	it("cancels synchronously but does not await an ignored-abort non-native foreground tool", async () => {
		const { harness, execution } = await harnessWithTool();
		const prompt = harness.session.prompt("foreground");
		await execution.started;
		const disposed = harness.session.dispose();
		expect(execution.signal?.aborted).toBe(true);
		await disposed;
		// Only now permit the JavaScript promise to finish: disposal cannot wait for it.
		execution.finish();
		await prompt;
	});

	it("still cancels detached controllers and suppresses late notifications when an earlier abort hook throws", async () => {
		vi.useFakeTimers();
		const { harness, execution } = await harnessWithTool();
		const prompt = harness.session.prompt("detach");
		await execution.started;
		await vi.advanceTimersByTimeAsync(1000);
		await prompt;
		expect(harness.session.agent.managedExecutions.list()).toHaveLength(1);
		vi.spyOn(harness.session, "abortRetry").mockImplementation(() => {
			throw new Error("abort hook failure");
		});
		const disposed = harness.session.dispose();
		expect(execution.signal?.aborted).toBe(true);
		expect(harness.session.agent.managedExecutions.list()).toEqual([]);
		await disposed;
		const entries = harness.sessionManager.getEntries().length;
		execution.finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.sessionManager.getEntries()).toHaveLength(entries);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("discards background compaction synchronously even when an earlier abort hook throws", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		releaseTools.push(() => release.resolve());
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10000 }],
			tools: [
				{
					name: "pad",
					label: "pad",
					description: "pad",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "p".repeat(2000) }], details: undefined }),
				},
			],
			settings: {
				compaction: {
					enabled: true,
					reserveTokens: 2000,
					keepRecentTokens: 1500,
					background: true,
					backgroundStartRatio: 0.5,
				},
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						signal = event.signal;
						entered.resolve();
						await release.promise;
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			...Array.from({ length: 9 }, () => fauxAssistantMessage(fauxToolCall("pad", {}))),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("start background summary");
		await entered.promise;
		await prompt;
		const background = Reflect.get(harness.session, "_backgroundCompaction") as { settled: Promise<void> };
		vi.spyOn(harness.session, "abortRetry").mockImplementation(() => {
			throw new Error("abort hook failure");
		});
		const disposal = harness.session.dispose();
		expect(signal?.aborted).toBe(true);
		expect(harness.session.isBackgroundCompacting).toBe(false);
		await disposal;
		const entries = harness.sessionManager.getEntries().length;
		const events = harness.events.length;
		release.resolve();
		await background.settled;
		expect(harness.sessionManager.getEntries()).toHaveLength(entries);
		expect(harness.events).toHaveLength(events);
	});

	it.each(["quit", "replacement"] as const)("awaits session disposal before %s follow-through", async (kind) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const services = servicesFor(harness);
		const createRuntime: CreateAgentSessionRuntimeFactory = vi.fn(async ({ sessionManager }) => {
			const successor = await createHarness({ sessionManager });
			harnesses.push(successor);
			return {
				session: successor.session,
				services: servicesFor(successor),
				extensionsResult: successor.session.resourceLoader.getExtensions(),
				diagnostics: [],
			};
		});
		const runtime = new AgentSessionRuntime(harness.session, services, createRuntime);
		const disposalEntered = deferred<void>();
		const finishDisposal = deferred<void>();
		const originalDispose = harness.session.dispose.bind(harness.session);
		vi.spyOn(harness.session, "dispose").mockImplementation(async () => {
			await originalDispose();
			disposalEntered.resolve();
			await finishDisposal.promise;
		});
		const settleWrites = vi.spyOn(services.modelRuntime, "settleCredentialWrites");
		vi.spyOn(harness.session, "abort").mockImplementation(async () => {
			await expect(harness.session.prompt("too late")).rejects.toThrow("Session is shutting down");
		});
		const completion = kind === "quit" ? runtime.dispose() : runtime.newSession();
		await disposalEntered.promise;
		expect(createRuntime).not.toHaveBeenCalled();
		expect(settleWrites).not.toHaveBeenCalled();
		finishDisposal.resolve();
		await completion;
		if (kind === "quit") expect(settleWrites).toHaveBeenCalledOnce();
		else expect(createRuntime).toHaveBeenCalledOnce();
	});

	it("runs managed cleanup and settles credential writes even when runtime teardown throws", async () => {
		vi.useFakeTimers();
		const { harness, execution } = await harnessWithTool();
		const prompt = harness.session.prompt("detach");
		await execution.started;
		await vi.advanceTimersByTimeAsync(1000);
		await prompt;
		const services = servicesFor(harness);
		const runtime = new AgentSessionRuntime(harness.session, services, async () => {
			throw new Error("must not replace after teardown failure");
		});
		const settleWrites = vi.spyOn(services.modelRuntime, "settleCredentialWrites");
		runtime.setBeforeSessionInvalidate(() => {
			throw new Error("teardown hook failure");
		});
		await expect(runtime.dispose()).rejects.toThrow("teardown hook failure");
		expect(execution.signal?.aborted).toBe(true);
		expect(harness.session.agent.managedExecutions.list()).toEqual([]);
		expect(settleWrites).toHaveBeenCalledOnce();
	});
});
