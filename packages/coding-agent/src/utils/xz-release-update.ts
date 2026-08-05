import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { satisfies } from "semver";
import { getPiUserAgent } from "./pi-user-agent.ts";

const REPOSITORY = "xz-dev/pi";
const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_DOWNLOAD_ORIGIN = "https://github.com";
const MANIFEST_FILE = "release-manifest.json";
const MANIFEST_MAX_BYTES = 1024 * 1024;
const INSTALLER_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const ATTESTATION_SIGNER_WORKFLOW = `${REPOSITORY}/.github/workflows/publish-github-release.yml`;
const ATTESTATION_SIGNER_REF = "refs/heads/main";

interface GitHubReleaseAsset {
	name: string;
	browser_download_url: string;
}

interface GitHubLatestRelease {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	assets: GitHubReleaseAsset[];
}

export interface XzReleaseManifest {
	schemaVersion: 1;
	repository: typeof REPOSITORY;
	tag: string;
	distributionVersion: string;
	apiVersion: string;
	commit: string;
	minimumNodeVersion: string;
	package: {
		name: typeof PACKAGE_NAME;
		file: string;
		bytes: number;
		sha256: string;
		integrity: string;
		bundled: true;
		packaging: "hybrid";
		networkPolicy: "external-optional-only";
		externalOptionalDependencies: Record<string, string>;
		allowedNetworkPackages: string[];
		allowedNetworkPackagePrefixes: string[];
	};
	installer: {
		file: "install.ts";
		bytes: number;
		sha256: string;
	};
	attestation: {
		repository: typeof REPOSITORY;
		signerWorkflow: typeof ATTESTATION_SIGNER_WORKFLOW;
		signerRef: typeof ATTESTATION_SIGNER_REF;
		denySelfHostedRunners: true;
		subjectsFile: "attestation-subjects.txt";
	};
	bootstrap: {
		tag: string;
		baseUrl: string;
		minimumNodeVersion: string;
		files: { sh: "install.sh"; ps1: "install.ps1" };
	};
}

export interface XzLatestRelease {
	version: string;
	manifest: XzReleaseManifest;
	manifestSha256: string;
	discoveryBaseUrl: string;
	exactBaseUrl: string;
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

function requireReleaseUrl(value: unknown, label: string): URL {
	const raw = requireString(value, label);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return fail(`Invalid ${label}`);
	}
	if (
		url.protocol !== "https:" ||
		url.origin !== RELEASE_DOWNLOAD_ORIGIN ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		return fail(`Invalid ${label}`);
	}
	return url;
}

function parseLatestRelease(value: unknown): GitHubLatestRelease {
	if (!isRecord(value)) return fail("Invalid GitHub latest Release response");
	const tagName = requireSafeAssetName(value.tag_name, "GitHub Release tag");
	if (value.draft !== false || value.prerelease !== false) {
		return fail("Latest GitHub Release must be published and non-prerelease");
	}
	if (!Array.isArray(value.assets)) return fail("Latest GitHub Release has no assets");
	const assetNames = new Set<string>();
	const assets: GitHubReleaseAsset[] = value.assets.map((asset) => {
		if (!isRecord(asset)) return fail("Invalid GitHub Release asset");
		const name = requireSafeAssetName(asset.name, "GitHub Release asset name");
		if (assetNames.has(name)) return fail(`Duplicate GitHub Release asset: ${name}`);
		assetNames.add(name);
		return {
			name,
			browser_download_url: requireReleaseUrl(asset.browser_download_url, "GitHub Release asset URL").href,
		};
	});
	return { tag_name: tagName, draft: false, prerelease: false, assets };
}

function requireExactAssetUrl(url: URL, tag: string, file: string): URL {
	const expectedPath = `/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`;
	if (url.pathname !== expectedPath) return fail(`${file} URL is not exact-tag pinned`);
	return url;
}

