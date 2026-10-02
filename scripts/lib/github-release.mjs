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
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { BUN_TARGET_IDS, bunTarget, releaseArchiveName, releaseEntryName } from "./bun-targets.mjs";

export { releaseArchiveName, releaseEntryName };

export const ENTRY_PACKAGE = "@earendil-works/pi-coding-agent";
export const DISTRIBUTION = "xz-dev";
export const REPOSITORY = "xz-dev/pi";
export const MANIFEST_SCHEMA_VERSION = 7;
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

// Release archive: a single-entry ZIP holding the executable as `pi`
// (`pi.exe` on Windows), deflated, with a fixed 1980-01-01 timestamp and
// Unix mode 0755 so `unzip`, `bsdtar`, Explorer and Scoop all restore a
// runnable file. ZIP64 is never needed: executables stay far below 4 GiB.
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_MAX = 0xffffffff;
const ZIP_DOS_DATE = (0 << 9) | (1 << 5) | 1;
const ZIP_UNIX_MODE = 0o100755;

export function createReleaseArchive(entryName, body) {
	if (body.length >= ZIP_MAX) throw new Error(`${entryName} is too large for a ZIP release archive`);
	const name = Buffer.from(entryName, "utf8");
	const data = deflateRawSync(body, { level: 9 });
	if (data.length >= ZIP_MAX) throw new Error(`${entryName} compressed data is too large`);
	const checksum = crc32(body);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(ZIP_LOCAL, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(0, 6);
	local.writeUInt16LE(8, 8);
	local.writeUInt16LE(0, 10);
	local.writeUInt16LE(ZIP_DOS_DATE, 12);
	local.writeUInt32LE(checksum, 14);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(body.length, 22);
	local.writeUInt16LE(name.length, 26);
	local.writeUInt16LE(0, 28);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(ZIP_CENTRAL, 0);
	central.writeUInt16LE((3 << 8) | 20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(0, 8);
	central.writeUInt16LE(8, 10);
	central.writeUInt16LE(0, 12);
	central.writeUInt16LE(ZIP_DOS_DATE, 14);
	central.writeUInt32LE(checksum, 16);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(body.length, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE(ZIP_UNIX_MODE * 0x10000, 38);
	central.writeUInt32LE(0, 42);
	const centralOffset = local.length + name.length + data.length;
	const end = Buffer.alloc(22);
	end.writeUInt32LE(ZIP_END, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(centralOffset, 16);
	return Buffer.concat([local, name, data, central, name, end]);
}

/**
 * Read a release archive written by createReleaseArchive and return the
 * executable bytes. Anything else (more entries, another name, other
 * compression, data descriptors, trailing bytes, CRC or size mismatch) throws.
 */
export function readReleaseArchive(archive, entryName, label = "release archive") {
	const fail = (reason) => {
		throw new Error(`${label} ${reason}`);
	};
	const name = Buffer.from(entryName, "utf8");
	if (archive.length < 30 + 46 + 22 + 2 * name.length) fail("is truncated");
	const endOffset = archive.length - 22;
	if (archive.readUInt32LE(endOffset) !== ZIP_END || archive.readUInt16LE(endOffset + 20) !== 0) fail("has no plain end record");
	if (archive.readUInt16LE(endOffset + 4) !== 0 || archive.readUInt16LE(endOffset + 6) !== 0 || archive.readUInt16LE(endOffset + 8) !== 1 || archive.readUInt16LE(endOffset + 10) !== 1) fail("must contain exactly one entry");
	const centralSize = archive.readUInt32LE(endOffset + 12);
	const centralOffset = archive.readUInt32LE(endOffset + 16);
	if (centralSize !== 46 + name.length || centralOffset + centralSize !== endOffset) fail("central directory is malformed");
	const central = archive.subarray(centralOffset, endOffset);
	if (central.readUInt32LE(0) !== ZIP_CENTRAL || central.readUInt16LE(8) !== 0 || central.readUInt16LE(10) !== 8) fail("entry must be plain deflate");
	if (central.readUInt16LE(28) !== name.length || central.readUInt16LE(30) !== 0 || central.readUInt16LE(32) !== 0 || central.readUInt32LE(42) !== 0) fail("central entry layout is unexpected");
	if (!central.subarray(46).equals(name)) fail(`must contain only ${entryName}`);
	const checksum = central.readUInt32LE(16);
	const compressedSize = central.readUInt32LE(20);
	const size = central.readUInt32LE(24);
	if ((central.readUInt32LE(38) >>> 16) !== ZIP_UNIX_MODE) fail(`${entryName} must be a 0755 regular file`);
	if (archive.readUInt32LE(0) !== ZIP_LOCAL || archive.readUInt16LE(6) !== 0 || archive.readUInt16LE(8) !== 8 || archive.readUInt16LE(26) !== name.length || archive.readUInt16LE(28) !== 0) fail("local entry layout is unexpected");
	if (archive.readUInt32LE(14) !== checksum || archive.readUInt32LE(18) !== compressedSize || archive.readUInt32LE(22) !== size) fail("local and central entries disagree");
	if (!archive.subarray(30, 30 + name.length).equals(name)) fail(`must contain only ${entryName}`);
	const dataStart = 30 + name.length;
	if (dataStart + compressedSize !== centralOffset) fail("has bytes outside the entry");
	const body = inflateRawSync(archive.subarray(dataStart, centralOffset), { maxOutputLength: size });
	if (body.length !== size || crc32(body) !== checksum) fail(`${entryName} failed size or CRC verification`);
	return body;
}

/** Write `pi-<target>.zip` for one raw executable. */
export function writeReleaseArchive(executablePath, archivePath, platform) {
	writeFileSync(archivePath, createReleaseArchive(releaseEntryName(platform), readFileSync(executablePath)));
}

/** Return the verified executable bytes inside a target's release archive. */
export function readTargetArchive(archivePath, platform) {
	return readReleaseArchive(readFileSync(archivePath), releaseEntryName(platform), archivePath);
}

export function stableStringify(value) {
	return `${JSON.stringify(value, undefined, "\t")}\n`;
}
