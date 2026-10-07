import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RELEASE_TARGET } from "../config.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";
import { readReleaseArchive } from "./release-archive.ts";
import { verifyReleaseAttestation } from "./release-attestation.ts";

/** Rename one path, retrying transient Windows sharing violations. */
function renameSyncRetryable(
	source: string,
	destination: string,
	rename: (source: string, destination: string) => void = renameSync,
): void {
	try {
		rename(source, destination);
		return;
	} catch (error: unknown) {
		if (!isTransientWindowsShareViolation(error)) throw error;
	}
	// Windows briefly reports EPERM/EACCES when another process holds an open
	// child handle without delete sharing - shell indexers, antivirus scans,
	// and handle-duplicating child processes all close them again on their
	// own. Wait, and recheck the destination after every failed attempt: the
	// caller that won the race may have already moved the path for us.
	for (let attempt = 0; attempt < 30; attempt++) {
		if (existsSync(destination) && !existsSync(source)) return;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		try {
			rename(source, destination);
			return;
		} catch (error: unknown) {
			if (attempt === 29 || !isTransientWindowsShareViolation(error)) throw error;
		}
	}
}

function isTransientWindowsShareViolation(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
}

const REPOSITORY = "xz-dev/pi";
const RELEASE_DOWNLOAD_ORIGIN = "https://github.com";
export const DEFAULT_XZ_RELEASE_MIRRORS = [
	"https://gh-proxy.com/https://github.com",
	"https://ghfast.top/https://github.com",
	RELEASE_DOWNLOAD_ORIGIN,
] as const;
const RELEASE_MAX_BYTES = 1024 * 1024;
const MANIFEST_SCHEMA_VERSION = 7;
const MANIFEST_FILENAME = "release-manifest.json";
const SUMS_FILENAME = "SHA256SUMS";
const ATTESTATION_FILENAME = "attestation-subjects.jsonl";
const EXECUTABLE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const EXECUTABLE_INACTIVITY_TIMEOUT_MS = 30000;
const DOWNLOAD_PROGRESS_INTERVAL_MS = 1000;
const DISTRIBUTION_VERSION_PATTERN = /^\d+\.\d+\.\d+-xz\.\d+\.\d+\.g[0-9a-f]{8}$/;

interface GitHubReleaseAsset {
	name: string;
	browser_download_url: string;
	size: number;
	digest: string;
	/** The single executable inside the ZIP asset. */
	executable: { size: number; digest: string };
}

export interface XzCleanupOptions {
	/** Injectable unlink for tests (deletion-failure reporting). */
	unlinkSync?: (path: string) => void;
}

export interface XzCleanupResult {
	removed: string[];
	retained: { file: string; error: string }[];
}

export interface XzLatestRelease {
	version: string;
	tag: string;
	commit: string;
	bundle: GitHubReleaseAsset;
	exactBaseUrl: string;
}

interface XzMirrorOptions {
	mirrors?: readonly string[];
	onMirrorError?: (message: string) => void;
}

interface XzReleaseOptions extends XzMirrorOptions {
	timeoutMs?: number;
	retry?: boolean;
}

async function withReleaseMirrors<T>(options: XzMirrorOptions, operation: (base: string) => Promise<T>): Promise<T> {
	const bases =
		process.env.PI_XZ_RELEASE_BASE_URL || !options.mirrors?.length ? [RELEASE_DOWNLOAD_ORIGIN] : options.mirrors;
	for (const [index, base] of bases.entries()) {
		try {
			return await operation(base);
		} catch (error) {
			const next = bases[index + 1];
			options.onMirrorError?.(
				`Release download from ${base} failed: ${error instanceof Error ? error.message : String(error)}.${next === undefined ? "" : ` Trying ${next}...`}`,
			);
			if (next === undefined) throw error;
		}
	}
	throw new Error("No Release download source available");
}

class RetryableDiscoveryError {
	readonly error: unknown;

	constructor(error: unknown) {
		this.error = error;
	}
}

interface XzSelfUpdateOptions extends XzMirrorOptions {
	executablePath?: string;
	inactivityTimeoutMs?: number;
	now?: () => number;
	writeProgress?: (message: string) => void;
	isTTY?: boolean;
	/** Injectable raw rename for tests; retry behavior always applies. */
	renameSync?: (source: string, destination: string) => void;
}

/**
 * Delete outdated single-executable backups next to the running `pi` binary.
 * Only regular files named exactly `pi-<distribution version>[.exe]` are
 * candidates; symlinks, directories, the running executable's own basename,
 * and everything else are left alone. Undeletable candidates (Windows
 * EBUSY/EPERM) are reported, not silently dropped.
 */
