import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./build-coding-agent-bundle.mjs", import.meta.url), "utf8");
const launcher = /const cliLauncher = `([\s\S]*?)`;/.exec(source)?.[1];
assert.ok(launcher);

for (const [name, runtime, status, stdout, stderr] of [
	["awaits TLA startup", 'await Promise.resolve(); console.log("started");', 0, /started/, /^$/],
	["propagates rejected startup", 'await Promise.reject(new Error("startup rejected"));', 1, /^$/, /startup rejected/],
	["preserves runtime exit status", 'await Promise.resolve(); process.exitCode = 23;', 23, /^$/, /^$/],
]) {
	test(`generated npm CLI launcher ${name}`, t => {
		const directory = mkdtempSync(join(tmpdir(), "pi-cli-launcher-"));
		t.after(() => rmSync(directory, { force: true, recursive: true }));
		writeFileSync(join(directory, "package.json"), '{"type":"module"}');
		writeFileSync(join(directory, "cli.js"), launcher);
		writeFileSync(join(directory, "cli-runtime.js"), runtime);
		const result = spawnSync(process.execPath, [join(directory, "cli.js")], { encoding: "utf8" });
		assert.equal(result.status, status, result.stderr);
		assert.match(result.stdout, stdout);
		assert.match(result.stderr, stderr);
	});
}
