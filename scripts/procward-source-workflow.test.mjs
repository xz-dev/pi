import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

for (const [file, job] of [["ci.yml", "test"], ["upstream-sync.yml", "sync-main-with-squash-branches"]]) {
	test(`${file} stages a release-verified procward after build and before source tests`, () => {
		const workflow = parse(readFileSync(join(import.meta.dirname, "../.github/workflows", file), "utf8"));
		const steps = workflow.jobs[job].steps;
		const stages = steps.filter((step) => step.run?.includes("scripts/acquire-procward.mjs --target"));
		assert.equal(stages.length, 1, "source test job must stage exactly one verified helper");
		const stage = stages[0];
		assert.equal(stage.run, "node scripts/acquire-procward.mjs --target linux-x64-gnu-modern packages/coding-agent/dist/native/procward");
		assert.equal(stage.env.GH_TOKEN, "${{ github.token }}");
		const build = steps.findIndex((step) => step.run === "npm run build");
		const tests = steps.findIndex((step) => /vitest|\.\/test\.sh/.test(step.run ?? ""));
		assert.ok(build >= 0 && steps.indexOf(stage) > build && steps.indexOf(stage) < tests, "verify helper bytes before any source test executes");
		if (file === "ci.yml") assert.equal(stage.if, "matrix.name == 'coding-agent'");
		else assert.equal(stage.if, undefined, "Sync must not bypass the release-only acquisition gate");
	});
}
