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
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { BUN_TARGET_IDS, bunTarget, packagedArchiveName, packagedExecutableName } from "./bun-targets.mjs";

export { packagedArchiveName };

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

const TAR_BLOCK = 512;

function tarField(header, offset, length, value) {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length > length) throw new Error(`tar header field too long: ${value}`);
	bytes.copy(header, offset);
}

function tarOctal(header, offset, length, value) {
	tarField(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

/** One-entry ustar archive holding `body` as a 0755 regular file owned by 0:0. */
function singleFileTar(name, body, mtimeSeconds) {
	const header = Buffer.alloc(TAR_BLOCK);
	tarField(header, 0, 100, name);
	tarOctal(header, 100, 8, 0o755);
	tarOctal(header, 108, 8, 0);
	tarOctal(header, 116, 8, 0);
	tarOctal(header, 124, 12, body.length);
	tarOctal(header, 136, 12, mtimeSeconds);
	header.fill(0x20, 148, 156);
	tarField(header, 156, 1, "0");
	tarField(header, 257, 6, "ustar\0");
	tarField(header, 263, 2, "00");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	tarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
	const padding = (TAR_BLOCK - (body.length % TAR_BLOCK)) % TAR_BLOCK;
	return Buffer.concat([header, body, Buffer.alloc(padding + 2 * TAR_BLOCK)]);
}

/**
 * Write the optional smaller download `pi-<target>.tar.xz`: a single `pi`
 * (`pi.exe` on Windows) entry with the exact executable bytes. The tar header
 * is written here so GNU, BSD and Windows runners produce the same layout.
 */
export function writePackagedArchive(executablePath, archivePath, platform) {
	const tar = singleFileTar(packagedExecutableName(platform), readFileSync(executablePath), Math.floor(statSync(executablePath).mtimeMs / 1000));
	const result = spawnSync("xz", ["-9", "-T0", "--block-size=32MiB", "-c"], { input: tar, maxBuffer: 4 * 1024 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`xz failed for ${archivePath}: ${result.error?.message ?? result.stderr?.toString() ?? ""}`);
	writeFileSync(archivePath, result.stdout);
}

/** Assert the archive holds exactly one 0755 `pi`/`pi.exe` entry whose bytes hash to `executableSha256`. */
export function assertPackagedArchive(archivePath, platform, executableSha256) {
	const result = spawnSync("xz", ["-dc", archivePath], { maxBuffer: 4 * 1024 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`xz could not decompress ${archivePath}: ${result.error?.message ?? result.stderr?.toString() ?? ""}`);
	const tar = result.stdout;
	const header = tar.subarray(0, TAR_BLOCK);
	const field = (offset, length) => header.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/s, "");
	const size = Number.parseInt(field(124, 12), 8);
	if (field(0, 100) !== packagedExecutableName(platform) || field(156, 1) !== "0" || Number.parseInt(field(100, 8), 8) !== 0o755 || !Number.isSafeInteger(size) || size <= 0) {
		throw new Error(`${archivePath} must contain exactly one 0755 ${packagedExecutableName(platform)} entry`);
	}
	const dataEnd = TAR_BLOCK + size;
	if (tar.length !== dataEnd + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK) + 2 * TAR_BLOCK || tar.subarray(dataEnd).some((byte) => byte !== 0)) {
		throw new Error(`${archivePath} contains entries beyond the executable`);
	}
	if (createHash("sha256").update(tar.subarray(TAR_BLOCK, dataEnd)).digest("hex") !== executableSha256) {
		throw new Error(`${archivePath} executable does not match the raw release asset`);
	}
}

export function stableStringify(value) {
	return `${JSON.stringify(value, undefined, "\t")}\n`;
}
