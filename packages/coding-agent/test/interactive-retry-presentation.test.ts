import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const WEBSOCKET_1006 = "Responses WebSocket closed (1006): Connection ended";

// Keep real session events, assistant/tool components, and transcript reconstruction.
// Only terminal I/O and unrelated startup/diagnostic collaborators are replaced.
function createView(harness: Harness) {
	const renders: Promise<void>[] = [];
	const errors: unknown[] = [];
	const context = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } } as unknown as TUI,
		chatContainer: new Container(),
		statusContainer: new Container(),
		session: harness.session,
		sessionManager: harness.sessionManager,
		settingsManager: {
			getShowTerminalProgress: () => false,
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowCacheMissNotices: () => false,
		},
		streamingComponent: undefined as InteractiveMode["streamingComponent"],
		streamingMessage: undefined as InteractiveMode["streamingMessage"],
		pendingTools: new Map<string, ToolExecutionComponent>(),
		activeStatusIndicator: undefined as StatusIndicator | undefined,
		defaultEditor: {} as { onEscape?: () => void },
		retryEscapeHandler: undefined as (() => void) | undefined,
		toolOutputExpanded: true,
		hideThinkingBlock: true,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		entriesRenderedByBoundaryCompaction: new Set<string>(),
		getMarkdownThemeWithSettings: () => undefined,
		getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: () => undefined,
		updatePendingMessagesDisplay: vi.fn(),
		showWorkingStatusIndicator: vi.fn(),
		showStatusIndicator(indicator: StatusIndicator) {
			this.activeStatusIndicator?.dispose();
			this.activeStatusIndicator = indicator;
			this.statusContainer.clear();
			this.statusContainer.addChild(indicator);
		},
		clearStatusIndicator(kind?: string) {
			if (kind && this.activeStatusIndicator?.kind !== kind) return;
			this.activeStatusIndicator?.dispose();
			this.activeStatusIndicator = undefined;
			this.statusContainer.clear();
		},
		checkShutdownRequested: async () => {},
		flushRetainedShutdownSlowLines: vi.fn(),
		maybeSuggestBugReport: vi.fn(),
		maybeShowThinkingDropNotice: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		maybeShowInstallChangeWarning: () => false,
		getUserMessageText: Reflect.get(
			InteractiveMode.prototype,
			"getUserMessageText",
		) as InteractiveMode["getUserMessageText"],
		addCustomEntryToChat: Reflect.get(
			InteractiveMode.prototype,
			"addCustomEntryToChat",
		) as InteractiveMode["addCustomEntryToChat"],
		showError: Reflect.get(InteractiveMode.prototype, "showError") as InteractiveMode["showError"],
		addMessageToChat: Reflect.get(
			InteractiveMode.prototype,
			"addMessageToChat",
		) as InteractiveMode["addMessageToChat"],
		renderSessionItems: Reflect.get(
			InteractiveMode.prototype,
			"renderSessionItems",
		) as InteractiveMode["renderSessionItems"],
		renderSessionEntries: Reflect.get(
			InteractiveMode.prototype,
			"renderSessionEntries",
		) as InteractiveMode["renderSessionEntries"],
		settlePendingModelSwitch: Reflect.get(
			InteractiveMode.prototype,
			"settlePendingModelSwitch",
		) as InteractiveMode["settlePendingModelSwitch"],
		rebuildChatFromMessages: Reflect.get(
			InteractiveMode.prototype,
			"rebuildChatFromMessages",
		) as InteractiveMode["rebuildChatFromMessages"],
		renderChat() {
			return stripAnsi(this.chatContainer.render(100).join("\n"));
		},
		async flush() {
			await Promise.all(renders);
			if (errors.length > 0) throw errors[0];
		},
	};
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: typeof context,
		event: AgentSessionEvent,
	) => Promise<void>;
	harness.session.subscribe((event) =>
		renders.push(
			handleEvent.call(context, event).catch((error: unknown) => {
				errors.push(error);
			}),
		),
	);
	return context;
}