export function cleanXzBackups(executablePath = process.execPath, options: XzCleanupOptions = {}): XzCleanupResult {
	const unlink = options.unlinkSync ?? unlinkSync;
	const directory = dirname(executablePath);
	const extension = process.platform === "win32" ? ".exe" : "";
	const ownName = basename(executablePath);
	const removed: string[] = [];
	const retained: { file: string; error: string }[] = [];
	for (const entry of readdirSync(directory)) {
		if (entry === ownName || entry === "pi-helper" || entry === "pi-helper.exe") continue;
		const match = entry.startsWith("pi-") && entry.endsWith(extension) ? entry : undefined;
		if (!match) continue;
		const version = entry.slice("pi-".length, entry.length - extension.length);
		if (!DISTRIBUTION_VERSION_PATTERN.test(version)) continue;
		const path = join(directory, entry);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(path);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		try {
			unlink(path);
			removed.push(entry);
		} catch (error: unknown) {
			retained.push({ file: entry, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { removed, retained };
}

function fail(message: string): never {
	throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value) return fail(`Invalid ${label}`);
	return value;
}

function requirePositiveSize(value: unknown, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
		return fail(`Invalid ${label}`);
	}
	return value as number;
}

function requireSha256Digest(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) return fail(`Invalid ${label}`);
	return value;
}

function parseDistributionVersion(value: string): { commit: string } {
	const match = /^\d+\.\d+\.\d+-xz\.\d+\.\d+\.g([0-9a-f]{8})$/.exec(value);
	if (!match) return fail("Invalid xz-dev distribution version");
	return { commit: match[1] };
}

function releaseBaseUrl(kind: "latest" | string): string {
	const override = process.env.PI_XZ_RELEASE_BASE_URL;
	if (override) {
		const url = new URL(override);
		if (url.protocol !== "https:" && url.protocol !== "http:") return fail("Invalid PI_XZ_RELEASE_BASE_URL");
		return url.href.endsWith("/") ? url.href : `${url.href}/`;
	}
	return `${RELEASE_DOWNLOAD_ORIGIN}/${REPOSITORY}/releases/${kind === "latest" ? "latest/download" : `download/${encodeURIComponent(kind)}`}/`;
}

function exactBaseUrl(tag: string): string {
	return releaseBaseUrl(tag);
}

function expectedBundleName(target: string): string {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target)) return fail("Invalid xz-dev Release target metadata");
	return `pi-${target}.zip`;
}

function expectedEntryName(): string {
	return process.platform === "win32" ? "pi.exe" : "pi";
}

function parseLatestRelease(value: unknown): XzLatestRelease {
	if (!isRecord(value)) return fail("Invalid xz-dev Release manifest");
	if (
		value.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
		value.repository !== REPOSITORY ||
		value.packaging !== "binary"
	) {
		return fail("Invalid xz-dev Release manifest identity");
	}
	const tag = requireString(value.tag, "release tag");
	if (!tag.startsWith("xz-v")) return fail("Invalid xz-dev Release tag");
	const version = requireString(value.distributionVersion, "distribution version");
	if (tag !== `xz-v${version}`) return fail("Release tag/version mismatch");
	const parsedVersion = parseDistributionVersion(version);
	const commit = requireString(value.commit, "release commit");
	if (!/^[0-9a-f]{40}$/.test(commit) || !commit.startsWith(parsedVersion.commit)) {
		return fail("Release commit/version mismatch");
	}
	if (!RELEASE_TARGET) return fail("xz-dev Release target metadata is missing from this binary");
	const expectedFile = expectedBundleName(RELEASE_TARGET);
	if (!isRecord(value.bundles)) return fail("Latest xz-dev Release bundles are missing");
	const bundle = value.bundles[RELEASE_TARGET];
	if (!isRecord(bundle) || bundle.file !== expectedFile || !isRecord(bundle.executable)) {
		return fail(`Invalid ${expectedFile} bundle metadata`);
	}
	const exactBase = exactBaseUrl(tag);
	return {
		version,
		tag,
		commit,
		exactBaseUrl: exactBase,
		bundle: {
			name: expectedFile,
			browser_download_url: `${exactBase}${expectedFile}`,
			size: requirePositiveSize(bundle.bytes, EXECUTABLE_MAX_BYTES, "bundle size"),
			digest: requireSha256Digest(`sha256:${requireString(bundle.sha256, "bundle digest")}`, "bundle digest"),
			executable: {
				size: requirePositiveSize(bundle.executable.bytes, EXECUTABLE_MAX_BYTES, "executable size"),
				digest: requireSha256Digest(
					`sha256:${requireString(bundle.executable.sha256, "executable digest")}`,
					"executable digest",
				),
			},
		},
	};
}

