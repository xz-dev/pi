#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_MANIFEST_URL = "https://github.com/xz-dev/pi/releases/latest/download/release-manifest.json";

export const TARGETS = [
	"darwin-arm64",
	"darwin-x64-baseline",
	"linux-arm64-gnu",
	"linux-x64-gnu-baseline",
	"linux-arm64-musl",
	"linux-x64-musl-baseline",
	"freebsd-arm64",
	"freebsd-x64",
];

export function hexToSri(hex) {
	if (!/^[0-9a-f]{64}$/i.test(hex)) {
		throw new Error(`Invalid sha256 hex digest: ${hex}`);
	}
	return `sha256-${Buffer.from(hex, "hex").toString("base64")}`;
}

export function patchPackageNix(content, version, sriHashes) {
	const versionRegex = /version \? "[^"]+",/;
	if (!versionRegex.test(content)) {
		throw new Error('Could not find `version ? "...",` in package.nix');
	}

	const hashesBlockRegex = /[ \t]*# Pre-built release archive checksums for each platform from xz-dev\/pi\n[ \t]*hashes = \{[^}]+\};/;
	if (!hashesBlockRegex.test(content)) {
		throw new Error("Could not find `hashes = { ... };` block in package.nix");
	}

	let updated = content.replace(versionRegex, `version ? "${version}",`);

	const newHashesLines = [
		"  # Pre-built release archive checksums for each platform from xz-dev/pi",
		"  hashes = {",
		...TARGETS.map((target) => {
			const hash = sriHashes[target];
			if (!hash) throw new Error(`Missing hash for required target: ${target}`);
			return `    "${target}" = "${hash}";`;
		}),
		"  };",
	].join("\n");

	updated = updated.replace(hashesBlockRegex, newHashesLines);

	return updated;
}

export async function fetchManifest(source = DEFAULT_MANIFEST_URL) {
	if (source.startsWith("http://") || source.startsWith("https://")) {
		const res = await fetch(source, {
			headers: process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {},
			redirect: "follow",
		});
		if (!res.ok) {
			throw new Error(`Failed to fetch release manifest from ${source}: HTTP ${res.status}`);
		}
		return await res.json();
	}
	return JSON.parse(readFileSync(resolve(source), "utf8"));
}

export async function updateNixPackage({
	manifestSource = DEFAULT_MANIFEST_URL,
	packageNixPath = "nix/package.nix",
	checkOnly = false,
} = {}) {
	const manifest = await fetchManifest(manifestSource);
	const version = manifest.distributionVersion;
	if (!version) {
		throw new Error("Release manifest missing distributionVersion");
	}

	const sriHashes = {};
	for (const target of TARGETS) {
		const bundle = manifest.bundles?.[target];
		if (!bundle?.sha256) {
			throw new Error(`Target ${target} missing in release manifest bundles`);
		}
		sriHashes[target] = hexToSri(bundle.sha256);
	}

	const fullPath = resolve(packageNixPath);
	const currentContent = readFileSync(fullPath, "utf8");
	const newContent = patchPackageNix(currentContent, version, sriHashes);

	if (currentContent === newContent) {
		console.log(`nix/package.nix is already up to date (${version}).`);
		return { updated: false, version };
	}

	if (checkOnly) {
		throw new Error(`nix/package.nix is out of date compared to release ${version}`);
	}

	writeFileSync(fullPath, newContent, "utf8");
	console.log(`Updated nix/package.nix to release ${version}.`);
	return { updated: true, version };
}

// CLI entry point
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	const args = process.argv.slice(2);
	let checkOnly = false;
	let manifestSource = DEFAULT_MANIFEST_URL;
	let packageNixPath = "nix/package.nix";

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--check") {
			checkOnly = true;
		} else if (args[i] === "--manifest" && args[i + 1]) {
			manifestSource = args[++i];
		} else if (args[i] === "--file" && args[i + 1]) {
			packageNixPath = args[++i];
		} else if (!args[i].startsWith("--")) {
			manifestSource = args[i];
		}
	}

	try {
		await updateNixPackage({ manifestSource, packageNixPath, checkOnly });
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}
