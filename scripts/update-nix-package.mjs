#!/usr/bin/env node
// Pins nix/package.nix to one authenticated xz-dev/pi Release.
//
// Usage: node scripts/update-nix-package.mjs [--check] <release-manifest.json> <package.nix>
//
// The Release's shipped Sigstore bundle must sit beside the manifest as
// attestation-subjects.jsonl. Only strictly validated version and SHA-256
// fields reach the Nix text, and only after `gh attestation verify` accepts the
// manifest for the main-branch Release workflow and the manifest's own source
// commit. --check fails instead of rewriting a stale package.nix.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	ATTESTATION_SIGNER_REF,
	ATTESTATION_SIGNER_WORKFLOW,
	ATTESTATION_SUBJECTS_FILENAME,
	MANIFEST_SCHEMA_VERSION,
	PACKAGING_BINARY,
	REPOSITORY,
	releaseArchiveName,
} from "./lib/github-release.mjs";

/** Release targets pinned by nix/package.nix, in hashes-block order. */
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

/** Convert a lowercase hex SHA-256 digest to a Nix SRI hash. */
export function hexToSri(hex) {
	if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) throw new Error("Invalid sha256 hex digest");
	return `sha256-${Buffer.from(hex, "hex").toString("base64")}`;
}

/** Return version, source commit and per-target SRI hashes of a schema-7 binary Release manifest, or throw. */
export function readReleasePins(manifest) {
	const version =
		typeof manifest?.distributionVersion === "string"
			? /^(\d+\.\d+\.\d+)-xz\.\d+\.\d+\.g([0-9a-f]{8})$/.exec(manifest.distributionVersion)
			: null;
	if (
		manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
		manifest.repository !== REPOSITORY ||
		manifest.packaging !== PACKAGING_BINARY ||
		!version ||
		manifest.apiVersion !== version[1] ||
		manifest.tag !== `xz-v${manifest.distributionVersion}` ||
		typeof manifest.commit !== "string" ||
		!/^[0-9a-f]{40}$/.test(manifest.commit) ||
		!manifest.commit.startsWith(version[2])
	) {
		throw new Error("Invalid GitHub Release manifest identity");
	}
	const sriHashes = {};
	for (const target of TARGETS) {
		const bundle = manifest.bundles?.[target];
		if (
			bundle?.file !== releaseArchiveName(target) ||
			!Number.isSafeInteger(bundle.bytes) ||
			bundle.bytes <= 0 ||
			typeof bundle.sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(bundle.sha256)
		) {
			throw new Error(`Invalid ${target} bundle metadata`);
		}
		sriHashes[target] = hexToSri(bundle.sha256);
	}
	return { version: manifest.distributionVersion, commit: manifest.commit, sriHashes };
}

const VERSION_LINE = /^([ \t]*)version \? "[^"\n]*",$/gm;
const HASHES_BLOCK =
	/^([ \t]*)# Pre-built release archive checksums for each platform from xz-dev\/pi\n[ \t]*hashes = \{[^}]*\};$/gm;

/** Rewrite the version default and the comment-marked hashes block; pins must come from readReleasePins. */
export function patchPackageNix(content, version, sriHashes) {
	if (content.match(VERSION_LINE)?.length !== 1) {
		throw new Error('package.nix must contain exactly one `version ? "...",` line');
	}
	if (content.match(HASHES_BLOCK)?.length !== 1) {
		throw new Error("package.nix must contain exactly one comment-marked `hashes = { ... };` block");
	}
	return content.replace(VERSION_LINE, (_line, indent) => `${indent}version ? "${version}",`).replace(
		HASHES_BLOCK,
		(_block, indent) =>
			[
				`${indent}# Pre-built release archive checksums for each platform from xz-dev/pi`,
				`${indent}hashes = {`,
				...TARGETS.map((target) => `${indent}  "${target}" = "${sriHashes[target]}";`),
				`${indent}};`,
			].join("\n"),
	);
}

/** Pin packageNixPath to the authenticated Release; with checkOnly, throw instead of writing a stale file. */
export function updateNixPackage(manifestPath, packageNixPath, { checkOnly = false } = {}) {
	const { version, commit, sriHashes } = readReleasePins(JSON.parse(readFileSync(manifestPath, "utf8")));
	verifyManifest(manifestPath, commit);
	const current = readFileSync(packageNixPath, "utf8");
	const pinned = patchPackageNix(current, version, sriHashes);
	if (pinned === current) return { updated: false, version };
	if (checkOnly) throw new Error(`${packageNixPath} is not pinned to ${version}`);
	writeFileSync(packageNixPath, pinned);
	return { updated: true, version };
}

const SIGNER_IDENTITY = `https://github.com/${REPOSITORY}/${ATTESTATION_SIGNER_WORKFLOW}@${ATTESTATION_SIGNER_REF}`;

// Same policy as the Release workflow's pre-publication check, bound to the
// manifest's own commit. There is deliberately no option to skip it.
function verifyManifest(manifestPath, commit) {
	const bundlePath = join(dirname(manifestPath), ATTESTATION_SUBJECTS_FILENAME);
	if (!existsSync(bundlePath)) throw new Error(`Missing Release attestation bundle ${bundlePath}`);
	const result = spawnSync(
		"gh",
		[
			"attestation",
			"verify",
			manifestPath,
			"--bundle",
			bundlePath,
			"--repo",
			REPOSITORY,
			"--cert-identity",
			SIGNER_IDENTITY,
			"--source-ref",
			ATTESTATION_SIGNER_REF,
			"--source-digest",
			commit,
			"--deny-self-hosted-runners",
		],
		{ stdio: ["ignore", "inherit", "inherit"] },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`gh attestation verify rejected ${manifestPath}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const checkOnly = process.argv[2] === "--check";
	const paths = process.argv.slice(checkOnly ? 3 : 2);
	if (paths.length !== 2 || paths.some((path) => path.startsWith("-"))) {
		console.error("Usage: node scripts/update-nix-package.mjs [--check] <release-manifest.json> <package.nix>");
		process.exit(1);
	}
	try {
		const { updated, version } = updateNixPackage(resolve(paths[0]), resolve(paths[1]), { checkOnly });
		console.log(`${paths[1]} ${updated ? "pinned" : "already pinned"} to ${version}`);
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