function fetchHeaders(currentVersion: string, accept: string): Record<string, string> {
	return { "User-Agent": getPiUserAgent(currentVersion), accept };
}

function manifestDigestFromSums(bytes: Uint8Array): string {
	const matches = new TextDecoder()
		.decode(bytes)
		.split(/\r?\n/)
		.filter((line) => line.endsWith(`  ${MANIFEST_FILENAME}`));
	if (matches.length !== 1 || !/^[0-9a-f]{64} {2}release-manifest\.json$/.test(matches[0])) {
		return fail(`Invalid ${SUMS_FILENAME} entry for ${MANIFEST_FILENAME}`);
	}
	return matches[0].slice(0, 64);
}

async function fetchResponse(
	url: URL | string,
	currentVersion: string,
	timeout: number | AbortSignal,
	accept: string,
	classifyRetryable = false,
): Promise<Response> {
	let response: Response;
	try {
		let target = new URL(url);
		const signal = typeof timeout === "number" ? AbortSignal.timeout(timeout) : timeout;
		for (let redirects = 0; ; redirects++) {
			response = await fetch(target.href, {
				headers: fetchHeaders(currentVersion, accept),
				signal,
				redirect: "manual",
			});
			const location = response.headers.get("location");
			if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
			await response.body?.cancel();
			if (redirects >= 20) throw new Error("Too many GitHub Release redirects");
			// Bun 1.4.2 cannot follow mirror paths such as /https://github.com/...
			// automatically. Resolve the Location ourselves, retaining the original timeout.
			target = new URL(location, target);
			if (target.protocol !== "https:" && target.protocol !== "http:") {
				throw new Error("Unsupported GitHub Release redirect protocol");
			}
		}
	} catch (error) {
		if (classifyRetryable) throw new RetryableDiscoveryError(error);
		throw error;
	}
	if (!response.ok) {
		await response.body?.cancel();
		const error = new Error(`GitHub Release request failed: HTTP ${response.status}`);
		if (classifyRetryable && [408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
			throw new RetryableDiscoveryError(error);
		}
		throw error;
	}
	return response;
}

async function readBoundedResponse(
	response: Response,
	maximumBytes: number,
	label: string,
	retryTransportFailures = false,
	onProgress?: (total: number) => void,
): Promise<Uint8Array> {
	const contentLength = response.headers.get("content-length");
	if (contentLength) {
		const parsed = Number(contentLength);
		if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
			return fail(`${label} exceeds the allowed size`);
		}
	}
	if (!response.body) return fail(`${label} returned no body`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		let next: Awaited<ReturnType<typeof reader.read>>;
		try {
			next = await reader.read();
		} catch (error) {
			if (retryTransportFailures) throw new RetryableDiscoveryError(error);
			throw error;
		}
		if (next.done) break;
		total += next.value.byteLength;
		if (total > maximumBytes) {
			await reader.cancel();
			return fail(`${label} exceeds the allowed size`);
		}
		if (next.value.byteLength > 0) onProgress?.(total);
		chunks.push(next.value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

async function discoverLatestXzRelease(
	currentVersion: string,
	timeoutMs: number,
	base: string,
): Promise<XzLatestRelease> {
	const latestBase = releaseBaseUrl("latest").replace(RELEASE_DOWNLOAD_ORIGIN, () => base);
	const sumsResponse = await fetchResponse(
		`${latestBase}${SUMS_FILENAME}`,
		currentVersion,
		timeoutMs,
		"text/plain",
		true,
	);
	const sumsBytes = await readBoundedResponse(sumsResponse, RELEASE_MAX_BYTES, SUMS_FILENAME, true);
	const expectedManifestDigest = manifestDigestFromSums(sumsBytes);
	const manifestResponse = await fetchResponse(
		`${latestBase}${MANIFEST_FILENAME}`,
		currentVersion,
		timeoutMs,
		"application/json",
		true,
	);
	const bytes = await readBoundedResponse(manifestResponse, RELEASE_MAX_BYTES, "Release manifest", true);
	const actualManifestDigest = createHash("sha256").update(bytes).digest("hex");
	if (actualManifestDigest !== expectedManifestDigest) return fail("Release manifest sha256 mismatch");
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return fail("Invalid xz-dev Release manifest JSON");
	}
	const release = parseLatestRelease(value);
	const attestationResponse = await fetchResponse(
		`${release.exactBaseUrl.replace(RELEASE_DOWNLOAD_ORIGIN, () => base)}${ATTESTATION_FILENAME}`,
		currentVersion,
		timeoutMs,
		"application/x-ndjson",
		true,
	);
	const attestationBytes = await readBoundedResponse(
		attestationResponse,
		RELEASE_MAX_BYTES,
		"Release attestation",
		true,
	);
	verifyReleaseAttestation(bytes, attestationBytes, release.commit);
	return release;
}

export async function getLatestXzRelease(
	currentVersion: string,
	options: XzReleaseOptions = {},
): Promise<XzLatestRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;
	parseDistributionVersion(currentVersion);
	const attempts = options.retry && !options.mirrors?.length ? 3 : 1;
	return withReleaseMirrors(options, async (base) => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await discoverLatestXzRelease(currentVersion, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, base);
			} catch (error) {
				if (!(error instanceof RetryableDiscoveryError) || attempt + 1 >= attempts) {
					throw error instanceof RetryableDiscoveryError ? error.error : error;
				}
			}
		}
	});
}

