#!/usr/bin/env node
/**
 * Shared GitHub Release artifact helpers for prepare/verify tooling.
 *
 * Plain ESM (.mjs) so it runs directly under Node without a build step.
 *
 * Binary packaging contract:
 * - each Release ships exactly twelve Bun-compiled target bundles
 * - the manifest freezes the exact tag, full commit, downstream/upstream API
 *   versions, per-platform archive metadata, bundle layout version, required
 *   paths, acceptance evidence, and attestation policy
 * - the verifier checks every required path and rejects any unsafe archive
 *   entry (symlink, hardlink, device, FIFO, traversal, or absolute path)
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { BUN_TARGET_IDS, binaryArchiveName as targetArchiveName, bunTarget } from "./bun-targets.mjs";

export const ENTRY_PACKAGE = "@earendil-works/pi-coding-agent";
export const DISTRIBUTION = "xz-dev";
export const REPOSITORY = "xz-dev/pi";
export const MANIFEST_SCHEMA_VERSION = 5;
export const ATTESTATION_SIGNER_WORKFLOW = ".github/workflows/publish-github-release.yml";
export const ATTESTATION_SIGNER_REF = "refs/heads/main";
export const ATTESTATION_SUBJECTS_FILENAME = "attestation-subjects.jsonl";
export const PACKAGING_BINARY = "binary";
export const BUNDLE_LAYOUT_VERSION = 2;

/** The canonical Bun-compiled target bundles shipped by each Release. */
export const BINARY_PLATFORMS = BUN_TARGET_IDS;

export function binaryArchiveName(targetId) {
	return targetArchiveName(targetId);
}

/** Native inventory for a canonical Bun target. */
export function platformNativeInfo(targetId) {
	return bunTarget(targetId);
}

/**
 * Machine-checkable required-path inventory for a platform bundle.
 * Every required path must exist inside the archive; the verifier also rejects
 * any entry that is absolute, traverses out of the bundle, or lives under a
 * top-level directory that is not part of the canonical bundle layout.
 */
