import { fileURLToPath } from "node:url";
import { StdioTransport } from "../../src/transports/stdio.ts";

setTimeout(() => process.exit(90), 10_000);
const transport = new StdioTransport({
	command: process.execPath,
	args: [fileURLToPath(new URL("./stdio-lifetime.mjs", import.meta.url)), "stubborn"],
	stderr: "inherit",
});
await transport.start();
transport.onMessage((message) => {
	if (message.id !== 1 || !("result" in message)) return;
	process.stdout.write(`${JSON.stringify({ primary: transport.pid, ...message.result })}\n`, () => process.exit(0));
});
await transport.send({ jsonrpc: "2.0", id: 1, method: "ready" });