function parseManifest(value: unknown, expectedTag: string): XzReleaseManifest {
	if (!isRecord(value)) return fail("Invalid release manifest");
	const allowedKeys = new Set([
		"schemaVersion",
		"repository",
		"tag",
		"distributionVersion",
		"apiVersion",
		"commit",
		"minimumNodeVersion",
		"package",
		"installer",
		"attestation",
		"bootstrap",
	]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) return fail("Invalid release manifest schema");
	if (value.schemaVersion !== 1 || value.repository !== REPOSITORY) return fail("Invalid release manifest identity");
	const tag = requireSafeAssetName(value.tag, "release tag");
	const version = requireSafeAssetName(value.distributionVersion, "distribution version");
	const versionMatch = /^(\d+\.\d+\.\d+)-xz\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.g([0-9a-f]{8})$/.exec(version);
	if (!versionMatch) return fail("Invalid xz-dev distribution version");
	if (tag !== expectedTag || tag !== `xz-v${version}`) return fail("Release tag/version mismatch");
	const apiVersion = requireString(value.apiVersion, "API version");
	if (apiVersion !== versionMatch[1]) return fail("Release API/version mismatch");
	const commit = requireString(value.commit, "release commit");
	const commitPrefix = versionMatch[4];
	if (!commitPrefix || !commit.startsWith(commitPrefix)) return fail("Release commit/version mismatch");
	if (!/^[0-9a-f]{40}$/.test(commit)) return fail("Invalid release commit");
	const minimumNodeVersion = requireString(value.minimumNodeVersion, "minimum Node version");
	if (!/^\d+\.\d+\.\d+$/.test(minimumNodeVersion)) return fail("Invalid minimum Node version");
	if (!satisfies(process.versions.node, `>=${minimumNodeVersion}`)) {
		return fail(`This Release requires Node-compatible runtime ${minimumNodeVersion} or newer`);
	}

	if (!isRecord(value.package)) return fail("Invalid canonical package metadata");
	const packageFile = requireSafeAssetName(value.package.file, "package filename");
	if (
		value.package.name !== PACKAGE_NAME ||
		value.package.bundled !== true ||
		value.package.packaging !== "hybrid" ||
		value.package.networkPolicy !== "external-optional-only" ||
		!packageFile.endsWith(".tgz")
	) {
		return fail("Invalid canonical package metadata");
	}
	if (
		!isRecord(value.package.externalOptionalDependencies) ||
		!Array.isArray(value.package.allowedNetworkPackages) ||
		!value.package.allowedNetworkPackages.every(
			(name) => typeof name === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name),
		) ||
		!Array.isArray(value.package.allowedNetworkPackagePrefixes) ||
		!value.package.allowedNetworkPackagePrefixes.every((prefix) => typeof prefix === "string") ||
		JSON.stringify(Object.keys(value.package.externalOptionalDependencies).sort()) !==
			JSON.stringify([...value.package.allowedNetworkPackages].sort()) ||
		new Set(value.package.allowedNetworkPackages).size !== value.package.allowedNetworkPackages.length ||
		JSON.stringify([...value.package.allowedNetworkPackagePrefixes].sort()) !==
			JSON.stringify(value.package.allowedNetworkPackages.map((name) => `${name}-`).sort())
	)
		return fail("Invalid external optional dependency policy");
	const externalOptionalDependencies = Object.fromEntries(
		Object.entries(value.package.externalOptionalDependencies).map(([name, version]) => {
			const specifier = requireString(version, "external optional dependency version");
			if (
				specifier.startsWith("file:") ||
				specifier.startsWith("link:") ||
				specifier.startsWith("workspace:") ||
				specifier.startsWith("git+") ||
				specifier.startsWith("github:") ||
				specifier.includes("npm.pkg.github.com") ||
				specifier.includes("@xz-dev/")
			)
				return fail("Invalid external optional dependency version");
			return [requireString(name, "external optional dependency name"), specifier];
		}),
	);
	const packageBytes = requirePositiveSize(value.package.bytes, 1024 * 1024 * 1024, "package size");
	const packageSha256 = requireSha256(value.package.sha256, "package sha256");
	const packageIntegrity = requireString(value.package.integrity, "package integrity");
	if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(packageIntegrity)) return fail("Invalid package integrity");

	const expectedPackageFile = `earendil-works-pi-coding-agent-${version}.tgz`;
	if (packageFile !== expectedPackageFile) return fail("Release package/version mismatch");

	if (!isRecord(value.installer)) return fail("Invalid installer metadata");
	if (value.installer.file !== "install.ts") return fail("Invalid installer filename");
	const installerBytes = requirePositiveSize(value.installer.bytes, INSTALLER_MAX_BYTES, "installer size");
	const installerSha256 = requireSha256(value.installer.sha256, "installer sha256");

	if (
		!isRecord(value.attestation) ||
		value.attestation.repository !== REPOSITORY ||
		value.attestation.signerWorkflow !== ATTESTATION_SIGNER_WORKFLOW ||
		value.attestation.signerRef !== ATTESTATION_SIGNER_REF ||
		value.attestation.denySelfHostedRunners !== true ||
		value.attestation.subjectsFile !== "attestation-subjects.txt"
	) {
		return fail("Invalid or missing release attestation policy");
	}
	if (
		!isRecord(value.bootstrap) ||
		value.bootstrap.tag !== tag ||
		value.bootstrap.baseUrl !== exactBaseUrl(tag) ||
		value.bootstrap.minimumNodeVersion !== minimumNodeVersion ||
		!isRecord(value.bootstrap.files) ||
		value.bootstrap.files.sh !== "install.sh" ||
		value.bootstrap.files.ps1 !== "install.ps1"
	) {
		return fail("Invalid bootstrap metadata");
	}

	return {
		schemaVersion: 1,
		repository: REPOSITORY,
		tag,
		distributionVersion: version,
		apiVersion,
		commit,
		minimumNodeVersion,
		package: {
			name: PACKAGE_NAME,
			file: packageFile,
			bytes: packageBytes,
			sha256: packageSha256,
			integrity: packageIntegrity,
			bundled: true,
			packaging: "hybrid",
			networkPolicy: "external-optional-only",
			externalOptionalDependencies,
			allowedNetworkPackages: [...value.package.allowedNetworkPackages] as string[],
			allowedNetworkPackagePrefixes: [...value.package.allowedNetworkPackagePrefixes] as string[],
		},
		installer: { file: "install.ts", bytes: installerBytes, sha256: installerSha256 },
		attestation: {
			repository: REPOSITORY,
			signerWorkflow: ATTESTATION_SIGNER_WORKFLOW,
			signerRef: ATTESTATION_SIGNER_REF,
			denySelfHostedRunners: true,
			subjectsFile: "attestation-subjects.txt",
		},
		bootstrap: {
			tag,
			baseUrl: exactBaseUrl(tag),
			minimumNodeVersion,
			files: { sh: "install.sh", ps1: "install.ps1" },
		},
	};
}

