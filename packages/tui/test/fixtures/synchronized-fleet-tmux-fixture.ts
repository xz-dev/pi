import { appendFileSync, writeFileSync } from "node:fs";
import { Editor, type EditorTheme } from "../../src/components/editor.ts";
import { ProcessTerminal } from "../../src/terminal.ts";
import type { Component, TUI } from "../../src/tui.ts";
import { TuiMainScreen } from "../../src/tui-main-screen.ts";

const checkpointPath = process.argv[2];
if (!checkpointPath) throw new Error("checkpoint path is required");

const theme: EditorTheme = {
	borderColor: (text) => text,
	selectList: {
		selectedPrefix: (text) => text,
		selectedText: (text) => text,
		description: (text) => text,
		scrollInfo: (text) => text,
		noMatch: (text) => text,
	},
};

class Base implements Component {
	frame = 0;
	render(): string[] {
		return ["x".repeat(209), ...Array.from({ length: 54 }, (_, index) => `base-${index}-${this.frame}`)];
	}
	invalidate(): void {}
}

class FleetInspector implements Component {
	frame = 0;
	render(width: number): string[] {
		const row = (content: string) => `│${content.padEnd(width - 2, " ")}│`;
		return [
			`╭${"Subagent fleet inspector".padEnd(width - 2, "─")}╮`,
			row(`Working ${this.frame}`),
			...Array.from({ length: 39 }, (_, index) => row(`agent-${index}`)),
			`╰${"live controls".padEnd(width - 2, "─")}╯`,
		];
	}
	invalidate(): void {}
}

writeFileSync(checkpointPath, "");
const checkpoint = (text: string) => appendFileSync(checkpointPath, `${text}\n`);
const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal, true);
const base = new Base();
const fleet = new FleetInspector();
const editor = new Editor(tui, theme);
editor.setText("draft");
tui.addChild(base);
tui.addChild(editor);
tui.setFocus(editor);
tui.showOverlay(fleet, { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 });

let frame = 0;
const timer = setInterval(() => {
	frame++;
	base.frame = frame;
	fleet.frame = frame;
	tui.requestRender();
	checkpoint(`frame:${frame}`);
	if (frame >= 20) {
		clearInterval(timer);
		setTimeout(() => {
			tui.stop();
			checkpoint("done");
		}, 100);
	}
}, 40);

tui.start();
checkpoint("ready");
