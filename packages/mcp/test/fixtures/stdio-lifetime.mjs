import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

setTimeout(() => process.exit(90), 10_000);
const mode = process.argv[2];
const daemon = spawn("/usr/bin/python3", [fileURLToPath(new URL("./stdio-daemon.py", import.meta.url))], {
	stdio: ["ignore", "pipe", "inherit"],
});
const ready = new Promise((resolve) => daemon.stdout.once("data", (data) => {
	const pid = Number(data.toString().trim());
	console.error(`daemon ${pid}`);
	resolve(pid);
}));
daemon.on("error", (error) => { throw error; });
process.on("SIGTERM", () => {
	console.error("term received");
	if (mode === "term") process.exit(0);
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("close", () => {
	console.error("stdin closed");
	if (mode === "eof") process.exit(0);
});
lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === "exit") process.exit(0);
	if (message.method === "ready") {
		ready.then((pid) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { daemon: pid } })}\n`));
		return;
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { pid: process.pid } })}\n`);
});
