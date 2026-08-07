#!/usr/bin/env node

/**
 * Generate the checked xz-dev Release binary contract consumed by the runtime
 * self-updater (packages/coding-agent/src/utils/xz-release-targets.generated.ts).
 *
 * The authoritative binary target matrix and per-target required-path
 * inventory live in the release distribution CI descriptor:
 *   scripts/lib/bun-targets.mjs + binaryRequiredPaths() in
 *   scripts/lib/github-release.mjs (branch fix/release-authless-attestation).
 *
 * To avoid duplicated manual drift across branches, this generator embeds a
 * faithful copy of that authoritative descriptor and emits the runtime
 * contract deterministically. When the CI target matrix changes, update this
 * script and re-run it; the committed contract is regenerated in place.
 *
 * Usage:
 *   node scripts/generate-xz-release-binary-contract.mjs            # regenerate in place
 *   node scripts/generate-xz-release-binary-contract.mjs --check    # fail if stale
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CHECK_ONLY = process.argv.includes("--check");

// --- Authoritative Bun binary target descriptor (mirrors CI bun-targets.mjs) ---

const common = {
	darwin: { executable: "pi", archive: "tar.gz" },
	linux: { executable: "pi", archive: "tar.gz" },
	windows: { executable: "pi.exe", archive: "zip" },
};

function target(id, os, arch, libc, cpu, clipboardNativePackage, clipboardNativeFile, nativeHelper) {
	return {
		id,
		os,
		arch,
		libc,
		cpu,
		executable: common[os].executable,
		archive: common[os].archive,
		clipboardNativePackage,
		clipboardNativeFile,
		...(nativeHelper ?? {}),
	};
}

const BUN_TARGETS = [
	target("darwin-x64-baseline", "darwin", "x64", undefined, "baseline", "clipboard-darwin-x64", "clipboard.darwin-x64.node", { nativeHelperDir: "native/darwin/prebuilds/darwin-x64", nativeHelperFile: "darwin-modifiers.node" }),
	target("darwin-x64-modern", "darwin", "x64", undefined, "modern", "clipboard-darwin-x64", "clipboard.darwin-x64.node", { nativeHelperDir: "native/darwin/prebuilds/darwin-x64", nativeHelperFile: "darwin-modifiers.node" }),
	target("darwin-arm64", "darwin", "arm64", undefined, "arm64", "clipboard-darwin-arm64", "clipboard.darwin-arm64.node", { nativeHelperDir: "native/darwin/prebuilds/darwin-arm64", nativeHelperFile: "darwin-modifiers.node" }),
	target("linux-x64-gnu-baseline", "linux", "x64", "gnu", "baseline", "clipboard-linux-x64-gnu", "clipboard.linux-x64-gnu.node"),
	target("linux-x64-gnu-modern", "linux", "x64", "gnu", "modern", "clipboard-linux-x64-gnu", "clipboard.linux-x64-gnu.node"),
	target("linux-arm64-gnu", "linux", "arm64", "gnu", "arm64", "clipboard-linux-arm64-gnu", "clipboard.linux-arm64-gnu.node"),
	target("linux-x64-musl-baseline", "linux", "x64", "musl", "baseline", "clipboard-linux-x64-musl", "clipboard.linux-x64-musl.node"),
	target("linux-x64-musl-modern", "linux", "x64", "musl", "modern", "clipboard-linux-x64-musl", "clipboard.linux-x64-musl.node"),
	target("linux-arm64-musl", "linux", "arm64", "musl", "arm64", "clipboard-linux-arm64-musl", "clipboard.linux-arm64-musl.node"),
	target("windows-x64-baseline", "windows", "x64", undefined, "baseline", "clipboard-win32-x64-msvc", "clipboard.win32-x64-msvc.node", { nativeHelperDir: "native/win32/prebuilds/win32-x64", nativeHelperFile: "win32-console-mode.node" }),
	target("windows-x64-modern", "windows", "x64", undefined, "modern", "clipboard-win32-x64-msvc", "clipboard.win32-x64-msvc.node", { nativeHelperDir: "native/win32/prebuilds/win32-x64", nativeHelperFile: "win32-console-mode.node" }),
	target("windows-arm64", "windows", "arm64", undefined, "arm64", "clipboard-win32-arm64-msvc", "clipboard.win32-arm64-msvc.node", { nativeHelperDir: "native/win32/prebuilds/win32-arm64", nativeHelperFile: "win32-console-mode.node" }),
];

function binaryArchiveName(platform) {
	const descriptor = BUN_TARGETS.find((entry) => entry.id === platform);
	if (!descriptor) throw new Error(`Unknown Bun Release target: ${platform}`);
	return `pi-${descriptor.id}.${descriptor.archive}`;
}

// Mirrors CI binaryRequiredPaths(). musl bundles additionally ship a provenance
// file and the musl clipboard package LICENSE for the reproducible native bindings.
function binaryRequiredPaths(platform) {
	const info = BUN_TARGETS.find((entry) => entry.id === platform);
	if (!info) throw new Error(`Unknown Bun Release target: ${platform}`);
	const clipboardParent = "node_modules/@mariozechner/clipboard";
	const paths = [
		info.executable,
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"THIRD_PARTY_NOTICES.md",
		"photon_rs_bg.wasm",
		"theme",
		"theme/dark.json",
		"theme/light.json",
		"theme/theme-schema.json",
		"assets",
		"export-html",
		"docs",
		"examples",
		clipboardParent,
		`node_modules/@mariozechner/${info.clipboardNativePackage}`,
		`${clipboardParent}/${info.clipboardNativeFile}`,
	];
	if (info.libc === "musl") {
		paths.push("clipboard-native-provenance.json");
		paths.push(`node_modules/@mariozechner/${info.clipboardNativePackage}/LICENSE`);
	}
	if (info.nativeHelperDir) {
		paths.push(info.nativeHelperDir);
		paths.push(`${info.nativeHelperDir}/${info.nativeHelperFile}`);
	}
	return paths;
}

// --- Emit the runtime contract module ---

const MANIFEST_SCHEMA_VERSION = 4;

const targets = BUN_TARGETS.map((entry) => ({
	platform: entry.id,
	archive: binaryArchiveName(entry.id),
	requiredPaths: binaryRequiredPaths(entry.id),
}));

function quote(value) {
	return JSON.stringify(value);
}

const lines = [
	"// Generated by scripts/generate-xz-release-binary-contract.mjs",
	"// DO NOT EDIT BY HAND. Regenerate with: node scripts/generate-xz-release-binary-contract.mjs",
	"//",
	"// Mirrors the authoritative xz-dev/pi Release binary descriptor",
	"// (scripts/lib/bun-targets.mjs + binaryRequiredPaths() in the release",
	"// distribution CI branch). The runtime self-updater consumes this exact",
	"// 12-target contract and rejects anything that drifts from it.",
	"",
	"export interface XzReleaseBinaryTarget {",
	"\tplatform: string;",
	"\tarchive: string;",
	"\trequiredPaths: readonly string[];",
	"}",
	"",
	"export const XZ_RELEASE_BINARY_CONTRACT: {",
	"\t/** Release manifest schema version this contract pairs with. */",
	"\tschemaVersion: 4;",
	"\ttargets: readonly XzReleaseBinaryTarget[];",
	"} = {",
	`\tschemaVersion: ${MANIFEST_SCHEMA_VERSION},`,
	"\ttargets: [",
];
for (const target of targets) {
	lines.push("\t\t{");
	lines.push(`\t\t\tplatform: ${quote(target.platform)},`);
	lines.push(`\t\t\tarchive: ${quote(target.archive)},`);
	lines.push("\t\t\trequiredPaths: [");
	for (const path of target.requiredPaths) lines.push(`\t\t\t\t${quote(path)},`);
	lines.push("\t\t\t],");
	lines.push("\t\t},");
}
lines.push("\t],");
lines.push("};");
lines.push("");

const outputPath = join(
	REPO_ROOT,
	"packages",
	"coding-agent",
	"src",
	"utils",
	"xz-release-targets.generated.ts",
);
const generated = lines.join("\n");

if (CHECK_ONLY) {
	const current = readFileSync(outputPath, "utf8");
	if (current !== generated) {
		console.error("packages/coding-agent/src/utils/xz-release-targets.generated.ts is out of date.");
		console.error("Run: node scripts/generate-xz-release-binary-contract.mjs");
		process.exit(1);
	}
	console.log(`Generated contract is up to date (${targets.length} targets, schema v${MANIFEST_SCHEMA_VERSION}).`);
} else {
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, generated);
	console.log(`Wrote ${outputPath} (${targets.length} targets, schema v${MANIFEST_SCHEMA_VERSION})`);
}
