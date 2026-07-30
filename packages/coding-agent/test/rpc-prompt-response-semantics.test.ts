import {
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { type SessionFileOperations, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	detachInput: vi.fn(),
	killTrackedDetachedChildren: vi.fn(),
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/utils/shell.js", () => ({
	killTrackedDetachedChildren: rpcIo.killTrackedDetachedChildren,
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return rpcIo.detachInput;
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

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

function createAssistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getCommandResponses(outputLines: string[], id: string, command: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === command,
	);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return getCommandResponses(outputLines, id, "prompt");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type NodeListener = Parameters<typeof process.on>[1];

function newProcessListener(event: NodeJS.Signals | "end", previous: NodeListener[]): NodeListener {
	const emitter = event === "end" ? process.stdin : process;
	const current = emitter.listeners(event as never) as NodeListener[];
	const listener = current.find((candidate) => !previous.includes(candidate));
	if (!listener) throw new Error(`Expected a new ${event} listener`);
	return listener;
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	firstResponseStopReason?: "error" | "aborted";
	streamFn?: Agent["streamFunction"];
	tools?: AgentTool[];
	sessionManagerFactory?: (tempDir: string) => SessionManager;
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	let streamCallCount = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: options.tools ?? [],
		},
		streamFn:
			options.streamFn ??
			((_model, _context, _options) => {
				streamCallCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const shouldFail = options.firstResponseStopReason !== undefined && streamCallCount === 1;
					const message = shouldFail
						? createAssistantMessage("", options.firstResponseStopReason)
						: createAssistantMessage("done");
					stream.push({ type: "start", partial: message });
					setTimeout(() => {
						stream.push(
							shouldFail
								? { type: "error", reason: options.firstResponseStopReason!, error: message }
								: { type: "done", reason: "stop", message },
						);
					}, options.responseDelayMs);
				});
				return stream;
			}),
	});

	const sessionManager = options.sessionManagerFactory?.(tempDir) ?? SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createModelRegistry(authStorage, tempDir);
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
		baseToolsOverride: options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined,
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		assertOperationAllowed: vi.fn((operation: string) => session.assertOperationAllowed(operation)),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	firstResponseStopReason?: "error" | "aborted";
	streamFn?: Agent["streamFunction"];
	tools?: AgentTool[];
	sessionManagerFactory?: (tempDir: string) => SessionManager;
}): Promise<{
	lineHandler: (line: string) => void;
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, runtimeHost, cleanup };
}

