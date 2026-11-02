import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { sessionCompressionCliFixture } from "./fixtures/session-compression-cli.mjs";
import { assertSessionCompressionEvidence, SESSION_COMPRESSION_CHECKS, smokeSessionCompression } from "./lib/session-compression-smoke.mjs";

test("offline executable smoke accepts real byte roundtrip, global settings, scope and failed-source checks", () => {
	const value = sessionCompressionCliFixture();
	try {
		const evidence = smokeSessionCompression([process.execPath, value.path, "normal"]);
		assert.deepEqual(evidence.checks, SESSION_COMPRESSION_CHECKS);
		assertSessionCompressionEvidence(evidence);
		assert.equal(evidence.commands.length, 5);
	} finally { rmSync(value.root, { recursive: true, force: true }); }
});

for (const [mode, error] of [
	["no-compress", /compression did not change storage encoding/],
	["no-pref", /global preference was not enabled/],
	["wrong-scope", /custom migration escaped its target/],
	["runtime", /extension runtime started/],
	["mutate-failure", /failed migration changed corrupt source/],
]) test(`offline executable smoke rejects ${mode}`, () => {
	const value = sessionCompressionCliFixture();
	try { assert.throws(() => smokeSessionCompression([process.execPath, value.path, mode]), error); }
	finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("acceptance evidence rejects missing checks, skipped failure probes and wrong command statuses", () => {
	const value = sessionCompressionCliFixture();
	try {
		const evidence = smokeSessionCompression([process.execPath, value.path, "normal"]);
		for (const mutate of [
			value => { value.checks.pop(); },
			value => { value.commands.pop(); },
			value => { value.commands[4].status = 0; },
			value => { value.status = "skipped"; },
		]) {
			const bad = structuredClone(evidence);
			mutate(bad);
			assert.throws(() => assertSessionCompressionEvidence(bad), /offline session compression acceptance/);
		}
	} finally { rmSync(value.root, { recursive: true, force: true }); }
});
