import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { type Component, TUI } from "../src/tui.ts";
import { ControlledDeliveryTerminal, LoggingVirtualTerminal } from "./recording-terminal.ts";
import { defaultEditorTheme } from "./test-themes.ts";

class StaticLines implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

function trimmedViewport(terminal: LoggingVirtualTerminal): string[] {
	return terminal.getViewport().map((line) => line.trimEnd());
}

function terminalTail(terminal: LoggingVirtualTerminal): string[] {
	return terminal
		.getScrollBuffer()
		.slice(-(terminal.rows + 2))
		.map((line) => line.trimEnd());
}

function splitAfterFirstSynchronizedLine(data: string): number {
	const synchronizedOutputStart = "\x1b[?2026h";
	const start = data.indexOf(synchronizedOutputStart);
	assert.notStrictEqual(start, -1, "render frame begins synchronized output");
	const firstLineEnd = data.indexOf("\r\n", start + synchronizedOutputStart.length);
	assert.notStrictEqual(firstLineEnd, -1, "render frame mutates at least one complete line before failing");
	return firstLineEnd + "\r\n".length;
}

function resetOutputObservations(terminal: LoggingVirtualTerminal): void {
	terminal.clearWrites();
	terminal.clearSynchronizedReleaseStates();
	terminal.clearCursorVisibilityTransitions();
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function nextTickBarrier(): Promise<void> {
	return new Promise((resolve) => process.nextTick(resolve));
}

describe("TUI terminal transport behavior", () => {
	it("emits no accepted terminal output for unchanged markerless render requests", async (t) => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		t.after(() => tui.stop());
		tui.addChild(new StaticLines(["Header", "Stable body"]));

		tui.start();
		await terminal.waitForRender();
		const viewportBefore = terminal.getViewport();
		resetOutputObservations(terminal);

		tui.requestRender();
		tui.requestRender();
		tui.requestRender();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			{
				viewport: terminal.getViewport(),
				acceptedWrites: terminal.getAcceptedWriteCount(),
				acceptedBytes: terminal.getAcceptedByteCount(),
			},
			{ viewport: viewportBefore, acceptedWrites: 0, acceptedBytes: 0 },
		);
	});

	it("converges after a synchronized frame is split inside a CSI sequence", async (t) => {
		const render = async (chunked: boolean) => {
			const terminal = new ControlledDeliveryTerminal(24, 4);
			const tui = new TUI(terminal, true);
			t.after(() => tui.stop());
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setText("alpha\nbeta\ngamma");
			tui.addChild(new StaticLines(["Header"]));
			tui.addChild(editor);
			tui.setFocus(editor);

			tui.start();
			await terminal.waitForRender();

			let splitFrame = false;
			terminal.deliverAcceptedWrites((write) => {
				if (!chunked || splitFrame) return [write];
				const synchronizedOutputStart = "\x1b[?2026h";
				const start = write.indexOf(synchronizedOutputStart);
				if (start === -1) return [write];
				splitFrame = true;
				const split = start + "\x1b[?20".length;
				return [write.slice(0, split), write.slice(split)];
			});
			await terminal.flush();
			if (chunked) assert.strictEqual(splitFrame, true, "split a synchronized frame inside its CSI sequence");

			return {
				viewport: trimmedViewport(terminal),
				tail: terminalTail(terminal),
				cursor: terminal.getCursorPosition(),
				cursorVisible: terminal.isCursorVisible(),
				synchronizedOutputActive: terminal.isSynchronizedOutputActive(),
			};
		};

		const unchunked = await render(false);
		const chunked = await render(true);

		assert.deepStrictEqual(chunked, unchunked);
		assert.strictEqual(chunked.synchronizedOutputActive, false);
	});

	it("preserves an unchanged focused Editor viewport and cursor without accepted output", async (t) => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal, true);
		t.after(() => tui.stop());
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("draft");
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await terminal.waitForRender();
		const viewportBefore = terminal.getViewport();
		const cursorBefore = terminal.getCursorPosition();
		resetOutputObservations(terminal);

		tui.requestRender();
		tui.requestRender();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			{
				viewport: terminal.getViewport(),
				cursor: terminal.getCursorPosition(),
				acceptedWrites: terminal.getAcceptedWriteCount(),
				acceptedBytes: terminal.getAcceptedByteCount(),
			},
			{ viewport: viewportBefore, cursor: cursorBefore, acceptedWrites: 0, acceptedBytes: 0 },
		);
	});

	it("releases one bounded frame per awaited spinner update above a real Editor", async (t) => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal, true);
		t.after(() => tui.stop());
		const status = new StaticLines(["Working |"]);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("draft");
		tui.addChild(status);
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await terminal.waitForRender();

		for (const frame of ["/", "-", "\\"]) {
			resetOutputObservations(terminal);
			status.lines = [`Working ${frame}`];
			tui.requestRender();
			await terminal.waitForRender();

			const releases = terminal.getSynchronizedReleaseStates();
			assert.strictEqual(releases.length, 1, `spinner frame ${frame}`);
			assert.ok(
				terminal.getAcceptedByteCount() <= Buffer.byteLength(status.lines[0]) + 64,
				`spinner frame ${frame} exceeded its changed-line transport budget`,
			);
			assert.deepStrictEqual(trimmedViewport(terminal).slice(0, 4), [
				`Working ${frame}`,
				"────────────────────────────────────────",
				"draft",
				"────────────────────────────────────────",
			]);
			assert.deepStrictEqual(terminal.getCursorPosition(), { x: 5, y: 2 });
			assert.deepStrictEqual(releases[0], {
				row: 2,
				column: 5,
				cursorVisible: true,
			});
		}
	});

	it("renders a cursor visibility change requested after stop when restarted", async (t) => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal, true);
		t.after(() => tui.stop());
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("draft");
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await terminal.waitForRender();
		tui.stop();
		resetOutputObservations(terminal);

		tui.setShowHardwareCursor(false);
		await nextTickBarrier();
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getSynchronizedReleaseStates().at(-1), {
			row: 1,
			column: 5,
			cursorVisible: false,
		});
		assert.strictEqual(terminal.isCursorVisible(), false);
	});

	for (const resize of [
		{ name: "shrink", from: 10, to: 7, expectedRow: 0 },
		{ name: "grow", from: 7, to: 10, expectedRow: 1 },
	] as const) {
		it(`reconciles the focused Editor cursor after a Termux height-only ${resize.name}`, async (t) => {
			await withEnv({ TERMUX_VERSION: "1" }, async () => {
				const terminal = new LoggingVirtualTerminal(40, resize.from);
				const tui = new TUI(terminal, true);
				t.after(() => tui.stop());
				const editor = new Editor(tui, defaultEditorTheme);
				editor.setText("draft");
				tui.addChild(editor);
				tui.setFocus(editor);

				tui.start();
				await terminal.waitForRender();
				const initialRedraws = tui.fullRedraws;
				resetOutputObservations(terminal);

				terminal.resize(40, resize.to);
				await terminal.waitForRender();

				assert.strictEqual(tui.fullRedraws, initialRedraws, "height-only Termux resize should not redraw");
				assert.strictEqual(terminal.getFullClearCount(), 0, "height-only Termux resize should not clear");
				assert.deepStrictEqual(terminal.getSynchronizedReleaseStates().at(-1), {
					row: resize.expectedRow,
					column: 5,
					cursorVisible: true,
				});
				assert.deepStrictEqual(terminal.getCursorPosition(), { x: 5, y: resize.expectedRow });
			});
		});
	}

	it("releases running visibility toggles at visible, hidden, then visible", async (t) => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal, true);
		t.after(() => tui.stop());
		const status = new StaticLines(["Ready"]);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("draft");
		tui.addChild(status);
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getSynchronizedReleaseStates().at(-1), {
			row: 2,
			column: 5,
			cursorVisible: true,
		});

		for (const cursorVisible of [false, true]) {
			resetOutputObservations(terminal);
			tui.setShowHardwareCursor(cursorVisible);
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getSynchronizedReleaseStates().at(-1), {
				row: 2,
				column: 5,
				cursorVisible,
			});
		}
	});

	it("recovers after a synchronized frame is only partially delivered", async (t) => {
		const terminal = new LoggingVirtualTerminal(24, 3);
		const tui = new TUI(terminal, true);
		t.after(() => tui.stop());
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("alpha\nbeta\ngamma");
		tui.addChild(new StaticLines(["Header"]));
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await terminal.waitForRender();
		editor.setText("changed alpha\nchanged beta\nchanged gamma");
		resetOutputObservations(terminal);
		terminal.injectPartialWriteFailure(splitAfterFirstSynchronizedLine);

		const renderNow = () => (tui as unknown as { doRender(): void }).doRender();
		assert.throws(renderNow, /injected partial terminal write failure/);
		await terminal.flush();
		assert.deepStrictEqual(
			{
				acceptedWrites: terminal.getAcceptedWriteCount(),
				acceptedBytes: terminal.getAcceptedByteCount(),
			},
			{
				acceptedWrites: 1,
				acceptedBytes: Buffer.byteLength("\x1b[?2026l"),
			},
			"failed frame was not accepted; only the recovery release was emitted",
		);
		const synchronizedOutputActiveAfterFailure = terminal.isSynchronizedOutputActive();

		const fullClearsBeforeRetry = terminal.getFullClearCount();
		tui.requestRender();
		await terminal.waitForRender();

		const oracleTerminal = new LoggingVirtualTerminal(24, 3);
		const oracleTui = new TUI(oracleTerminal, true);
		t.after(() => oracleTui.stop());
		const oracleEditor = new Editor(oracleTui, defaultEditorTheme);
		oracleEditor.setText("changed alpha\nchanged beta\nchanged gamma");
		oracleTui.addChild(new StaticLines(["Header"]));
		oracleTui.addChild(oracleEditor);
		oracleTui.setFocus(oracleEditor);
		oracleTui.start();
		await oracleTerminal.waitForRender();
		oracleTui.requestRender(true);
		await oracleTerminal.waitForRender();

		assert.deepStrictEqual(
			{
				viewport: trimmedViewport(terminal),
				tail: terminalTail(terminal),
				cursor: terminal.getCursorPosition(),
				cursorVisible: terminal.isCursorVisible(),
				synchronizedOutputActive: terminal.isSynchronizedOutputActive(),
			},
			{
				viewport: trimmedViewport(oracleTerminal),
				tail: terminalTail(oracleTerminal),
				cursor: oracleTerminal.getCursorPosition(),
				cursorVisible: oracleTerminal.isCursorVisible(),
				synchronizedOutputActive: false,
			},
		);
		assert.ok(terminal.getFullClearCount() > fullClearsBeforeRetry, "retry performed a full redraw");
		assert.strictEqual(
			synchronizedOutputActiveAfterFailure,
			false,
			"write failure recovery released partially delivered synchronized output",
		);
	});

	it("converges to the pre-stop viewport and cursor after restarting the same TUI", async (t) => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal, true);
		t.after(() => tui.stop());
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("draft");
		tui.addChild(new StaticLines(["Header"]));
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await terminal.waitForRender();
		const viewportBeforeStop = terminal.getViewport();
		const cursorBeforeStop = terminal.getCursorPosition();

		tui.stop();
		resetOutputObservations(terminal);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			{ viewport: terminal.getViewport(), cursor: terminal.getCursorPosition() },
			{ viewport: viewportBeforeStop, cursor: cursorBeforeStop },
		);
	});

	it("changes running cursor visibility only in a synchronized release", async (t) => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal, true);
		t.after(() => tui.stop());
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("draft");
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await terminal.waitForRender();
		resetOutputObservations(terminal);

		tui.setShowHardwareCursor(false);
		await terminal.waitForRender();

		const transitions = terminal.getCursorVisibilityTransitions();
		assert.ok(transitions.length > 0);
		assert.ok(
			transitions.every((transition) => transition.synchronizedOutput),
			"cursor visibility changed outside synchronized output",
		);
		assert.strictEqual(terminal.getSynchronizedReleaseStates().at(-1)?.cursorVisible, false);
	});

	it("defers cursor visibility set while stopped and applies it on restart", async (t) => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal, true);
		t.after(() => tui.stop());
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("draft");
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await terminal.waitForRender();
		tui.stop();
		resetOutputObservations(terminal);

		tui.setShowHardwareCursor(false);
		await terminal.flush();
		const stoppedObservation = {
			acceptedWrites: terminal.getAcceptedWriteCount(),
			acceptedBytes: terminal.getAcceptedByteCount(),
		};

		terminal.clearWrites();
		terminal.clearCursorVisibilityTransitions();
		tui.start();
		await terminal.waitForRender();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		await terminal.flush();

		assert.deepStrictEqual(
			{
				stopped: stoppedObservation,
				restartedCursorVisible: terminal.isCursorVisible(),
			},
			{
				stopped: { acceptedWrites: 0, acceptedBytes: 0 },
				restartedCursorVisible: false,
			},
		);
	});
});