function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB"];
	let value = bytes;
	let unit = units[0];
	for (const nextUnit of units.slice(1)) {
		if (value < 1024) break;
		value /= 1024;
		unit = nextUnit;
	}
	return `${value.toFixed(unit === "B" ? 0 : 1)} ${unit}`;
}

function writeDownloadProgress(message: string, isTTY = Boolean(process.stdout.isTTY)): void {
	process.stdout.write(isTTY ? `\r\x1b[2K${message}` : `${message}\n`);
}

/**
 * Download the release ZIP, verify its byte length and sha256, extract the
 * single executable entry and verify its size and sha256, all BEFORE anything
 * is written. Mirror fallback only retries download/verification, never filesystem operations.
 */
async function downloadExecutable(
	release: XzLatestRelease,
	currentVersion: string,
	options: XzSelfUpdateOptions,
	base: string,
): Promise<Uint8Array> {
	const expectedBase = exactBaseUrl(release.tag);
	const expectedFile = RELEASE_TARGET ? expectedBundleName(RELEASE_TARGET) : "";
	const expectedUrl = `${expectedBase}${expectedFile}`;
	if (
		release.exactBaseUrl !== expectedBase ||
		release.bundle.name !== expectedFile ||
		release.bundle.browser_download_url !== expectedUrl
	) {
		return fail("Release bundle URL is not the exact xz-dev tag asset");
	}
	const controller = new AbortController();
	const inactivityTimeoutMs = options.inactivityTimeoutMs ?? EXECUTABLE_INACTIVITY_TIMEOUT_MS;
	const abortStalledDownload = (): void => {
		controller.abort(
			new Error(
				`${release.bundle.name} download stalled: no data received for ${Math.round(inactivityTimeoutMs / 1000)} seconds`,
			),
		);
	};
	let inactivityTimeout = setTimeout(abortStalledDownload, inactivityTimeoutMs);
	const resetInactivityTimeout = (): void => {
		clearTimeout(inactivityTimeout);
		inactivityTimeout = setTimeout(abortStalledDownload, inactivityTimeoutMs);
	};
	const now = options.now ?? Date.now;
	const writeProgress = options.writeProgress ?? ((message) => writeDownloadProgress(message, options.isTTY));
	const startedAt = now();
	let lastProgressAt = -Infinity;
	let downloaded = 0;
	let progressShown = false;
	const showProgress = (complete = false): void => {
		const timestamp = now();
		if (!complete && timestamp - lastProgressAt < DOWNLOAD_PROGRESS_INTERVAL_MS) return;
		lastProgressAt = timestamp;
		progressShown = true;
		const percent = Math.min(100, Math.floor((downloaded / release.bundle.size) * 100));
		const elapsedSeconds = Math.max((timestamp - startedAt) / 1000, 0.001);
		writeProgress(
			`Downloading ${release.bundle.name}: ${percent}%  ${formatBytes(downloaded)} / ${formatBytes(release.bundle.size)}  ${formatBytes(downloaded / elapsedSeconds)}/s`,
		);
	};
	try {
		const response = await fetchResponse(
			expectedUrl.replace(RELEASE_DOWNLOAD_ORIGIN, () => base),
			currentVersion,
			controller.signal,
			"application/octet-stream",
		);
		showProgress();
		const bytes = await readBoundedResponse(response, release.bundle.size, release.bundle.name, false, (total) => {
			resetInactivityTimeout();
			downloaded = total;
			showProgress();
		});
		if (downloaded !== release.bundle.size) return fail(`${release.bundle.name} byte length mismatch`);
		showProgress(true);
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (`sha256:${digest}` !== release.bundle.digest) return fail(`${release.bundle.name} sha256 mismatch`);
		const executable = readReleaseArchive(bytes, expectedEntryName(), release.bundle.name);
		const executableDigest = createHash("sha256").update(executable).digest("hex");
		if (
			executable.byteLength !== release.bundle.executable.size ||
			`sha256:${executableDigest}` !== release.bundle.executable.digest
		) {
			return fail(`${release.bundle.name} executable does not match the Release manifest`);
		}
		return executable;
	} finally {
		clearTimeout(inactivityTimeout);
		if (progressShown && !options.writeProgress && (options.isTTY ?? process.stdout.isTTY))
			process.stdout.write("\n");
	}
}

