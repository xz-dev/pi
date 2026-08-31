import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, ManagedExecutionCancelResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { collectSettingsDiagnostics } from "../../src/core/settings-diagnostics.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createAllTools, createToolTaskTool } from "../../src/core/tools/index.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionFactory } from "../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

type ManagedExecutionStatus = "running" | "completed" | "error" | "cancel_requested";

type ManagedExecutionInfo = {
	id: string;
	toolName: string;
	toolCallId: string;
	status: ManagedExecutionStatus;
};

type ManagedWaitResult = {
	content: Array<{ type: string; text?: string }>;
	details: unknown;
	isError: boolean;
};

type ManagedExecutionsApi = {
	list(): ManagedExecutionInfo[];
	info(id: string): ManagedExecutionInfo | undefined;
	wait(id: string, timeoutSeconds: number): Promise<ManagedWaitResult>;
	cancel(id: string): ManagedExecutionCancelResult;
};

function managedFromSession(session: { agent: { managedExecutions?: ManagedExecutionsApi } }): ManagedExecutionsApi {
	expect(session.agent.managedExecutions, "Agent.managedExecutions public registry").toBeDefined();
	return session.agent.managedExecutions!;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
	return (
		result?.content
			?.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n") ?? ""
	);
}

function toolResults(session: Harness["session"]) {
	return session.messages.filter((message) => message.role === "toolResult");
}

function createDeferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

const emptySchema = Type.Object({});

async function expectSettled(promise: Promise<unknown>, label: string): Promise<void> {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let i = 0; i < 20; i++) {
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
	}
	expect(settled, label).toBe(true);
}

function hangTool(name: string): {
	tool: AgentTool;
	started: ReturnType<typeof createDeferred<void>>;
	finish: ReturnType<typeof createDeferred<{ text: string; error?: boolean }>>;
} {
	const started = createDeferred<void>();
	const finish = createDeferred<{ text: string; error?: boolean }>();
	hangCleanups.push(() => finish.resolve({ text: "cleanup", error: true }));
	return {
		started,
		finish,
		tool: {
			name,
			label: name,
			description: `${name} hangs`,
			parameters: emptySchema,
			execute: async () => {
				started.resolve(undefined);
				const outcome = await finish.promise;
				if (outcome.error) throw new Error(outcome.text);
				return { content: [{ type: "text", text: outcome.text }], details: { text: outcome.text } };
			},
		},
	};
}

const hangCleanups: Array<() => void> = [];

