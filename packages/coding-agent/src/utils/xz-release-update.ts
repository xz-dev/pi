import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPiUserAgent } from "./pi-user-agent.ts";
import { XZ_RELEASE_BINARY_CONTRACT } from "./xz-release-targets.generated.ts";

const REPOSITORY = "xz-dev/pi";
const LATEST_MANIFEST_URL = `https://github.com/${REPOSITORY}/releases/latest/download/release-manifest.json`;
const RELEASE_DOWNLOAD_ORIGIN = "https://github.com";
const RELEASE_ASSET_CDN_HOST = "release-assets.githubusercontent.com";
const SHA256SUMS_FILE = "SHA256SUMS";
const INSTALL_SH_FILE = "install.sh";
const INSTALL_PS1_FILE = "install.ps1";
const ATTESTATION_SUBJECTS_FILE = "attestation-subjects.jsonl";
const ATTESTATION_SIGNER_WORKFLOW = `${REPOSITORY}/.github/workflows/publish-github-release.yml`;
const ATTESTATION_SIGNER_REF = "refs/heads/main";
const MANIFEST_MAX_BYTES = 1024 * 1024;
const SHA256SUMS_MAX_BYTES = 1024 * 1024;
const INSTALLER_MAX_BYTES = 1024 * 1024;
const BUNDLE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;

const BINARY_PLATFORMS = Object.freeze(XZ_RELEASE_BINARY_CONTRACT.targets.map((target) => target.platform));
const ARCHIVE_NAMES = Object.freeze(
	Object.fromEntries(XZ_RELEASE_BINARY_CONTRACT.targets.map((target) => [target.platform, target.archive])),
);
const REQUIRED_PATHS = Object.freeze(
	Object.fromEntries(XZ_RELEASE_BINARY_CONTRACT.targets.map((target) => [target.platform, target.requiredPaths])),
);
const MANIFEST_SCHEMA_VERSION = XZ_RELEASE_BINARY_CONTRACT.schemaVersion;

interface XzBundle {
	file: string;
	bytes: number;
	sha256: string;
}

export interface XzReleaseManifest {
	schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
	repository: typeof REPOSITORY;
	tag: string;
	distributionVersion: string;
	apiVersion: string;
	commit: string;
	packaging: "binary";
	layoutVersion: 1;
	bundles: Record<string, XzBundle>;
	requiredPaths: Record<string, readonly string[]>;
	installer: {
		posix: { file: typeof INSTALL_SH_FILE };
		windows: { file: typeof INSTALL_PS1_FILE };
		checksums: { file: typeof SHA256SUMS_FILE; algorithm: "sha256" };
	};
	attestation: {
		repository: typeof REPOSITORY;
		signerWorkflow: typeof ATTESTATION_SIGNER_WORKFLOW;
		signerRef: typeof ATTESTATION_SIGNER_REF;
		denySelfHostedRunners: true;
		subjectsFile: typeof ATTESTATION_SUBJECTS_FILE;
	};
}

export interface XzLatestRelease {
	version: string;
	manifest: XzReleaseManifest;
	manifestSha256: string;
	exactBaseUrl: string;
	installerName: typeof INSTALL_SH_FILE | typeof INSTALL_PS1_FILE;
	installerSha256: string;
	installerUrl: string;
}

interface XzReleaseOptions {
	timeoutMs?: number;
}

interface SpawnOptions {
	spawn?: typeof spawn;
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

function requireSafeAssetName(value: unknown, label: string): string {
	const name = requireString(value, label);
	if (name === "." || name === ".." || name.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) {
		return fail(`Invalid ${label}`);
	}
	return name;
}

function requirePositiveSize(value: unknown, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
		return fail(`Invalid ${label}`);
	}
	return value as number;
}

function requireSha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return fail(`Invalid ${label}`);
	return value;
}

function exactBaseUrl(tag: string): string {
	return `${RELEASE_DOWNLOAD_ORIGIN}/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/`;
}

function parseDistributionVersion(value: string): { api: string; run: number; attempt: number; commit: string } {
	const match = /^(\d+\.\d+\.\d+)-xz\.(\d+)\.(\d+)\.g([0-9a-f]{8})$/.exec(value);
	if (!match) return fail("Invalid xz-dev distribution version");
	return { api: match[1], run: Number(match[2]), attempt: Number(match[3]), commit: match[4] };
}

