import {
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { type SessionFileOperations, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

type SessionWithExtensionEmitHook = {
	_emitExtensionEvent: (event: AgentEvent) => Promise<void>;
	_replaceMessageInPlace: (target: AgentMessage, replacement: AgentMessage) => void;
};

describe("AgentSession retry", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-retry-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(options?: {
		failCount?: number;
		maxRetries?: number;
		delayAssistantMessageEndMs?: number;
	}) {
		const failCount = options?.failCount ?? 1;
		const maxRetries = options?.maxRetries ?? 3;
		const delayAssistantMessageEndMs = options?.delayAssistantMessageEndMs ?? 0;
		let callCount = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount <= failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		if (delayAssistantMessageEndMs > 0) {
			const sessionWithHook = session as unknown as SessionWithExtensionEmitHook;
			const original = sessionWithHook._emitExtensionEvent.bind(sessionWithHook);
			sessionWithHook._emitExtensionEvent = async (event: AgentEvent) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					await new Promise((resolve) => setTimeout(resolve, delayAssistantMessageEndMs));
				}
				await original(event);
			};
		}

		return { session, getCallCount: () => callCount };
	}

	it("retries after a transient error and succeeds", async () => {
		const created = await createSession({ failCount: 1 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(created.session.isRetrying).toBe(false);
	});

	it("exhausts max retries and emits failure", async () => {
		const created = await createSession({ failCount: 99, maxRetries: 2 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(3);
		expect(events).toContain("start:1");
		expect(events).toContain("start:2");
		expect(events).toContain("end:success=false");
		expect(created.session.isRetrying).toBe(false);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const created = await createSession({ failCount: 1, delayAssistantMessageEndMs: 40 });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.isRetrying).toBe(false);
	});

	it("retries provider network_error failures", async () => {
		const created = await createSession({ failCount: 0 });
		let callCount = 0;
		const streamFn = () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Provider finish_reason: network_error",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
					return;
				}

				const msg = createAssistantMessage("Recovered after retry");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		};
		created.session.dispose();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");

		expect(callCount).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
	});

	it("prompt waits for full agent loop when retry produces tool calls", async () => {
		// Regression: when auto-retry fires and the retry response includes tool_use,
		// session.prompt() must wait for the entire tool loop to finish before returning.
		// Previously, _resolveRetry() on the first successful message_end would unblock
		// waitForRetry() while the agent was still executing tools.
		let callCount = 0;
		const toolExecuted = { value: false };

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted.value = true;
				return { content: [{ type: "text", text: "echoed" }], details: undefined };
			},
		};

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						// First call: overloaded error
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else if (callCount === 2) {
						// Second call (retry): text + tool_use
						const msg: AssistantMessage = {
							...createAssistantMessage("Looking that up now."),
							stopReason: "toolUse",
							content: [
								{ type: "text", text: "Looking that up now." },
								{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hello" } },
							],
						};
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						// Third call (after tool result): final response
						const msg = createAssistantMessage("Final answer.");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { echo: echoTool },
		});

		await session.prompt("Test");

		// All three LLM calls must have completed
		expect(callCount).toBe(3);
		// Tool must have been executed
		expect(toolExecuted.value).toBe(true);
		// Agent must not be streaming after prompt returns
		expect(session.isStreaming).toBe(false);
		// A follow-up prompt must work (no "Agent is already processing" error)
		await session.prompt("Follow-up");
		expect(callCount).toBe(4);
	});

	it("keeps the retry pending admission out of idle and waits for abort-aware setup", async () => {
		const created = await createSession({ failCount: 1, maxRetries: 0 });
		await created.session.prompt("Test");
		let releaseTransform: (() => void) | undefined;
		created.session.agent.transformContext = async (messages, signal) => {
			await new Promise<void>((resolve) => {
				releaseTransform = resolve;
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			if (signal?.aborted) throw new Error("aborted");
			return messages;
		};

		const retry = created.session.retry();
		await vi.waitFor(() => expect(created.session.isIdle).toBe(false));
		let idleResolved = false;
		const idle = created.session.waitForIdle().then(() => {
			idleResolved = true;
		});
		await created.session.abort();
		await idle;
		expect(idleResolved).toBe(true);
		expect(created.session.isIdle).toBe(true);
		releaseTransform?.();
		await expect(retry).rejects.toThrow("aborted");
	});

	it("keeps manual retry owned until an aborted in-flight converter resolves", async () => {
		const created = await createSession({ failCount: 1, maxRetries: 0 });
		await created.session.prompt("Test");
		let releaseConversion = () => {};
		const conversionStarted = new Promise<void>((resolveStarted) => {
			created.session.agent.convertToLlm = async (messages) => {
				resolveStarted();
				await new Promise<void>((resolve) => {
					releaseConversion = resolve;
				});
				return convertToLlm(messages);
			};
		});
		let providerCalls = 0;
		created.session.agent.streamFunction = () => {
			providerCalls++;
			return new MockAssistantStream();
		};
		const lifecycleEvents: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "agent_start" || event.type === "turn_start" || event.type === "agent_settled") {
				lifecycleEvents.push(event.type);
			}
		});

		const retry = created.session.retry();
		await conversionStarted;
		const abort = created.session.abort();
		let idleResolved = false;
		const idle = created.session.waitForIdle().then(() => {
			idleResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(created.session.isIdle).toBe(false);
		expect(idleResolved).toBe(false);
		expect(lifecycleEvents).toEqual([]);
		expect(() => created.session.dispose()).toThrow("manual retry is in progress");

		releaseConversion();
		await expect(retry).rejects.toThrow("This operation was aborted");
		await abort;
		await idle;
		expect(created.session.isIdle).toBe(true);
		expect(providerCalls).toBe(0);
		expect(lifecycleEvents).toEqual([]);
		await new Promise((resolve) => setImmediate(resolve));
		expect(lifecycleEvents).toEqual([]);
	});

	it("waits for an in-flight assistant replacement after abort before settling retry state", async () => {
		await createSession({ failCount: 1, maxRetries: 0 });
		await session.prompt("Test");
		const failedLeaf = session.sessionManager.getLeafId();
		let resolveReplacementStarted = () => {};
		const replacementStarted = new Promise<void>((resolve) => {
			resolveReplacementStarted = resolve;
		});
		let resolveReleaseReplacement = () => {};
		const releaseReplacement = new Promise<void>((resolve) => {
			resolveReleaseReplacement = resolve;
		});
		const originalEmit = (session as unknown as SessionWithExtensionEmitHook)._emitExtensionEvent.bind(session);
		(session as unknown as SessionWithExtensionEmitHook)._emitExtensionEvent = async (event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "stop"
			) {
				resolveReplacementStarted();
				await releaseReplacement;
				(session as unknown as SessionWithExtensionEmitHook)._replaceMessageInPlace(event.message, {
					...event.message,
					content: [{ type: "text", text: "extension replacement" }],
				});
				return;
			}
			await originalEmit(event);
		};
		const events: AgentEvent[] = [];
		session.subscribe((event) => {
			if ("messages" in event || "message" in event || event.type === "agent_start" || event.type === "turn_start") {
				events.push(event as AgentEvent);
			}
		});

		const retryPromise = session.retry();
		await replacementStarted;
		const abortPromise = session.abort();
		let settled = false;
		void Promise.all([retryPromise, abortPromise]).then(() => {
			settled = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);

		resolveReleaseReplacement();
		await Promise.all([retryPromise, abortPromise]);

		const terminalAttempts = events.filter(
			(event) => event.type === "agent_end" && event.messages.some((message) => message.role === "assistant"),
		);
		expect(terminalAttempts).toHaveLength(1);
		expect(session.sessionManager.getLeafId()).not.toBe(failedLeaf);
		expect(session.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "extension replacement" }] });
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			content: [{ type: "text", text: "extension replacement" }],
		});
	});

	it.each(["open", "chmod", "write", "flush", "close", "rename"] as const)(
		"reports and reconciles a post-admission $s persistence failure",
		async (faultSeam) => {
			const model = getModel("anthropic", "claude-sonnet-4-5")!;
			let providerCalls = 0;
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "Test", tools: [] },
				streamFn: () => {
					providerCalls++;
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						const message =
							providerCalls === 1
								? createAssistantMessage("", { stopReason: "error", errorMessage: "fatal" })
								: createAssistantMessage("retry result");
						stream.push(
							message.stopReason === "error"
								? { type: "error", reason: "error", error: message }
								: { type: "done", reason: "stop", message },
						);
					});
					return stream;
				},
			});
			let faultPending = true;
			const failAt = (seam: typeof faultSeam): void => {
				if (faultPending && seam === faultSeam) {
					faultPending = false;
					throw new Error(`injected ${faultSeam} failure`);
				}
			};
			const operations: SessionFileOperations = {
				open: (path, flags, mode) => {
					failAt("open");
					return openSync(path, flags, mode);
				},
				chmod: (fd, mode) => {
					failAt("chmod");
					fchmodSync(fd, mode);
				},
				write: (fd, contents) => {
					failAt("write");
					writeFileSync(fd, contents);
				},
				flush: (fd) => {
					failAt("flush");
					fsyncSync(fd);
				},
				close: (fd) => {
					failAt("close");
					closeSync(fd);
				},
				rename: (from, to) => {
					failAt("rename");
					renameSync(from, to);
				},
				remove: (path) => unlinkSync(path),
			};
			const sessionManager = SessionManager.createForTesting(tempDir, tempDir, operations);
			faultPending = true;
			const settingsManager = SettingsManager.create(tempDir, tempDir);
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			const modelRegistry = await createModelRegistry(authStorage, tempDir);
			await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
			settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } });
			session = new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd: tempDir,
				modelRuntime: getModelRuntime(modelRegistry),
				resourceLoader: createTestResourceLoader(),
			});
			await session.prompt("Test");
			const sessionFile = sessionManager.getSessionFile()!;
			const bytesBefore = readFileSync(sessionFile);
			const entriesBefore = sessionManager.getEntries();
			const leafBefore = sessionManager.getLeafId();
			const lifecycleEvents: Array<{ type: string; [key: string]: unknown }> = [];
			const settledSnapshots: Array<{ leafId: string | null; idle: boolean; messages: AgentMessage[] }> = [];
			session.subscribe((event) => {
				lifecycleEvents.push(event as { type: string; [key: string]: unknown });
				if (event.type === "agent_settled") {
					settledSnapshots.push({
						leafId: session.sessionManager.getLeafId(),
						idle: session.isIdle,
						messages: session.messages,
					});
				}
			});
			await expect(session.retry()).rejects.toThrow(`injected ${faultSeam} failure`);

			expect(lifecycleEvents.filter((event) => event.type === "agent_operation_error")).toEqual([
				{
					type: "agent_operation_error",
					operation: "manual_retry",
					phase: "post_admission_persistence",
					errorMessage: `injected ${faultSeam} failure`,
				},
			]);
			expect(
				lifecycleEvents
					.filter((event) => event.type === "agent_operation_error" || event.type === "agent_settled")
					.map((event) => event.type),
			).toEqual(["agent_operation_error", "agent_settled"]);
			expect(settledSnapshots).toEqual([
				{ leafId: leafBefore, idle: true, messages: sessionManager.buildSessionContext().messages },
			]);
			expect(session.isIdle).toBe(true);
			expect(readFileSync(sessionFile)).toEqual(bytesBefore);
			expect(sessionManager.getEntries()).toEqual(entriesBefore);
			expect(sessionManager.getLeafId()).toBe(leafBefore);
			expect(sessionManager.getEntries()).toHaveLength(entriesBefore.length);
			expect(session.agent.state.messages).toEqual(sessionManager.buildSessionContext().messages);
			expect(readdirSync(tempDir).some((name) => name.endsWith(".retry.tmp"))).toBe(false);
			const reopenedAfterFailure = SessionManager.open(sessionFile);
			expect(reopenedAfterFailure.getEntries()).toEqual(entriesBefore);
			expect(reopenedAfterFailure.getLeafId()).toBe(leafBefore);

			await session.retry();
			expect(sessionManager.getLeafEntry()).toMatchObject({
				type: "message",
				parentId: entriesBefore.at(-1)?.parentId,
				message: { role: "assistant", stopReason: "stop" },
			});
		},
	);

	it("keeps the original leaf until the first retry assistant is durably appended", async () => {
		const created = await createSession({ failCount: 1, maxRetries: 0 });
		await created.session.prompt("Test");
		const failedLeafId = created.session.sessionManager.getLeafId();
		const entriesBefore = created.session.sessionManager.getEntries();
		let releaseProvider: (() => void) | undefined;
		created.session.agent.streamFunction = () => {
			const stream = new MockAssistantStream();
			new Promise<void>((resolve) => {
				releaseProvider = resolve;
			}).then(() => {
				const message = createAssistantMessage("retry result");
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const retry = created.session.retry();
		await vi.waitFor(() => expect(releaseProvider).toBeTypeOf("function"));

		expect(created.session.sessionManager.getLeafId()).toBe(failedLeafId);
		expect(created.session.sessionManager.getEntries()).toEqual(entriesBefore);
		releaseProvider?.();
		await retry;
	});

	it("rejects public mutations before side effects while retry setup owns the session", async () => {
		const created = await createSession({ failCount: 1, maxRetries: 0 });
		await created.session.prompt("Test");
		const entriesBefore = created.session.sessionManager.getEntries();
		const thinkingBefore = created.session.thinkingLevel;
		const toolsBefore = created.session.getActiveToolNames();
		let releaseTransform: (() => void) | undefined;
		created.session.agent.transformContext = async (messages) => {
			await new Promise<void>((resolve) => {
				releaseTransform = resolve;
			});
			return messages;
		};
		const retry = created.session.retry();
		await vi.waitFor(() => expect(releaseTransform).toBeTypeOf("function"));

		expect(() => created.session.setThinkingLevel("high")).toThrow("manual retry is in progress");
		expect(() => created.session.setActiveToolsByName([])).toThrow("manual retry is in progress");
		await expect(
			created.session.sendCustomMessage({ customType: "blocked", content: "blocked", display: true }),
		).rejects.toThrow("manual retry is in progress");
		await expect(created.session.executeBash("echo blocked")).rejects.toThrow("manual retry is in progress");
		expect(() => created.session.dispose()).toThrow("manual retry is in progress");
		await expect(created.session.navigateTree(entriesBefore[0]!.id)).rejects.toThrow("manual retry is in progress");
		expect(created.session.thinkingLevel).toBe(thinkingBefore);
		expect(created.session.getActiveToolNames()).toEqual(toolsBefore);
		expect(created.session.sessionManager.getEntries()).toEqual(entriesBefore);

		releaseTransform?.();
		await retry;
	});

	it("rejects retry admission when messages are queued without consuming the queue", async () => {
		const created = await createSession({ failCount: 1, maxRetries: 0 });
		await created.session.prompt("Test");
		created.session.agent.followUp({ role: "user", content: "queued", timestamp: Date.now() });

		await expect(created.session.retry()).rejects.toThrow("messages are queued");

		expect(created.session.agent.hasQueuedMessages()).toBe(true);
		expect(created.getCallCount()).toBe(1);
	});

	it("retries a terminal error as a sibling without adding a user or custom message", async () => {
		const created = await createSession({ failCount: 1, maxRetries: 0 });

		await created.session.prompt("Test");
		const failedLeaf = created.session.sessionManager.getLeafEntry();
		expect(failedLeaf).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "error" } });
		const failedParentId = failedLeaf?.parentId;
		expect(failedParentId).toBeTruthy();

		await created.session.retry();

		expect(created.getCallCount()).toBe(2);
		const retriedLeaf = created.session.sessionManager.getLeafEntry();
		expect(retriedLeaf).toMatchObject({
			type: "message",
			parentId: failedParentId,
			message: { role: "assistant", stopReason: "stop" },
		});
		expect(retriedLeaf?.id).not.toBe(failedLeaf?.id);
		expect(created.session.messages).toHaveLength(2);
		expect(created.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(created.session.messages.some((message) => message.role === "custom")).toBe(false);
	});

	it("retries an aborted terminal response", async () => {
		const created = await createSession({ failCount: 1, maxRetries: 0 });
		created.session.setAutoRetryEnabled(false);
		let callCount = 0;
		created.session.agent.streamFunction = () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message =
					callCount === 1
						? createAssistantMessage("", { stopReason: "aborted" })
						: createAssistantMessage("Recovered");
				stream.push({ type: "start", partial: message });
				stream.push(
					message.stopReason === "aborted"
						? { type: "error", reason: "aborted", error: message }
						: { type: "done", reason: "stop", message },
				);
			});
			return stream;
		};

		await created.session.prompt("Test");
		await created.session.retry();

		expect(callCount).toBe(2);
		expect(created.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("rejects retry while active or when the branch tail is not retryable", async () => {
		const created = await createSession({ failCount: 0, maxRetries: 0 });

		await expect(created.session.retry()).rejects.toThrow("Nothing to retry");
		let release: (() => void) | undefined;
		created.session.agent.streamFunction = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				new Promise<void>((resolve) => {
					release = resolve;
				}).then(() => {
					const message = createAssistantMessage("done");
					stream.push({ type: "done", reason: "stop", message });
				});
			});
			return stream;
		};
		const prompt = created.session.prompt("Test");
		await vi.waitFor(() => expect(created.session.isStreaming).toBe(true));
		await expect(created.session.retry()).rejects.toThrow("Cannot retry while an agent response is running");
		release?.();
		await prompt;
		await expect(created.session.retry()).rejects.toThrow("Nothing to retry");
	});

	it("rejects concurrent retries while the first retry owns the run", async () => {
		const created = await createSession({ failCount: 1, maxRetries: 0 });
		await created.session.prompt("Test");
		let release: (() => void) | undefined;
		created.session.agent.streamFunction = () => {
			const stream = new MockAssistantStream();
			new Promise<void>((resolve) => {
				release = resolve;
			}).then(() => {
				const message = createAssistantMessage("done");
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const firstRetry = created.session.retry();
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		await expect(created.session.retry()).rejects.toThrow("Cannot retry");
		release?.();
		await firstRetry;
	});

	it("preserves trailing settings as audit history and reopens the retry branch with current thinking", async () => {
		const created = await createSession({ failCount: 1, maxRetries: 0 });
		await created.session.prompt("Test");
		const failedEntry = created.session.sessionManager.getLeafEntry();
		created.session.setThinkingLevel("high");
		const oldLeafId = created.session.sessionManager.getLeafId();

		await created.session.retry();

		expect(created.getCallCount()).toBe(2);
		const leaf = created.session.sessionManager.getLeafEntry();
		expect(leaf).toMatchObject({ type: "thinking_level_change", thinkingLevel: "high" });
		const branch = created.session.sessionManager.getBranch();
		const retryEntry = branch.find(
			(entry) => entry.type === "message" && entry.message.role === "assistant" && entry.id !== failedEntry?.id,
		);
		expect(retryEntry).toMatchObject({ type: "message", parentId: failedEntry?.parentId });
		expect(created.session.sessionManager.getEntry(oldLeafId!)).toMatchObject({
			type: "thinking_level_change",
			thinkingLevel: "high",
		});
		expect(created.session.sessionManager.buildSessionContext().thinkingLevel).toBe("high");
	});
});