describe("coding-agent managed tool executions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (hangCleanups.length > 0) {
			hangCleanups.pop()?.();
		}
		vi.useRealTimers();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("registers tool_task by default and never detaches it", async () => {
		vi.useFakeTimers();
		const hang = hangTool("hang");
		const harness = await createHarness({
			tools: [hang.tool],
			settings: { backgroundToolCalls: { hang: { detachAfterSeconds: 1 } } },
		});
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).toContain("tool_task");
		expect(harness.session.getAllTools().some((tool) => tool.name === "tool_task")).toBe(true);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hang", {}, { id: "call-hang" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("tool_task", { action: "list" }, { id: "call-task" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("listed"),
		]);
		const promptPromise = harness.session.prompt("run hang");
		await hang.started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(promptPromise, "session prompt released after detach");

		const toolTaskResult = toolResults(harness.session).find((message) => message.toolCallId === "call-task");
		expect(toolTaskResult).toBeDefined();
		expect(JSON.stringify(toolTaskResult)).not.toContain("secret-output");
		expect(managedFromSession(harness.session).list()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(600_000);
		expect(managedFromSession(harness.session).list()[0]?.status).toBe("running");
		hang.finish.resolve({ text: "secret-output" });
	});

	it("reports tool_task cancellation dispositions truthfully", async () => {
		const dispositions = new Map<string, ManagedExecutionCancelResult>([
			["running", { disposition: "requested", status: "cancel_requested" }],
			["repeated", { disposition: "already_requested", status: "cancel_requested" }],
			["completed", { disposition: "already_terminal", status: "completed" }],
			["error", { disposition: "already_terminal", status: "error" }],
		]);
		const tool = createToolTaskTool({
			list: () => [],
			info: () => undefined,
			wait: async () => {
				throw new Error("not used");
			},
			cancel: (id) => {
				const result = dispositions.get(id);
				if (!result) throw new Error(`Unknown managed tool execution: ${id}`);
				return result;
			},
		});

		const requested = await tool.execute("cancel-running", { action: "cancel", id: "running" });
		expect(requested.details).toEqual({
			id: "running",
			disposition: "requested",
			status: "cancel_requested",
			cancellationRequested: true,
		});
		expect(textOf(requested)).toContain("Cancellation requested");

		const repeated = await tool.execute("cancel-repeated", { action: "cancel", id: "repeated" });
		expect(repeated.details).toEqual({
			id: "repeated",
			disposition: "already_requested",
			status: "cancel_requested",
			cancellationRequested: false,
		});
		expect(textOf(repeated)).toContain("already requested");

		for (const status of ["completed", "error"] as const) {
			const terminal = await tool.execute(`cancel-${status}`, { action: "cancel", id: status });
			expect(terminal.details).toEqual({
				id: status,
				disposition: "already_terminal",
				status,
				cancellationRequested: false,
			});
			expect(textOf(terminal)).toContain(`already ${status}`);
			expect(textOf(terminal)).toContain("no cancellation request was sent");
		}
	});

	it("rejects invalid wait arguments through tool_task and returns cached error via wait's own result", async () => {
		vi.useFakeTimers();
		const hang = hangTool("hang");
		const harness = await createHarness({
			tools: [hang.tool],
			settings: { backgroundToolCalls: { hang: { detachAfterSeconds: 1 } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hang", {}, { id: "call-hang" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("detached"),
		]);
		const firstPrompt = harness.session.prompt("run hang");
		await hang.started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(firstPrompt, "session prompt released after detach");
		const taskId = managedFromSession(harness.session).list()[0]!.id;

		harness.appendResponses([
			fauxAssistantMessage(fauxToolCall("tool_task", { action: "wait", id: taskId }, { id: "wait-missing" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("tool_task", { action: "wait", id: taskId, timeoutSeconds: 0 }, { id: "wait-zero" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("tool_task", { action: "wait", id: taskId, timeoutSeconds: 1801 }, { id: "wait-too-long" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("tool_task", { action: "wait", id: taskId, timeoutSeconds: 30 }, { id: "wait-ok" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("tool_task", { action: "wait", id: taskId, timeoutSeconds: 1 }, { id: "wait-repeat" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("after repeat"),
		]);

		const waitPrompt = harness.session.prompt("wait for hang");
		await vi.advanceTimersByTimeAsync(0);
		hang.finish.resolve({ text: "late-error", error: true });
		await waitPrompt;

		const missing = toolResults(harness.session).find((message) => message.toolCallId === "wait-missing");
		const zero = toolResults(harness.session).find((message) => message.toolCallId === "wait-zero");
		const tooLong = toolResults(harness.session).find((message) => message.toolCallId === "wait-too-long");
		const ok = toolResults(harness.session).find((message) => message.toolCallId === "wait-ok");
		const repeat = toolResults(harness.session).find((message) => message.toolCallId === "wait-repeat");
		expect(missing?.isError).toBe(true);
		expect(zero?.isError).toBe(true);
		expect(tooLong?.isError).toBe(true);
		expect(ok?.isError).toBe(true);
		expect(textOf(ok)).toContain("late-error");
		expect(textOf(repeat)).toContain("late-error");
		expect(toolResults(harness.session).filter((message) => message.toolCallId === "call-hang")).toHaveLength(1);
	});

	it("steers a trusted completion notice without raw output, then starts a turn when idle", async () => {
		vi.useFakeTimers();
		const hang = hangTool("hang");
		const harness = await createHarness({
			tools: [hang.tool],
			settings: { backgroundToolCalls: { hang: { detachAfterSeconds: 1 } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hang", {}, { id: "call-hang" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("detached"),
			(context) => {
				const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
				const text =
					typeof lastUser?.content === "string"
						? lastUser.content
						: lastUser?.content
								?.filter((part) => part.type === "text")
								.map((part) => ("text" in part ? part.text : ""))
								.join("\n");
				expect(text).toBeDefined();
				expect(text).toMatch(/tool_task/i);
				expect(text).not.toContain("secret-output");
				return fauxAssistantMessage("noticed completion");
			},
		]);

		const promptPromise = harness.session.prompt("run hang");
		await hang.started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(promptPromise, "session prompt released after detach");
		const taskId = managedFromSession(harness.session).list()[0]!.id;

		hang.finish.resolve({ text: "secret-output" });
		await vi.advanceTimersByTimeAsync(0);
		await harness.session.agent.waitForIdle();

		expect(getMessageText(harness.session.messages.at(-1))).toContain("noticed completion");
		const noticeText = harness.session.messages
			.filter((message) => message.role === "user" || message.role === "custom")
			.map((message) => getMessageText(message))
			.join("\n");
		expect(noticeText).toContain(taskId);
		expect(noticeText).not.toContain("secret-output");
	});

	it("queues a trusted completion notice while the agent is busy and does not notify after dispose", async () => {
		vi.useFakeTimers();
		const hang = hangTool("hang");
		const busy = hangTool("busy");
		const harness = await createHarness({
			tools: [hang.tool, busy.tool],
			settings: { backgroundToolCalls: { hang: { detachAfterSeconds: 1 } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hang", {}, { id: "call-hang" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("detached"),
			fauxAssistantMessage(fauxToolCall("busy", {}, { id: "call-busy" }), { stopReason: "toolUse" }),
			(context) => {
				const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
				const text =
					typeof lastUser?.content === "string"
						? lastUser.content
						: lastUser?.content
								?.filter((part) => part.type === "text")
								.map((part) => ("text" in part ? part.text : ""))
								.join("\n");
				expect(text).not.toContain("secret-output");
				expect(text).toMatch(/tool_task/i);
				return fauxAssistantMessage("steered after busy");
			},
			fauxAssistantMessage("busy done"),
		]);

		const first = harness.session.prompt("run hang");
		await hang.started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(first, "session prompt released after detach");

		const second = harness.session.prompt("keep busy");
		await busy.started.promise;
		hang.finish.resolve({ text: "secret-output" });
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.session.agent.state.isStreaming).toBe(true);

		busy.finish.resolve({ text: "busy-done" });
		await second;
		expect(getMessageText(harness.session.messages.at(-1))).toContain("steered after busy");

		const disposedHang = hangTool("hang");
		const disposed = await createHarness({
			tools: [disposedHang.tool],
			settings: { backgroundToolCalls: { hang: { detachAfterSeconds: 1 } } },
		});
		harnesses.push(disposed);
		disposed.setResponses([
			fauxAssistantMessage(fauxToolCall("hang", {}, { id: "call-disposed" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("detached"),
			fauxAssistantMessage("should-not-run"),
		]);
		const disposedPrompt = disposed.session.prompt("run hang");
		await disposedHang.started.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(disposedPrompt, "disposed session prompt released after detach");
		disposed.session.dispose();
		disposedHang.finish.resolve({ text: "late-secret" });
		await vi.advanceTimersByTimeAsync(0);
		expect(disposed.getPendingResponseCount()).toBe(1);
	});

	it("does not background user ! shell or timeout === 1200; backgrounds omitted and >1200 AI shell timeouts", async () => {
		vi.useFakeTimers();
		const pending = new Map<string, ReturnType<typeof createDeferred<void>>>();
		hangCleanups.push(() => {
			for (const gate of pending.values()) gate.resolve(undefined);
		});
		const operations = {
			exec: async (command: string) => {
				const gate = pending.get(command) ?? createDeferred<void>();
				pending.set(command, gate);
				await gate.promise;
				return { exitCode: 0 };
			},
		};
		const tools = createAllTools(process.cwd(), {
			bash: { operations },
			powershell: { operations },
		});
		const harness = await createHarness({
			tools: [tools.bash, tools.powershell],
		});
		harnesses.push(harness);

		await harness.session.executeBash("echo user-shell");
		expect(managedFromSession(harness.session).list()).toEqual([]);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo boundary", timeout: 1200 }, { id: "bash-1200" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("boundary done"),
		]);
		const boundaryPrompt = harness.session.prompt("boundary timeout");
		await vi.advanceTimersByTimeAsync(600_000);
		expect(harness.session.agent.state.isStreaming).toBe(true);
		pending.get("echo boundary")?.resolve(undefined);
		await boundaryPrompt;
		expect(toolResults(harness.session).find((message) => message.toolCallId === "bash-1200")?.details).not.toEqual(
			expect.objectContaining({ taskId: expect.any(String) }),
		);

		harness.appendResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo long", timeout: 1201 }, { id: "bash-1201" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("powershell", { command: "echo ps" }, { id: "ps-omit" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ps detached"),
		]);
		const detachPrompt = harness.session.prompt("detach shells");
		await vi.advanceTimersByTimeAsync(600_000);
		pending.get("echo long")?.resolve(undefined);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(600_000);
		await expectSettled(detachPrompt, "AI shell prompt released after default detach");
		expect(toolResults(harness.session).find((message) => message.toolCallId === "bash-1201")?.details).toEqual(
			expect.objectContaining({ taskId: expect.any(String) }),
		);
		expect(toolResults(harness.session).find((message) => message.toolCallId === "ps-omit")?.details).toEqual(
			expect.objectContaining({ taskId: expect.any(String) }),
		);
	});

	it("diagnoses invalid backgroundToolCalls without replacing the last valid config", async () => {
		const tempDir = join(tmpdir(), `pi-managed-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ backgroundToolCalls: { hang: { detachAfterSeconds: 12 } } }));

		const manager = SettingsManager.create(tempDir, agentDir);
		expect(manager.getBackgroundToolCalls()).toEqual({ hang: { detachAfterSeconds: 12 } });

		writeFileSync(settingsPath, JSON.stringify({ backgroundToolCalls: { hang: { detachAfterSeconds: 0 } } }));
		await manager.reload();
		expect(manager.getBackgroundToolCalls()).toEqual({ hang: { detachAfterSeconds: 12 } });
		expect(collectSettingsDiagnostics(manager).some((item) => /backgroundToolCalls/i.test(item.message))).toBe(true);
	});
});

describe("managed execution session lifecycle", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (hangCleanups.length > 0) {
			hangCleanups.pop()?.();
		}
		vi.useRealTimers();
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-managed-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		faux.setResponses([fauxAssistantMessage("startup")]);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const settingsManager = SettingsManager.inMemory({
			backgroundToolCalls: { hang: { detachAfterSeconds: 1 } },
		});
		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			settingsManager,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const runtime = await createAgentSessionRuntime(
			async ({ cwd, sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
				return {
					...(await createAgentSessionFromServices({
						services,
						sessionManager,
						sessionStartEvent,
						model: runtimeOptions.model,
					})),
					services,
					diagnostics: services.diagnostics,
				};
			},
			{
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.create(tempDir),
			},
		);
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
		});
		return { runtime, faux };
	}

	it("preserves added tool metadata when a detached extension tool completes after reload", async () => {
		const changedTools = createDeferred<void>();
		const finish = createDeferred<string>();
		hangCleanups.push(() => finish.resolve("cleanup"));
		const harness = await createHarness({
			settings: { backgroundToolCalls: { hang: { detachAfterSeconds: 1 } } },
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "hang",
						label: "hang",
						description: "adds a tool, then hangs",
						parameters: emptySchema,
						execute: async () => {
							pi.setActiveTools([...pi.getActiveTools(), "after_load"]);
							changedTools.resolve(undefined);
							const text = await finish.promise;
							return { content: [{ type: "text", text }], details: { text } };
						},
					});
					pi.registerTool({
						name: "after_load",
						label: "after_load",
						description: "tool added by hang",
						parameters: emptySchema,
						execute: async () => ({ content: [{ type: "text", text: "after" }], details: {} }),
					});
				},
			],
		});
		cleanups.push(() => harness.cleanup());

		harness.session.setActiveToolsByName(["hang", "tool_task"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hang", {}, { id: "call-hang" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("detached"),
		]);
		const promptPromise = harness.session.prompt("run hang");
		await changedTools.promise;
		await promptPromise;
		const taskId = managedFromSession(harness.session).list()[0]!.id;

		await harness.session.reload();
		harness.session.agent.managedExecutions.setCompletionHandler(undefined);
		expect(harness.session.getActiveToolNames()).toContain("after_load");

		finish.resolve("completed after reload");
		const cachedOutcome = await managedFromSession(harness.session).wait(taskId, 1);
		expect((cachedOutcome as { addedToolNames?: string[] }).addedToolNames).toContain("after_load");
	}, 10_000);

	it("preserves managed executions across reload and cancels them on newSession", async () => {
		vi.useFakeTimers();
		const hangStarted = createDeferred<void>();
		const hangAbort = { current: false };
		const hangFinish = createDeferred<string>();
		hangCleanups.push(() => hangFinish.resolve("cleanup"));
		const { runtime, faux } = await createRuntimeForTest((pi) => {
			pi.registerTool({
				name: "hang",
				label: "hang",
				description: "hangs",
				parameters: emptySchema,
				execute: (_toolCallId, _params, signal) =>
					new Promise<AgentToolResult<unknown>>((resolve) => {
						hangStarted.resolve(undefined);
						signal?.addEventListener("abort", () => {
							hangAbort.current = true;
							resolve({ content: [{ type: "text", text: "aborted" }], details: {} });
						});
						void hangFinish.promise.then((text) => {
							resolve({ content: [{ type: "text", text }], details: { text } });
						});
					}),
			});
		});

		await runtime.session.prompt("startup");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("hang", {}, { id: "call-hang" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("detached"),
		]);
		const promptPromise = runtime.session.prompt("run hang");
		await hangStarted.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await expectSettled(promptPromise, "session prompt released after detach");
		const beforeReload = managedFromSession(runtime.session).list();
		expect(beforeReload).toHaveLength(1);

		await runtime.session.reload();
		expect(hangAbort.current).toBe(false);
		expect(
			managedFromSession(runtime.session)
				.list()
				.map((task) => task.id),
		).toEqual([beforeReload[0]!.id]);

		await runtime.newSession();
		await vi.advanceTimersByTimeAsync(0);
		expect(hangAbort.current).toBe(true);
		expect(managedFromSession(runtime.session).list()).toEqual([]);
	});
});
