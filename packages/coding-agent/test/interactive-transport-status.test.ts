import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
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
		streamFn: StreamFn,
		model: Model<string> = getModel("anthropic", "claude-sonnet-4-5")!,
	): Promise<AgentSession> {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn,
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

		expect(transportEvents(events)).toEqual([
			{ transport: "SSE", modelId: "claude-sonnet-4-5" },
			{ transport: undefined, modelId: "claude-sonnet-4-5" },
		]);
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

		expect(transportEvents(events).map((t) => t.transport)).toEqual(["WS", undefined, "SSE", undefined]);
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
		expect(transports).toHaveLength(2);
		expect(transports[0]).toEqual({ transport: "SSE", modelId: "claude-sonnet-4-5" });
		expect(transports[1].transport).toBeUndefined();
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
		// Each request reports its own label then clears it; nothing leaks between runs.
		expect(labels).toEqual(["SSE", undefined, "WS", undefined]);
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

// Structural view of the private state handleEvent/formatWorkingMessage need.
// InteractiveMode has private fields, so the prototype crosses via `unknown`.
type WorkingLabelMode = {
	isInitialized: boolean;
	workingMessage: string | undefined;
	currentTransport: string | undefined;
	defaultWorkingMessage: string;
	workingVisible: boolean;
	activeStatusIndicator: { kind: string; setMessage: (message: string) => void } | undefined;
	ui: { requestRender: () => void; terminal: { setProgress: (on: boolean) => void } };
	settingsManager: { getShowTerminalProgress: () => boolean };
	footer: { invalidate: () => void };
	programStatus: { handleEvent: (event: AgentSessionEvent) => void };
	clearStatusIndicator: () => void;
	showWorkingStatusIndicator: () => void;
	updateWorkingIndicatorMessage: () => void;
	formatWorkingMessage: () => string;
	handleEvent: (event: AgentSessionEvent) => Promise<void>;
};

describe("InteractiveMode working label", () => {
	const proto = InteractiveMode.prototype as unknown as Pick<
		WorkingLabelMode,
		"updateWorkingIndicatorMessage" | "formatWorkingMessage" | "handleEvent"
	>;

	function fakeMode(): WorkingLabelMode {
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
			updateWorkingIndicatorMessage: proto.updateWorkingIndicatorMessage,
			formatWorkingMessage: proto.formatWorkingMessage,
			handleEvent: proto.handleEvent,
		};
	}

	const fakeModel = {} as Model<string>;

	it("shows Working(SSE) once the adapter reports and Working after it clears", async () => {
		const mode = fakeMode();

		// No report yet: bare default label.
		expect(mode.formatWorkingMessage()).toBe("Working");

		await mode.handleEvent({ type: "transport_status", transport: "SSE", model: fakeModel });
		expect(mode.formatWorkingMessage()).toBe("Working(SSE)");
		expect(mode.activeStatusIndicator?.setMessage).toHaveBeenLastCalledWith("Working(SSE)");

		await mode.handleEvent({ type: "transport_status", transport: "WS", model: fakeModel });
		expect(mode.formatWorkingMessage()).toBe("Working(WS)");

		await mode.handleEvent({ type: "transport_status", transport: undefined, model: fakeModel });
		expect(mode.formatWorkingMessage()).toBe("Working");
		expect(mode.activeStatusIndicator?.setMessage).toHaveBeenLastCalledWith("Working");
	});

	it.each(["WS/full", "WS/continuation"])("renders and clears the actual %s request label", async (transport) => {
		const mode = fakeMode();
		await mode.handleEvent({ type: "transport_status", transport, model: fakeModel });
		expect(mode.formatWorkingMessage()).toBe(`Working(${transport})`);
		expect(mode.activeStatusIndicator?.setMessage).toHaveBeenLastCalledWith(`Working(${transport})`);
		mode.workingMessage = "Custom progress";
		await mode.handleEvent({ type: "transport_status", transport, model: fakeModel });
		expect(mode.activeStatusIndicator?.setMessage).toHaveBeenLastCalledWith("Custom progress");
		mode.workingMessage = undefined;
		await mode.handleEvent({ type: "transport_status", transport: undefined, model: fakeModel });
		expect(mode.activeStatusIndicator?.setMessage).toHaveBeenLastCalledWith("Working");
	});

	it("keeps an extension working message verbatim and clears transport on turn_start", async () => {
		const mode = fakeMode();

		await mode.handleEvent({ type: "transport_status", transport: "SSE", model: fakeModel });
		mode.workingMessage = "Analyzing codebase...";
		expect(mode.formatWorkingMessage()).toBe("Analyzing codebase...");

		// turn_start resets the label before the next request reports its transport.
		await mode.handleEvent({ type: "turn_start" });
		mode.workingMessage = undefined;
		expect(mode.currentTransport).toBeUndefined();
		expect(mode.formatWorkingMessage()).toBe("Working");
	});
});
