import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { Container, setKeybindings, TuiMainScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { defaultEditorTheme } from "../../../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";
import { createAllToolRenderers } from "../../../src/core/tools/renderers/index.ts";
import { ExperimentalChatView } from "../../../src/experimental/client-tui-chat.ts";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { SettingsSelectorComponent } from "../../../src/modes/interactive/components/settings-selector.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness } from "../harness.ts";

initTheme("dark");
afterEach(() => setKeybindings(new KeybindingsManager()));

function settings(global: object, project: object = {}) {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify(global));
	storage.withLock("project", () => JSON.stringify(project));
	return { storage, manager: SettingsManager.fromStorage(storage) };
}

interface AssistantCtx {
	isInitialized: boolean;
	thinkingDisplayMode: string;
	thinkingBulkExpanded: boolean | null;
	toolOutputExpanded: boolean;
	outputPad: number;
	hiddenThinkingLabel: string;
	streamingComponent?: AssistantMessageComponent;
	streamingMessage?: unknown;
	chatContainer: Container;
	pendingTools: Map<unknown, unknown>;
	footer: { invalidate: () => void };
	session: {
		sessionManager: { getCwd: () => string; buildContextEntries: () => never[]; getBranch: () => never[] };
		retryAttempt: number;
	};
	settingsManager: SettingsManager;
	getMarkdownThemeWithSettings: () => undefined;
	getMarkdownTransformers: () => never[];
	getRegisteredToolDefinition: () => undefined;
	maybeSuggestBugReport: () => void;
	maybeShowThinkingDropNotice: () => void;
	maybeShowCacheMissNotice: () => void;
	updatePendingMessagesDisplay: () => void;
	updateTerminalTitle: () => void;
	updateEditorBorderColor: () => void;
	addCustomEntryToChat: () => void;
	addCacheWarmingUsage: () => void;
	addMessageToChat: () => void;
	renderSessionEntries: () => void;
	addCompactionCostNotice: () => void;
	maybeShowInstallChangeWarning: () => boolean;
	clearStatusIndicator: () => void;
	showWorkingStatusIndicator: () => void;
	workingVisible: boolean;
	activeStatusIndicator: undefined;
	entriesRenderedByBoundaryCompaction: Set<string>;
	ui: { requestRender: () => void; terminal: { setProgress: (v: boolean) => void } };
}

function makeCtx(manager: SettingsManager, chatContainer: Container): AssistantCtx {
	const noop = () => {};
	return {
		isInitialized: true,
		thinkingDisplayMode: manager.getThinkingDisplayMode(),
		thinkingBulkExpanded: null,
		toolOutputExpanded: false,
		outputPad: 1,
		hiddenThinkingLabel: "Thinking...",
		streamingComponent: undefined,
		streamingMessage: undefined,
		chatContainer,
		pendingTools: new Map(),
		footer: { invalidate: noop },
		ui: { requestRender: noop, terminal: { setProgress: noop } },
		session: {
			sessionManager: { getCwd: () => process.cwd(), buildContextEntries: () => [], getBranch: () => [] },
			retryAttempt: 0,
		},
		settingsManager: manager,
		getMarkdownThemeWithSettings: () => undefined,
		getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: () => undefined,
		maybeSuggestBugReport: noop,
		maybeShowThinkingDropNotice: noop,
		maybeShowCacheMissNotice: noop,
		updatePendingMessagesDisplay: noop,
		updateTerminalTitle: noop,
		updateEditorBorderColor: noop,
		addCustomEntryToChat: noop,
		addCacheWarmingUsage: noop,
		addMessageToChat: noop,
		renderSessionEntries: noop,
		addCompactionCostNotice: noop,
		maybeShowInstallChangeWarning: () => false,
		clearStatusIndicator: noop,
		showWorkingStatusIndicator: noop,
		workingVisible: false,
		activeStatusIndicator: undefined,
		entriesRenderedByBoundaryCompaction: new Set(),
	};
}

function renderText(component: { render(width: number): string[] }, width = 80) {
	return stripAnsi(component.render(width).join("\n"));
}