export function binaryRequiredPaths(platform) {
	const info = platformNativeInfo(platform);
	const clipboardParent = "node_modules/@mariozechner/clipboard";
	const paths = [
		info.wrapper,
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

/** Top-level archive entries that the bundle may legitimately contain. */
export const ALLOWED_BUNDLE_TOP_LEVEL = Object.freeze([
	"pi",
	"pi.exe",
	"pi-native",
	"pi-native.exe",
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"THIRD_PARTY_NOTICES.md",
	"photon_rs_bg.wasm",
	"theme",
	"assets",
	"export-html",
	"docs",
	"examples",
	"node_modules",
	"native",
	"clipboard-native-provenance.json",
]);

function normalizeArchiveEntry(entry) {
	return entry.replaceAll("\\", "/").replace(/^\/+/u, "");
}

function assertSafeArchiveEntry(entry, archiveName) {
	const normalized = normalizeArchiveEntry(entry);
	if (
		!normalized ||
		normalized === "." ||
		normalized === ".." ||
		/^(?:[A-Za-z]:)?\//u.test(normalized) ||
		normalized.split("/").some((segment) => segment === "..") ||
		/\u0000/u.test(normalized)
	) {
		throw new Error(`Unsafe archive entry ${JSON.stringify(entry)} in ${archiveName}`);
	}
	return normalized;
}

function assertAllowedTopLevel(normalized, archiveName) {
	const top = normalized.split("/")[0];
	if (!ALLOWED_BUNDLE_TOP_LEVEL.includes(top)) {
		throw new Error(`Unexpected top-level entry ${JSON.stringify(top)} in ${archiveName}`);
	}
}

/**
 * Inspect a tar listing mode and reject any entry that is not a regular file
 * (mode begins with '-') or a directory (mode begins with 'd'). Symlink,
 * hardlink, device, and FIFO entries are rejected before any extraction.
 */
function parseTarTypeByte(modeString, archiveName) {
	const typeChar = modeString[0] ?? "";
	if (typeChar === "-" || typeChar === "d") return typeChar;
	throw new Error(
		`Unsafe tar entry type ${JSON.stringify(modeString)} in ${archiveName} (only regular files and directories are allowed)`,
	);
}

/**
 * List entries of a tar.gz bundle and reject unsafe/unknown paths and unsafe
 * entry types (symlink, hardlink, device, FIFO). Uses GNU tar's verbose listing
 * so the type byte is available before any extraction. tar.gz bundles wrap
 * files under a top-level `pi/` directory; that wrapper prefix is normalized
 * away so the required-path inventory is expressed relative to the bundle
 * content root. Returns normalized forward-slash paths.
 */
export function listTarBundleEntries(tarPath) {
	const output = run("tar", ["-tvzf", tarPath], {
		capture: true,
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, LC_ALL: "C" },
	});
	const entries = new Set();
	for (const line of output.split(/\r?\n/u)) {
		if (!line.trim()) continue;
		const tokens = line.trim().split(/\s+/u);
		const mode = tokens[0] ?? "";
		parseTarTypeByte(mode, tarPath);
		const name = tokens[tokens.length - 1] ?? "";
		const safe = assertSafeArchiveEntry(name, tarPath);
		let normalized;
		if (safe === "pi" || safe.startsWith("pi/")) {
			normalized = safe === "pi" ? "." : safe.slice(3);
		} else {
			normalized = safe;
		}
		if (normalized === "." || normalized === "") continue;
		const bare = normalized.replace(/\/$/u, "");
		if (!bare) continue;
		assertAllowedTopLevel(bare, tarPath);
		entries.add(bare);
	}
	return [...entries];
}

/** Zip signatures. */
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CD_HEADER_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
/** External-attribute high bits encode the POSIX file type. */
const ZIP_TYPE_DIRECTORY = 0x4000;
const ZIP_TYPE_REGULAR = 0x8000;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATED = 8;

function zipEntryType(record) {
	return record.typeBits === 0 ? (record.name.endsWith("/") ? ZIP_TYPE_DIRECTORY : ZIP_TYPE_REGULAR) : record.typeBits;
}

/**
 * Parse a zip archive's central directory into entry records. Each record
 * carries the name, external-attribute POSIX file-type bits when present,
 * the compression method, the local header offset, and the compressed size.
 * Windows ZIP tools may omit POSIX bits; those entries are classified from
 * their trailing directory separator and remain subject to path/top-level checks.
 */
export function zipCentralDirectoryEntries(buffer) {
	if (buffer.length < 22) throw new Error("Zip archive is too small to contain an end-of-central-directory record");
	const eocdMax = Math.min(buffer.length, 22 + 65535);
	const tail = buffer.subarray(buffer.length - eocdMax);
	let eocdOffset = -1;
	for (let i = tail.length - 22; i >= 0; i -= 1) {
		if (tail.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) {
			eocdOffset = buffer.length - eocdMax + i;
			break;
		}
	}
	if (eocdOffset < 0) throw new Error("Zip archive is missing an end-of-central-directory record");
	const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
	const cdSize = buffer.readUInt32LE(eocdOffset + 12);
	const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
	const cdEnd = cdOffset + cdSize;
	if (cdOffset + cdSize > buffer.length) throw new Error("Zip central directory extends past end of archive");
	const entries = [];
	let offset = cdOffset;
	for (let index = 0; index < totalEntries; index += 1) {
		if (offset + 46 > cdEnd) throw new Error("Zip central directory is truncated");
		if (buffer.readUInt32LE(offset) !== ZIP_CD_HEADER_SIGNATURE) {
			throw new Error("Zip central directory header signature mismatch");
		}
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const externalAttributes = buffer.readUInt32LE(offset + 38);
		const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		entries.push({
			name,
			typeBits: (externalAttributes >>> 16) & 0xf000,
			method,
			localOffset,
			compressedSize,
		});
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/**
 * Read a single file's bytes out of a zip archive by exact path using only
 * standard Node (no `unzip` dependency). Returns a Buffer. Throws if the entry
 * is absent or uses an unsupported compression method.
 */
export function readZipFileBuffer(zipPath, entryName) {
	const buffer = readFileSync(zipPath);
	const entries = zipCentralDirectoryEntries(buffer);
	const record = entries.find((entry) => entry.name === entryName);
	if (!record) throw new Error(`Could not find ${entryName} in ${zipPath}`);
	if (zipEntryType(record) !== ZIP_TYPE_REGULAR) {
		throw new Error(`${entryName} in ${zipPath} is not a regular file`);
	}
	const local = record.localOffset;
	if (buffer.length < local + 30 || buffer.readUInt32LE(local) !== ZIP_LOCAL_HEADER_SIGNATURE) {
		throw new Error(`Invalid local header for ${entryName} in ${zipPath}`);
	}
	const nameLength = buffer.readUInt16LE(local + 26);
	const extraLength = buffer.readUInt16LE(local + 28);
	const dataStart = local + 30 + nameLength + extraLength;
	const data = buffer.subarray(dataStart, dataStart + record.compressedSize);
	if (record.method === ZIP_METHOD_STORED) return data;
	if (record.method === ZIP_METHOD_DEFLATED) return inflateRawSync(data);
	throw new Error(`Unsupported zip compression method ${record.method} for ${entryName} in ${zipPath}`);
}

/**
 * List entries of a Windows zip bundle and reject unsafe/unknown paths and
 * unsafe entry types (symlink, hardlink, device, FIFO). Inspects central
 * directory metadata directly. Unix-created archives must identify regular
 * files/directories explicitly; DOS-only entries are inferred from the path
 * shape because that metadata cannot encode a Unix link type. Zip bundles have
 * no wrapper directory: files live at the archive root. Returns normalized
 * forward-slash paths.
 */
export function listZipBundleEntries(zipPath) {
	const records = zipCentralDirectoryEntries(readFileSync(zipPath));
	const seen = new Set();
	for (const record of records) {
		const safe = assertSafeArchiveEntry(record.name, zipPath);
		const inferredType = zipEntryType(record);
		if (inferredType !== ZIP_TYPE_REGULAR && inferredType !== ZIP_TYPE_DIRECTORY) {
			throw new Error(
				`Unsafe zip entry type 0x${record.typeBits.toString(16).padStart(4, "0")} for ${JSON.stringify(record.name)} in ${zipPath}`,
			);
		}
		if (safe === "." || safe === "") continue;
		const bare = safe.replace(/\/$/u, "");
		if (!bare) continue;
		assertAllowedTopLevel(bare, zipPath);
		seen.add(bare);
	}
	return [...seen];
}

/**
 * Verify a platform bundle archive: every required path present, and no unsafe
 * or unknown top-level entry and no non-regular/non-directory entry. Returns
 * the normalized entry set.
 */
export function assertBinaryBundleInventory(archivePath, platform) {
	const entries = platformNativeInfo(platform).archive === "zip"
		? listZipBundleEntries(archivePath)
		: listTarBundleEntries(archivePath);
	const entrySet = new Set(entries);
	for (const required of binaryRequiredPaths(platform)) {
		if (!entrySet.has(required)) {
			throw new Error(`Bundle ${archivePath} is missing required path ${required}`);
		}
	}
	return entrySet;
}

/**
 * Read a single file's UTF-8 contents out of a tar.gz archive by exact path.
 * The tar.gz bundle wraps files under a top-level `pi/` directory.
 */
export function readTarFile(tarPath, archivePath) {
	const result = spawnSync("tar", ["-xOf", tarPath, archivePath], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`Could not read ${archivePath} from ${tarPath}: ${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

/**
 * Read a single file's UTF-8 contents out of a Windows zip bundle using the
 * pure-Node zip reader (no `unzip` dependency). The zip has no wrapper
 * directory: files live at the archive root.
 */
export function readZipFile(zipPath, archivePath) {
	return readZipFileBuffer(zipPath, archivePath).toString("utf8");
}

/** Read package.json out of a platform bundle archive. */
export function readBundlePackageJson(archivePath, platform) {
	const contents = platformNativeInfo(platform).archive === "zip"
		? readZipFile(archivePath, "package.json")
		: readTarFile(archivePath, "pi/package.json");
	return JSON.parse(contents);
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
