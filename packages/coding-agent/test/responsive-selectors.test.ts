import { type Component, Container, setKeybindings, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { SelectorHost } from "../src/modes/interactive/components/selector-host.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const labels = Array.from({ length: 20 }, (_, index) => `option-${String(index).padStart(2, "0")} 界界界界界界界界`);

describe("responsive sibling selectors", () => {
	let harness: Harness | undefined;
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	// Same editor-slot clipping regression as earendil-works/pi#10213.
	it.each(["extension", "oauth", "fork", "scoped"] as const)(
		"keeps the %s selection visible and confirms that item",
		async (kind) => {
			const terminal = new VirtualTerminal(40, 40);
			const ui = new TuiAltScreen(terminal, false, "/var/tmp");
			const selected: string[] = [];
			let component: Component;
			let focus: Component;
			if (kind === "extension") {
				component = focus = new ExtensionSelectorComponent(
					"Choose an option",
					labels,
					(value) => selected.push(value),
					() => {},
				);
			} else if (kind === "oauth") {
				component = focus = new OAuthSelectorComponent(
					"login",
					labels.map((name, i) => ({ id: String(i), name, authType: "api_key" })),
					(id) => selected.push(id),
					() => {},
				);
			} else if (kind === "fork") {
				const selector = new UserMessageSelectorComponent(
					labels.map((text, i) => ({ id: String(i), text })),
					(id) => selected.push(id),
					() => {},
					"0",
				);
				component = selector;
				focus = selector.getMessageList();
			} else {
				harness = await createHarness({ models: labels.map((id) => ({ id, name: id })) });
				component = focus = new ScopedModelsSelectorComponent(
					{ allModels: labels.map((id) => harness!.getModel(id)!), enabledModelIds: null },
					{
						onChange: (ids) => {
							selected.push(ids?.includes(`faux/${labels[8]}`) ? "still enabled" : "8");
						},
						onPersist: () => {},
						onCancel: () => {},
					},
				);
			}
			const host = new SelectorHost(ui, () => []);
			host.addChild(component);
			const viewport = createChatViewport({
				document: new Text("conversation", 0, 0),
				pendingMessages: new Container(),
				status: new Container(),
				editor: host,
				footer: new Text("footer", 0, 0),
			});
			ui.setLayoutRoot(viewport.root);
			ui.setFocus(focus);
			ui.start();
			try {
				await terminal.waitForRender();
				for (let i = 0; i < 8; i++) terminal.sendInput("\x1b[B");
				for (const height of [12, 40]) {
					terminal.resize(40, height);
					await terminal.waitForRender();
					const screen = stripAnsi((await terminal.flushAndGetViewport()).join("\n"));
					expect(screen).toMatch(/[→›].*option-08/);
					if (kind === "oauth" || kind === "scoped") expect(screen).toContain(">");
				}
				terminal.sendInput("\r");
				expect(selected).toEqual([kind === "extension" ? labels[8] : "8"]);
			} finally {
				ui.stop();
			}
		},
	);

	it("does not confirm a permission choice while its explanation cannot fit", () => {
		const selected: string[] = [];
		const selector = new ExtensionSelectorComponent(
			"Permission\n".repeat(20),
			["Yes", "No"],
			(value) => selected.push(value),
			() => {},
		);
		expect(stripAnsi(selector.renderInBounds(40, 8).join("\n"))).toContain("Resize to read and choose");
		selector.handleInput("\r");
		expect(selected).toEqual([]);
		selector.renderInBounds(40, 40);
		selector.handleInput("\r");
		expect(selected).toEqual(["Yes"]);
	});
});
