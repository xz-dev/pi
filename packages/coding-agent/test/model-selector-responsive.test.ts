import { Container, setKeybindings, Text, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { SelectorHost } from "../src/modes/interactive/components/selector-host.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const MODEL_COUNT = 20;

describe("model selector fullscreen height", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	// Regression: earendil-works/pi#10213, fullscreen clipped the selected row below the search cursor.
	it.each(["fullscreen", "regular"] as const)(
		"keeps the selected row and search input visible through resize in %s",
		async (mode) => {
			harness = await createHarness({
				models: Array.from({ length: MODEL_COUNT }, (_, index) => ({
					id: `model-${String(index).padStart(2, "0")}`,
					name: `Model ${index}`,
				})),
			});
			const terminal = new VirtualTerminal(40, 40);
			const ui =
				mode === "fullscreen"
					? new TuiAltScreen(terminal, false, "/var/tmp")
					: new TuiMainScreen(terminal, false, "/var/tmp");
			const selected: string[] = [];
			const selector = new ModelSelectorComponent(
				ui,
				harness.getModel("model-00"),
				harness.session.modelRuntime,
				[],
				(model) => selected.push(model.id),
				() => {},
				undefined,
				() => {},
			);
			const footer = new Text("model footer", 0, 0);
			const editor = new SelectorHost(ui, () => [footer]);
			editor.addChild(selector);
			const viewport = createChatViewport({
				document: new Text("conversation", 0, 0),
				pendingMessages: new Container(),
				status: new Container(),
				editor,
				footer,
			});
			if (ui instanceof TuiAltScreen) ui.setLayoutRoot(viewport.root);
			else {
				ui.addChild(new Text(Array.from({ length: 50 }, (_, index) => `conversation ${index}`).join("\n"), 0, 0));
				ui.addChild(editor);
				ui.addChild(footer);
			}
			ui.setFocus(selector);
			ui.start();
			try {
				await terminal.waitForRender();

				const screen = async () => stripAnsi((await terminal.flushAndGetViewport()).join("\n"));
				const selectedRow = (rendered: string) =>
					rendered
						.split("\n")
						.find((line) => line.includes("→"))
						?.trim();

				terminal.resize(40, 12);
				await terminal.waitForRender();
				for (let i = 0; i < 8; i++) terminal.sendInput("\x1b[B");
				await terminal.waitForRender();

				let rendered = await screen();
				expect(rendered).toContain(">");
				expect(selectedRow(rendered)).toContain("model-08");
				expect(rendered).toContain("select");
				expect(rendered).toContain("cancel");

				terminal.resize(40, 40);
				await terminal.waitForRender();
				rendered = await screen();
				expect(selectedRow(rendered)).toContain("model-08");
				terminal.sendInput("\r");
				await terminal.waitForRender();
				expect(selected).toEqual(["model-08"]);
			} finally {
				selector.dispose();
				ui.stop();
			}
		},
	);

	it("keeps a filtered model through cursor movement and wrapped-row resize", async () => {
		harness = await createHarness({
			models: Array.from({ length: 20 }, (_, index) => ({
				id: `model-${String(index).padStart(2, "0")}-界界界界界界界界`,
				name: `Model ${index}`,
			})),
		});
		const terminal = new VirtualTerminal(24, 12);
		const ui = new TuiAltScreen(terminal, false, "/var/tmp");
		const saved: string[] = [];
		const selector = new ModelSelectorComponent(
			ui,
			harness.getModel("model-00-界界界界界界界界"),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			"model",
			(model) => saved.push(model.id),
		);
		selector.focused = true;
		try {
			// The independent refresh-selection patch tests refresh while browsing.
			// Let startup settle before exercising bounded rendering on this branch.
			await vi.waitFor(() => expect(stripAnsi(selector.render(80).join("\n"))).toContain("refreshed"));
			for (let i = 0; i < 8; i++) selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[C");
			const screen = () => stripAnsi(selector.renderInBounds(24, 10).join("\n"));
			expect(screen()).toMatch(/→.*model-08/);
			expect(selector.getSearchInput().getValue()).toBe("model");
			for (const height of [0, 1, 2, 5, 12, 40]) {
				const lines = selector.renderInBounds(24, height);
				expect(lines.length).toBeLessThanOrEqual(height);
				if (height >= 2) expect(stripAnsi(lines.join("\n"))).toMatch(/→.*model-08/);
			}
			selector.handleInput("\x13");
			expect(saved).toEqual(["model-08-界界界界界界界界"]);
		} finally {
			selector.dispose();
			ui.stop();
		}
	});
	it("retains the model query and highlight while the compact dock hides and expands", async () => {
		harness = await createHarness({
			models: Array.from({ length: 20 }, (_, index) => ({
				id: `model-${String(index).padStart(2, "0")}`,
				name: `Model ${index}`,
			})),
		});
		const terminal = new VirtualTerminal(40, 40);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			terminal,
			showHardwareCursor: false,
			logDirectory: "/var/tmp",
		});
		const chosen: string[] = [];
		const selector = new ModelSelectorComponent(
			ui,
			harness.getModel("model-00"),
			harness.session.modelRuntime,
			[],
			(model) => chosen.push(model.id),
			() => {},
			"model",
		);
		const editor = new SelectorHost(ui, () => []);
		editor.addChild(selector);
		const viewport = createChatViewport({
			document: new Text(Array.from({ length: 50 }, (_, i) => `message ${i}`).join("\n"), 0, 0),
			pendingMessages: new Container(),
			status: new Container(),
			editor,
			footer: new Text("model footer", 0, 0),
		});
		ui.setLayoutRoot(viewport.root);
		ui.setFocus(selector);
		const screen = () => terminal.getViewport().join("\n");
		const click = (label: string) => {
			const lines = terminal.getViewport();
			const row = lines.findIndex((line) => line.includes(label));
			expect(row, screen()).toBeGreaterThanOrEqual(0);
			const column = lines[row].indexOf(label);
			terminal.sendInput(`\x1b[<0;${column + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${column + 1};${row + 1}m`);
		};
		ui.start();
		try {
			await terminal.waitForRender();
			terminal.resize(40, 12);
			for (let i = 0; i < 8; i++) terminal.sendInput("\x1b[B");
			await terminal.waitForRender();
			expect(screen()).toMatch(/→.*model-08/);
			terminal.sendInput("\x1b[5~");
			terminal.sendInput("\r");
			terminal.sendInput("X");
			await terminal.waitForRender();
			expect(chosen).toEqual([]);
			expect(selector.getSearchInput().getValue()).toBe("model");
			expect(screen()).not.toMatch(/model-08|model footer/);
			click("[Expand input]");
			await terminal.waitForRender();
			expect(ui.isFollowingOutput).toBe(false);
			expect(screen()).toMatch(/→.*model-08/);
			click("[Collapse input]");
			await terminal.waitForRender();
			terminal.resize(40, 40);
			await terminal.waitForRender();
			expect(screen()).not.toContain("model-08");
			click("Jump to latest");
			await terminal.waitForRender();
			expect(screen()).toMatch(/→.*model-08/);
			terminal.sendInput("\r");
			expect(chosen).toEqual(["model-08"]);
		} finally {
			selector.dispose();
			ui.stop();
		}
	});
});
