// Finite host and detached descendant for native-owner integration tests.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

setTimeout(() => process.exit(91), 12_000);
const descendant = spawn(
	process.execPath,
	["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setTimeout(() => process.exit(92), 10000)'],
	{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
);
await new Promise<void>((resolve) => descendant.stdout!.once("data", () => resolve()));
writeFileSync(process.env.OWNED_DESCENDANT_FILE!, String(descendant.pid));
process.on("message", (message: { chord2control?: { type: string; value?: unknown } }) => {
	if (message.chord2control?.type === "init") {
		process.send!({ pid: process.pid, init: message.chord2control.value });
		process.send!({ chord2control: { type: "ready" } });
		if (process.env.OWNED_DISCONNECT === "1") {
			setTimeout(() => {
				process.disconnect();
				setTimeout(() => process.exit(0), 1500);
			}, 100);
		}
	}
	if (message.chord2control?.type === "shutdown" && process.env.OWNED_IGNORE_SHUTDOWN !== "1") {
		process.exit(Number(process.env.OWNED_EXIT_CODE ?? 0));
	}
});
