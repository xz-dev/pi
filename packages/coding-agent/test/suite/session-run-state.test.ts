import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("persisted agent run state", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harness(): Promise<Harness> {
		const created = await createHarness({
			settings: { retry: { enabled: false } },
			sessionManagerFactory: (dir) => SessionManager.create(dir, dir),
		});
		harnesses.push(created);
		return created;
	}

	function reopen(created: Harness): SessionManager {
		return SessionManager.open(created.sessionManager.getSessionFile()!, created.tempDir);
	}

	it("records an unfinished run before the first response, without changing the conversation tree", async () => {
		const created = await harness();
		let release = () => {};
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		created.setResponses([
			async () => {
				entered();
				await gate;
				return fauxAssistantMessage("done");
			},
		]);
		const prompt = created.session.prompt("work");
		await started;
		try {
			expect(reopen(created).getInterruptedRun()).toBeDefined();
			expect(created.session.canRetry).toBe(false);
		} finally {
			release();
			await prompt;
		}
		expect(reopen(created).getInterruptedRun()).toBeUndefined();
		expect(created.sessionManager.getLeafEntry()).toMatchObject({ type: "message", message: { role: "assistant" } });
		expect(created.session.canRetry).toBe(false);
		const records = readFileSync(created.sessionManager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.filter((entry) => entry.type === "run_state").map((entry) => entry.state)).toEqual([
			"started",
			"finished",
		]);
	});

	it.each(["abort", "dispose"] as const)("distinguishes explicit %s from an interrupted exit", async (action) => {
		const created = await harness();
		let release = () => {};
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		created.setResponses([
			async () => {
				entered();
				await gate;
				return fauxAssistantMessage("late");
			},
		]);
		const prompt = created.session.prompt("work");
		await started;
		const stopped = action === "abort" ? created.session.abort() : Promise.resolve(created.session.dispose());
		// Cancellation must be durable even before the running provider has settled.
		expect(Boolean(reopen(created).getInterruptedRun())).toBe(action === "dispose");
		release();
		await Promise.allSettled([prompt, stopped]);
		expect(Boolean(reopen(created).getInterruptedRun())).toBe(action === "dispose");
		if (action === "abort") expect(created.session.canRetry).toBe(true);
	});

	it.each(["abort", "settle"] as const)("still becomes idle when %s run-state persistence fails", async (action) => {
		const created = await harness();
		let entered = () => {};
		let release = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		created.setResponses([
			async () => {
				entered();
				await gate;
				return fauxAssistantMessage("done");
			},
		]);
		const prompt = created.session.prompt("work");
		await started;
		const persist = vi.spyOn(created.sessionManager, "appendRunState").mockImplementation(() => {
			throw new Error("run-state disk full");
		});
		let abort: Promise<void> | undefined;
		try {
			if (action === "abort") {
				abort = created.session.abort();
				void abort.catch(() => {});
				expect(created.session.agent.signal?.aborted).toBe(true);
			}
			release();
			await expect(abort ?? prompt).rejects.toThrow("run-state disk full");
			await prompt.catch(() => {});
			expect(created.session.isIdle).toBe(true);
		} finally {
			release();
			await Promise.allSettled([prompt, ...(abort ? [abort] : [])]);
			persist.mockRestore();
		}
	});

	it("can recover again after retry published a sibling response and exit interrupted its tool", async () => {
		let entered = () => {};
		let release = () => {};
		let executions = 0;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tool: AgentTool = {
			name: "pending_work",
			label: "Pending work",
			description: "Controlled local tool",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				entered();
				await gate;
				return { content: [{ type: "text", text: "done" }], details: undefined };
			},
		};
		const created = await createHarness({
			tools: [tool],
			initialActiveToolNames: [tool.name],
			settings: { retry: { enabled: false } },
			sessionManagerFactory: (dir) => SessionManager.create(dir, dir),
		});
		harnesses.push(created);
		created.sessionManager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
		const failedId = created.sessionManager.appendMessage(fauxAssistantMessage("failed", { stopReason: "error" }));
		created.session.refreshContext();
		created.setResponses([
			fauxAssistantMessage([fauxToolCall(tool.name, {}, { id: "pending" })], { stopReason: "toolUse" }),
		]);
		const retry = created.session.retry();
		await started;
		try {
			expect(created.sessionManager.getLeafId()).not.toBe(failedId);
			expect(reopen(created).getInterruptedRun()).toBeDefined();
		} finally {
			created.session.dispose();
			release();
			await retry;
		}
		const restored = await createHarness({
			sessionManager: reopen(created),
			settings: { retry: { enabled: false } },
		});
		harnesses.push(restored);
		restored.session.refreshContext();
		expect(restored.session.canRetry).toBe(true);
		expect(restored.sessionManager.getInterruptedRun()).toBeDefined();
		restored.setResponses([fauxAssistantMessage("recovered")]);
		await restored.session.retry();
		expect(executions).toBe(1);
		expect(restored.sessionManager.getInterruptedRun()).toBeUndefined();
	});

	it.each(["exit", "cancel"] as const)("handles %s during automatic-retry waiting", async (action) => {
		const created = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } },
			sessionManagerFactory: (dir) => SessionManager.create(dir, dir),
		});
		harnesses.push(created);
		let waiting = () => {};
		const ready = new Promise<void>((resolve) => {
			waiting = resolve;
		});
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") waiting();
		});
		created.setResponses([fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "503 overloaded" })]);
		const prompt = created.session.prompt("work");
		await ready;
		expect(created.session.isRetrying).toBe(true);
		expect(reopen(created).getInterruptedRun()).toBeDefined();
		if (action === "cancel") {
			created.session.abortRetry();
			expect(reopen(created).getInterruptedRun()).toBeUndefined();
			await prompt;
			expect(created.session.canRetry).toBe(true);
			return;
		}
		created.session.dispose();
		await prompt;
		const restored = await createHarness({
			sessionManager: reopen(created),
			settings: { retry: { enabled: false } },
		});
		harnesses.push(restored);
		restored.session.refreshContext();
		expect(restored.session.canRetry).toBe(true);
		restored.setResponses([fauxAssistantMessage("after restart")]);
		await restored.session.retry();
		expect(restored.sessionManager.getInterruptedRun()).toBeUndefined();
	});

	it("does not revive earlier runs from another branch or copy their state to a fork", async () => {
		const created = await harness();
		const root = created.sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
		const left = created.sessionManager.appendMessage(fauxAssistantMessage("left", { stopReason: "error" }));
		created.sessionManager.appendRunState("started");
		created.sessionManager.branch(root);
		created.sessionManager.appendMessage(fauxAssistantMessage("right", { stopReason: "error" }));
		expect(reopen(created).getInterruptedRun()).toBeUndefined();
		const rightRun = created.sessionManager.appendRunState("started");
		created.sessionManager.appendRunState("finished", rightRun);
		created.sessionManager.branch(left);
		expect(created.sessionManager.getInterruptedRun()).toBeUndefined();
		created.sessionManager.appendRunState("started");
		const fork = SessionManager.forkFrom(created.sessionManager.getSessionFile()!, created.tempDir, created.tempDir);
		expect(fork.getInterruptedRun()).toBeUndefined();
		expect(fork.getEntries()).toEqual(created.sessionManager.getEntries());
	});

	it("keeps retry history atomic while recording recovery failure as terminal", async () => {
		const created = await harness();
		created.sessionManager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
		created.sessionManager.appendMessage(fauxAssistantMessage("failed", { stopReason: "error" }));
		created.session.refreshContext();
		const leaf = created.sessionManager.getLeafId();
		const generation = created.sessionManager.getGeneration();
		const entries = created.sessionManager.getEntries();
		created.session.agent.streamFunction = async () => {
			throw new Error("provider failed");
		};
		expect(created.session.canRetry).toBe(true);
		await expect(created.session.retry()).rejects.toThrow("provider failed");
		expect(created.sessionManager.getLeafId()).toBe(leaf);
		expect(created.sessionManager.getGeneration()).toBe(generation);
		expect(created.sessionManager.getEntries()).toEqual(entries);
		expect(reopen(created).getInterruptedRun()).toBeUndefined();
	});
});