function clickRow(component: AssistantMessageComponent, needle: string, width = 80) {
	const lines = component.render(width);
	const y = lines.findIndex((line) => stripAnsi(line).includes(needle));
	expect(y).toBeGreaterThanOrEqual(0);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 1,
		y,
		screenX: 1,
		screenY: y,
		width,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	expect(component.handleMouse(event)?.handled).toBe(true);
}

describe("thinking preview display", () => {
	test("settings storage: legacy bool migration, valid enum, invalid enum fallback, persistence", async () => {
		for (const [input, expected] of [
			[{}, "preview"],
			[{ hideThinkingBlock: true }, "collapsed"],
			[{ hideThinkingBlock: false }, "expanded"],
			[{ hideThinkingBlock: "false" }, "preview"],
			[{ thinkingDisplay: "expanded" }, "expanded"],
			[{ thinkingDisplay: "collapsed" }, "collapsed"],
			[{ thinkingDisplay: "preview" }, "preview"],
			[{ thinkingDisplay: "bad" }, "preview"],
			[{ thinkingDisplay: false }, "preview"],
			[{ thinkingDisplay: 42 }, "preview"],
			[{ thinkingDisplay: {} }, "preview"],
			[{ thinkingDisplay: [] }, "preview"],
			[{ thinkingDisplay: null }, "preview"],
		] as const) {
			expect(settings(input).manager.getThinkingDisplayMode()).toBe(expected);
		}

		// Project settings override global.
		const { storage, manager } = settings({ hideThinkingBlock: true }, { hideThinkingBlock: false });
		expect(manager.getThinkingDisplayMode()).toBe("expanded");

		// Persist and reload.
		manager.setThinkingDisplayMode("collapsed");
		await manager.flush();
		expect(SettingsManager.fromStorage(storage).getThinkingDisplayMode()).toBe("expanded");
		let saved = "";
		storage.withLock("global", (current) => {
			saved = current ?? "";
			return undefined;
		});
		expect(JSON.parse(saved)).toEqual({ thinkingDisplay: "collapsed" });
	});

	test("faux provider: default preview keeps the identical tail row at thinking_end before the answer delta", async () => {
		const h = await createHarness();
		const chatContainer = new Container();
		const ctx = makeCtx(h.settingsManager, chatContainer);
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent");
		const snapshots: Array<{ kind: string; text: string }> = [];
		const pending: Promise<void>[] = [];
		const unsubscribe = h.session.subscribe((event) => {
			if (
				(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
				event.message.role === "assistant"
			) {
				pending.push(handleEvent.call(ctx, event));
				snapshots.push({
					kind: event.type === "message_update" ? event.assistantMessageEvent.type : event.type,
					text: stripAnsi(chatContainer.render(80).join("\n")),
				});
			}
		});
		try {
			h.setResponses([
				fauxAssistantMessage([
					{ type: "thinking", thinking: "first\nlive tail" },
					{ type: "text", text: "answer" },
				]),
			]);
			await h.session.prompt("offline check");
			await Promise.all(pending);
			const delta = snapshots.find((s) => s.kind === "thinking_delta" && s.text.includes("live tail"));
			expect(delta).toBeDefined();
			const end = snapshots.find((s) => s.kind === "thinking_end");
			expect(end).toBeDefined();
			// Folded preview-mode run keeps the identical tail row, not a first-line summary or label.
			expect(end?.text).toContain("live tail");
			expect(end?.text).not.toContain("first");
			expect(end?.text).not.toContain("Thinking...");
			expect(end?.text).not.toContain("answer");
			// The thinking_end row is unchanged from the streaming tail row.
			expect(end?.text.split("\n").find((l) => l.includes("live tail"))).toBe(
				delta?.text.split("\n").find((l) => l.includes("live tail")),
			);
			expect(snapshots.at(-1)?.text).toContain("answer");
		} finally {
			unsubscribe();
			h.cleanup();
		}
	});

	test.each([
		[true, "stop"],
		[false, "stop"],
		[true, "aborted"],
		[false, "aborted"],
	] as const)("mouse expanded=%s survives live stream ending with %s", async (expanded, stopReason) => {
		const h = await createHarness({ settings: { thinkingDisplay: expanded ? "preview" : "expanded" } });
		const chatContainer = new Container();
		const ctx = makeCtx(h.settingsManager, chatContainer);
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent");
		const pending: Promise<void>[] = [];
		let component: AssistantMessageComponent | undefined;
		let endObserved = false;
		const unsubscribe = h.session.subscribe((event) => {
			if (
				(event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") ||
				event.message.role !== "assistant"
			)
				return;
			pending.push(handleEvent.call(ctx, event));
			if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta" && !component) {
				const thinking = event.message.content.find((block) => block.type === "thinking");
				if (!thinking?.thinking.includes("earlier") || !ctx.streamingComponent) return;
				component = ctx.streamingComponent;
				expect(event.message.stopReason).toBe("pending");
				clickRow(component, expanded ? renderText(component).trim() : "earlier");
				expect(renderText(component).includes("earlier")).toBe(expanded);
				if (stopReason === "aborted") pending.push(h.session.abort());
			}
			if (event.type === "message_end") {
				endObserved = true;
				expect(event.message.stopReason).toBe(stopReason);
				expect(component).toBeDefined();
				if (component) expect(renderText(component).includes("earlier")).toBe(expanded);
			}
		});
		try {
			h.setResponses([
				fauxAssistantMessage([
					{ type: "thinking", thinking: `earlier\nlive tail ${"still reasoning ".repeat(30)}` },
					{ type: "text", text: "answer" },
				]),
			]);
			await h.session.prompt("offline check");
			await Promise.all(pending);
			expect(component).toBeDefined();
			expect(endObserved).toBe(true);
			expect(chatContainer.children).toContain(component);
			if (component && !expanded) expect(renderText(component)).toContain("Thinking...");
		} finally {
			unsubscribe();
			h.cleanup();
		}
	});

	test("editor actions cycle persisted styles and bulk-toggle real thinking and completed tools", async () => {
		const kb = new KeybindingsManager();
		setKeybindings(kb);
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editor = new CustomEditor(ui, defaultEditorTheme, kb);
		const { manager, storage } = settings({});
		const chatContainer = new Container();
		const message = fauxAssistantMessage([{ type: "thinking", thinking: "first reasoning\nlive tail" }]);
		const component = new AssistantMessageComponent();
		component.updateContent(message, true, 0);
		chatContainer.addChild(component);
		const tool = new ToolExecutionComponent(
			"read",
			"completed-read",
			{ path: "example.txt" },
			{},
			createAllToolRenderers().read,
			ui,
			process.cwd(),
		);
		tool.setArgsComplete();
		tool.updateResult({
			content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `tool-line-${i}`).join("\n") }],
			isError: false,
		});
		chatContainer.addChild(tool);
		const collapsedTool = renderText(tool);
		expect(collapsedTool).not.toContain("tool-line-39");

		const ctx = {
			...makeCtx(manager, chatContainer),
			defaultEditor: editor,
			editor,
			ui,
			loadedResourcesContainer: new Container(),
			showStatus() {},
		};
		for (const name of [
			"toggleToolOutputExpansion",
			"setToolsExpanded",
			"toggleThinkingBlockVisibility",
			"updateThinkingBlockVisibility",
		]) {
			Reflect.set(ctx, name, Reflect.get(InteractiveMode.prototype, name));
		}
		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(ctx);
		for (const expected of ["expanded", "collapsed", "preview"]) {
			editor.handleInput("\x14");
			expect(ctx.thinkingDisplayMode).toBe(expected);
			expect(renderText(component).includes("first reasoning")).toBe(expected === "expanded");
			await manager.flush();
			expect(SettingsManager.fromStorage(storage).getThinkingDisplayMode()).toBe(expected);
			expect(renderText(tool)).toBe(collapsedTool);
			expect(chatContainer.children[1]).toBe(tool);
		}

		editor.handleInput("\x0f");
		expect(renderText(tool)).toContain("tool-line-39");
		expect(renderText(component)).toContain("first reasoning");
		const expandedTool = renderText(tool);
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent");
		const nextMessage = fauxAssistantMessage([{ type: "thinking", thinking: "new first\nnew tail" }]);
		await handleEvent.call(ctx, { type: "message_start", message: nextMessage });
		await handleEvent.call(ctx, {
			type: "message_update",
			message: nextMessage,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "new tail", partial: nextMessage },
		});
		const next = ctx.streamingComponent;
		expect(next).toBeDefined();
		if (!next) throw new Error("message_start did not create an assistant component");
		// Bulk-expanded state from Ctrl+O still expands the new run.
		expect(renderText(next)).toContain("new first");
		clickRow(next, "new first");
		// Per-run mouse collapse folds back to the rolling tail row.
		expect(renderText(next)).toContain("new tail");
		expect(renderText(next)).not.toContain("new first");
		expect(renderText(component)).toContain("first reasoning");
		expect(renderText(tool)).toBe(expandedTool);
		// A new bulk action resets that local mouse choice, without replacing cards.
		editor.handleInput("\x0f");
		editor.handleInput("\x0f");
		expect(renderText(next)).toContain("new first");
		for (const expected of ["expanded", "collapsed", "preview"]) {
			editor.handleInput("\x14");
			expect(ctx.thinkingDisplayMode).toBe(expected);
			expect(renderText(tool)).toBe(expandedTool);
			expect(chatContainer.children[1]).toBe(tool);
		}
		editor.handleInput("\x0f");
		expect(renderText(tool)).toBe(collapsedTool);
		expect(renderText(component)).toContain("live tail");
		expect(renderText(component)).not.toContain("first reasoning");
		await handleEvent.call(ctx, { type: "message_end", message: nextMessage });
		await handleEvent.call(ctx, { type: "message_start", message: nextMessage });
		await handleEvent.call(ctx, {
			type: "message_update",
			message: nextMessage,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "new tail", partial: nextMessage },
		});
		expect(ctx.streamingComponent).not.toBe(next);
		expect(ctx.streamingComponent).toBeDefined();
		if (!ctx.streamingComponent) throw new Error("new assistant component missing");
		expect(renderText(ctx.streamingComponent)).toContain("new tail");
		expect(renderText(ctx.streamingComponent)).not.toContain("new first");
		await handleEvent.call(ctx, {
			type: "message_update",
			message: nextMessage,
			assistantMessageEvent: {
				type: "thinking_end",
				contentIndex: 0,
				content: "new first\nnew tail",
				partial: nextMessage,
			},
		});
		expect(renderText(ctx.streamingComponent)).not.toContain("Thinking...");
		// thinking_end keeps the identical rolling tail row: still the tail, still no first line.
		expect(renderText(ctx.streamingComponent)).toContain("new tail");
		expect(renderText(ctx.streamingComponent)).not.toContain("new first");
	});

	test.each(["ctrl+t", "ctrl+y"] as const)("settings description respects display binding %s", (binding) => {
		setKeybindings(new KeybindingsManager({ "app.thinking.toggle": binding }));
		const config = {
			availableDefaultModels: [],
			availableThinkingLevels: [],
			availableThemes: [],
			currentTheme: "dark",
			terminalTheme: "dark",
			thinkingDisplayMode: "preview",
			modelThinkingLevels: {},
			httpIdleTimeoutMs: 60000,
		};
		const selector = new SettingsSelectorComponent(config as never, {} as never);
		const list = Reflect.get(selector, "settingsList");
		const item = Reflect.get(list, "items").find((entry: { id: string }) => entry.id === "thinking-display");
		expect(item.description.toLowerCase()).toContain(binding);
	});

	test("experimental chat view keeps streaming and completed reasoning visible", () => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const chat = new ExperimentalChatView(ui, process.cwd());
		const conversation = { id: 1 as ConversationId };
		const message = fauxAssistantMessage([{ type: "thinking", thinking: "formerly visible reasoning" }]);
		try {
			chat.apply({
				conversation,
				entries: [],
				docs: {
					"pi.live": JSON.parse(JSON.stringify({ generation: { attempt: 0, message } })),
				},
			});
			expect(renderText(chat.transcript)).toContain("formerly visible reasoning");
			chat.apply({
				conversation,
				docs: {},
				entries: [{ id: 1 as EntryId, conversationId: conversation.id, kind: "pi.assistant", model: [message] }],
			});
			expect(renderText(chat.transcript)).toContain("formerly visible reasoning");
			// A historical message also goes through the non-streaming constructor.
			chat.apply({
				conversation,
				docs: {},
				entries: [{ id: 2 as EntryId, conversationId: conversation.id, kind: "pi.assistant", model: [message] }],
			});
			expect(renderText(chat.transcript)).toContain("formerly visible reasoning");
		} finally {
			chat.dispose();
		}
	});
});
