import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

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

type CapturedTransport = { transport: string | undefined; modelId: string };

describe("transport_status events", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-transport-status-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(
		streamFn: (model: any, context: any, options: any) => ReturnType<typeof createAssistantMessageEventStream>,
		model = getModel("anthropic", "claude-sonnet-4-5")!,
	): Promise<AgentSession> {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: streamFn as any,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	function transportEvents(events: AgentSessionEvent[]): CapturedTransport[] {
		return events
			.filter((e): e is Extract<AgentSessionEvent, { type: "transport_status" }> => e.type === "transport_status")
			.map((e) => ({ transport: e.transport, modelId: e.model.id }));
	}

	it("forwards adapter transport labels for the active request", async () => {
		const created = await createSession((_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await options?.onTransport?.("SSE", _model);
				const msg = createAssistantMessage("ok");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		});

		const events: AgentSessionEvent[] = [];
		created.subscribe((event) => events.push(event));
		await created.prompt("hello");

		expect(transportEvents(events)).toEqual([{ transport: "SSE", modelId: "claude-sonnet-4-5" }]);
	});

	it("reports a mid-stream WS->SSE transition and clears at request start", async () => {
		const created = await createSession((_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await options?.onTransport?.("WS", _model);
				await options?.onTransport?.(undefined, _model);
				await options?.onTransport?.("SSE", _model);
				const msg = createAssistantMessage("ok");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		});

		const events: AgentSessionEvent[] = [];
		created.subscribe((event) => events.push(event));
		await created.prompt("hello");

		expect(transportEvents(events).map((t) => t.transport)).toEqual(["WS", undefined, "SSE"]);
	});

	it("tags the transport event with the model that issued the request", async () => {
		const created = await createSession((_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await options?.onTransport?.("SSE", _model);
				const msg = createAssistantMessage("ok");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		});

		const events: AgentSessionEvent[] = [];
		created.subscribe((event) => events.push(event));
		await created.prompt("hello");

		const transports = transportEvents(events);
		expect(transports).toHaveLength(1);
		expect(transports[0].modelId).toBe("claude-sonnet-4-5");
	});

	it("ignores late callbacks fired after the request stream completed", async () => {
		let emitLate: (() => Promise<void>) | undefined;
		const created = await createSession((_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const msg = createAssistantMessage("ok");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
				// Held until the request has fully settled; firing must be a no-op.
				emitLate = () => options?.onTransport?.("WS", _model) as Promise<void>;
			});
			return stream;
		});

		const events: AgentSessionEvent[] = [];
		created.subscribe((event) => events.push(event));
		await created.prompt("hello");
		await emitLate?.();

		expect(transportEvents(events)).toEqual([]);
	});

	it("scopes each transport report to its own request across prompts", async () => {
		let call = 0;
		const created = await createSession((_model, _context, options) => {
			call++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await options?.onTransport?.(call === 1 ? "SSE" : "WS", _model);
				const msg = createAssistantMessage("ok");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		});

		const events: AgentSessionEvent[] = [];
		created.subscribe((event) => events.push(event));
		await created.prompt("one");
		await created.prompt("two");

		const labels = transportEvents(events).map((t) => t.transport);
		// Each request reports exactly its own label; nothing leaks between runs.
		expect(labels).toEqual(["SSE", "WS"]);
	});

	it("does not emit transport_status for opaque streams that never report", async () => {
		const created = await createSession(() => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const msg = createAssistantMessage("ok");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		});

		const events: AgentSessionEvent[] = [];
		created.subscribe((event) => events.push(event));
		await created.prompt("hello");

		expect(transportEvents(events)).toEqual([]);
	});
});

describe("InteractiveMode working label", () => {
	function fakeMode(): any {
		return {
			isInitialized: true,
			workingMessage: undefined,
			currentTransport: undefined,
			defaultWorkingMessage: "Working",
			workingVisible: true,
			activeStatusIndicator: { kind: "working", setMessage: vi.fn() },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			settingsManager: { getShowTerminalProgress: () => false },
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			clearStatusIndicator: vi.fn(),
			showWorkingStatusIndicator: vi.fn(),
			updateWorkingIndicatorMessage: (InteractiveMode as any).prototype.updateWorkingIndicatorMessage,
			formatWorkingMessage: (InteractiveMode as any).prototype.formatWorkingMessage,
		};
	}

	it("shows Working(SSE) once the adapter reports and Working after it clears", async () => {
		const mode = fakeMode();
		const format = (InteractiveMode as any).prototype.formatWorkingMessage;
		const handleEvent = (InteractiveMode as any).prototype.handleEvent;

		// No report yet: bare default label.
		expect(format.call(mode)).toBe("Working");

		await handleEvent.call(mode, { type: "transport_status", transport: "SSE", model: {} });
		expect(format.call(mode)).toBe("Working(SSE)");
		expect(mode.activeStatusIndicator.setMessage).toHaveBeenLastCalledWith("Working(SSE)");

		await handleEvent.call(mode, { type: "transport_status", transport: "WS", model: {} });
		expect(format.call(mode)).toBe("Working(WS)");

		await handleEvent.call(mode, { type: "transport_status", transport: undefined, model: {} });
		expect(format.call(mode)).toBe("Working");
		expect(mode.activeStatusIndicator.setMessage).toHaveBeenLastCalledWith("Working");
	});

	it("keeps an extension working message verbatim and clears transport on turn_start", async () => {
		const mode = fakeMode();
		const format = (InteractiveMode as any).prototype.formatWorkingMessage;
		const handleEvent = (InteractiveMode as any).prototype.handleEvent;

		await handleEvent.call(mode, { type: "transport_status", transport: "SSE", model: {} });
		mode.workingMessage = "Analyzing codebase...";
		expect(format.call(mode)).toBe("Analyzing codebase...");

		// turn_start resets the label before the next request reports its transport.
		await handleEvent.call(mode, { type: "turn_start" });
		mode.workingMessage = undefined;
		expect(mode.currentTransport).toBeUndefined();
		expect(format.call(mode)).toBe("Working");
	});
});
