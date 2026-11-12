#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bunTarget } from "./lib/bun-targets.mjs";
import { assertOwnerLifecycleRows, smokeOwnerLifecycleAsNonadmin } from "./smoke-owner-lifecycle.mjs";

const [binary, targetId, output, candidate] = process.argv.slice(2);
assert(
	binary && targetId && output && candidate,
	"Usage: smoke-installed-owner.mjs <pi> <target> <evidence.json> <source-built-development-helper>",
);
assert.equal(process.platform, "win32");
const executable = resolve(binary);
const developmentHelper = resolve(candidate);
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const before = { cli: hash(executable), candidate: hash(developmentHelper) };
let evidence;
try {
	evidence = await smokeOwnerLifecycleAsNonadmin(executable, bunTarget(targetId), { developmentHelper });
	assert.equal(evidence.privilegeDrop?.verifiedNonadmin, true, JSON.stringify(evidence));
	assertOwnerLifecycleRows(evidence, "windows", { allowDevelopmentHelper: true });
	assert.equal(evidence.rows.length, 6);
	// The development helper is the only permitted final-gate refusal; every other gate must pass.
	if (evidence.status !== "passed") assert.match(evidence.error ?? "", /^owner privilege drop child failed: development helper cannot attest the final embedded product$/);
	assert.equal(evidence.windowsRuntimeGate?.status, "passed", `Windows runtime gate: ${evidence.windowsRuntimeGate?.error}`);
	for (const row of evidence.rows.filter((entry) => entry.name.endsWith("installed-task"))) {
		assert.equal(row.pi.developmentNativeOverride, true);
		assert.equal(row.pi.developmentOwnerSha256, before.candidate);
		assert.equal(row.pi.bun, evidence.artifactBunVersion);
	}
	assert.equal(hash(executable), before.cli);
	assert.equal(hash(developmentHelper), before.candidate);
	writeFileSync(
		output,
		`${JSON.stringify({ status: "passed-development-only", target: targetId, cliSha256: before.cli, candidateSha256: before.candidate, finalEmbeddedGatePassed: false, nativeFormalReleaseAndPinStillRequired: true, evidence }, null, 2)}\n`,
	);
} catch (error) {
	writeFileSync(
		output,
		`${JSON.stringify({ status: "failed", target: targetId, cliSha256: before.cli, candidateSha256: before.candidate, error: String(error.stack ?? error), evidence }, null, 2)}\n`,
	);
	process.exitCode = 1;
}
