import { Container, setKeybindings, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { VirtualTerminal } from "../packages/tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../packages/coding-agent/src/core/keybindings.ts";
import { createChatViewport } from "../packages/coding-agent/src/modes/interactive/chat-viewport.ts";
import { ModelSelectorComponent } from "../packages/coding-agent/src/modes/interactive/components/model-selector.ts";
import { SelectorHost } from "../packages/coding-agent/src/modes/interactive/components/selector-host.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../packages/coding-agent/src/utils/ansi.ts";
import { createHarness } from "../packages/coding-agent/test/suite/harness.ts";

// Complete-replay gate: combines the independent refresh-selection policy with responsive selectors.
it("retains a browsed model through delayed refresh, cursor movement and wrapped resize", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const harness = await createHarness({ models: Array.from({ length: 20 }, (_, i) => ({
		id: `model-${String(i).padStart(2, "0")}-界界界界界界界界`, name: `Model ${i}`,
	})) });
	const terminal = new VirtualTerminal(40, 40);
	const ui = new TuiAltScreen(terminal, false, "/var/tmp");
	let complete!: () => void;
	const refresh = vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(async () => {
		await new Promise<void>((resolve) => { complete = resolve; });
		return { aborted: false, errors: new Map<string, Error>() };
	});
	const selected: string[] = [];
	const selector = new ModelSelectorComponent(ui, harness.getModel("model-00-界界界界界界界界"),
		harness.session.modelRuntime, [], (model) => selected.push(model.id), () => {}, "model");
	const host = new SelectorHost(ui, () => []);
	host.addChild(selector);
	ui.setLayoutRoot(createChatViewport({ document: new Text("history", 0, 0), pendingMessages: new Container(),
		status: new Container(), editor: host, footer: new Text("footer", 0, 0) }).root);
	ui.setFocus(selector);
	ui.start();
	const screen = async () => stripAnsi((await terminal.flushAndGetViewport()).join("\n"));
	try {
		await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
		await terminal.waitForRender();
		for (let i = 0; i < 8; i++) terminal.sendInput("\x1b[B");
		terminal.resize(40, 12);
		await terminal.waitForRender();
		expect(await screen()).toMatch(/→.*model-08/);
		terminal.sendInput("\x1b[C");
		expect(selector.getSearchInput().getValue()).toBe("model");
		terminal.resize(24, 12);
		await terminal.waitForRender();
		expect(await screen()).toMatch(/→.*model-08/);
		complete();
		await vi.waitFor(() => expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed."));
		ui.renderNow();
		await terminal.waitForRender();
		expect(await screen()).toMatch(/→.*model-08/);
		expect(selector.getSearchInput().getValue()).toBe("model");
		terminal.resize(40, 40);
		await terminal.waitForRender();
		expect(await screen()).toMatch(/→.*model-08/);
		terminal.sendInput("\r");
		expect(selected).toEqual(["model-08-界界界界界界界界"]);
	} finally {
		selector.dispose(); ui.stop(); refresh.mockRestore(); harness.cleanup();
	}
});
