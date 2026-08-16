import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { RELEASE_TARGET } from "../config.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";
import { extractZipArchive } from "./tools-manager.ts";

const REPOSITORY = "xz-dev/pi";
const RELEASE_DOWNLOAD_ORIGIN = "https://github.com";
const RELEASE_MAX_BYTES = 1024 * 1024;
const MANIFEST_SCHEMA_VERSION = 5;
const BUNDLE_LAYOUT_VERSION = 2;
const MANIFEST_FILENAME = "release-manifest.json";
const SUMS_FILENAME = "SHA256SUMS";
const BUNDLE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const BUNDLE_INACTIVITY_TIMEOUT_MS = 30000;
const DOWNLOAD_PROGRESS_INTERVAL_MS = 1000;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_DIRECTORY_TYPE = 0x4000;
const ZIP_REGULAR_TYPE = 0x8000;

interface GitHubReleaseAsset {
	name: string;
	browser_download_url: string;
	size: number;
	digest: string;
}

export interface XzLatestRelease {
	version: string;
	tag: string;
	commit: string;
	bundle: GitHubReleaseAsset;
	exactBaseUrl: string;
}

interface XzReleaseOptions {
	timeoutMs?: number;
	retry?: boolean;
}

class RetryableDiscoveryError {
	readonly error: unknown;

	constructor(error: unknown) {
		this.error = error;
	}
}

interface XzSelfUpdateOptions {
	executablePath?: string;
	inactivityTimeoutMs?: number;
	now?: () => number;
	writeProgress?: (message: string) => void;
	isTTY?: boolean;
}

