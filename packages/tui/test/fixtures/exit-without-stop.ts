import { ProcessTerminal } from "../../src/terminal.ts";
import { TuiAltScreen } from "../../src/tui-alt-screen.ts";

const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true });
tui.start();
if (process.argv[2] === "stop") tui.stop({ preserveScreen: true });
if (process.argv[2] === "dead") {
	process.stdout.write("TTY_LOST");
	tui.stop({ restoreTerminal: false });
	tui.requestRender(true);
	await new Promise((resolve) => setTimeout(resolve, 50));
}
process.exit(0);
