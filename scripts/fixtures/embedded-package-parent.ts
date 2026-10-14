import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Copied to the isolated acceptance root before Pi loads it.
import registerSubagents from "./agent/git/github.com/xz-dev/pi-subagents/index.ts";

export default function (pi: ExtensionAPI) {
	const root = process.env.PI_PACKAGE_ACCEPTANCE_ROOT;
	assert.ok(root);
	let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	let deliver: (message: unknown) => void = () => {};
	const notification = new Promise<unknown>(resolve => { deliver = resolve; });
	registerSubagents(new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
				target.registerTool(definition);
				if (definition.name === "subagent") tool = definition;
			};
			if (key === "sendMessage") return (...args: Parameters<ExtensionAPI["sendMessage"]>) => {
				target.sendMessage(args[0], { ...args[1], triggerTurn: false });
				if (args[0].customType === "subagent-notify") deliver(args[0]);
			};
			return Reflect.get(target, key);
		},
	}));
	pi.on("session_start", async (_event, ctx) => {
		const timer = setTimeout(() => { console.error("Native child acceptance timed out"); process.exit(1); }, 60000);
		try {
			assert.ok(tool);
			const launch = await tool.execute("acceptance-read", {
				agent: "fixture-reader", task: `Read ${join(root, "random-fixture.txt")} and return its contents.`,
				async: true, context: "fresh", model: "package-acceptance/local", acceptance: false,
				output: false, timeoutMs: 30000,
			}, new AbortController().signal, undefined, ctx);
			const details = launch.details as { asyncDir: string };
			const delivered = await notification;
			fs.writeFileSync(join(root, "native-notification.json"), JSON.stringify(delivered));
			const expected = fs.readFileSync(join(root, "random-fixture.txt"), "utf8").trim();
			assert.ok(JSON.stringify(delivered).includes(`read fixture verified ${expected}`));
			const terminal = join(details.asyncDir, "process-terminal.json");
			await new Promise<void>(resolve => {
				const check = () => {
					if (fs.existsSync(terminal) && JSON.parse(fs.readFileSync(terminal, "utf8")).state === "observed") {
						fs.unwatchFile(terminal, check); resolve();
					}
				};
				fs.watchFile(terminal, { interval: 25 }, check); check();
			});
			const status = JSON.parse(fs.readFileSync(join(details.asyncDir, "status.json"), "utf8"));
			const observed = JSON.parse(fs.readFileSync(join(root, "read-observed.json"), "utf8"));
			assert.equal(status.state, "complete");
			assert.equal(observed.pid, status.pid);
			assert.deepEqual(observed.tools, ["read"]);
			assert.throws(() => process.kill(status.pid, 0), { code: "ESRCH" });
			const shutdowns = fs.readFileSync(join(root, "shutdown.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
			assert.ok(shutdowns.some(event => event.pid === status.pid && event.calls === 2));
			fs.copyFileSync(terminal, join(root, "native-terminal.json"));
			console.log("PASS real native child read, notification, shutdown and observed exit");
			process.exit(0);
		} catch (error) { console.error(error); process.exit(1); }
		finally { clearTimeout(timer); }
	});
}
