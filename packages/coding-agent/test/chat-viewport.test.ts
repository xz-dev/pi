import { Container, getKeybindings, setKeybindings, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";

describe("chat viewport", () => {
	test.each([8, 30])("keeps the reading dock compact (%i rows)", async (rows) => {
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
			for (const input of ["\x1b[<64;1;1M", "\x1b[5~", "\x1b[H"]) {
				terminal.sendInput(input);
				await terminal.waitForRender();
				expect(terminal.getViewport()[9]).toContain("Working");
				expect(terminal.getViewport().join("\n")).not.toContain("model footer");
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
			terminal.sendInput("\x1b[F");
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
			// A selector or opaque extension editor must keep its full rendering.
			editorSlot.clear();
			editorSlot.addChild(new Text("selector one\nselector two\nselector three\nselector four", 0, 0));
			ui.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("selector four");
			expect(terminal.getViewport().join("\n")).toContain("model footer");
			editorSlot.clear();
			editorSlot.addChild(editor);
			editor.setAutocompleteProvider({
				getSuggestions: async () => ({
					prefix: "/",
					items: [
						{ value: "/one", label: "completion one" },
						{ value: "/two", label: "completion two" },
					],
				}),
				applyCompletion: (_lines, _line, _col, item) => ({
					lines: [item.value],
					cursorLine: 0,
					cursorCol: item.value.length,
				}),
			});
			editor.setText("");
			terminal.sendInput("/");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("completion two");
			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			expect(terminal.getViewport()[9]).toContain("Working");
			expect(terminal.getViewport().join("\n")).not.toContain("model footer");
		} finally {
			status.dispose();
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
