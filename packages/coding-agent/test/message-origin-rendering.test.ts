import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, Text, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { CustomMessageEntryDraft, MessageRenderer } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
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
		expect(text(component)).toContain("[Extension · pi-subagents]");
		expect(text(component)).not.toMatch(/hidden body|expand|Ctrl|▸|▶/);
		const ansi = component.render(80).join("\n");
		expect(ansi).toContain(theme.fg("muted", "[Extension · pi-subagents]"));
		expect(ansi).not.toContain("\x1b[3m");
		click(component);
		expect(text(component)).toContain("hidden body");
		click(component);
		expect(text(component)).not.toContain("hidden body");
		// Like tool results, clicking the expanded body collapses it again.
		click(component);
		click(component, "hidden body");
		expect(text(component)).not.toContain("hidden body");
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
			settingsManager: { getShowImages: () => false, getImageWidthCells: () => 60 },
			getUserMessageText: () => "human input",
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
