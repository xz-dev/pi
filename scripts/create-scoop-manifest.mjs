#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { binaryArchiveName, stableStringify } from "./lib/github-release.mjs";

const [releaseManifestArg, outputArg] = process.argv.slice(2);
if (!releaseManifestArg || !outputArg) {
	throw new Error("Usage: node scripts/create-scoop-manifest.mjs <release-manifest.json> <pi.json>");
}

const releaseManifest = JSON.parse(readFileSync(resolve(releaseManifestArg), "utf8"));
const version = releaseManifest.distributionVersion;
const tag = releaseManifest.tag;
if (!version || tag !== `xz-v${version}`) throw new Error("Invalid GitHub Release manifest version");

const releaseUrl = `https://github.com/xz-dev/pi/releases/download/${tag}`;
const architecture = Object.fromEntries(
	[
		["64bit", "windows-x64-modern"],
		["arm64", "windows-arm64"],
	].map(([scoopArch, target]) => {
		const bundle = releaseManifest.bundles?.[target];
		const file = binaryArchiveName(target);
		if (bundle?.file !== file || !/^[0-9a-f]{64}$/.test(bundle.sha256 ?? "")) {
			throw new Error(`Invalid ${target} bundle metadata`);
		}
		return [scoopArch, { url: `${releaseUrl}/${file}`, hash: bundle.sha256 }];
	}),
);

// Mark the installation as scoop-managed by dropping an empty
// .scoop.managed.lock next to the executable. `pi update --self` detects the
// *.managed.lock marker, refuses to replace the binary, and points at scoop.
// The zip itself stays channel-neutral for users who download it directly.
const postInstall = ["New-Item -Force -ItemType File (Join-Path $dir '.scoop.managed.lock') | Out-Null"];

writeFileSync(
	resolve(outputArg),
	stableStringify({
		version,
		description: "Terminal coding agent with multi-provider LLM support",
		homepage: "https://github.com/xz-dev/pi",
		license: "MIT",
		architecture,
		bin: "pi.exe",
		post_install: postInstall,
	}),
);
