import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { run } from "./lib/e2e-command.mjs";

for (const exitCode of [0, 7]) {
	test(`E2E command drains inherited output after parent exit (${exitCode})`, { timeout: 10_000 }, async () => {
		// Wait for the direct child to exit before its descendant writes to the
		// inherited pipes: no scheduler timing assumption and no mocked streams.
		const writer = `
			const parent = Number(process.argv[1]);
			const deadline = Date.now() + 5000;
			const timer = setInterval(() => {
				try { process.kill(parent, 0); }
				catch (error) {
					if (error.code !== "ESRCH") throw error;
					clearInterval(timer);
					process.stdout.write("fixture-version\\n");
					process.stderr.write("late diagnostic\\n");
					return;
				}
				if (Date.now() > deadline) { clearInterval(timer); process.exitCode = 9; }
			}, 10);
		`;
		const launcher = `
			const { spawn } = require("node:child_process");
			spawn(process.execPath, ["--eval", ${JSON.stringify(writer)}, String(process.pid)], {
				stdio: ["ignore", 1, 2], windowsHide: true,
			}).unref();
			process.exit(${exitCode});
		`;
		if (exitCode === 0) {
			assert.equal(await run(process.execPath, ["--eval", launcher]), "fixture-version\n");
		} else {
			await assert.rejects(run(process.execPath, ["--eval", launcher]), /failed \(7\): fixture-version\nlate diagnostic\n$/);
		}
	});
}

test("E2E command still reports spawn failures", async () => {
	await assert.rejects(run(join(import.meta.dirname, "missing-e2e-command"), []), { code: "ENOENT" });
});