function failedPreview(errorMessage = WEBSOCKET_1006): AssistantMessage {
	return fauxAssistantMessage(
		[
			{ type: "text", text: "Partial response" },
			fauxToolCall("never_ran", { path: "one" }),
			fauxToolCall("never_ran", { path: "two" }),
		],
		{ stopReason: "error", errorMessage },
	);
}

function useScriptedStream(harness: Harness, script: AssistantMessage[], waitForAbort = false): () => number {
	let calls = 0;
	const streamFunction: StreamFn = (model, _context, options) => {
		const response = {
			...structuredClone(script[Math.min(calls++, script.length - 1)]!),
			api: model.api,
			provider: model.provider,
			model: model.id,
		};
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const partial = { ...response, content: [] as AssistantMessage["content"], stopReason: "pending" as const };
			stream.push({ type: "start", partial: structuredClone(partial) });
			for (const [index, block] of response.content.entries()) {
				partial.content.push(block);
				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: index,
						content: block.text,
						partial: structuredClone(partial),
					});
				} else if (block.type === "toolCall") {
					stream.push({
						type: "toolcall_end",
						contentIndex: index,
						toolCall: block,
						partial: structuredClone(partial),
					});
				}
			}
			const finish = () => {
				if (waitForAbort) {
					response.stopReason = "aborted";
					response.errorMessage = "Operation aborted";
				}
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					stream.push({ type: "error", reason: response.stopReason, error: response });
				} else if (response.stopReason !== "pending") {
					stream.push({ type: "done", reason: response.stopReason, message: response });
				}
				stream.end(response);
			};
			if (waitForAbort && !options?.signal?.aborted)
				options?.signal?.addEventListener("abort", finish, { once: true });
			else finish();
		});
		return stream;
	};
	harness.session.agent.streamFunction = streamFunction;
	return () => calls;
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