function githubToken(): string | undefined {
	const configured = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
	if (configured) return configured;
	try {
		return (
			execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
				encoding: "utf8",
				shell: false,
				stdio: ["ignore", "pipe", "ignore"],
				timeout: DEFAULT_TIMEOUT_MS,
			}).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

function fetchHeaders(currentVersion: string, accept: string, includeAuthorization: boolean): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": getPiUserAgent(currentVersion),
		accept,
	};
	if (includeAuthorization) {
		const token = githubToken();
		if (token) headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

async function fetchResponse(
	url: URL | string,
	currentVersion: string,
	timeoutMs: number,
	accept: string,
): Promise<Response> {
	const requested = new URL(url);
	const response = await fetch(requested.href, {
		headers: fetchHeaders(currentVersion, accept, requested.origin === "https://api.github.com"),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (requested.origin !== "https://api.github.com" && response.redirected) {
		const destination = new URL(response.url);
		if (destination.protocol !== "https:" || destination.hostname !== "release-assets.githubusercontent.com") {
			return fail("GitHub Release asset redirected outside the trusted GitHub asset CDN");
		}
	}
	if (!response.ok) {
		const rateLimit = response.status === 403 || response.status === 429;
		const detail = rateLimit ? " (GitHub API rate limit may have been exceeded; retry later)" : "";
		return fail(`GitHub Release request failed: HTTP ${response.status}${detail}`);
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

function exactBaseUrl(tag: string): string {
	return `${RELEASE_DOWNLOAD_ORIGIN}/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/`;
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
	const releaseResponse = await fetchResponse(
		LATEST_RELEASE_URL,
		currentVersion,
		timeoutMs,
		"application/vnd.github+json",
	);
	const release = parseLatestRelease(await releaseResponse.json());
	const manifestAsset = release.assets.find((asset) => asset.name === MANIFEST_FILE);
	if (!manifestAsset) return fail("Latest GitHub Release is missing release-manifest.json");
	const manifestUrl = requireExactAssetUrl(
		new URL(manifestAsset.browser_download_url),
		release.tag_name,
		MANIFEST_FILE,
	);
	const manifestResponse = await fetchResponse(manifestUrl, currentVersion, timeoutMs, "application/json");
	const manifestBytes = await readBoundedResponse(manifestResponse, MANIFEST_MAX_BYTES, "release manifest");
	let manifestValue: unknown;
	try {
		manifestValue = JSON.parse(new TextDecoder().decode(manifestBytes));
	} catch {
		return fail("Invalid release manifest JSON");
	}
	const manifest = parseManifest(manifestValue, release.tag_name);
	const expectedAssets = [
		manifest.package.file,
		MANIFEST_FILE,
		manifest.installer.file,
		"install.sh",
		"install.ps1",
		"SHA256SUMS",
		manifest.attestation.subjectsFile,
	].sort();
	const actualAssets = release.assets.map((asset) => asset.name).sort();
	if (JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)) {
		return fail("Latest GitHub Release does not contain the exact canonical asset inventory");
	}
	for (const asset of release.assets) {
		requireExactAssetUrl(new URL(asset.browser_download_url), manifest.tag, asset.name);
	}
	const installerAsset = release.assets.find((asset) => asset.name === manifest.installer.file)!;
	const installerUrl = requireExactAssetUrl(
		new URL(installerAsset.browser_download_url),
		manifest.tag,
		manifest.installer.file,
	);
	return {
		version: manifest.distributionVersion,
		manifest,
		manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
		discoveryBaseUrl: exactBaseUrl(manifest.tag),
		exactBaseUrl: exactBaseUrl(manifest.tag),
		installerUrl: installerUrl.href,
	};
}

async function downloadInstaller(release: XzLatestRelease, currentVersion: string, destination: string): Promise<void> {
	const installerUrl = requireExactAssetUrl(
		new URL(release.installerUrl),
		release.manifest.tag,
		release.manifest.installer.file,
	);
	const response = await fetchResponse(installerUrl, currentVersion, DEFAULT_TIMEOUT_MS, "application/octet-stream");
	const bytes = await readBoundedResponse(response, release.manifest.installer.bytes, "install.ts");
	if (bytes.byteLength !== release.manifest.installer.bytes) return fail("install.ts has an invalid size");
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== release.manifest.installer.sha256) return fail("install.ts sha256 mismatch");
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
	options: SpawnOptions = {},
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "pi-xz-self-update-"));
	const installer = join(directory, "install.ts");
	try {
		await downloadInstaller(release, currentVersion, installer);
		const spawnRuntime = options.spawn ?? spawn;
		await new Promise<void>((resolve, reject) => {
			const child = spawnRuntime(process.execPath, [installer, "--update"], {
				env: {
					...process.env,
					PI_XZ_RELEASE_BASE_URL: release.discoveryBaseUrl,
					PI_XZ_RELEASE_EXACT_BASE_URL: release.exactBaseUrl,
					PI_XZ_RELEASE_MANIFEST_SHA256: release.manifestSha256,
				},
				shell: false,
				stdio: "inherit",
			});
			child.once("error", reject);
			child.once("close", (code, signal) => {
				if (code === 0) resolve();
				else if (signal) reject(new Error(`install.ts terminated by signal ${signal}`));
				else reject(new Error(`install.ts exited with code ${code ?? "unknown"}`));
			});
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