function parseManifest(value: unknown): XzReleaseManifest {
	if (!isRecord(value)) return fail("Invalid release manifest");
	const allowedKeys = new Set([
		"schemaVersion",
		"repository",
		"tag",
		"distributionVersion",
		"apiVersion",
		"commit",
		"packaging",
		"layoutVersion",
		"bundles",
		"requiredPaths",
		"installer",
		"attestation",
	]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) return fail("Invalid release manifest schema");
	if (
		value.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
		value.repository !== REPOSITORY ||
		value.packaging !== "binary" ||
		value.layoutVersion !== 1
	) {
		return fail("Invalid release manifest identity");
	}
	const version = requireSafeAssetName(value.distributionVersion, "distribution version");
	const parsedVersion = parseDistributionVersion(version);
	const apiVersion = requireString(value.apiVersion, "API version");
	if (apiVersion !== parsedVersion.api) return fail("Release API/version mismatch");
	const tag = requireSafeAssetName(value.tag, "release tag");
	if (tag !== `xz-v${version}`) return fail("Release tag/version mismatch");
	const commit = requireString(value.commit, "release commit");
	if (!/^[0-9a-f]{40}$/.test(commit)) return fail("Invalid release commit");
	if (!commit.startsWith(parsedVersion.commit)) return fail("Release commit/version mismatch");

	if (!isRecord(value.bundles) || Array.isArray(value.bundles))
		return fail("Manifest bundles must be a per-platform object");
	const bundles: Record<string, XzBundle> = {};
	const bundlePlatforms = Object.keys(value.bundles).sort();
	if (JSON.stringify(bundlePlatforms) !== JSON.stringify([...BINARY_PLATFORMS].sort())) {
		return fail("Manifest bundles must cover exactly the twelve canonical platforms");
	}
	for (const platform of BINARY_PLATFORMS) {
		const bundle = value.bundles[platform];
		if (!isRecord(bundle) || Object.keys(bundle).some((key) => !["file", "bytes", "sha256"].includes(key))) {
			return fail(`Invalid bundle metadata for ${platform}`);
		}
		const file = requireSafeAssetName(bundle.file, "bundle filename");
		const expectedName = ARCHIVE_NAMES[platform];
		if (file !== expectedName) return fail(`Invalid bundle metadata for ${platform}`);
		bundles[platform] = {
			file,
			bytes: requirePositiveSize(bundle.bytes, BUNDLE_MAX_BYTES, "bundle size"),
			sha256: requireSha256(bundle.sha256, "bundle sha256"),
		};
	}

	if (!isRecord(value.requiredPaths)) return fail("Manifest requiredPaths is required");
	if (JSON.stringify(Object.keys(value.requiredPaths).sort()) !== JSON.stringify([...BINARY_PLATFORMS].sort())) {
		return fail("Manifest requiredPaths must cover exactly the twelve canonical platforms");
	}
	const requiredPaths: Record<string, readonly string[]> = {};
	for (const platform of BINARY_PLATFORMS) {
		if (!Array.isArray(value.requiredPaths[platform]) || value.requiredPaths[platform].length === 0) {
			return fail(`Manifest requiredPaths missing for ${platform}`);
		}
		const paths = value.requiredPaths[platform];
		const expectedPaths = REQUIRED_PATHS[platform];
		if (JSON.stringify(paths) !== JSON.stringify(expectedPaths)) {
			return fail(`Manifest requiredPaths for ${platform} does not match canonical inventory`);
		}
		requiredPaths[platform] = expectedPaths;
	}

	if (
		!isRecord(value.installer) ||
		!isRecord(value.installer.posix) ||
		value.installer.posix.file !== INSTALL_SH_FILE ||
		Object.keys(value.installer.posix).length !== 1 ||
		!isRecord(value.installer.windows) ||
		value.installer.windows.file !== INSTALL_PS1_FILE ||
		Object.keys(value.installer.windows).length !== 1 ||
		!isRecord(value.installer.checksums) ||
		value.installer.checksums.file !== SHA256SUMS_FILE ||
		value.installer.checksums.algorithm !== "sha256" ||
		Object.keys(value.installer.checksums).length !== 2 ||
		Object.keys(value.installer).length !== 3
	) {
		return fail("Invalid installer metadata");
	}

	if (
		!isRecord(value.attestation) ||
		Object.keys(value.attestation).some(
			(key) => !["repository", "signerWorkflow", "signerRef", "denySelfHostedRunners", "subjectsFile"].includes(key),
		) ||
		value.attestation.repository !== REPOSITORY ||
		value.attestation.signerWorkflow !== ATTESTATION_SIGNER_WORKFLOW ||
		value.attestation.signerRef !== ATTESTATION_SIGNER_REF ||
		value.attestation.denySelfHostedRunners !== true ||
		value.attestation.subjectsFile !== ATTESTATION_SUBJECTS_FILE
	) {
		return fail("Invalid or missing release attestation policy");
	}
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		repository: REPOSITORY,
		tag,
		distributionVersion: version,
		apiVersion,
		commit,
		packaging: "binary",
		layoutVersion: 1,
		bundles,
		requiredPaths,
		installer: {
			posix: { file: INSTALL_SH_FILE },
			windows: { file: INSTALL_PS1_FILE },
			checksums: { file: SHA256SUMS_FILE, algorithm: "sha256" },
		},
		attestation: {
			repository: REPOSITORY,
			signerWorkflow: ATTESTATION_SIGNER_WORKFLOW,
			signerRef: ATTESTATION_SIGNER_REF,
			denySelfHostedRunners: true,
			subjectsFile: ATTESTATION_SUBJECTS_FILE,
		},
	};
}

