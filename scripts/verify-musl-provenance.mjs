#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { bunTarget } from "./lib/bun-targets.mjs";
import { MUSL_CLIPBOARD_PROVENANCE } from "./lib/musl-provenance.mjs";

const [provenancePath, addonPath, targetId] = process.argv.slice(2);
if (!provenancePath || !addonPath || !targetId) throw new Error("Usage: verify-musl-provenance.mjs <provenance.json> <addon.node> <target>");
const target = bunTarget(targetId);
const value = JSON.parse(readFileSync(provenancePath, "utf8"));
const sha = createHash("sha256").update(readFileSync(addonPath)).digest("hex");
const expectedTarget = MUSL_CLIPBOARD_PROVENANCE.build.targets[target.arch];
const expectedSource = {
	url: MUSL_CLIPBOARD_PROVENANCE.source.url,
	commit: MUSL_CLIPBOARD_PROVENANCE.source.commit,
	sha256: MUSL_CLIPBOARD_PROVENANCE.source.archiveSha256,
	sourceTreeSha256: MUSL_CLIPBOARD_PROVENANCE.source.sourceTreeSha256,
	vendorTreeSha256: MUSL_CLIPBOARD_PROVENANCE.source.vendorTreeSha256,
	cargoLockSha256: MUSL_CLIPBOARD_PROVENANCE.source.cargoLockSha256,
	license: MUSL_CLIPBOARD_PROVENANCE.source.license,
	licenseFile: `node_modules/@mariozechner/clipboard-linux-${target.arch}-musl/LICENSE`,
};
const expectedBuild = {
	container: expectedTarget.container,
	platform: expectedTarget.platform,
	hostMachine: expectedTarget.hostMachine,
	rust: MUSL_CLIPBOARD_PROVENANCE.build.rust,
	muslDev: MUSL_CLIPBOARD_PROVENANCE.build.muslDev,
	muslDevApkSha256: expectedTarget.muslDevApkSha256,
	networkDisabled: true,
	cargoOffline: true,
	cargoLocked: true,
	profile: "release",
};
if (target.libc !== "musl" || value.schemaVersion !== 3 || value.component !== MUSL_CLIPBOARD_PROVENANCE.component || value.upstreamVersion !== MUSL_CLIPBOARD_PROVENANCE.upstreamVersion || value.architecture !== target.arch || JSON.stringify(value.source) !== JSON.stringify(expectedSource) || JSON.stringify(value.build) !== JSON.stringify(expectedBuild) || value.addon?.sha256 !== sha || value.addon?.file !== `node_modules/@mariozechner/clipboard-linux-${target.arch}-musl/${target.clipboardNativeFile}`) throw new Error(`invalid musl provenance for ${targetId}`);
console.log(`${targetId}: musl provenance verified`);