describe("RPC prompt response semantics", () => {
	it("returns a clear error when retry has no eligible terminal response", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "retry-empty", type: "retry" }));

			await vi.waitFor(() => {
				const responses = getCommandResponses(rpcIo.outputLines, "retry-empty", "retry");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "retry-empty",
					type: "response",
					command: "retry",
					success: false,
					error: expect.stringContaining("Nothing to retry"),
				});
			});
		} finally {
			await cleanup();
		}
	});

	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		rpcIo.detachInput.mockClear();
		rpcIo.killTrackedDetachedChildren.mockClear();
	});

	it("retries a settled terminal error through RPC", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			firstResponseStopReason: "error",
		});

		try {
			lineHandler(JSON.stringify({ id: "retry-prompt", type: "prompt", message: "Hello" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines).some((record) => record.type === "agent_settled")).toBe(true);
			});

			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "retry-success", type: "retry" }));
			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				const responses = getCommandResponses(rpcIo.outputLines, "retry-success", "retry");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({ success: true });
				expect(records.findIndex((record) => record.type === "response")).toBeLessThan(
					records.findIndex((record) => record.type === "agent_start"),
				);
				expect(records.filter((record) => record.type === "agent_settled")).toHaveLength(1);
			});
		} finally {
			await cleanup();
		}
	});

	it("reconciles a persisted RPC retry after first-assistant rename failure and remains retryable", async () => {
		let responseCount = 0;
		let failRetryRename = false;
		const operations: SessionFileOperations = {
			open: (path, flags, mode) => openSync(path, flags, mode),
			chmod: (fd, mode) => fchmodSync(fd, mode),
			write: (fd, contents) => writeFileSync(fd, contents),
			flush: (fd) => fsyncSync(fd),
			close: (fd) => closeSync(fd),
			rename: (from, to) => {
				if (failRetryRename) {
					failRetryRename = false;
					throw new Error("injected retry rename failure");
				}
				renameSync(from, to);
			},
			remove: (path) => unlinkSync(path),
		};
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			sessionManagerFactory: (tempDir) => SessionManager.createForTesting(tempDir, tempDir, operations),
			streamFn: () => {
				responseCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message =
						responseCount === 1
							? createAssistantMessage("failed", "error")
							: createAssistantMessage(`retry-${responseCount}`);
					stream.push(
						message.stopReason === "error"
							? { type: "error", reason: "error", error: message }
							: { type: "done", reason: "stop", message },
					);
				});
				return stream;
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "persisted-prompt", type: "prompt", message: "Hello" }));
			await vi.waitFor(() =>
				expect(
					parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_settled"),
				).toHaveLength(1),
			);
			const session = runtimeHost.session;
			const sessionFile = session.sessionFile;
			if (!sessionFile) throw new Error("Expected persisted session file");
			const failedLeaf = session.sessionManager.getLeafId();
			const failedMessages = session.sessionManager.buildSessionContext().messages;
			const bytesBefore = readFileSync(sessionFile);

			rpcIo.outputLines = [];
			failRetryRename = true;
			lineHandler(JSON.stringify({ id: "persisted-retry-1", type: "retry" }));
			await vi.waitFor(() =>
				expect(
					parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_settled"),
				).toHaveLength(1),
			);

			const records = parseOutputLines(rpcIo.outputLines);
			expect(getCommandResponses(rpcIo.outputLines, "persisted-retry-1", "retry")).toEqual([
				expect.objectContaining({ success: true }),
			]);
			expect(records.filter((record) => record.type === "agent_operation_error")).toEqual([
				expect.objectContaining({
					operation: "manual_retry",
					phase: "post_admission_persistence",
					errorMessage: "injected retry rename failure",
				}),
			]);
			expect(
				records
					.filter(
						(record) =>
							record.type === "response" ||
							record.type === "agent_operation_error" ||
							record.type === "agent_settled",
					)
					.map((record) => record.type),
			).toEqual(["response", "agent_operation_error", "agent_settled"]);
			expect(session.isIdle).toBe(true);
			expect(session.sessionManager.getLeafId()).toBe(failedLeaf);
			expect(session.messages).toEqual(failedMessages);
			expect(readFileSync(sessionFile)).toEqual(bytesBefore);
			expect(SessionManager.open(sessionFile).getLeafId()).toBe(failedLeaf);

			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "persisted-retry-2", type: "retry" }));
			await vi.waitFor(() =>
				expect(
					parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_settled"),
				).toHaveLength(1),
			);
			expect(getCommandResponses(rpcIo.outputLines, "persisted-retry-2", "retry")).toEqual([
				expect.objectContaining({ success: true }),
			]);
			expect(responseCount).toBe(3);
			expect(session.sessionManager.getLeafId()).not.toBe(failedLeaf);
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "retry-3" }],
			});
		} finally {
			await cleanup();
		}
	});

	it("admits one multi-turn retry response before one agent_start", async () => {
		const tool: AgentTool = {
			name: "rpc_tool",
			label: "RPC tool",
			description: "Continue to a second provider turn",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "tool result" }], details: {} }),
		};
		let callCount = 0;
		const streamFn: Agent["streamFunction"] = () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message =
					callCount === 1
						? createAssistantMessage("", "error")
						: callCount === 2
							? {
									...createAssistantMessage("tool", "toolUse"),
									content: [{ type: "toolCall" as const, id: "rpc-1", name: "rpc_tool", arguments: {} }],
								}
							: createAssistantMessage("done");
				stream.push(
					message.stopReason === "error"
						? { type: "error", reason: "error", error: message }
						: { type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message },
				);
			});
			return stream;
		};
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			streamFn,
			tools: [tool],
		});

		try {
			lineHandler(JSON.stringify({ id: "multi-prompt", type: "prompt", message: "Hello" }));
			await vi.waitFor(() =>
				expect(parseOutputLines(rpcIo.outputLines).some((record) => record.type === "agent_settled")).toBe(true),
			);
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "multi-retry", type: "retry" }));
			await vi.waitFor(() =>
				expect(
					parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_settled"),
				).toHaveLength(1),
			);
			const records = parseOutputLines(rpcIo.outputLines);
			expect(getCommandResponses(rpcIo.outputLines, "multi-retry", "retry")).toHaveLength(1);
			expect(records.filter((record) => record.type === "agent_start")).toHaveLength(1);
			expect(records.filter((record) => record.type === "turn_start")).toHaveLength(2);
			expect(records.findIndex((record) => record.type === "response")).toBeLessThan(
				records.findIndex((record) => record.type === "agent_start"),
			);
		} finally {
			await cleanup();
		}
	});

	it("keeps one manual retry lifecycle across an automatic transient retry", async () => {
		let callCount = 0;
		const streamFn: Agent["streamFunction"] = () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message =
					callCount <= 2
						? { ...createAssistantMessage("", "error"), errorMessage: "overloaded_error" }
						: createAssistantMessage("recovered");
				stream.push(
					message.stopReason === "error"
						? { type: "error", reason: "error", error: message }
						: { type: "done", reason: "stop", message },
				);
			});
			return stream;
		};
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0, streamFn });

		try {
			lineHandler(JSON.stringify({ id: "disable-auto", type: "set_auto_retry", enabled: false }));
			await vi.waitFor(() =>
				expect(getCommandResponses(rpcIo.outputLines, "disable-auto", "set_auto_retry")).toHaveLength(1),
			);
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "first-error", type: "prompt", message: "Hello" }));
			await vi.waitFor(() =>
				expect(
					parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_settled"),
				).toHaveLength(1),
			);

			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "enable-auto", type: "set_auto_retry", enabled: true }));
			await vi.waitFor(() =>
				expect(getCommandResponses(rpcIo.outputLines, "enable-auto", "set_auto_retry")).toHaveLength(1),
			);
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "retry-auto", type: "retry" }));
			await vi.waitFor(() =>
				expect(
					getCommandResponses(rpcIo.outputLines, "retry-auto", "retry"),
					JSON.stringify(parseOutputLines(rpcIo.outputLines)),
				).toHaveLength(1),
			);
			const retryResponse = getCommandResponses(rpcIo.outputLines, "retry-auto", "retry")[0];
			expect(retryResponse).toMatchObject({ success: true });
			await vi.waitFor(
				() =>
					expect(
						parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_settled"),
					).toHaveLength(1),
				{ timeout: 5_000 },
			);

			const records = parseOutputLines(rpcIo.outputLines);
			expect(getCommandResponses(rpcIo.outputLines, "retry-auto", "retry")).toEqual([
				expect.objectContaining({ success: true }),
			]);
			expect(records.filter((record) => record.type === "agent_start")).toHaveLength(1);
			expect(records.filter((record) => record.type === "turn_start")).toHaveLength(2);
			expect(records.filter((record) => record.type === "auto_retry_start")).toHaveLength(1);
			expect(records.filter((record) => record.type === "auto_retry_end")).toEqual([
				expect.objectContaining({ success: true }),
			]);
			expect(records.filter((record) => record.type === "agent_settled")).toHaveLength(1);
			expect(callCount).toBe(3);
		} finally {
			await cleanup();
		}
	});

	it.each([
		{ source: "SIGTERM" as const, exitCode: 143 },
		...(process.platform === "win32" ? [] : [{ source: "SIGHUP" as const, exitCode: 129 }]),
		{ source: "end" as const, exitCode: 0 },
	])("queues $source shutdown during manual retry before all side effects", async ({ source, exitCode }) => {
		const previousListeners =
			source === "end"
				? (process.stdin.listeners("end") as NodeListener[])
				: (process.listeners(source) as NodeListener[]);
		let releaseRetry = () => {};
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			firstResponseStopReason: "error",
		});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const pause = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);

		try {
			lineHandler(JSON.stringify({ id: `${source}-first-error`, type: "prompt", message: "Hello" }));
			await vi.waitFor(() =>
				expect(
					parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_settled"),
				).toHaveLength(1),
			);
			let converterStarted = () => {};
			const converterBarrier = new Promise<void>((resolve) => {
				converterStarted = resolve;
			});
			runtimeHost.session.agent.convertToLlm = async (messages) => {
				converterStarted();
				await new Promise<void>((resolve) => {
					releaseRetry = resolve;
				});
				return convertToLlm(messages);
			};
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: `${source}-retry`, type: "retry" }));
			await converterBarrier;

			const listener = newProcessListener(source, previousListeners);
			listener();
			listener();
			await new Promise((resolve) => setImmediate(resolve));

			expect(runtimeHost.dispose).not.toHaveBeenCalled();
			expect(rpcIo.killTrackedDetachedChildren).not.toHaveBeenCalled();
			expect(rpcIo.detachInput).not.toHaveBeenCalled();
			expect(pause).not.toHaveBeenCalled();
			expect(exit).not.toHaveBeenCalled();

			releaseRetry();
			await vi.waitFor(() => expect(runtimeHost.dispose).toHaveBeenCalledTimes(1));
			expect(rpcIo.killTrackedDetachedChildren).toHaveBeenCalledTimes(1);
			expect(rpcIo.detachInput).toHaveBeenCalledTimes(1);
			expect(pause).toHaveBeenCalledTimes(1);
			expect(exit).toHaveBeenCalledTimes(1);
			expect(exit).toHaveBeenCalledWith(exitCode);
		} finally {
			exit.mockRestore();
			pause.mockRestore();
			await cleanup();
			const emitter = source === "end" ? process.stdin : process;
			for (const listener of emitter.listeners(source as never) as NodeListener[]) {
				if (!previousListeners.includes(listener)) emitter.off(source as never, listener as never);
			}
		}
	});

	it("rejects shutdown preflight during manual retry without losing retry observers", async () => {
		let callCount = 0;
		let releaseRetry!: () => void;
		const retryRelease = new Promise<void>((resolve) => {
			releaseRetry = resolve;
		});
		const streamFn: Agent["streamFunction"] = () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(async () => {
				if (callCount === 1) {
					const failed = { ...createAssistantMessage("", "error"), errorMessage: "not retryable" };
					stream.push({ type: "error", reason: "error", error: failed });
					return;
				}
				await retryRelease;
				const recovered = createAssistantMessage("recovered");
				stream.push({ type: "done", reason: "stop", message: recovered });
			});
			return stream;
		};
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			streamFn,
		});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

		try {
			lineHandler(JSON.stringify({ id: "shutdown-first-error", type: "prompt", message: "Hello" }));
			await vi.waitFor(() =>
				expect(
					parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_settled"),
				).toHaveLength(1),
			);
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "shutdown-retry", type: "retry" }));
			await vi.waitFor(() =>
				expect(getCommandResponses(rpcIo.outputLines, "shutdown-retry", "retry")).toHaveLength(1),
			);

			runtimeHost.session.extensionRunner.shutdown();
			lineHandler(JSON.stringify({ id: "shutdown-probe", type: "get_state" }));
			await vi.waitFor(() =>
				expect(
					getCommandResponses(rpcIo.outputLines, "shutdown-probe", "get_state").filter(
						(response) => response.success === false,
					),
				).toEqual([expect.objectContaining({ error: expect.stringContaining("manual retry") })]),
			);
			expect(runtimeHost.dispose).not.toHaveBeenCalled();

			releaseRetry();
			await vi.waitFor(() =>
				expect(
					parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_settled"),
				).toHaveLength(1),
			);
			expect(parseOutputLines(rpcIo.outputLines).some((record) => record.type === "message_end")).toBe(true);
			await vi.waitFor(() => expect(runtimeHost.dispose).toHaveBeenCalledTimes(1));
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});
});
