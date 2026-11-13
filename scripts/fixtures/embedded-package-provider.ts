import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const root = process.env.PI_PACKAGE_ACCEPTANCE_ROOT;
	assert.ok(root);
	const file = join(root, "random-fixture.txt");
	const faux = fauxProvider({ provider: "package-acceptance", models: [{ id: "local" }], tokensPerSecond: 100000 });
	faux.setResponses([
		() => fauxAssistantMessage(fauxToolCall("read", { path: file }), { stopReason: "toolUse" }),
		(context) => {
			const expected = fs.readFileSync(file, "utf8").trim();
			assert.ok(context.messages.some(message => message.role === "toolResult" && JSON.stringify(message).includes(expected)));
			fs.writeFileSync(join(root, "read-observed.json"), JSON.stringify({ pid: process.pid, expected, tools: pi.getActiveTools() }));
			return fauxAssistantMessage(`read fixture verified ${expected}`);
		},
	]);
	pi.registerProvider(faux.provider);
	pi.on("session_shutdown", () => {
		fs.appendFileSync(join(root, "shutdown.jsonl"), JSON.stringify({ pid: process.pid, calls: faux.state.callCount }) + "\n");
	});
}