export function cleanXzBundles(executablePath = process.execPath): number {
	const executableDirectory = dirname(executablePath);
	const parentDirectory = dirname(executableDirectory);
	const installRoot = basename(parentDirectory) === "bundles" ? dirname(parentDirectory) : executableDirectory;
	const bundlesRoot = join(installRoot, "bundles");
	const currentVersion = readFileSync(join(installRoot, "current"), "utf8").trim();
	let removed = 0;

	for (const entry of readdirSync(bundlesRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === currentVersion || entry.name.startsWith(".update-")) continue;
		rmSync(join(bundlesRoot, entry.name), { recursive: true, force: true });
		removed++;
	}
	rmSync(join(installRoot, "previous"), { force: true });
	return removed;
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

function validateZipEntries(archivePath: string): void {
	const archive = readFileSync(archivePath);
	const tailLength = Math.min(archive.length, 22 + 65535);
	const tailStart = archive.length - tailLength;
	let endOffset = -1;
	for (let offset = archive.length - 22; offset >= tailStart; offset--) {
		if (archive.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
			endOffset = offset;
			break;
		}
	}
	if (endOffset < 0) fail("Release bundle ZIP is missing its central directory");
	const entryCount = archive.readUInt16LE(endOffset + 10);
	const directorySize = archive.readUInt32LE(endOffset + 12);
	const directoryOffset = archive.readUInt32LE(endOffset + 16);
	const directoryEnd = directoryOffset + directorySize;
	if (directoryEnd > archive.length) fail("Release bundle ZIP central directory is truncated");
	let offset = directoryOffset;
	const names = new Set<string>();
	for (let index = 0; index < entryCount; index++) {
		if (offset + 46 > directoryEnd || archive.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
			fail("Release bundle ZIP central directory is invalid");
		}
		const nameLength = archive.readUInt16LE(offset + 28);
		const extraLength = archive.readUInt16LE(offset + 30);
		const commentLength = archive.readUInt16LE(offset + 32);
		const nameEnd = offset + 46 + nameLength;
		if (nameEnd > directoryEnd) fail("Release bundle ZIP entry is truncated");
		const name = archive
			.subarray(offset + 46, nameEnd)
			.toString("utf8")
			.replaceAll("\\", "/");
		const type = (archive.readUInt32LE(offset + 38) >>> 16) & 0xf000;
		if (
			!name ||
			name.includes("\0") ||
			/^(?:[A-Za-z]:)?\//.test(name) ||
			name.split("/").some((segment) => segment === "..") ||
			(type !== ZIP_REGULAR_TYPE && type !== ZIP_DIRECTORY_TYPE) ||
			names.has(name)
		) {
			fail(`Unsafe Release bundle ZIP entry ${JSON.stringify(name)}`);
		}
		names.add(name);
		offset = nameEnd + extraLength + commentLength;
	}
	if (offset !== directoryEnd) fail("Release bundle ZIP central directory size mismatch");
}

function parseLatestRelease(value: unknown): XzLatestRelease {
	if (!isRecord(value)) return fail("Invalid xz-dev Release manifest");
	if (
		value.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
		value.repository !== REPOSITORY ||
		value.packaging !== "binary" ||
		value.layoutVersion !== BUNDLE_LAYOUT_VERSION
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
	if (!isRecord(bundle) || bundle.file !== expectedFile) return fail(`Invalid ${expectedFile} bundle metadata`);
	const exactBase = exactBaseUrl(tag);
	return {
		version,
		tag,
		commit,
		exactBaseUrl: exactBase,
		bundle: {
			name: expectedFile,
			browser_download_url: `${exactBase}${expectedFile}`,
			size: requirePositiveSize(bundle.bytes, BUNDLE_MAX_BYTES, "bundle size"),
			digest: requireSha256Digest(`sha256:${requireString(bundle.sha256, "bundle digest")}`, "bundle digest"),
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
		response = await fetch(new URL(url).href, {
			headers: fetchHeaders(currentVersion, accept),
			signal: typeof timeout === "number" ? AbortSignal.timeout(timeout) : timeout,
		});
	} catch (error) {
		if (classifyRetryable) throw new RetryableDiscoveryError(error);
		throw error;
	}
	if (!response.ok) {
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

async function discoverLatestXzRelease(currentVersion: string, timeoutMs: number): Promise<XzLatestRelease> {
	const latestBase = releaseBaseUrl("latest");
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
	return parseLatestRelease(value);
}

export async function getLatestXzRelease(
	currentVersion: string,
	options: XzReleaseOptions = {},
): Promise<XzLatestRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;
	parseDistributionVersion(currentVersion);
	const attempts = options.retry ? 3 : 1;
	for (let attempt = 0; ; attempt++) {
		try {
			return await discoverLatestXzRelease(currentVersion, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		} catch (error) {
			if (!(error instanceof RetryableDiscoveryError) || attempt + 1 >= attempts) {
				throw error instanceof RetryableDiscoveryError ? error.error : error;
			}
		}
	}
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

async function downloadBundle(
	release: XzLatestRelease,
	currentVersion: string,
	destination: string,
	options: XzSelfUpdateOptions,
): Promise<void> {
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
	const inactivityTimeoutMs = options.inactivityTimeoutMs ?? BUNDLE_INACTIVITY_TIMEOUT_MS;
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
		const response = await fetchResponse(expectedUrl, currentVersion, controller.signal, "application/octet-stream");
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
		writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
		validateZipEntries(destination);
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
	const target = RELEASE_TARGET;
	const executableDirectory = dirname(options.executablePath ?? process.execPath);
	const parentDirectory = dirname(executableDirectory);
	const installRoot = basename(parentDirectory) === "bundles" ? dirname(parentDirectory) : executableDirectory;
	const bundlesRoot = join(installRoot, "bundles");
	const destination = join(bundlesRoot, release.version);
	const wrapperName = process.platform === "win32" ? "pi.exe" : "pi";
	const executableName = process.platform === "win32" ? "pi-native.exe" : "pi-native";
	const currentPath = join(installRoot, "current");
	const previousVersion = existsSync(currentPath) ? readFileSync(currentPath, "utf8").trim() : currentVersion;
	const directory = mkdtempSync(join(tmpdir(), "pi-xz-self-update-"));
	const archive = join(directory, release.bundle.name);
	mkdirSync(bundlesRoot, { recursive: true });
	const staging = mkdtempSync(join(bundlesRoot, ".update-"));
	const validateBundle = (bundleDirectory: string): void => {
		for (const required of [wrapperName, executableName, "package.json"]) {
			if (!existsSync(join(bundleDirectory, required))) fail(`Release bundle is missing required path ${required}`);
		}
		let pkg: {
			name?: string;
			version?: string;
			piConfig?: { distribution?: string; releaseTarget?: string };
		};
		try {
			pkg = JSON.parse(readFileSync(join(bundleDirectory, "package.json"), "utf8"));
		} catch {
			fail("Release bundle package.json is invalid");
		}
		if (
			pkg.name !== "@earendil-works/pi-coding-agent" ||
			pkg.version !== release.version ||
			pkg.piConfig?.distribution !== "xz-dev" ||
			pkg.piConfig.releaseTarget !== target
		) {
			fail("Release bundle package identity mismatch");
		}
	};
	try {
		await downloadBundle(release, currentVersion, archive, options);
		extractZipArchive(archive, staging, release.bundle.name);
		validateBundle(staging);
		if (!existsSync(destination)) renameSync(staging, destination);
		validateBundle(destination);

		if (process.platform !== "win32") {
			const nextWrapper = join(installRoot, `.${wrapperName}.next-${process.pid}`);
			copyFileSync(join(destination, wrapperName), nextWrapper);
			chmodSync(nextWrapper, 0o755);
			chmodSync(join(destination, executableName), 0o755);
			renameSync(nextWrapper, join(installRoot, wrapperName));
		}
		if (previousVersion && previousVersion !== release.version) {
			const nextPrevious = join(installRoot, `.previous.next-${process.pid}`);
			writeFileSync(nextPrevious, `${previousVersion}\n`, { flag: "wx" });
			renameSync(nextPrevious, join(installRoot, "previous"));
		}
		const nextCurrent = join(installRoot, `.current.next-${process.pid}`);
		writeFileSync(nextCurrent, `${release.version}\n`, { flag: "wx" });
		renameSync(nextCurrent, currentPath);
	} finally {
		rmSync(directory, { recursive: true, force: true });
		rmSync(staging, { recursive: true, force: true });
	}
}
