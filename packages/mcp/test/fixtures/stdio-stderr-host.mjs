import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import { StdioTransport } from "../../src/transports/stdio.ts";

const mode = process.argv[2];
const command = process.argv[3];
const marker = 'E2 genuine stderr; S{"pid":1}; pi-env supervise: GENUINE--TAIL';
const alarm = setTimeout(() => process.exit(90), 8000);
let output = "";
let info;
const transport = new StdioTransport({
	command: command || process.execPath,
	args: command ? ["original-arg"] : ["-e", `
		const fs = require("node:fs");
		const { dev, ino, mode } = fs.fstatSync(2);
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
			dev, ino, mode, tty: process.stderr.isTTY === true
		}}) + "\\n");
		process.stderr.write(${JSON.stringify(marker)});
		process.exitCode = 7;
	`],
	stderr: mode,
	maxStderrBytes: 4,
	onStderr(chunk) { output += chunk; },
});
const closed = new Promise((resolve) => transport.onClose(resolve));
transport.onMessage((message) => { if ("result" in message) info = message.result; });
try {
	const startup = transport.start();
	// Queue real early output/exit before the host can process private S.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
	if (command) {
		await assert.rejects(startup, { path: command, spawnargs: ["original-arg"] });
		assert.equal(output, "");
		assert.equal(transport.stderr, "");
	} else {
		await startup;
		await closed;
		assert.equal(output, mode === "pipe" ? marker : "");
		assert.equal(transport.stderr, mode === "pipe" ? "TAIL" : "");
		if (mode === "inherit") {
			const { dev, ino, mode: fdMode } = fstatSync(2);
			assert.deepEqual(info, { dev, ino, mode: fdMode, tty: process.stderr.isTTY === true });
		}
	}
	await closed;
	assert.equal(transport.pid, undefined);
	console.log(JSON.stringify({ mode, closed: true, failed: Boolean(command), info }));
} finally {
	await transport.close();
	clearTimeout(alarm);
}
