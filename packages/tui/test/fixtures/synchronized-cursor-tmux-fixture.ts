import { appendFileSync, writeFileSync } from "node:fs";
import { Editor, type EditorTheme, Loader, ProcessTerminal, TUI } from "../../src/index.ts";

const checkpointPath = process.argv[2];
if (!checkpointPath) {
	throw new Error("checkpoint path is required");
}

const editorTheme: EditorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
};

writeFileSync(checkpointPath, "");
const checkpoint = (value: string): void => appendFileSync(checkpointPath, `${value}\n`);

const terminal = new ProcessTerminal();
const tui = new TUI(terminal, true);
const loader = new Loader(
	tui,
	(text) => text,
	(text) => text,
	"STATUS_BUSY",
	{
		frames: ["|", "/", "-", "\\"],
		intervalMs: 80,
	},
);
const editor = new Editor(tui, editorTheme);
let stopped = false;

const stop = (reason: string): void => {
	if (stopped) return;
	stopped = true;
	loader.stop();
	tui.stop();
	checkpoint(`stopped:${reason}`);
	process.exitCode = 0;
};

editor.onChange = (text: string) => checkpoint(`changed:${text}`);
editor.onSubmit = (text: string) => {
	checkpoint(`submitted:${text}`);
	stop("submit");
};

tui.addChild(loader);
tui.addChild(editor);
tui.setFocus(editor);
tui.addInputListener((data) => {
	if (data === "\u0003") {
		stop("interrupt");
		return { consume: true };
	}
	return undefined;
});

process.once("SIGTERM", () => stop("sigterm"));
process.once("SIGHUP", () => stop("sighup"));

tui.start();
checkpoint("ready");