export async function runXzSelfUpdate(
	release: XzLatestRelease,
	currentVersion: string,
	_force = false,
	options: XzSelfUpdateOptions = {},
): Promise<void> {
	if (!RELEASE_TARGET) return fail("xz-dev Release target metadata is missing from this binary");
	parseDistributionVersion(currentVersion);
	const executablePath = options.executablePath ?? process.execPath;
	const executableDirectory = dirname(executablePath);
	const extension = process.platform === "win32" ? ".exe" : "";
	const backupName = `pi-${currentVersion}${extension}`;
	const candidateName = `pi-${release.version}${extension}`;
	const backupPath = join(executableDirectory, backupName);
	const reinstall = candidateName === backupName;
	// Reinstallation must not place verified bytes in the old executable's backup slot.
	const candidatePath = join(
		executableDirectory,
		reinstall ? `.${candidateName}.${process.pid}.candidate` : candidateName,
	);
	// Staging name carries the pid so two concurrent updates never share a
	// partially written download (design: no update mutex).
	const stagingPath = join(executableDirectory, `.${candidateName}.${process.pid}.download`);
	const rename = (source: string, destination: string): void =>
		renameSyncRetryable(source, destination, options.renameSync);

	// Validate paths before any bytes move: the current executable must be a
	// plain regular file we can rename, and neither the backup nor the
	// candidate name may be occupied by a directory or symlink.
	let executableStat: ReturnType<typeof lstatSync>;
	try {
		executableStat = lstatSync(executablePath);
	} catch (error: unknown) {
		return fail(
			`Pi executable at ${executablePath} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
		return fail(`Pi executable at ${executablePath} is not a regular file`);
	}
	for (const blocked of [backupPath, candidatePath]) {
		if (!existsSync(blocked)) continue;
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(blocked);
		} catch {
			continue;
		}
		if (!stat.isFile() || stat.isSymbolicLink()) {
			return fail(`Cannot replace ${basename(blocked)}: it is not a regular file`);
		}
	}

	try {
		const executable = await withReleaseMirrors(options, (base) =>
			downloadExecutable(release, currentVersion, options, base),
		);
		// Write exclusively only after verification; local failures must not trigger mirror retries.
		writeFileSync(stagingPath, executable, { flag: "wx", mode: 0o600 });
		rename(stagingPath, candidatePath);
	} catch (error) {
		try {
			unlinkSync(stagingPath);
		} catch {}
		throw error;
	}

	// Activation: move the running executable aside into its versioned backup
	// name, then move the verified candidate onto the entrypoint. Both renames
	// happen in the same directory so they are atomic on POSIX and move-tolerant
	// on Windows (a running binary can be renamed, just not unlinked).
	let backupMade = false;
	try {
		if (process.platform !== "win32") chmodSync(candidatePath, 0o755);
		rename(executablePath, backupPath);
		backupMade = true;
		rename(candidatePath, executablePath);
	} catch (error) {
		if (backupMade && !existsSync(executablePath) && existsSync(backupPath)) {
			// Second rename failed; restore the entrypoint so the install stays
			// bootable, then report the original failure.
			try {
				renameSyncRetryable(backupPath, executablePath);
			} catch {}
		}
		// Keep recovery bytes if rollback failed; otherwise discard the temporary reinstall candidate.
		if (reinstall && existsSync(executablePath)) {
			try {
				unlinkSync(candidatePath);
			} catch {}
		}
		throw error;
	}
}