describe("Interactive retry presentation", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("shows core recovery once and removes abandoned previews, including after reconstruction", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 10, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const view = createView(harness);
		const calls = useScriptedStream(harness, [failedPreview(), fauxAssistantMessage("recovered")]);
		const statuses: string[] = [];
		const duringRetry: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				statuses.push(stripAnsi(view.statusContainer.render(100).join("\n")));
				// Repainting during backoff must not restore a provisional error.
				view.chatContainer.invalidate();
				duringRetry.push(view.renderChat());
			}
		});
		await harness.session.prompt("test");
		await view.flush();
		expect(calls()).toBe(2);
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toContain("1/10");
		expect(duringRetry.join("\n")).not.toContain(WEBSOCKET_1006);
		for (const reconstruct of [false, true]) {
			if (reconstruct) view.rebuildChatFromMessages();
			expect(view.renderChat()).toContain("recovered");
			expect(view.renderChat()).toContain("Partial response");
			expect(view.renderChat()).not.toContain(WEBSOCKET_1006);
			expect(view.renderChat()).not.toContain("never_ran");
		}
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
	});

	it.each([true, false])("defers a pre-start failure through message_end hooks with retry=%s", async (enabled) => {
		const hookEntered = Promise.withResolvers<void>();
		const hookReleased = Promise.withResolvers<void>();
		const harness = await createHarness({
			settings: { retry: { enabled, maxRetries: 1, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant" && event.message.stopReason === "error") {
							hookEntered.resolve();
							await hookReleased.promise;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		const view = createView(harness);
		let calls = 0;
		harness.session.agent.streamFunction = (model) => {
			const failed = ++calls === 1;
			const response = {
				...fauxAssistantMessage(
					failed ? "" : "recovered",
					failed ? { stopReason: "error", errorMessage: WEBSOCKET_1006 } : {},
				),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			const stream = createAssistantMessageEventStream();
			// No start event: exercise the agent loop's synthetic message_start.
			stream.push(
				failed
					? { type: "error", reason: "error", error: response }
					: { type: "done", reason: "stop", message: response },
			);
			stream.end(response);
			return stream;
		};
		const prompt = harness.session.prompt("test");
		await hookEntered.promise;
		try {
			await view.flush();
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
			view.chatContainer.invalidate();
			expect(view.renderChat()).not.toContain(WEBSOCKET_1006);
		} finally {
			hookReleased.resolve();
			await prompt;
			await view.flush();
		}
		expect(calls).toBe(enabled ? 2 : 1);
		if (enabled) {
			expect(view.renderChat()).toContain("recovered");
			expect(view.renderChat()).not.toContain(WEBSOCKET_1006);
		} else {
			expect(occurrences(view.renderChat(), WEBSOCKET_1006)).toBe(1);
		}
	});

	it.each([
		{ name: "disabled retry", enabled: false, maxRetries: 10, error: WEBSOCKET_1006 },
		{ name: "zero retry budget", enabled: true, maxRetries: 0, error: WEBSOCKET_1006 },
		{ name: "non-retryable failure", enabled: true, maxRetries: 10, error: "invalid_api_key" },
	])("shows one terminal error with $name and no fake tool results", async ({ enabled, maxRetries, error }) => {
		const harness = await createHarness({ settings: { retry: { enabled, maxRetries, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const view = createView(harness);
		const calls = useScriptedStream(harness, [failedPreview(error)]);
		await harness.session.prompt("test");
		await view.flush();
		expect(calls()).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		for (const reconstruct of [false, true]) {
			if (reconstruct) view.rebuildChatFromMessages();
			expect(occurrences(view.renderChat(), error)).toBe(1);
			expect(view.renderChat()).not.toContain("never_ran");
		}
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
	});

	it.each([WEBSOCKET_1006, "invalid_api_key"])("shows the final retry failure once: %s", async (lastError) => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const view = createView(harness);
		useScriptedStream(harness, [failedPreview(), failedPreview(lastError)]);
		await harness.session.prompt("test");
		await view.flush();
		for (const reconstruct of [false, true]) {
			if (reconstruct) view.rebuildChatFromMessages();
			expect(occurrences(view.renderChat(), lastError)).toBe(1);
			expect(view.renderChat()).not.toContain("never_ran");
		}
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, finalError: lastError }]);
	});

	it("shows direct stream cancellation once after previews, also on reconstruction", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const view = createView(harness);
		useScriptedStream(harness, [failedPreview()], true);
		const preview = Promise.withResolvers<void>();
		harness.session.subscribe((event) => {
			if (
				event.type === "message_update" &&
				event.message.role === "assistant" &&
				event.message.content.filter((c) => c.type === "toolCall").length === 2
			)
				preview.resolve();
		});
		const prompt = harness.session.prompt("test");
		await preview.promise;
		await harness.session.abort();
		await prompt;
		await view.flush();
		for (const reconstruct of [false, true]) {
			if (reconstruct) view.rebuildChatFromMessages();
			expect(occurrences(view.renderChat(), "Operation aborted")).toBe(1);
			expect(view.renderChat()).not.toContain("never_ran");
		}
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
	});

	it("shows cancellation during retry backoff without running previewed tools", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 10, baseDelayMs: 500 } } });
		harnesses.push(harness);
		const view = createView(harness);
		const calls = useScriptedStream(harness, [failedPreview(), fauxAssistantMessage("unreached")]);
		const retry = Promise.withResolvers<void>();
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retry.resolve();
		});
		const prompt = harness.session.prompt("test");
		await retry.promise;
		harness.session.abortRetry();
		await prompt;
		await view.flush();
		expect(calls()).toBe(1);
		for (const reconstruct of [false, true]) {
			if (reconstruct) view.rebuildChatFromMessages();
			expect(occurrences(view.renderChat(), "Retry cancelled")).toBe(1);
			expect(view.renderChat()).not.toContain("never_ran");
			expect(view.renderChat()).not.toContain(WEBSOCKET_1006);
		}
		const sessionFile = join(harness.tempDir, "cancelled.jsonl");
		writeFileSync(
			sessionFile,
			`${[harness.sessionManager.getHeader(), ...harness.sessionManager.getEntries()]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const restored = await createHarness({ sessionManager: SessionManager.open(sessionFile, harness.tempDir) });
		harnesses.push(restored);
		const resumedView = createView(restored);
		resumedView.rebuildChatFromMessages();
		expect(occurrences(resumedView.renderChat(), "Retry cancelled")).toBe(1);
		expect(resumedView.renderChat()).not.toContain(WEBSOCKET_1006);
		expect(JSON.stringify(restored.session.messages)).not.toContain("Retry cancelled");
	});

	it("preserves an executed tool failure across later provider recovery and reconstruction", async () => {
		let executions = 0;
		const tool: AgentTool = {
			name: "fails",
			label: "Fails",
			description: "Controlled tool failure",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				throw new Error("actual tool failure");
			},
		};
		const harness = await createHarness({
			tools: [tool],
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const view = createView(harness);
		useScriptedStream(harness, [
			fauxAssistantMessage([fauxToolCall("fails", {})], { stopReason: "toolUse" }),
			failedPreview(),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("test");
		await view.flush();
		expect(executions).toBe(1);
		expect(harness.eventsOfType("tool_execution_end")).toMatchObject([{ isError: true }]);
		for (const reconstruct of [false, true]) {
			if (reconstruct) view.rebuildChatFromMessages();
			expect(occurrences(view.renderChat(), "actual tool failure")).toBe(1);
			expect(view.renderChat()).not.toContain(WEBSOCKET_1006);
			expect(view.renderChat()).not.toContain("never_ran");
		}
	});
});

describe("Interactive model switch indicator", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	function createModelSwitchView(harness: Harness) {
		return createView(harness);
	}

	it("shows old → new until the next request starts, then settles to the new model in place", async () => {
		const harness = await createHarness({ models: [{ id: "model-a" }, { id: "model-b" }] });
		harnesses.push(harness);
		const view = createModelSwitchView(harness);
		useScriptedStream(harness, [fauxAssistantMessage("answer")]);

		const setPendingModelSwitch = Reflect.get(
			InteractiveMode.prototype,
			"setPendingModelSwitch",
		) as InteractiveMode["setPendingModelSwitch"];
		const settlePendingModelSwitch = Reflect.get(
			InteractiveMode.prototype,
			"settlePendingModelSwitch",
		) as InteractiveMode["settlePendingModelSwitch"];

		const [oldModel, newModel] = harness.models;
		await harness.session.setModel(newModel);
		setPendingModelSwitch.call(view as unknown as InteractiveMode, oldModel, newModel);
		await view.flush();

		// Pending: arrow form, before any request.
		expect(view.renderChat()).toContain("Model: model-a → model-b");

		// turn_start fires before the provider request; the indicator settles in place.
		settlePendingModelSwitch.call(view as unknown as InteractiveMode);
		await view.flush();
		expect(view.renderChat()).toContain("Model: model-b");
		expect(view.renderChat()).not.toContain("→");
	});

	it("ignores a no-op reselection of the current model", async () => {
		const harness = await createHarness({ models: [{ id: "model-a" }, { id: "model-b" }] });
		harnesses.push(harness);
		const view = createModelSwitchView(harness);

		const setPendingModelSwitch = Reflect.get(
			InteractiveMode.prototype,
			"setPendingModelSwitch",
		) as InteractiveMode["setPendingModelSwitch"];

		const current = harness.session.model;
		setPendingModelSwitch.call(view as unknown as InteractiveMode, current, current);
		await view.flush();
		expect(view.renderChat()).not.toContain("Model:");
	});
});
