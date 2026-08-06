import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MUSL_CLIPBOARD_PROVENANCE } from "./lib/musl-provenance.mjs";

const target = "linux-x64-musl-modern";
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-musl-provenance-"));
	const addon = join(root, "clipboard.node"); writeFileSync(addon, "addon");
	const expected = MUSL_CLIPBOARD_PROVENANCE; const buildTarget = expected.build.targets.x64;
	const provenance = {
		schemaVersion: 3, component: expected.component, upstreamVersion: expected.upstreamVersion, architecture: "x64",
		source: { url: expected.source.url, commit: expected.source.commit, sha256: expected.source.archiveSha256, sourceTreeSha256: expected.source.sourceTreeSha256, vendorTreeSha256: expected.source.vendorTreeSha256, cargoLockSha256: expected.source.cargoLockSha256, license: expected.source.license, licenseFile: "node_modules/@mariozechner/clipboard-linux-x64-musl/LICENSE" },
		build: { container: buildTarget.container, platform: buildTarget.platform, hostMachine: buildTarget.hostMachine, rust: expected.build.rust, muslDev: expected.build.muslDev, muslDevApkSha256: buildTarget.muslDevApkSha256, networkDisabled: true, cargoOffline: true, cargoLocked: true, profile: "release" },
		addon: { file: "node_modules/@mariozechner/clipboard-linux-x64-musl/clipboard.linux-x64-musl.node", sha256: "613c3abf0f077f31505d3c8cc0fed9a94a49cf025af3e604c4d38259c1cdf4c7" },
	};
	const path = join(root, "provenance.json"); writeFileSync(path, JSON.stringify(provenance));
	return { root, path, addon, provenance };
}

test("verifier accepts exact authoritative musl inputs", () => {
	const value = fixture(); try { execFileSync(process.execPath, [join(import.meta.dirname, "verify-musl-provenance.mjs"), value.path, value.addon, target]); } finally { rmSync(value.root, { recursive: true, force: true }); }
});

for (const [label, mutate] of [
	["vendored source closure", (value) => { value.source.sourceTreeSha256 = "0".repeat(64); }],
	["vendored Cargo.lock", (value) => { value.source.cargoLockSha256 = "0".repeat(64); }],
	["target image digest", (value) => { value.build.container = `docker.io/library/rust@sha256:${"0".repeat(64)}`; }],
	["Rust version", (value) => { value.build.rust = "rustc 0.0.0"; }],
	["musl-dev version", (value) => { value.build.muslDev = "0.0.0"; }],
]) test(`verifier rejects mismatched ${label}`, () => {
	const fixtureValue = fixture(); try {
		mutate(fixtureValue.provenance); writeFileSync(fixtureValue.path, JSON.stringify(fixtureValue.provenance));
		const result = spawnSync(process.execPath, [join(import.meta.dirname, "verify-musl-provenance.mjs"), fixtureValue.path, fixtureValue.addon, target], { encoding: "utf8" });
		assert.notEqual(result.status, 0); assert.match(result.stderr, /invalid musl provenance/);
	} finally { rmSync(fixtureValue.root, { recursive: true, force: true }); }
});
