#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { muslClipboardProvenance } from "./lib/musl-provenance.mjs";

const [provenancePath, helperPath, targetId] = process.argv.slice(2);
if (!provenancePath || !helperPath || !targetId) throw new Error("Usage: verify-musl-provenance.mjs <provenance.json> <helper.node> <target>");
try {
	const value = JSON.parse(readFileSync(provenancePath, "utf8"));
	const expected = muslClipboardProvenance(targetId);
	assert.deepEqual(value, expected);
	assert.equal(createHash("sha256").update(readFileSync(helperPath)).digest("hex"), expected.helper.sha256);
	assert.equal(createHash("sha256").update(readFileSync(join(dirname(provenancePath), expected.source.licenseFile))).digest("hex"), expected.source.licenseSha256);
} catch (error) {
	throw new Error(`invalid musl provenance for ${targetId}`, { cause: error });
}
console.log(`${targetId}: upstream native helper provenance verified`);
