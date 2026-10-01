#!/usr/bin/env node
/**
 * Shared GitHub Release artifact helpers for prepare/verify tooling.
 *
 * Plain ESM (.mjs) so it runs directly under Node without a build step.
 *
 * Binary packaging contract:
 * - each Release ships the canonical Bun-compiled target executables
 *   (`pi-<target>` on POSIX, `pi-<target>.exe` on Windows) as raw files
 * - the manifest freezes the exact tag, full commit, downstream/upstream API
 *   versions, per-platform executable metadata (file, bytes, sha256),
 *   acceptance evidence, and attestation policy
 * - the verifier checks each asset's size, digest, and executable shape
 *   (regular file, nonzero, x bit on POSIX)
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { BUN_TARGET_IDS, bunTarget } from "./bun-targets.mjs";

export const ENTRY_PACKAGE = "@earendil-works/pi-coding-agent";
export const DISTRIBUTION = "xz-dev";
export const REPOSITORY = "xz-dev/pi";
export const MANIFEST_SCHEMA_VERSION = 6;
export const ATTESTATION_SIGNER_WORKFLOW = ".github/workflows/publish-github-release.yml";
export const ATTESTATION_SIGNER_REF = "refs/heads/main";
export const ATTESTATION_SUBJECTS_FILENAME = "attestation-subjects.jsonl";
export const PACKAGING_BINARY = "binary";

/** The canonical Bun-compiled target executables shipped by each Release. */
export const BINARY_PLATFORMS = BUN_TARGET_IDS;

/** Release asset filename for a target's raw executable. */
export function binaryArchiveName(targetId) {
	const target = bunTarget(targetId);
	return `pi-${targetId}${target.os === "windows" ? ".exe" : ""}`;
}

/** Native inventory for a canonical Bun target. */
export function platformNativeInfo(targetId) {
	return bunTarget(targetId);
}

/**
 * Assert that a path is a runnable release executable: a regular file with
 * nonzero size, carrying the owner execute bit on POSIX.
 */
export function assertExecutableAsset(path, platform) {
	const stat = statSync(path);
	if (!stat.isFile()) throw new Error(`Release asset ${path} is not a regular file`);
	if (stat.size <= 0) throw new Error(`Release asset ${path} is empty`);
	if (platformNativeInfo(platform).os !== "windows" && (stat.mode & 0o100) === 0) {
		throw new Error(`Release asset ${path} is missing its execute bit`);
	}
}

export function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env ?? process.env,
		input: options.input,
		maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
		stdio: options.capture
			? ["pipe", "pipe", options.mergeStderr ? "pipe" : "inherit"]
			: options.stdio ?? "inherit",
	});
	if (result.status !== 0) {
		const detail = options.capture
			? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
			: "";
		throw new Error(
			`Command failed: ${[command, ...args].join(" ")}${detail ? `\n${detail}` : ""}`,
		);
	}
	return result.stdout ?? "";
}

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

export function forkDistributionVersion(baseVersion, env = process.env) {
	const runNumber = env.GITHUB_RUN_NUMBER ?? "0";
	const runAttempt = env.GITHUB_RUN_ATTEMPT ?? "1";
	if (!/^\d+$/.test(runNumber) || !/^\d+$/.test(runAttempt)) {
		throw new Error("GITHUB_RUN_NUMBER and GITHUB_RUN_ATTEMPT must be decimal integers");
	}
	let sha = env.GITHUB_SHA;
	if (!sha) {
		sha = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
	}
	if (!/^[0-9a-f]{8,40}$/i.test(sha)) {
		throw new Error("GITHUB_SHA or checked-out HEAD must be a hexadecimal commit SHA");
	}
	return `${baseVersion}-xz.${runNumber}.${runAttempt}.g${sha.slice(0, 8).toLowerCase()}`;
}

export function resolveFullCommit(env = process.env) {
	if (env.GITHUB_SHA && /^[0-9a-f]{40}$/i.test(env.GITHUB_SHA)) {
		const expected = env.GITHUB_SHA.toLowerCase();
		if (env.GITHUB_ACTIONS || env.CI) {
			const head = run("git", ["rev-parse", "HEAD"], { capture: true }).trim().toLowerCase();
			if (head !== expected) {
				throw new Error(`GITHUB_SHA ${expected} does not match checked-out HEAD ${head}`);
			}
		}
		return expected;
	}
	if (env.GITHUB_SHA && env.GITHUB_SHA.length >= 7) {
		// Prefer full SHA from git when env only has a partial or any value.
		try {
			return run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
		} catch {
			return env.GITHUB_SHA;
		}
	}
	return run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
}

export function formatSha256Sums(entries) {
	// Deterministic GNU-style "HASH  filename" lines, sorted by filename.
	return `${entries
		.slice()
		.sort((a, b) => a.file.localeCompare(b.file))
		.map((entry) => `${entry.sha256}  ${entry.file}`)
		.join("\n")}\n`;
}

export function parseSha256Sums(text) {
	const entries = new Map();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = line.match(/^([0-9a-f]{64})  (.+)$/);
		if (!match) {
			throw new Error(`Invalid SHA256SUMS line: ${line}`);
		}
		if (entries.has(match[2])) {
			throw new Error(`Duplicate SHA256SUMS entry: ${match[2]}`);
		}
		entries.set(match[2], match[1]);
	}
	return entries;
}

export function stableStringify(value) {
	return `${JSON.stringify(value, undefined, "\t")}\n`;
}