function fetchHeaders(currentVersion: string, accept: string): Record<string, string> {
	return {
		"User-Agent": getPiUserAgent(currentVersion),
		accept,
	};
}

async function fetchResponse(
	url: URL | string,
	currentVersion: string,
	timeoutMs: number,
	accept: string,
): Promise<Response> {
	const response = await fetch(new URL(url).href, {
		headers: fetchHeaders(currentVersion, accept),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (response.redirected) {
		const destination = new URL(response.url);
		if (destination.protocol !== "https:" || destination.hostname !== RELEASE_ASSET_CDN_HOST) {
			return fail("GitHub Release asset redirected outside the trusted GitHub asset CDN");
		}
	}
	if (!response.ok) {
		return fail(`GitHub Release request failed: HTTP ${response.status}`);
	}
	return response;
}

async function readBoundedResponse(response: Response, maximumBytes: number, label: string): Promise<Uint8Array> {
	const contentLength = response.headers.get("content-length");
	if (contentLength) {
		const parsed = Number(contentLength);
		if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes)
			return fail(`${label} exceeds the allowed size`);
	}
	if (!response.body) return fail(`${label} returned no body`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		total += next.value.byteLength;
		if (total > maximumBytes) {
			await reader.cancel();
			return fail(`${label} exceeds the allowed size`);
		}
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

/** Exact installer asset name for the host platform (POSIX vs PowerShell). */
function hostInstallerName(): typeof INSTALL_SH_FILE | typeof INSTALL_PS1_FILE {
	return process.platform === "win32" ? INSTALL_PS1_FILE : INSTALL_SH_FILE;
}

function parseSha256Sums(text: string): Map<string, string> {
	const entries = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
		if (!match) return fail("Invalid SHA256SUMS entry");
		if (entries.has(match[2])) return fail(`Duplicate SHA256SUMS entry: ${match[2]}`);
		entries.set(match[2], match[1]);
	}
	if (entries.size === 0) return fail("Empty SHA256SUMS");
	return entries;
}

export async function getLatestXzRelease(
	currentVersion: string,
	options: XzReleaseOptions = {},
): Promise<XzLatestRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;
	if (!/^\d+\.\d+\.\d+-xz\.\d+\.\d+\.g[0-9a-f]{8}$/.test(currentVersion)) {
		return fail("xz-dev Release update requires an installed xz-dev distribution version");
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// Prefer the public latest release-manifest.json asset to avoid the GitHub
	// REST API rate-limit dependence entirely. The manifest pins the exact tag,
	// commit, and download base URL; a redirect is only trusted to GitHub's CDN.
	const manifestResponse = await fetchResponse(LATEST_MANIFEST_URL, currentVersion, timeoutMs, "application/json");
	const manifestBytes = await readBoundedResponse(manifestResponse, MANIFEST_MAX_BYTES, "release manifest");
	let manifestValue: unknown;
	try {
		manifestValue = JSON.parse(new TextDecoder().decode(manifestBytes));
	} catch {
		return fail("Invalid release manifest JSON");
	}
	const manifest = parseManifest(manifestValue);
	const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");

	const exactBase = exactBaseUrl(manifest.tag);
	const sumsResponse = await fetchResponse(`${exactBase}${SHA256SUMS_FILE}`, currentVersion, timeoutMs, "text/plain");
	const sumsBytes = await readBoundedResponse(sumsResponse, SHA256SUMS_MAX_BYTES, "SHA256SUMS");
	const sums = parseSha256Sums(new TextDecoder().decode(sumsBytes));
	const expectedChecksums = [
		...Object.values(manifest.bundles).map((bundle) => bundle.file),
		"release-manifest.json",
		INSTALL_SH_FILE,
		INSTALL_PS1_FILE,
	].sort();
	if (JSON.stringify([...sums.keys()].sort()) !== JSON.stringify(expectedChecksums)) {
		return fail("SHA256SUMS does not contain the exact canonical release asset inventory");
	}
	if (sums.get("release-manifest.json") !== manifestSha256) {
		return fail("release-manifest.json sha256 mismatch in exact-tag SHA256SUMS");
	}

	const installerName = hostInstallerName();
	const installerSha256 = sums.get(installerName);
	if (!installerSha256) return fail(`${installerName} is missing from SHA256SUMS`);
	const installerUrl = new URL(installerName, exactBase);
	if (installerUrl.pathname !== `${new URL(exactBase).pathname}${encodeURIComponent(installerName)}`) {
		return fail(`${installerName} URL is not exact-tag pinned`);
	}

	return {
		version: manifest.distributionVersion,
		manifest,
		manifestSha256,
		exactBaseUrl: exactBase,
		installerName,
		installerSha256,
		installerUrl: installerUrl.href,
	};
}

async function downloadInstaller(release: XzLatestRelease, currentVersion: string, destination: string): Promise<void> {
	const expectedName = hostInstallerName();
	const expectedBase = exactBaseUrl(release.manifest.tag);
	const expectedUrl = `${expectedBase}${expectedName}`;
	if (
		release.manifest.repository !== REPOSITORY ||
		release.exactBaseUrl !== expectedBase ||
		release.installerName !== expectedName ||
		release.installerUrl !== expectedUrl
	) {
		return fail("Release installer URL is not the exact xz-dev tag asset");
	}
	const response = await fetchResponse(expectedUrl, currentVersion, DEFAULT_TIMEOUT_MS, "application/octet-stream");
	const bytes = await readBoundedResponse(response, INSTALLER_MAX_BYTES, release.installerName);
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== release.installerSha256) return fail(`${release.installerName} sha256 mismatch`);
	const descriptor = openSync(destination, "wx", 0o600);
	try {
		writeSync(descriptor, bytes);
	} finally {
		closeSync(descriptor);
	}
}

export async function runXzSelfUpdate(
	release: XzLatestRelease,
	currentVersion: string,
	force = false,
	options: SpawnOptions = {},
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "pi-xz-self-update-"));
	const installer = join(directory, release.installerName);
	try {
		await downloadInstaller(release, currentVersion, installer);
		const spawnRuntime = options.spawn ?? spawn;
		// Invoke the exact platform installer (install.sh / install.ps1) with the
		// internal update flag. The native installer re-verifies its pinned manifest
		// and bundle, validates provenance, stages the binary, and activates it.
		const command = release.installerName === INSTALL_PS1_FILE ? "powershell" : "sh";
		const installerArgs = ["--update", ...(force ? ["--force"] : [])];
		const args =
			release.installerName === INSTALL_PS1_FILE
				? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer, ...installerArgs]
				: [installer, ...installerArgs];
		await new Promise<void>((resolve, reject) => {
			const child = spawnRuntime(command, args, {
				env: {
					...process.env,
					PI_XZ_RELEASE_BASE_URL: release.exactBaseUrl,
					PI_XZ_RELEASE_EXACT_BASE_URL: release.exactBaseUrl,
					PI_XZ_RELEASE_MANIFEST_SHA256: release.manifestSha256,
				},
				shell: false,
				stdio: "inherit",
			});
			child.once("error", reject);
			child.once("close", (code, signal) => {
				if (code === 0) resolve();
				else if (signal) reject(new Error(`${release.installerName} terminated by signal ${signal}`));
				else reject(new Error(`${release.installerName} exited with code ${code ?? "unknown"}`));
			});
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
