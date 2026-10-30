import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, MouseRegion, Text, TuiAltScreen, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { CustomMessageEntryDraft, MessageRenderer } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { OriginMessageComponent } from "../src/modes/interactive/components/origin-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const message: CustomMessage = {
	role: "custom",
	customType: "notice",
	display: false,
	content: "hidden body",
	timestamp: 1,
	origin: { type: "extension", extensionId: "test", extensionName: "pi-subagents" },
};
function text(component: Container, width = 80): string {
	return component.render(width).map(stripVTControlCharacters).join("\n");
}
function click(component: Container, label = "Extension"): void {
	const lines = component.render(80);
	const y = lines.findIndex((line) => stripVTControlCharacters(line).includes(label));
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width: 80,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
	};
	expect(component.handleMouse(event)?.handled).toBe(true);
}

// Exercise the same controller dispatch as Ctrl+O without booting provider/network services.
const controller = InteractiveMode.prototype as unknown as {
	handleEvent(this: object, event: AgentSessionEvent): Promise<void>;
	setToolsExpanded(this: object, expanded: boolean): void;
	addMessageToChat(this: object, message: AgentMessage, options?: { populateHistory?: boolean }): void;
};

const proto = InteractiveMode.prototype as unknown as Record<string, unknown>;

describe("message origin rendering", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	beforeAll(() => initTheme("dark"));

	it.each([null, undefined])("renders nullish hidden boundary content as empty (%s)", async (content) => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => ({
						entries: [
							{
								type: "custom_message",
								customType: "empty-control",
								display: false,
								...(content === undefined ? {} : { content }),
							} as unknown as CustomMessageEntryDraft,
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("start", { source: "interactive" });
		const event = harness.eventsOfType("entry_appended").find((entry) => entry.entry.type === "custom_message");
		expect(event).toBeDefined();
		const view = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			entriesRenderedByBoundaryCompaction: new Set<string>(),
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			outputPad: 1,
			toolOutputExpanded: false,
			session: harness.session,
			settingsManager: { getShowImages: () => false, getImageWidthCells: () => 60 },
			addMessageToChat(entry: AgentMessage) {
				controller.addMessageToChat.call(this, entry);
			},
		};
		await expect(controller.handleEvent.call(view, event!)).resolves.toBeUndefined();
		expect(view.chatContainer.render(80)).toEqual([]);
	});

	it("shows a gray tool-style source row without hints and toggles hidden content by click", () => {
		const component = new OriginMessageComponent(message);
		const collapsed = component.render(80).join("\n");
		expect(stripVTControlCharacters(collapsed)).toContain("[Extension · pi-subagents · hidden]");
		expect(stripVTControlCharacters(collapsed)).not.toMatch(/hidden body|expand|Ctrl|▸|▶/);
		// Collapsed hidden message: gray italic, background only under the text.
		expect(collapsed).toContain(theme.italic(theme.fg("muted", "[Extension · pi-subagents · hidden]")));
		expect(collapsed).toMatch(/\x1b\[48;/);
		click(component, "· hidden");
		const expandedAnsi = component.render(80).join("\n");
		expect(stripVTControlCharacters(expandedAnsi)).toContain("[Extension · pi-subagents]");
		expect(stripVTControlCharacters(expandedAnsi)).toContain("hidden body");
		expect(expandedAnsi).toMatch(/\x1b\[48;/);
		click(component);
		expect(text(component)).not.toContain("hidden body");
		// Like tool results, clicking the expanded body collapses it again.
		click(component, "· hidden");
		click(component, "hidden body");
		expect(text(component)).not.toContain("hidden body");
	});

	it.each([false, true])("keeps an expanded source heading in view (scrolled up: %s)", async (scrolledUp) => {
		const terminal = new VirtualTerminal(80, 16);
		const ui = new TuiAltScreen(terminal, false, "/var/tmp");
		const document = new Container();
		const previousReply = new Text("Previous answer", 0, 0);
		document.addChild(new Text(Array.from({ length: 20 }, (_, i) => `Earlier line ${i}`).join("\n"), 0, 0));
		document.addChild(previousReply);
		document.addChild(
			new OriginMessageComponent({
				...message,
				content: [
					"Continuation check starts here",
					...Array.from({ length: 40 }, (_, i) => `Review context ${i}`),
					"Previous answer",
				].join("\n"),
			}),
		);
		document.addChild(new Text("Next reply\nSecond line\nThird line", 0, 0));
		const viewport = createChatViewport({
			document,
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		ui.setLayoutRoot(viewport.root);
		ui.start();
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				ui.scrollToBottom();
				await terminal.waitForRender();
				if (scrolledUp) {
					ui.scrollBy(-1);
					await terminal.waitForRender();
				}
				const row = terminal.getViewport().findIndex((line) => line.includes("· hidden]"));
				expect(row).toBeGreaterThanOrEqual(0);
				terminal.sendInput(`\x1b[<0;3;${row + 1}M`);
				terminal.sendInput(`\x1b[<0;3;${row + 1}m`);
				await terminal.waitForRender();
				const screen = terminal.getViewport();
				expect(screen.join("\n")).toContain("[Extension · pi-subagents]");
				expect(screen.join("\n")).toContain("Continuation check starts here");
				expect(previousReply.render(80)).toEqual(new Text("Previous answer", 0, 0).render(80));
				const expandedRow = screen.findIndex((line) => line.includes("[Extension · pi-subagents]"));
				terminal.sendInput(`\x1b[<0;3;${expandedRow + 1}M`);
				terminal.sendInput(`\x1b[<0;3;${expandedRow + 1}m`);
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("· hidden]");
				expect(terminal.getViewport().join("\n")).not.toContain("Continuation check starts here");
			}
		} finally {
			ui.stop();
		}
	});

	it.each([false, true])(
		"preserves normal clicks and layout replacement (replace layout: %s)",
		async (replaceLayout) => {
			const terminal = new VirtualTerminal(80, 10);
			const ui = new TuiAltScreen(terminal, false, "/var/tmp");
			const document = new Container();
			document.addChild(new Text(Array.from({ length: 20 }, (_, i) => `Earlier line ${i}`).join("\n"), 0, 0));
			document.addChild(
				new MouseRegion(new Text("Ordinary action", 0, 0), (event) => {
					if (event.type !== "click") return undefined;
					if (replaceLayout) ui.setLayoutRoot(new Text("Replacement layout", 0, 0));
					return { handled: true, render: replaceLayout, preserveScroll: replaceLayout };
				}),
			);
			ui.addChild(document);
			ui.start();
			try {
				await terminal.waitForRender();
				const row = terminal.getViewport().findIndex((line) => line.includes("Ordinary action"));
				expect(row).toBeGreaterThanOrEqual(0);
				terminal.sendInput(`\x1b[<0;3;${row + 1}M`);
				expect(() => terminal.sendInput(`\x1b[<0;3;${row + 1}m`)).not.toThrow();
				await terminal.waitForRender();
				if (replaceLayout) {
					expect(terminal.getViewport().join("\n")).toContain("Replacement layout");
				} else {
					document.addChild(new Text("NEW OUTPUT", 0, 0));
					ui.requestRender();
					await terminal.waitForRender();
					expect(terminal.getViewport().join("\n")).toContain("NEW OUTPUT");
				}
			} finally {
				ui.stop();
			}
		},
	);

	it("preserves reading position for press-owned expansion without affecting overlays", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const ui = new TuiAltScreen(terminal, false, "/var/tmp");
		const document = new Container();
		const details = new Text("Collapsed control", 0, 0);
		document.addChild(new Text(Array.from({ length: 20 }, (_, i) => `Earlier line ${i}`).join("\n"), 0, 0));
		document.addChild(
			new MouseRegion(details, (event) => {
				if (event.type === "press") return { handled: true, capture: true };
				if (event.type !== "click") return undefined;
				details.setText(["Expanded control", ...Array.from({ length: 20 }, (_, i) => `Detail ${i}`)].join("\n"));
				return { handled: true, preserveScroll: true };
			}),
		);
		document.addChild(new Text("Following reply\nLast line", 0, 0));
		ui.addChild(document);
		ui.start();
		try {
			await terminal.waitForRender();
			const row = terminal.getViewport().findIndex((line) => line.includes("Collapsed control"));
			expect(row).toBeGreaterThanOrEqual(0);
			terminal.sendInput(`\x1b[<0;3;${row + 1}M`);
			terminal.sendInput(`\x1b[<0;3;${row + 1}m`);
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("Expanded control");
			expect(terminal.getViewport().join("\n")).toContain("Detail 0");
			ui.scrollToBottom();
			const overlay = ui.showOverlay(
				new MouseRegion(new Text("Overlay action", 0, 0), (event) =>
					event.type === "press"
						? { handled: true, capture: true }
						: { handled: true, preserveScroll: event.type === "click" },
				),
				{ anchor: "top-left", width: 30 },
			);
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;3;1M");
			terminal.sendInput("\x1b[<0;3;1m");
			overlay.hide();
			document.addChild(new Text("NEW OUTPUT", 0, 0));
			ui.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("NEW OUTPUT");
		} finally {
			ui.stop();
		}
	});

	it("lets global expansion override per-message choices in both directions", () => {
		const a = new OriginMessageComponent(message);
		const b = new OriginMessageComponent({ ...message, content: "second" });
		const chatContainer = new Container();
		chatContainer.addChild(a);
		chatContainer.addChild(b);
		const host = {
			toolOutputExpanded: false,
			chatContainer,
			loadedResourcesContainer: new Container(),
			showStatus: vi.fn(),
		};
		click(a);
		expect(text(b)).not.toContain("second");
		controller.setToolsExpanded.call(host, true);
		expect(text(b)).toContain("second");
		click(a);
		controller.setToolsExpanded.call(host, false);
		expect(text(a)).not.toContain("hidden body");
		expect(text(b)).not.toContain("second");
	});

	it("keeps the source visible even when a custom renderer supplies styled content", () => {
		const render: MessageRenderer = () => new Text("\x1b[31m\x1b[3mcustom body\x1b[0m", 0, 0);
		const component = new OriginMessageComponent(message, render);
		component.setExpanded(true);
		const output = component.render(80).join("\n");
		expect(stripVTControlCharacters(output)).toContain("Extension · pi-subagents");
		expect(output).toContain(theme.fg("muted", "custom body").replace(/\x1b\[39m$/, ""));
		expect(output).not.toMatch(/\x1b\[(?:31|3)m/);
	});

	it("keeps empty markers empty, identifies image-only content, and fits narrow widths", () => {
		expect(new OriginMessageComponent({ ...message, content: "  " }).render(80)).toEqual([]);
		const component = new OriginMessageComponent(
			{ ...message, content: [{ type: "image", data: "image", mimeType: "image/png" }] },
			undefined,
			1,
			false,
		);
		component.setExpanded(true);
		expect(text(component)).toContain("image/png");
		for (const width of [8, 20, 80])
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("routes hidden injections through the core shell while leaving interactive text unchanged", () => {
		const chatContainer = new Container();
		const history = vi.fn();
		const host = {
			chatContainer,
			outputPad: 1,
			toolOutputExpanded: false,
			session: { extensionRunner: { getMessageRenderer: () => undefined } },
			settingsManager: {
				getShowImages: () => false,
				getImageWidthCells: () => 60,
				getCollapseExpandedInput: () => true,
			},
			getUserMessageText: () => "human input",
			getUserMessageDisplayText: proto.getUserMessageDisplayText,
			getSubmittedCommandTextFor: proto.getSubmittedCommandTextFor,
			getMarkdownThemeWithSettings: () => undefined,
			getMarkdownTransformers: () => [],
			editor: { addToHistory: history },
		};
		controller.addMessageToChat.call(host, message, { populateHistory: true });
		expect(text(chatContainer)).toContain("pi-subagents");
		expect(text(chatContainer)).not.toContain("hidden body");
		expect(history).not.toHaveBeenCalled();
		controller.addMessageToChat.call(
			host,
			{ role: "user", content: "human input", origin: { type: "interactive" }, timestamp: 2 },
			{ populateHistory: true },
		);
		const last = chatContainer.children.at(-1)!;
		expect(last.render(80)).toEqual(new UserMessageComponent("human input").render(80));
		expect(history).toHaveBeenCalledWith("human input");
	});
});
