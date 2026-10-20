import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
// Atomic publish: a kill between open and write must never leave an empty pidfile (Number("") is pid 0 = self).
const pidfile = process.env.PI_WINDOWS_OWNER_PIDFILE;
if (pidfile) { writeFileSync(`${pidfile}.tmp`, String(process.pid)); renameSync(`${pidfile}.tmp`, pidfile); }

// No descendants before first message: this is the explicit Windows attach contract.
process.on("message", (message, handle) => {
	if (message?.kind === "server") {
		handle.on("connection", (socket) => socket.end("handle-round-trip"));
		process.send({ kind: "handle-ready" });
	} else if (message?.kind === "echo") {
		process.send({ kind: "echo", value: message.value });
	} else if (message?.chord2control?.type === "init") {
		const { fixture, directory } = message.chord2control.value;
		const child = spawn(fixture, ["tree", directory], { stdio: ["ignore", "pipe", "inherit"], detached: true });
		child.stdout.once("data", () => process.send({ chord2control: { type: "ready" } }));
	} else if (message?.chord2control?.type === "shutdown") process.exit(7);
});
process.on("disconnect", () => process.exit(7));
