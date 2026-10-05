import { Container, getKeybindings, Input, setKeybindings, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";

describe("chat viewport", () => {
	beforeEach(() => initTheme("dark"));
	test.each([
		{ rows: 8, prefix: "/" },
		{ rows: 30, prefix: "@" },
	])("keeps the reading dock compact ($rows rows, $prefix completions)", async ({ rows, prefix }) => {
		const previousKeys = getKeybindings();
		const keys = new KeybindingsManager();
		setKeybindings(keys);
		const terminal = new VirtualTerminal(60, 12);
		const ui = new TuiAltScreen(terminal, false, "/var/tmp", {
			wheelScrollLines: 1,
			scrollToEndIndicator: () => "Jump to latest",
		});
		const document = new Text(Array.from({ length: rows }, (_, i) => `message ${i}`).join("\n"), 0, 0);
		const editor = new CustomEditor(ui, defaultEditorTheme, keys, { embedWorkingStatus: true });
		editor.setText("first draft line\nsecond draft line\nthird draft line");
		const status = new WorkingStatusIndicator(ui, "Working", undefined, (text) => text);
		editor.setWorkingStatusIndicator(status);
		const editorSlot = new Container();
		editorSlot.addChild(editor);
		const components = {
			document,
			pendingMessages: new Text("queued preview", 0, 0),
			status: new Container(),
			editor: editorSlot,
			widgetsAbove: new Text("above widget", 0, 0),
			widgetsBelow: new Text("below widget", 0, 0),
			footer: new Text("model footer", 0, 0),
		};
		const viewport = createChatViewport(components);
		for (const component of Object.values(components)) ui.addChild(component);
		ui.setLayoutRoot(viewport.root);
		ui.setFocus(editor);
		ui.start();
		try {
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("model footer");
			terminal.sendInput("\x1b[<64;1;1M");
			for (let frame = 0; frame < 3; frame++) {
				ui.requestRender();
				await terminal.waitForRender();
				const screen = terminal.getViewport();
				expect(screen[9]).toContain("Working");
				expect(screen[10]).toContain("third draft line");
				expect(screen[11]).toMatch(/^─+$/);
				expect(screen.join("\n")).not.toMatch(/model footer|widget|queued preview/);
			}
			// Upward intent must not restore the dock even when shrinking it makes all messages fit.
			for (const input of ["\x1b[<64;1;1M", "\x1b[5~", "\x1b[1;5H"]) {
				terminal.sendInput(input);
				await terminal.waitForRender();
				expect(terminal.getViewport()[9]).toContain("Working");
				expect(terminal.getViewport().join("\n")).not.toContain("model footer");
			}
			// Manual expansion also stays detached when the short transcript fits after collapse.
			for (const label of ["[Expand input]", "[Collapse input]"]) {
				const screen = terminal.getViewport();
				const row = screen.findIndex((line) => line.includes(label));
				expect(row).toBeGreaterThanOrEqual(0);
				terminal.sendInput(`\x1b[<0;1;${row + 1}M`);
				terminal.sendInput(`\x1b[<0;1;${row + 1}m`);
				await terminal.waitForRender();
				expect(ui.isFollowingOutput).toBe(false);
				expect(terminal.getViewport().join("\n").includes("model footer")).toBe(label === "[Expand input]");
			}
			const readingLine = terminal.getViewport()[0];
			document.setText(Array.from({ length: rows + 5 }, (_, i) => `message ${i}`).join("\n"));
			ui.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport()[0]).toBe(readingLine);
			expect(terminal.getViewport()[9]).toContain("Working");
			expect(editor.getText()).toBe("first draft line\nsecond draft line\nthird draft line");
			// The compact render must not change the editor's regular-mode height.
			expect(editor.render(60)).toHaveLength(5);
			ui.requestRender();
			await terminal.waitForRender();
			terminal.sendInput("\x1b[A");
			terminal.sendInput("\x05"); // Move to the draft line end, not the transcript end.
			terminal.sendInput("\x1b[200~ pasted\x1b[201~");
			await terminal.waitForRender();
			expect(editor.getCursor().line).toBe(1);
			expect(terminal.getViewport()[10]).toContain("pasted");
			expect(editor.getText()).toContain("first draft line\nsecond draft line pasted\nthird draft line");
			terminal.sendInput("\x1b[<0;1;11M");
			terminal.sendInput("\x1b[<0;1;11m");
			terminal.sendInput("X");
			await terminal.waitForRender();
			expect(ui.getFocusedComponent()).toBe(editor);
			expect(editor.getText()).toContain("\nXsecond draft line pasted\n");
			terminal.resize(40, 14);
			await terminal.waitForRender();
			expect(terminal.getViewport()[11]).toContain("Working");
			expect(terminal.getViewport()[12]).toContain("Xsecond draft line pasted");
			terminal.resize(60, 12);
			await terminal.waitForRender();
			terminal.sendInput("\x1b[1;5F");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("model footer");
			expect(terminal.getViewport().join("\n")).toContain("above widget");
			// Mouse-wheel and the existing clickable indicator also restore the full dock.
			for (const restore of ["wheel", "indicator"]) {
				terminal.sendInput("\x1b[<64;1;1M");
				await terminal.waitForRender();
				if (restore === "wheel") {
					terminal.sendInput("\x1b[<65;1;1M");
				} else {
					const labelRow = terminal.getViewport()[8];
					const column = labelRow.indexOf("Jump to latest") + 1;
					expect(column).toBeGreaterThan(0);
					terminal.sendInput(`\x1b[<0;${column};9M`);
					terminal.sendInput(`\x1b[<0;${column};9m`);
				}
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("model footer");
			}
			terminal.sendInput("\x1b[<64;1;1M");
			await terminal.waitForRender();
			// Replacement panels follow the same scrollback collapse state as the editor.
			editorSlot.clear();
			editorSlot.addChild(new Text("selector one\nselector two\nselector three\nselector four", 0, 0));
			ui.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).not.toContain("selector four");
			expect(terminal.getViewport().join("\n")).toContain("[Expand input]");
			expect(terminal.getViewport().join("\n")).toContain("Jump to latest");
			expect(terminal.getViewport().join("\n")).not.toContain("model footer");
			editorSlot.clear();
			editorSlot.addChild(editor);
			editor.setAutocompleteProvider({
				getSuggestions: async () => ({
					prefix,
					items: [
						{ value: `${prefix}one`, label: "completion one" },
						{ value: `${prefix}two`, label: "completion two" },
					],
				}),
				applyCompletion: (_lines, _line, _col, item) => ({
					lines: [item.value],
					cursorLine: 0,
					cursorCol: item.value.length,
				}),
			});
			editor.setText("");
			terminal.sendInput(prefix);
			await expect.poll(() => editor.isShowingAutocomplete()).toBe(true);
			await terminal.waitForRender();
			const completionScreen = terminal.getViewport().join("\n");
			expect(completionScreen).toContain(prefix);
			expect(completionScreen).toContain("completion two");
			expect(completionScreen).not.toMatch(/model footer|widget|queued preview/);
			expect(ui.isFollowingOutput).toBe(false);
			expect(ui.getFocusedComponent()).toBe(editor);
			expect(completionScreen).toContain("[Expand input]");
			const expandRow = terminal.getViewport().findIndex((line) => line.includes("[Expand input]"));
			terminal.sendInput(`\x1b[<0;1;${expandRow + 1}M`);
			terminal.sendInput(`\x1b[<0;1;${expandRow + 1}m`);
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("completion two");
			expect(terminal.getViewport().join("\n")).toContain("[Collapse input]");
			terminal.sendInput("\x1b");
			terminal.sendInput("\x1b[1;5F");
			terminal.sendInput("\x1b[5~");
			await terminal.waitForRender();
			expect(terminal.getViewport()[9]).toContain("Working");
			expect(terminal.getViewport().join("\n")).not.toContain("model footer");
		} finally {
			status.dispose();
			ui.stop();
			setKeybindings(previousKeys);
		}
	});

	test.each([80, 40])("hides custom panels without losing or submitting answers (%i columns)", async (columns) => {
		const previousKeys = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const terminal = new VirtualTerminal(columns, 14);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			terminal,
			showHardwareCursor: false,
			logDirectory: "/var/tmp",
		});
		const input = new Input();
		input.handleInput("saved answer");
		const submitted: string[] = [];
		input.onSubmit = (answer) => submitted.push(answer);
		// ctx.ui.custom mounts and focuses a component in the editor slot, as ask does.
		const panel = new (class extends Container {
			handleInput(data: string): void {
				input.handleInput(data);
			}
		})();
		panel.addChild(new Text("Question\nOption one\nOption two", 0, 0));
		panel.addChild(input);
		const editorSlot = new Container();
		editorSlot.addChild(panel);
		const viewport = createChatViewport({
			document: new Text(Array.from({ length: 50 }, (_, i) => `message ${i}`).join("\n"), 0, 0),
			pendingMessages: new Container(),
			status: new Container(),
			editor: editorSlot,
			footer: new Text("model footer", 0, 0),
		});
		ui.setLayoutRoot(viewport.root);
		ui.setFocus(panel);
		const click = (label: string) => {
			const screen = terminal.getViewport();
			const row = screen.findIndex((line) => line.includes(label));
			expect(row, screen.join("\n")).toBeGreaterThanOrEqual(0);
			const column = screen[row].indexOf(label);
			terminal.sendInput(`\x1b[<0;${column + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${column + 1};${row + 1}m`);
		};
		ui.start();
		try {
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("saved answer");
			terminal.sendInput("\x1b[5~");
			// Hidden controls must not process keys, even before the next frame.
			terminal.sendInput("\r");
			terminal.sendInput("X");
			await terminal.waitForRender();
			expect(submitted).toEqual([]);
			expect(input.getValue()).toBe("saved answer");
			const screen = terminal.getViewport().join("\n");
			expect(screen).toContain("[Expand input]");
			expect(screen).toContain("Jump to latest");
			expect(screen).not.toMatch(/Question|Option|saved answer|model footer/);
			const readingLine = terminal.getViewport()[0];
			click("[Expand input]");
			await terminal.waitForRender();
			expect(ui.isFollowingOutput).toBe(false);
			expect(terminal.getViewport()[0]).toBe(readingLine);
			expect(terminal.getViewport().join("\n")).toContain("saved answer");
			expect(terminal.getViewport().join("\n")).toContain("Jump to latest");
			terminal.sendInput("!");
			await terminal.waitForRender();
			expect(input.getValue()).toBe("saved answer!");
			click("[Collapse input]");
			await terminal.waitForRender();
			terminal.resize(columns, 2);
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("[Expand input]");
			expect(terminal.getViewport().join("\n")).toContain("Jump to latest");
			terminal.resize(columns, 14);
			await terminal.waitForRender();
			click("Jump to latest");
			await terminal.waitForRender();
			expect(ui.isFollowingOutput).toBe(true);
			expect(terminal.getViewport().join("\n")).toContain("saved answer!");
			expect(terminal.getViewport().join("\n")).not.toMatch(/\[(?:Expand|Collapse) input\]/);
			terminal.sendInput("\r");
			expect(submitted).toEqual(["saved answer!"]);
			terminal.sendInput("\x1b[5~");
			terminal.sendInput("\x1b[1;5F");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("saved answer!");
		} finally {
			ui.stop();
			setKeybindings(previousKeys);
		}
	});

	test.each([80, 55, 40, 20])("toggles the reading dock without navigating (%i columns)", async (columns) => {
		const previousKeys = getKeybindings();
		const keys = new KeybindingsManager();
		setKeybindings(keys);
		const terminal = new VirtualTerminal(columns, 14);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			terminal,
			showHardwareCursor: false,
			logDirectory: "/var/tmp",
		});
		const document = new Text(Array.from({ length: 50 }, (_, i) => `message ${i}`).join("\n"), 0, 0);
		const editor = new CustomEditor(ui, defaultEditorTheme, keys, { embedWorkingStatus: true });
		const draft = "first draft\nsecond draft\nthird draft";
		editor.setText(draft);
		const viewport = createChatViewport({
			document,
			pendingMessages: new Text("queued preview", 0, 0),
			status: new Container(),
			editor,
			widgetsAbove: new Text("above widget", 0, 0),
			footer: new Text("model footer", 0, 0),
		});
		ui.setLayoutRoot(viewport.root);
		ui.setFocus(editor);
		const click = (label: string) => {
			const screen = terminal.getViewport();
			const row = screen.findIndex((line) => line.includes(label));
			expect(row, `Missing ${label}:\n${screen.join("\n")}`).toBeGreaterThanOrEqual(0);
			const column = screen[row].indexOf(label);
			terminal.sendInput(`\x1b[<0;${column + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${column + 1};${row + 1}m`);
		};
		const expectControls = (label: string, stacked: boolean) => {
			const screen = terminal.getViewport();
			const row = screen.findIndex((line) => line.includes(label));
			expect(row).toBeGreaterThanOrEqual(0);
			expect(screen[row].indexOf(label)).toBe(0);
			expect(screen.findIndex((line) => line.includes("Jump to latest"))).toBe(row + (stacked ? 1 : 0));
			expect(ui.isFollowingOutput).toBe(false);
			expect(editor.getText()).toBe(draft);
			expect(ui.getFocusedComponent()).toBe(editor);
		};
		ui.start();
		try {
			await terminal.waitForRender();
			ui.scrollBy(-20);
			await terminal.waitForRender();
			const readingLine = terminal.getViewport()[0].match(/^message \d+/)![0];
			expectControls("[Expand input]", columns < 55);
			expect(terminal.getViewport().join("\n")).not.toContain("model footer");
			click("[Expand input]");
			await terminal.waitForRender();
			expectControls("[Collapse input]", columns < 55);
			expect(terminal.getViewport().join("\n")).toContain("model footer");
			expect(terminal.getViewport()[0]).toContain(readingLine);
			click("[Collapse input]");
			await terminal.waitForRender();
			expectControls("[Expand input]", columns < 55);
			expect(terminal.getViewport().join("\n")).not.toContain("model footer");
			expect(terminal.getViewport()[0]).toContain(readingLine);
			click("[Expand input]");
			await terminal.waitForRender();
			// Streaming and wide/narrow resizing preserve the manual choice and rebuild hit targets.
			document.setText(Array.from({ length: 55 }, (_, i) => `message ${i}`).join("\n"));
			ui.requestRender();
			await terminal.waitForRender();
			for (const width of [40, 80]) {
				terminal.resize(width, 14);
				await terminal.waitForRender();
				expectControls("[Collapse input]", width === 40);
				expect(terminal.getViewport()[0]).toContain(readingLine);
				click("[Collapse input]");
				await terminal.waitForRender();
				expectControls("[Expand input]", width === 40);
				click("[Expand input]");
				await terminal.waitForRender();
			}
			// A new episode resets even if latest and scrollback occur before the next frame.
			terminal.sendInput("\x1b[1;5F");
			terminal.sendInput("\x1b[5~");
			await terminal.waitForRender();
			expectControls("[Expand input]", false);
			click("[Expand input]");
			await terminal.waitForRender();
			terminal.resize(40, 5);
			await terminal.waitForRender();
			expectControls("[Collapse input]", true);
			click("[Collapse input]");
			await terminal.waitForRender();
			expectControls("[Expand input]", true);
			// Jump remains a separate target on the lower row, including after height changes.
			click("Jump to latest");
			await terminal.waitForRender();
			expect(ui.isFollowingOutput).toBe(true);
			expect(terminal.getViewport().join("\n")).not.toMatch(/\[(?:Expand|Collapse) input\]/);
			terminal.resize(80, 14);
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("model footer");
			terminal.sendInput("\x1b[5~");
			await terminal.waitForRender();
			expectControls("[Expand input]", false);
		} finally {
			ui.stop();
			setKeybindings(previousKeys);
		}
	});

	test.each([
		{ columns: 80, rows: 5, scrollback: false },
		{ columns: 40, rows: 5, scrollback: false },
		{ columns: 80, rows: 3, scrollback: false },
		{ columns: 80, rows: 4, scrollback: true },
		{ columns: 40, rows: 4, scrollback: true },
	])(
		"preserves constrained dock space ($columns x $rows, scrollback=$scrollback)",
		async ({ columns, rows, scrollback }) => {
			const previousKeys = getKeybindings();
			const keys = new KeybindingsManager();
			setKeybindings(keys);
			const terminal = new VirtualTerminal(columns, rows);
			const ui = createInteractiveTui({
				tuiMode: "fullscreen",
				terminal,
				showHardwareCursor: false,
				logDirectory: "/var/tmp",
			});
			const editor = new CustomEditor(ui, defaultEditorTheme, keys, { embedWorkingStatus: true });
			editor.setText("MY DRAFT");
			const viewport = createChatViewport({
				document: new Text(Array.from({ length: 30 }, (_, i) => `message ${i}`).join("\n"), 0, 0),
				pendingMessages: new Container(),
				status: new Container(),
				editor,
				footer: new Text("model footer", 0, 0),
			});
			ui.setLayoutRoot(viewport.root);
			ui.setFocus(editor);
			ui.start();
			try {
				await terminal.waitForRender();
				if (scrollback) {
					ui.scrollBy(-10);
					await terminal.waitForRender();
				}
				const screen = terminal.getViewport();
				expect(screen.join("\n")).toContain("MY DRAFT");
				if (rows === 5) expect(screen[4]).toContain("model footer");
				if (scrollback) {
					if (columns === 80) expect(screen[3]).toMatch(/^─+$/);
					expect(ui.isFollowingOutput).toBe(false);
					expect(screen.join("\n")).toContain("[Expand input]");
					expect(screen.join("\n")).toContain("Jump to latest");
				}
			} finally {
				ui.stop();
				setKeybindings(previousKeys);
			}
		},
	);

	test("scrolls constrained widgets without losing the editor, footer, or transcript position", async () => {
		const previousKeys = getKeybindings();
		const keys = new KeybindingsManager();
		setKeybindings(keys);
		const terminal = new VirtualTerminal(60, 22);
		const ui = new TuiAltScreen(terminal, false, "/var/tmp", { wheelScrollLines: 1 });
		const editor = new CustomEditor(ui, defaultEditorTheme, keys);
		editor.setText("MY DRAFT");
		const viewport = createChatViewport({
			document: new Text(Array.from({ length: 50 }, (_, i) => `message ${i}`).join("\n"), 0, 0),
			pendingMessages: new Container(),
			status: new Container(),
			editor,
			widgetsAbove: new Text(Array.from({ length: 11 }, (_, i) => `above ${i}`).join("\n"), 0, 0),
			widgetsBelow: new Text(Array.from({ length: 7 }, (_, i) => `below ${i}`).join("\n"), 0, 0),
			footer: new Text("footer 0\nfooter 1\nfooter 2", 0, 0),
		});
		ui.setLayoutRoot(viewport.root);
		ui.setFocus(editor);
		const wheel = async (prefix: string, button: 64 | 65) => {
			const row = terminal.getViewport().findIndex((line) => line.startsWith(prefix));
			expect(row).toBeGreaterThanOrEqual(0);
			for (let i = 0; i < 20; i++) terminal.sendInput(`\x1b[<${button};1;${row + 1}M`);
			await terminal.waitForRender();
			expect(ui.isFollowingOutput).toBe(true);
			expect(terminal.getViewport().join("\n")).toContain("MY DRAFT");
			expect(terminal.getViewport().join("\n")).toContain("footer 2");
		};
		ui.start();
		try {
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("footer 2");
			expect(terminal.getViewport().join("\n")).not.toContain("above 10");
			expect(terminal.getViewport().join("\n")).not.toContain("below 6");
			// A wheel gesture at a widget boundary must not collapse the input dock.
			await wheel("above ", 64);
			await wheel("above ", 65);
			expect(terminal.getViewport().join("\n")).toContain("above 10");
			await wheel("below ", 65);
			expect(terminal.getViewport().join("\n")).toContain("below 6");
			await wheel("above ", 64);
			await wheel("below ", 64);
			terminal.resize(60, 49);
			await terminal.waitForRender();
			const screen = terminal.getViewport().join("\n");
			for (const line of ["above 0", "above 10", "below 0", "below 6", "MY DRAFT", "footer 2"]) {
				expect(screen).toContain(line);
			}
			expect(ui.isFollowingOutput).toBe(true);
			// When widgets fit, their area retains the original transcript scrolling behavior.
			const row = terminal.getViewport().findIndex((line) => line.startsWith("above "));
			expect(row).toBeGreaterThanOrEqual(0);
			terminal.sendInput(`\x1b[<64;1;${row + 1}M`);
			await terminal.waitForRender();
			expect(ui.isFollowingOutput).toBe(false);
			expect(terminal.getViewport().join("\n")).toContain("MY DRAFT");
			expect(terminal.getViewport().join("\n")).not.toMatch(/above|below|footer/);
		} finally {
			ui.stop();
			setKeybindings(previousKeys);
		}
	});

	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});
});
