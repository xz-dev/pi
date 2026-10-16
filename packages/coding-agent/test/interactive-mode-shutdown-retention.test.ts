import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ExtensionShutdownProgress } from "../src/core/extensions/runner.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { formatShutdownProgressLine } from "../src/modes/interactive/shutdown-progress.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type ShutdownPresentation = {
	statusContainer: Container;
	chatContainer: Container;
	pendingRetainedShutdownSlowLines: string[];
	lastStatusSpacer: unknown;
	lastStatusText: unknown;
	sessionManager: { buildContextEntries: () => unknown[] };
	ui: { requestRender: () => void };
	renderSessionEntries: (entries: unknown) => void;
	renderInitialMessages: () => void;
	loadedResourcesContainer: Container;
	pendingMessagesContainer: Container;
	compactionQueuedMessages: unknown[];
	streamingComponent: undefined;
	streamingMessage: undefined;
	pendingTools: Map<string, unknown>;
};

const showShutdownProgress = Reflect.get(InteractiveMode.prototype, "showShutdownProgress") as (
	this: ShutdownPresentation,
	entry: ExtensionShutdownProgress,
) => void;
const rebuildChatFromMessages = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (
	this: ShutdownPresentation,
) => void;
const renderCurrentSessionState = Reflect.get(InteractiveMode.prototype, "renderCurrentSessionState") as (
	this: ShutdownPresentation,
) => void;
const flushRetainedShutdownSlowLines = Reflect.get(InteractiveMode.prototype, "flushRetainedShutdownSlowLines") as (
	this: ShutdownPresentation,
) => void;

function createPresentation(): ShutdownPresentation {
	const chatContainer = new Container();
	const mode = {
		statusContainer: new Container(),
		chatContainer,
		pendingRetainedShutdownSlowLines: [] as string[],
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		sessionManager: { buildContextEntries: () => [] },
		ui: { requestRender: vi.fn() },
		renderSessionEntries: () => {
			chatContainer.addChild(new Text("session-entry", 1, 0));
		},
		renderInitialMessages: () => {
			chatContainer.addChild(new Text("session-entry", 1, 0));
		},
		loadedResourcesContainer: new Container(),
		pendingMessagesContainer: new Container(),
		compactionQueuedMessages: ["queued"] as unknown[],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map<string, unknown>([["tool", {}]]),
		flushRetainedShutdownSlowLines() {
			flushRetainedShutdownSlowLines.call(this);
		},
	};
	return mode;
}

function progress(
	overrides: Partial<ExtensionShutdownProgress> & Pick<ExtensionShutdownProgress, "status">,
): ExtensionShutdownProgress {
	return {
		extensionPath: "/secret/home/user/.pi/agent/extensions/slow.ts",
		handlerIndex: 2,
		elapsedMs: overrides.status === "start" ? undefined : 143,
		slow: overrides.status === "end",
		...overrides,
	};
}

function rendered(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

function countSlowLines(text: string): number {
	return text.split("\n").filter((line) => line.includes("Slow shutdown hook:")).length;
}

describe("InteractiveMode shutdown line retention", () => {
	beforeAll(() => {
		initTheme();
	});

	test("reload reconstruction keeps one basename slow line and clears waiting/fast status", () => {
		const mode = createPresentation();

		showShutdownProgress.call(mode, progress({ status: "start", slow: false, elapsedMs: undefined }));
		expect(rendered(mode.statusContainer)).toContain("Shutting down: slow.ts#2");
		expect(rendered(mode.statusContainer)).not.toContain("/secret/home");

		showShutdownProgress.call(mode, progress({ status: "end", slow: false, elapsedMs: 10 }));
		expect(rendered(mode.statusContainer)).toBe("");
		expect(countSlowLines(rendered(mode.chatContainer))).toBe(0);

		showShutdownProgress.call(mode, progress({ status: "start", slow: false, elapsedMs: undefined }));
		expect(rendered(mode.statusContainer)).toContain("Shutting down: slow.ts#2");

		showShutdownProgress.call(mode, progress({ status: "end", slow: true, elapsedMs: 143 }));
		expect(rendered(mode.statusContainer)).toBe("");
		expect(countSlowLines(rendered(mode.chatContainer))).toBe(0);
		expect(mode.pendingRetainedShutdownSlowLines).toEqual([
			formatShutdownProgressLine(progress({ status: "end", slow: true, elapsedMs: 143 })),
		]);

		rebuildChatFromMessages.call(mode);
		const afterReload = rendered(mode.chatContainer);
		expect(afterReload).toContain("session-entry");
		expect(afterReload).toContain("Slow shutdown hook: slow.ts#2 · 143 ms");
		expect(afterReload).not.toContain("/secret/home");
		expect(countSlowLines(afterReload)).toBe(1);
		expect(mode.pendingRetainedShutdownSlowLines).toEqual([]);

		rebuildChatFromMessages.call(mode);
		expect(countSlowLines(rendered(mode.chatContainer))).toBe(0);
	});

	test("session replacement reconstruction drains once and does not leak to the next session", () => {
		const mode = createPresentation();
		showShutdownProgress.call(mode, progress({ status: "start", slow: false, elapsedMs: undefined }));
		showShutdownProgress.call(mode, progress({ status: "end", slow: true, elapsedMs: 250 }));

		renderCurrentSessionState.call(mode);
		const afterReplace = rendered(mode.chatContainer);
		expect(afterReplace).toContain("session-entry");
		expect(afterReplace).toContain("Slow shutdown hook: slow.ts#2 · 250 ms");
		expect(afterReplace).not.toContain("/secret/home");
		expect(countSlowLines(afterReplace)).toBe(1);
		expect(mode.pendingRetainedShutdownSlowLines).toEqual([]);
		expect(mode.compactionQueuedMessages).toEqual([]);
		expect(mode.pendingTools.size).toBe(0);

		renderCurrentSessionState.call(mode);
		expect(countSlowLines(rendered(mode.chatContainer))).toBe(0);
		expect(rendered(mode.statusContainer)).toBe("");
	});

	test("stop discards an undrained queue", () => {
		const mode = {
			...createPresentation(),
			disposeActiveSelector: () => {},
			settingsManager: {
				getShowTerminalProgress: () => false,
				getFullscreenExitOutput: () => "none" as const,
			},
			clearStatusIndicator: () => {},
			themeController: { disableAutoSync: () => {} },
			clearExtensionTerminalInputListeners: () => {},
			footer: { dispose: () => {} },
			footerDataProvider: { dispose: () => {} },
			isInitialized: false,
			unregisterSignalHandlers: () => {},
		};
		showShutdownProgress.call(mode, progress({ status: "end", slow: true, elapsedMs: 99 }));
		expect(mode.pendingRetainedShutdownSlowLines).toHaveLength(1);

		const stop = Reflect.get(InteractiveMode.prototype, "stop") as (this: typeof mode) => void;
		stop.call(mode);
		expect(mode.pendingRetainedShutdownSlowLines).toEqual([]);
		flushRetainedShutdownSlowLines.call(mode);
		expect(mode.chatContainer.children.filter((child) => !(child instanceof Spacer))).toHaveLength(0);
	});
});
