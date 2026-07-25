import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
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

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
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

function createAssistantMessage(text: string): AssistantMessage {
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
		stopReason: "stop",
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

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: { withAuth: boolean; responseDelayMs: number; model?: Model<any> }): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
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
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
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

async function startRpcMode(options: { withAuth: boolean; responseDelayMs: number; model?: Model<any> }): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it.each(["get_entries", "get_tree"] as const)(
		"sanitizes provider-private messages and model transitions from %s",
		async (command) => {
			rpcIo.outputLines = [];
			rpcIo.lineHandler = undefined;
			const { runtimeHost, cleanup } = await createRuntimeHost({ withAuth: true, responseDelayMs: 0 });
			runtimeHost.session.sessionManager.appendMessage({ role: "user", content: "visible rpc user", timestamp: 1 });
			const modelChangeId = runtimeHost.session.sessionManager.appendModelChange(
				"private-rpc-model-change-provider",
				"private-rpc-model-change-id",
			);
			const sourceModelChange = runtimeHost.session.sessionManager.getEntry(modelChangeId);
			if (!sourceModelChange || sourceModelChange.type !== "model_change") throw new Error("model change missing");
			runtimeHost.session.sessionManager.appendMessage({
				...createAssistantMessage("visible rpc assistant"),
				content: [
					{ type: "text", text: "visible rpc assistant", textSignature: "private-rpc-text-signature" },
					{
						type: "toolCall",
						id: "visible-rpc-call",
						name: "visible-rpc-tool",
						arguments: { provider: "ordinary rpc tool provider" },
						thoughtSignature: "private-rpc-thought-signature",
					},
				],
				responseModel: "private-rpc-response-model",
				responseId: "private-rpc-response-id",
				diagnostics: [{ type: "private-rpc-diagnostic", timestamp: 1 }],
			});
			void runRpcMode(runtimeHost);
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			try {
				if (!rpcIo.lineHandler) throw new Error("RPC line handler missing");
				Reflect.apply(rpcIo.lineHandler, undefined, [JSON.stringify({ id: command, type: command })]);
				await vi.waitFor(() => {
					const output = parseOutputLines(rpcIo.outputLines).find(
						(record) => record.id === command && record.command === command,
					);
					expect(output).toBeDefined();
					const serialized = JSON.stringify(output);
					for (const sentinel of [
						"anthropic-messages",
						"anthropic",
						"claude-sonnet-4-5",
						"private-rpc-text-signature",
						"private-rpc-thought-signature",
						"private-rpc-response-model",
						"private-rpc-response-id",
						"private-rpc-diagnostic",
						"private-rpc-model-change-provider",
						"private-rpc-model-change-id",
					]) {
						expect(serialized).not.toContain(sentinel);
					}
					expect(serialized).toContain('"type":"model_change"');
					expect(serialized).toContain(sourceModelChange.timestamp);
					for (const visible of [
						"visible rpc user",
						"visible rpc assistant",
						"visible-rpc-call",
						"visible-rpc-tool",
						"ordinary rpc tool provider",
					]) {
						expect(serialized).toContain(visible);
					}
				});
			} finally {
				await cleanup();
			}
		},
	);

	it("sanitizes and detaches get_messages while preserving visible message behavior", async () => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		const { runtimeHost, cleanup } = await createRuntimeHost({ withAuth: true, responseDelayMs: 0 });
		const sourceAssistant = {
			...createAssistantMessage("visible rpc message assistant"),
			content: [
				{
					type: "text" as const,
					text: "visible rpc message assistant",
					textSignature: "private-rpc-message-signature",
				},
				{
					type: "toolCall" as const,
					id: "visible-rpc-message-call",
					name: "visible-rpc-message-tool",
					arguments: { exact: "visible-rpc-message-arguments" },
					thoughtSignature: "private-rpc-message-thought-signature",
				},
			],
			responseId: "private-rpc-message-response-id",
			diagnostics: [{ type: "private-rpc-message-diagnostic", timestamp: 1 }],
		};
		runtimeHost.session.agent.state.messages = [
			{ role: "user", content: "visible rpc message user", timestamp: 1 },
			sourceAssistant,
			{
				role: "toolResult",
				toolCallId: "visible-rpc-message-call",
				toolName: "visible-rpc-message-tool",
				content: [{ type: "text", text: "visible rpc message result", textSignature: "ordinary-rpc-result-field" }],
				details: { provider: "ordinary-rpc-result-provider" },
				usage: sourceAssistant.usage,
				isError: true,
				timestamp: 3,
			},
		];
		void runRpcMode(runtimeHost);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		try {
			if (!rpcIo.lineHandler) throw new Error("RPC line handler missing");
			Reflect.apply(rpcIo.lineHandler, undefined, [JSON.stringify({ id: "messages", type: "get_messages" })]);
			await vi.waitFor(() => {
				const output = parseOutputLines(rpcIo.outputLines).find(
					(record) => record.id === "messages" && record.command === "get_messages",
				);
				expect(output).toBeDefined();
				const serialized = JSON.stringify(output);
				for (const sentinel of [
					"private-rpc-message-signature",
					"private-rpc-message-thought-signature",
					"private-rpc-message-response-id",
					"private-rpc-message-diagnostic",
				]) {
					expect(serialized).not.toContain(sentinel);
				}
				for (const visible of [
					"visible rpc message user",
					"visible rpc message assistant",
					"visible-rpc-message-call",
					"visible-rpc-message-tool",
					"visible-rpc-message-arguments",
					"visible rpc message result",
					"ordinary-rpc-result-field",
					"ordinary-rpc-result-provider",
				]) {
					expect(serialized).toContain(visible);
				}
				const response = output as { data: { messages: Array<{ role: string; content: unknown[] }> } };
				response.data.messages.find((message) => message.role === "assistant")!.content = [];
				expect(sourceAssistant.content).toHaveLength(2);
			});
		} finally {
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
