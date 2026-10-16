import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashFileTree, muslClipboardProvenance } from "./lib/musl-provenance.mjs";

function fixture(arch = "x64") {
	const root = mkdtempSync(join(tmpdir(), "pi-musl-provenance-"));
	execFileSync(process.execPath, [join(import.meta.dirname, "lib/musl-provenance.mjs"), root, arch]);
	const target = arch === "x64" ? "linux-x64-musl-modern" : "linux-arm64-musl";
	const path = join(root, "provenance.json");
	const provenance = JSON.parse(readFileSync(path, "utf8"));
	return { root, path, target, provenance, helper: join(root, provenance.helper.file) };
}

function verify(value) {
	return spawnSync(process.execPath, [join(import.meta.dirname, "verify-musl-provenance.mjs"), value.path, value.helper, value.target], { encoding: "utf8" });
}

for (const arch of ["x64", "arm64"]) test(`staging preserves exact upstream ${arch} helper and source/license provenance`, () => {
	const value = fixture(arch);
	try {
		assert.deepEqual(value.provenance, muslClipboardProvenance(value.target));
		assert.equal(value.provenance.method, "upstream-prebuilt");
		assert.equal(value.provenance.build, undefined, "copying a prebuild must not claim a downstream source build");
		const result = verify(value);
		assert.equal(result.status, 0, result.stderr);
	} finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("file-tree digest is deterministic across creation order", () => {
	const left = mkdtempSync(join(tmpdir(), "pi-tree-left-"));
	const right = mkdtempSync(join(tmpdir(), "pi-tree-right-"));
	try {
		writeFileSync(join(left, "b"), "second"); writeFileSync(join(left, "a"), "first");
		writeFileSync(join(right, "a"), "first"); writeFileSync(join(right, "b"), "second");
		assert.equal(hashFileTree(left), hashFileTree(right));
	} finally {
		rmSync(left, { recursive: true, force: true }); rmSync(right, { recursive: true, force: true });
	}
});

for (const [label, mutate] of [
	["source commit", (value) => { value.provenance.source.commit = "0".repeat(40); }],
	["source closure", (value) => { value.provenance.source.linuxSourceSha256 = "0".repeat(64); }],
	["common header", (value) => { value.provenance.source.clipboardHeaderSha256 = "0".repeat(64); }],
	["wrong architecture", (value) => { value.provenance.architecture = "arm64"; }],
	["source-build claim", (value) => { value.provenance.method = "cargo-offline"; }],
	["changed helper", (value) => { writeFileSync(value.helper, "corrupt"); }],
	["changed license", (value) => { writeFileSync(join(value.root, "native/LICENSE"), "wrong license"); }],
	["non-musl target", (value) => { value.target = "linux-x64-gnu-modern"; }],
]) test(`verifier rejects mismatched ${label}`, () => {
	const value = fixture();
	try {
		mutate(value); writeFileSync(value.path, JSON.stringify(value.provenance));
		const result = verify(value);
		assert.notEqual(result.status, 0); assert.match(result.stderr, /invalid musl provenance/);
	} finally { rmSync(value.root, { recursive: true, force: true }); }
});
