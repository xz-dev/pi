import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

for (const group of ["", "coding-agent", "durable", "other", "invalid"]) {
	test(`isolated test runner selects ${group || "all workspaces"}`, () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-workspace-test-"));
		try {
			mkdirSync(join(dir, "bin"));
			const log = join(dir, "calls.jsonl");
			const npm = join(dir, "bin", "npm");
			writeFileSync(npm, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2), secret:process.env.PI_TEST_SECRET, home:process.env.HOME})+'\\n');\n`);
			chmodSync(npm, 0o755);
			const out = spawnSync("bash", ["test.sh"], {
				cwd: resolve(import.meta.dirname, ".."),
				env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, PI_TEST_WORKSPACE_GROUP: group, PI_TEST_SECRET: "must-not-leak" },
				encoding: "utf8",
				timeout: 10000,
			});
			if (group === "invalid") {
				assert.notEqual(out.status, 0);
				assert.match(out.stderr, /Unknown test workspace group/);
				return;
			}
			assert.equal(out.status, 0, out.stderr);
			const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.ok(calls.every((call) => call.secret === undefined && call.home !== process.env.HOME));
			assert.equal(calls.some((call) => call.args.includes("test:scripts")), group === "" || group === "other");
			const args = calls.at(-1).args;
			if (!group) assert.ok(args.includes("--workspaces"));
			else if (group === "other") {
				assert.ok(args.includes("packages/ai"));
				assert.ok(!args.includes("packages/coding-agent") && !args.includes("packages/durable"));
			} else assert.ok(args.includes(`packages/${group}`));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
