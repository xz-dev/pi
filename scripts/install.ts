#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ENTRY_PACKAGE = "@earendil-works/pi-coding-agent";
const LEGACY_PACKAGE = "@xz-dev/pi-coding-agent";
const REPOSITORY = "xz-dev/pi";
const MANIFEST_MAX_BYTES = 1024 * 1024;
const PACKAGE_MAX_BYTES = 1024 * 1024 * 1024;

type Manifest = {
	schemaVersion: 1;
	repository: string;
	tag: string;
	distributionVersion: string;
	apiVersion: string;
	commit: string;
	minimumNodeVersion: string;
	package: {
		name: string;
		file: string;
		bytes: number;
		sha256: string;
		integrity: string;
		bundled: boolean;
		packaging: string;
		networkPolicy: string;
		externalOptionalDependencies: Record<string, string>;
		allowedNetworkPackages: string[];
		allowedNetworkPackagePrefixes: string[];
	};
	installer: { file: string; bytes: number; sha256: string };
	attestation: { repository: string; signerWorkflow: string; signerRef: string; denySelfHostedRunners: boolean; subjectsFile: string };
	bootstrap: { tag: string; baseUrl: string; minimumNodeVersion: string; files: { sh: string; ps1: string } };
};

type Receipt = Manifest;
type InstallMetadata = {
	schemaVersion: 1;
	name: string;
	version: string;
	treeSha256: string;
};

type Options = {
	mode: "install" | "migrate" | "update" | "rollback";
	rollbackVersion?: string;
};

type DistributionVersion = {
	api: number[];
	run: number;
	attempt: number;
	commit: string;
};

type Replacement = { target: string; backup?: string; temporary: string };
type Transaction = {
	replacements: Replacement[];
	createdFinalRoot?: string;
	stagingRoot?: string;
	legacyBackup?: LegacyBackup;
	committed?: boolean;
};
type StoredTransaction = {
	schemaVersion: 1;
	replacements: Replacement[];
	createdFinalRoot?: string;
	stagingRoot?: string;
	legacyBackup?: LegacyBackup;
	committed?: boolean;
};
type LegacyInstallation = { packagePath: string; shimPaths: string[] };
type LegacyBackup = {
	packagePath: string;
	packageBackup: string;
	shimBackups: Array<{ path: string; backup: string }>;
};

function fail(message: string): never {
	throw new Error(message);
}

function parseArgs(args: string[]): Options {
	if (args.length === 0) return { mode: "install" };
	if (args.length === 1 && args[0] === "--migrate") return { mode: "migrate" };
	if (args.length === 1 && args[0] === "--update") return { mode: "update" };
	if (args.length === 2 && args[0] === "--rollback" && args[1]) {
		return { mode: "rollback", rollbackVersion: args[1] };
	}
	return fail("Usage: install.ts [--migrate | --update | --rollback <version>]");
}

const selectedPlatform =
	process.env.PI_XZ_TEST_PLATFORM === "win32" &&
	process.env.PI_XZ_RELEASE_BASE_URL?.startsWith("http://127.0.0.1:") &&
	!process.env.CI
		? "win32"
		: platform();

function defaultRoot(): string {
	if (selectedPlatform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (!localAppData) return fail("LOCALAPPDATA is required on Windows");
		return join(localAppData, "pi-xz");
	}
	return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "pi-xz");
}

function defaultBin(): string {
	if (selectedPlatform === "win32") return join(defaultRoot(), "bin");
	return process.env.XDG_BIN_HOME ?? join(homedir(), ".local", "bin");
}

const installRoot = resolve(process.env.PI_XZ_INSTALL_ROOT ?? defaultRoot());
const binDir = resolve(process.env.PI_XZ_BIN_DIR ?? defaultBin());
const cacheDir = resolve(process.env.PI_XZ_CACHE_DIR ?? join(installRoot, "cache"));
const lockDirectory = resolve(process.env.PI_XZ_INSTALL_LOCK ?? join(installRoot, ".install.lock"));
const legacyPrefix = process.env.PI_XZ_LEGACY_PREFIX ? resolve(process.env.PI_XZ_LEGACY_PREFIX) : undefined;
const discoveryBaseUrl = process.env.PI_XZ_RELEASE_BASE_URL ?? "https://github.com/xz-dev/pi/releases/latest/download/";
const expectedManifestSha256 = process.env.PI_XZ_RELEASE_MANIFEST_SHA256;
const transactionJournalName = ".install-transaction.json";
const transactionJournalPath = join(installRoot, transactionJournalName);
const packageSegments = ENTRY_PACKAGE.split("/");
const legacySegments = LEGACY_PACKAGE.split("/");

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function safeComponent(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 255) {
		return fail(`Invalid ${label}: expected a non-empty safe component`);
	}
	if (
		value === "." ||
		value === ".." ||
		isAbsolute(value) ||
		/[\\/?#:%\u0000-\u001f\u007f]/.test(value) ||
		value.includes("..") && /(?:^|[._+-])\.\.(?:$|[._+-])/.test(value)
	) {
		return fail(`Invalid unsafe ${label} component`);
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) return fail(`Invalid unsafe ${label} component`);
	return value;
}

function containedPath(root: string, ...components: string[]): string {
	const target = resolve(root, ...components);
	const fromRoot = relative(root, target);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		return fail(`Resolved path escapes managed root: ${target}`);
	}
	return target;
}

function requireDirectoryWithoutSymlink(path: string, label: string): void {
	if (!pathExists(path)) return;
	const state = lstatSync(path);
	if (state.isSymbolicLink() || !state.isDirectory()) return fail(`${label} must be a real directory`);
}

function requireRegularFile(path: string, label: string): void {
	if (!pathExists(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
		return fail(`${label} is missing or unsafe`);
	}
}

function createDirectoryWithoutSymlinkFrom(root: string, target: string, label: string): void {
	const relativeTarget = relative(root, target);
	if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
		return fail(`${label} is outside its trusted root`);
	}
	let current = root;
	for (const component of relativeTarget.split(sep).filter(Boolean)) {
		current = join(current, component);
		if (!pathExists(current)) break;
		const state = lstatSync(current);
		if (state.isSymbolicLink() || !state.isDirectory()) return fail(`${label} must not contain symbolic links`);
	}
	mkdirSync(target, { recursive: true, mode: 0o755 });
	ensureRealContainment(root, target, label);
}

function ensureRealContainment(root: string, target: string, label: string): void {
	const actualRoot = realpathSync(root);
	const actualTarget = realpathSync(target);
	const fromRoot = relative(actualRoot, actualTarget);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		return fail(`${label} escapes its managed root`);
	}
}

function sha(path: string, algorithm: "sha256" | "sha512"): string {
	return createHash(algorithm).update(readFileSync(path)).digest(algorithm === "sha512" ? "base64" : "hex");
}

function isTrustedGitHubAssetRedirect(requested: URL, response: Response): boolean {
	if (!response.redirected) return true;
	if (requested.hostname !== "github.com") return false;
	const destination = new URL(response.url);
	return destination.protocol === "https:" && destination.hostname === "release-assets.githubusercontent.com";
}

async function download(url: URL, path: string, expectedBytes: number | undefined, maximumBytes: number): Promise<void> {
	const response = await fetch(url, {
		headers: { accept: "application/octet-stream", "cache-control": "no-store" },
		redirect: "follow",
		signal: AbortSignal.timeout(60_000),
	});
	if (!isTrustedGitHubAssetRedirect(url, response)) {
		return fail(`Download redirected away from its pinned GitHub Release URL: ${url.href}`);
	}
	if (!response.ok) return fail(`Could not download ${url.href}: HTTP ${response.status}`);
	const contentLength = response.headers.get("content-length");
	if (contentLength && (!Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > maximumBytes)) {
		return fail(`Download from ${url.href} exceeds the allowed size`);
	}
	if (!response.body) return fail(`Download from ${url.href} returned no body`);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const descriptor = openSync(path, "wx", 0o600);
	let total = 0;
	try {
		const reader = response.body.getReader();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > maximumBytes || (expectedBytes !== undefined && total > expectedBytes)) {
				await reader.cancel();
				return fail(`Download from ${url.href} has an invalid size`);
			}
			writeSync(descriptor, chunk.value);
		}
	} catch (error) {
		closeSync(descriptor);
		rmSync(path, { force: true });
		throw error;
	}
	closeSync(descriptor);
	if (expectedBytes !== undefined && total !== expectedBytes) {
		rmSync(path, { force: true });
		return fail(`Download from ${url.href} has an invalid size`);
	}
}

function validateBaseUrl(value: string, label: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return fail(`Invalid ${label}`);
	}
	const localTestUrl =
		url.protocol === "http:" &&
		["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !localTestUrl) ||
		url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/")
	) {
		return fail(`Invalid ${label}`);
	}
	return url;
}

function validateManifest(value: unknown): Manifest {
	if (!value || typeof value !== "object") return fail("Invalid release manifest");
	const manifest = value as Manifest;
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
	if (manifest.schemaVersion !== 1 || manifest.repository !== REPOSITORY) return fail("Invalid release manifest identity");
	const version = safeComponent(manifest.distributionVersion, "distribution version");
	const parsedVersion = parseDistributionVersion(version);
	if (manifest.apiVersion !== parsedVersion.api.join(".")) return fail("Release API/version mismatch");
	const tag = safeComponent(manifest.tag, "release tag");
	const packageFile = safeComponent(manifest.package?.file, "package filename");
	if (
		manifest.package?.name !== ENTRY_PACKAGE ||
		manifest.package.bundled !== true ||
		manifest.package.packaging !== "hybrid" ||
		manifest.package.networkPolicy !== "external-optional-only"
	) return fail("Invalid canonical package metadata");
	if (tag !== `xz-v${version}`) return fail("Release tag/version mismatch");
	if (packageFile !== `earendil-works-pi-coding-agent-${version}.tgz`) return fail("Release package/version mismatch");
	if (
		!manifest.package.externalOptionalDependencies ||
		typeof manifest.package.externalOptionalDependencies !== "object" ||
		Array.isArray(manifest.package.externalOptionalDependencies) ||
		!Array.isArray(manifest.package.allowedNetworkPackages) ||
		!manifest.package.allowedNetworkPackages.every((name) =>
			typeof name === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
		) ||
		!Array.isArray(manifest.package.allowedNetworkPackagePrefixes) ||
		!manifest.package.allowedNetworkPackagePrefixes.every((prefix) => typeof prefix === "string") ||
		!Object.values(manifest.package.externalOptionalDependencies).every((specifier) =>
			typeof specifier === "string" &&
			specifier.length > 0 &&
			!specifier.startsWith("file:") &&
			!specifier.startsWith("link:") &&
			!specifier.startsWith("workspace:") &&
			!specifier.startsWith("git+") &&
			!specifier.startsWith("github:") &&
			!specifier.includes("npm.pkg.github.com") &&
			!specifier.includes("@xz-dev/")
		) ||
		JSON.stringify(Object.keys(manifest.package.externalOptionalDependencies).sort()) !==
			JSON.stringify([...manifest.package.allowedNetworkPackages].sort()) ||
		new Set(manifest.package.allowedNetworkPackages).size !== manifest.package.allowedNetworkPackages.length ||
		JSON.stringify([...manifest.package.allowedNetworkPackagePrefixes].sort()) !==
			JSON.stringify(manifest.package.allowedNetworkPackages.map((name) => `${name}-`).sort())
	) return fail("Invalid external optional dependency policy");
	if (!Number.isSafeInteger(manifest.package.bytes) || manifest.package.bytes <= 0 || manifest.package.bytes > PACKAGE_MAX_BYTES) {
		return fail("Invalid package size");
	}
	if (!/^[0-9a-f]{40}$/.test(manifest.commit)) return fail("Invalid release commit");
	if (!manifest.commit.startsWith(parsedVersion.commit)) return fail("Release commit/version mismatch");
	if (!/^\d+\.\d+\.\d+$/.test(manifest.minimumNodeVersion)) return fail("Invalid minimum Node version");
	const currentNode = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
	const requiredNode = manifest.minimumNodeVersion.split(".").map((part) => Number.parseInt(part, 10));
	for (let index = 0; index < 3; index += 1) {
		if (currentNode[index] > requiredNode[index]) break;
		if (currentNode[index] < requiredNode[index]) return fail(`Release requires Node-compatible runtime ${manifest.minimumNodeVersion} or newer`);
	}
	if (!/^[0-9a-f]{64}$/.test(manifest.package.sha256)) return fail("Invalid package sha256");
	if (
		manifest.installer?.file !== "install.ts" ||
		!Number.isSafeInteger(manifest.installer.bytes) ||
		manifest.installer.bytes <= 0 ||
		!/^[0-9a-f]{64}$/.test(manifest.installer.sha256)
	) return fail("Invalid installer metadata");
	if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(manifest.package.integrity)) return fail("Invalid package integrity");
	if (
		!manifest.attestation ||
		manifest.attestation.repository !== REPOSITORY ||
		manifest.attestation.signerWorkflow !== `${REPOSITORY}/.github/workflows/publish-github-release.yml` ||
		manifest.attestation.signerRef !== "refs/heads/main" ||
		manifest.attestation.denySelfHostedRunners !== true ||
		manifest.attestation.subjectsFile !== "attestation-subjects.txt"
	) return fail("Invalid or missing release attestation policy");
	if (
		!manifest.bootstrap ||
		manifest.bootstrap.tag !== tag ||
		manifest.bootstrap.baseUrl !== `https://github.com/${REPOSITORY}/releases/download/${tag}/` ||
		manifest.bootstrap.minimumNodeVersion !== manifest.minimumNodeVersion ||
		manifest.bootstrap.files?.sh !== "install.sh" ||
		manifest.bootstrap.files?.ps1 !== "install.ps1"
	) return fail("Invalid bootstrap metadata");
	return manifest;
}

function parseDistributionVersion(value: string): DistributionVersion {
	const match = /^(\d+\.\d+\.\d+)-xz\.(\d+)\.(\d+)\.g([0-9a-f]{8})$/.exec(value);
	if (!match) return fail(`Invalid xz distribution version: ${value}`);
	return {
		api: match[1].split(".").map((part) => Number.parseInt(part, 10)),
		run: Number.parseInt(match[2], 10),
		attempt: Number.parseInt(match[3], 10),
		commit: match[4],
	};
}

function compareDistributionVersions(leftValue: string, rightValue: string): number {
	const left = parseDistributionVersion(leftValue);
	const right = parseDistributionVersion(rightValue);
	for (let index = 0; index < Math.max(left.api.length, right.api.length); index += 1) {
		const difference = (left.api[index] ?? 0) - (right.api[index] ?? 0);
		if (difference !== 0) return difference;
	}
	if (left.run !== right.run) return left.run - right.run;
	return left.attempt - right.attempt;
}

function releaseUrls(manifest?: Manifest): { discovery: URL; exact?: URL } {
	const discovery = validateBaseUrl(discoveryBaseUrl, "release discovery base URL");
	const localTestDiscovery =
		discovery.protocol === "http:" &&
		["127.0.0.1", "localhost", "[::1]"].includes(discovery.hostname);
	if (!localTestDiscovery && discovery.origin !== "https://github.com") {
		return fail("Release discovery must use xz-dev/pi on github.com");
	}
	if (!manifest) return { discovery };
	if (
		!localTestDiscovery &&
		discovery.pathname !== "/xz-dev/pi/releases/latest/download/" &&
		discovery.pathname !== `/xz-dev/pi/releases/download/${manifest.tag}/`
	) return fail("Release discovery path is not xz-dev/pi latest or exact-tag pinned");
	const configured = process.env.PI_XZ_RELEASE_EXACT_BASE_URL ?? "https://github.com/xz-dev/pi/releases/download/{tag}/";
	const occurrences = configured.split("{tag}").length - 1;
	if (occurrences > 1) return fail("Exact release base URL may contain at most one {tag} placeholder");
	const exact = validateBaseUrl(
		occurrences === 1 ? configured.replace("{tag}", encodeURIComponent(manifest.tag)) : configured,
		"exact release base URL",
	);
	if (exact.origin !== discovery.origin) return fail("Exact release assets must use the discovery origin");
	if (!exact.pathname.endsWith(`/releases/download/${manifest.tag}/`)) {
		return fail("Exact release base URL is not pinned to the manifest tag");
	}
	return { discovery, exact };
}

function packagePath(versionRoot: string): string {
	return containedPath(versionRoot, "node_modules", ...packageSegments);
}

function receiptPath(version: string): string {
	return containedPath(installRoot, "receipts", `${safeComponent(version, "receipt version")}.json`);
}

function managedPath(...components: string[]): string {
	return containedPath(installRoot, ...components);
}

function archivePath(versionRoot: string): string {
	return containedPath(versionRoot, ".pi-xz", "release-package.tgz");
}

function installMetadataPath(versionRoot: string): string {
	return containedPath(versionRoot, ".pi-xz", "install.json");
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
	const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: "inherit" });
	if (result.error) return fail(`${command} could not be executed: ${result.error.message}`);
	if (result.status !== 0) return fail(`${command} ${args.join(" ")} exited with ${result.status ?? "unknown"}`);
}

function verifyAttestation(tarball: string, manifest: Manifest, discovery: URL): void {
	if (process.env.PI_XZ_SKIP_ATTESTATION === "1") {
		const local = discovery.hostname === "127.0.0.1" || discovery.hostname === "localhost" || discovery.hostname === "[::1]";
		if (process.env.CI || !local) return fail("Attestation bypass is allowed only for local non-CI tests");
		return;
	}
	const local = discovery.hostname === "127.0.0.1" || discovery.hostname === "localhost" || discovery.hostname === "[::1]";
	const gh = local && !process.env.CI ? (process.env.PI_XZ_GH_COMMAND ?? "gh") : "gh";
	run(gh, [
		"attestation",
		"verify",
		tarball,
		"--repo",
		manifest.attestation.repository,
		"--signer-workflow",
		manifest.attestation.signerWorkflow,
		"--source-ref",
		manifest.attestation.signerRef,
		"--source-digest",
		manifest.commit,
		"--deny-self-hosted-runners",
	]);
}

function treeSha256(root: string): string {
	const hash = createHash("sha256");
	function visit(path: string, relativePath: string): void {
		const state = lstatSync(path);
		const normalized = relativePath.replaceAll("\\", "/");
		if (state.isSymbolicLink()) {
			hash.update(`link\0${normalized}\0${readlinkSync(path)}\0`);
			return;
		}
		if (state.isDirectory()) {
			hash.update(`dir\0${normalized}\0${state.mode & 0o777}\0`);
			for (const name of readdirSync(path).sort()) visit(join(path, name), relativePath ? join(relativePath, name) : name);
			return;
		}
		if (!state.isFile()) return fail(`Installed package contains an unsupported filesystem entry: ${normalized}`);
		hash.update(`file\0${normalized}\0${state.mode & 0o777}\0`);
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	visit(root, "");
	return hash.digest("hex");
}

function readPackageIdentity(versionRoot: string): { name?: string; version?: string; main?: string; exports?: unknown } {
	const root = packagePath(versionRoot);
	requireDirectoryWithoutSymlink(root, "Installed package");
	ensureRealContainment(versionRoot, root, "Installed package");
	return JSON.parse(readFileSync(containedPath(root, "package.json"), "utf8")) as {
		name?: string;
		version?: string;
		main?: string;
		exports?: unknown;
	};
}

function runSmoke(versionRoot: string, expectedVersion: string): void {
	const root = packagePath(versionRoot);
	const identity = readPackageIdentity(versionRoot);
	const exported = identity.exports && typeof identity.exports === "object" ? (identity.exports as Record<string, unknown>)["."] : undefined;
	const entry = typeof exported === "string" ? exported : identity.main;
	if (typeof entry !== "string" || !entry.startsWith("./")) return fail("Installed package is missing a safe import entry");
	const importPath = resolve(root, entry);
	const importRelative = relative(root, importPath);
	if (importRelative === ".." || importRelative.startsWith(`..${sep}`) || isAbsolute(importRelative)) return fail("Installed package import escapes its root");
	const cli = containedPath(root, "dist", "cli.js");
	requireRegularFile(cli, "Installed package CLI");
	const smokeAgent = containedPath(versionRoot, ".smoke-agent");
	const environment = { ...process.env, PI_CODING_AGENT_DIR: smokeAgent };
	const imported = spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(importPath).href)})`], {
		encoding: "utf8",
		env: environment,
	});
	if (imported.status !== 0) return fail(`Installed package import smoke verification failed: ${imported.stderr.trim()}`);
	for (const args of [["--version"], ["--help"]]) {
		const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: environment });
		if (result.status !== 0) return fail(`Installed package smoke verification failed for ${args.join(" ")}`);
		if (args[0] === "--version" && result.stdout.trim() !== expectedVersion) {
			return fail(`Installed package version mismatch: ${result.stdout.trim()}`);
		}
	}
	rmSync(smokeAgent, { recursive: true, force: true });
}

function launcherPaths(): string[] {
	const pi = containedPath(binDir, "pi");
	return selectedPlatform === "win32" ? [pi, `${pi}.cmd`, `${pi}.ps1`] : [pi];
}

function managedLauncher(path: string): boolean {
	if (!pathExists(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return false;
	return readFileSync(path, "utf8").includes("pi-xz managed launcher");
}

function pointsIntoLegacy(path: string, packageRoot: string): boolean {
	const expectedCli = containedPath(packageRoot, "dist", "cli.js");
	if (lstatSync(path).isSymbolicLink()) {
		return resolve(dirname(path), readlinkSync(path)) === expectedCli;
	}
	if (!lstatSync(path).isFile()) return false;
	const normalize = (value: string): string => value.replaceAll("\\", "/").toLowerCase();
	const contents = normalize(readFileSync(path, "utf8"));
	const expected = normalize(expectedCli);
	return contents.includes(expected) && !contents.includes(normalize(containedPath(packageRoot, "package.json")));
}

function legacyInstallation(): LegacyInstallation | undefined {
	if (!legacyPrefix) return undefined;
	const packageRoot = selectedPlatform === "win32"
		? containedPath(legacyPrefix, "node_modules", ...legacySegments)
		: containedPath(legacyPrefix, "lib", "node_modules", ...legacySegments);
	if (!pathExists(packageRoot)) return undefined;
	requireDirectoryWithoutSymlink(packageRoot, "Legacy package");
	const shims = launcherPaths();
	for (const shim of shims) {
		if (!pathExists(shim)) return fail(`Legacy package exists but its pi shim is missing: ${shim}`);
		if (!pointsIntoLegacy(shim, packageRoot)) return fail(`Refusing unknown or non-owned legacy pi shim: ${shim}`);
	}
	return { packagePath: packageRoot, shimPaths: shims };
}

function ensureLauncherOwnership(legacy: LegacyInstallation | undefined): void {
	for (const launcher of launcherPaths()) {
		if (!pathExists(launcher)) continue;
		if (legacy?.shimPaths.includes(launcher)) continue;
		if (!managedLauncher(launcher)) return fail(`Refusing to overwrite unknown pi shim: ${launcher}`);
	}
}

function writeTransactionJournal(transaction: Transaction): void {
	mkdirSync(installRoot, { recursive: true, mode: 0o755 });
	const stored: StoredTransaction = {
		schemaVersion: 1,
		replacements: transaction.replacements,
		...(transaction.createdFinalRoot ? { createdFinalRoot: transaction.createdFinalRoot } : {}),
		...(transaction.stagingRoot ? { stagingRoot: transaction.stagingRoot } : {}),
		...(transaction.legacyBackup ? { legacyBackup: transaction.legacyBackup } : {}),
		...(transaction.committed ? { committed: true } : {}),
	};
	const temp = `${transactionJournalPath}.new-${randomUUID()}`;
	const descriptor = openSync(temp, "wx", 0o600);
	try {
		const contents = Buffer.from(`${JSON.stringify(stored, undefined, 2)}\n`);
		writeSync(descriptor, contents);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	const prior = `${transactionJournalPath}.prior-${randomUUID()}`;
	let hadPrior = false;
	try {
		if (pathExists(transactionJournalPath)) {
			renameSync(transactionJournalPath, prior);
			hadPrior = true;
		}
		renameSync(temp, transactionJournalPath);
		rmSync(prior, { force: true });
	} catch (error) {
		rmSync(temp, { force: true });
		if (hadPrior && pathExists(prior) && !pathExists(transactionJournalPath)) renameSync(prior, transactionJournalPath);
		throw error;
	}
}

function beginTransaction(): Transaction {
	const transaction = { replacements: [] };
	writeTransactionJournal(transaction);
	return transaction;
}

function atomicWrite(transaction: Transaction, target: string, contents: string | Buffer, mode: number): void {
	mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
	const temp = `${target}.pi-xz-new-${randomUUID()}`;
	const backup = `${target}.pi-xz-backup-${randomUUID()}`;
	const descriptor = openSync(temp, "wx", mode);
	try {
		writeFileSync(descriptor, contents);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	chmodSync(temp, mode);
	const hadPrior = pathExists(target);
	const replacement = { target, temporary: temp, ...(hadPrior ? { backup } : {}) };
	transaction.replacements.push(replacement);
	writeTransactionJournal(transaction);
	try {
		if (hadPrior) {
			renameSync(target, backup);
			if (target === managedPath("current")) injectCrash("current-backup");
		}
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true, recursive: true });
		if (hadPrior && pathExists(backup) && !pathExists(target)) renameSync(backup, target);
		throw error;
	}
}

function transactionJournalSwapArtifacts(kind: "new" | "prior"): string[] {
	const pattern = new RegExp(`^\\.install-transaction\\.json\\.${kind}-[0-9a-f-]{36}$`);
	return readdirSync(installRoot)
		.filter((name) => pattern.test(name))
		.map((name) => join(installRoot, name));
}

function cleanupTransactionJournalSwapArtifacts(): void {
	for (const path of [...transactionJournalSwapArtifacts("new"), ...transactionJournalSwapArtifacts("prior")]) {
		const state = lstatSync(path);
		if (!state.isFile() && !state.isSymbolicLink()) return fail("Install transaction journal swap artifact is unsafe");
		rmSync(path, { force: true });
	}
}

function rollbackTransaction(transaction: Transaction): void {
	for (const replacement of [...transaction.replacements].reverse()) {
		if (replacement.temporary) rmSync(replacement.temporary, { force: true, recursive: true });
		if (replacement.backup) {
			if (pathExists(replacement.backup)) {
				rmSync(replacement.target, { force: true, recursive: true });
				renameSync(replacement.backup, replacement.target);
			}
		} else {
			rmSync(replacement.target, { force: true, recursive: true });
		}
	}
	restoreLegacy(transaction.legacyBackup);
	if (transaction.createdFinalRoot) rmSync(transaction.createdFinalRoot, { recursive: true, force: true });
	if (transaction.stagingRoot) rmSync(transaction.stagingRoot, { recursive: true, force: true });
	rmSync(transactionJournalPath, { force: true });
	cleanupTransactionJournalSwapArtifacts();
}

function commitTransaction(transaction: Transaction): void {
	transaction.committed = true;
	writeTransactionJournal(transaction);
	for (const replacement of transaction.replacements) {
		if (replacement.temporary) rmSync(replacement.temporary, { force: true, recursive: true });
		if (replacement.backup) rmSync(replacement.backup, { force: true, recursive: true });
	}
	finishLegacy(transaction.legacyBackup);
	rmSync(transactionJournalPath, { force: true });
	cleanupTransactionJournalSwapArtifacts();
}

function validateStoredTransaction(stored: StoredTransaction): void {
	if (
		!stored ||
		typeof stored !== "object" ||
		stored.schemaVersion !== 1 ||
		!Array.isArray(stored.replacements) ||
		(stored.committed !== undefined && stored.committed !== true) ||
		(stored.createdFinalRoot !== undefined && typeof stored.createdFinalRoot !== "string") ||
		(stored.stagingRoot !== undefined && typeof stored.stagingRoot !== "string")
	) {
		return fail("Invalid interrupted install transaction journal");
	}
	const allowedTargets = new Set([...launcherPaths(), managedPath("launcher.cjs"), managedPath("current")]);
	const seenTargets = new Set<string>();
	for (const replacement of stored.replacements) {
		if (
			!replacement ||
			typeof replacement.target !== "string" ||
			typeof replacement.temporary !== "string" ||
			(replacement.backup !== undefined && typeof replacement.backup !== "string")
		) {
			return fail("Invalid interrupted install transaction replacement");
		}
		const receiptRelative = relative(managedPath("receipts"), replacement.target);
		const targetAllowed =
			allowedTargets.has(replacement.target) ||
			/^[A-Za-z0-9][A-Za-z0-9._+-]*\.json$/.test(receiptRelative);
		if (!targetAllowed) return fail("Interrupted install transaction target is outside managed files");
		if (seenTargets.has(replacement.target)) return fail("Interrupted install transaction has duplicate targets");
		seenTargets.add(replacement.target);
		const temporaryPrefix = `${replacement.target}.pi-xz-new-`;
		const backupPrefix = `${replacement.target}.pi-xz-backup-`;
		if (
			!replacement.temporary.startsWith(temporaryPrefix) ||
			!/^[0-9a-f-]{36}$/.test(replacement.temporary.slice(temporaryPrefix.length))
		) return fail("Invalid interrupted install transaction temporary path");
		if (
			replacement.backup &&
			(!replacement.backup.startsWith(backupPrefix) ||
				!/^[0-9a-f-]{36}$/.test(replacement.backup.slice(backupPrefix.length)))
		) return fail("Invalid interrupted install transaction backup path");
	}
	if (stored.createdFinalRoot) {
		const relativePath = relative(managedPath("versions"), stored.createdFinalRoot);
		if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(relativePath)) {
			return fail("Invalid interrupted install transaction final version path");
		}
	}
	if (stored.stagingRoot) {
		const relativePath = relative(managedPath("versions"), stored.stagingRoot);
		if (!/^\.[A-Za-z0-9][A-Za-z0-9._+-]*\.staging-[0-9a-f-]{36}$/.test(relativePath)) {
			return fail("Invalid interrupted install transaction staging path");
		}
	}
	if (stored.legacyBackup !== undefined) {
		const legacy = stored.legacyBackup;
		const expectedPackagePath = legacyPrefix
			? selectedPlatform === "win32"
				? join(legacyPrefix, "node_modules", ...legacySegments)
				: join(legacyPrefix, "lib", "node_modules", ...legacySegments)
			: undefined;
		if (
			!legacy ||
			typeof legacy !== "object" ||
			typeof legacy.packagePath !== "string" ||
			typeof legacy.packageBackup !== "string" ||
			!Array.isArray(legacy.shimBackups) ||
			legacy.packagePath !== expectedPackagePath
		) return fail("Invalid interrupted legacy migration journal");
		const packageBackupPrefix = `${legacy.packagePath}.pi-xz-backup-`;
		const seenShims = new Set<string>();
		if (
			!legacy.packageBackup.startsWith(packageBackupPrefix) ||
			!/^[0-9a-f-]{36}$/.test(legacy.packageBackup.slice(packageBackupPrefix.length)) ||
			legacy.shimBackups.some((shim) => {
				if (!shim || typeof shim.path !== "string" || typeof shim.backup !== "string") return true;
				const prefix = `${shim.path}.pi-xz-backup-`;
				if (seenShims.has(shim.path)) return true;
				seenShims.add(shim.path);
				return !launcherPaths().includes(shim.path) ||
					!shim.backup.startsWith(prefix) ||
					!/^[0-9a-f-]{36}$/.test(shim.backup.slice(prefix.length));
			})
		) return fail("Invalid interrupted legacy migration journal");
	}
}

function recoverTransaction(): void {
	const priorArtifacts = transactionJournalSwapArtifacts("prior");
	const newArtifacts = transactionJournalSwapArtifacts("new");
	if (priorArtifacts.length > 1 || newArtifacts.length > 1) {
		return fail("Ambiguous interrupted install transaction journal swap");
	}
	if (!pathExists(transactionJournalPath)) {
		if (priorArtifacts.length === 0) {
			cleanupTransactionJournalSwapArtifacts();
			return;
		}
		requireRegularFile(priorArtifacts[0]!, "Interrupted prior install transaction journal");
		renameSync(priorArtifacts[0]!, transactionJournalPath);
	}
	requireRegularFile(transactionJournalPath, "Interrupted install transaction journal");
	let stored: StoredTransaction;
	try {
		stored = JSON.parse(readFileSync(transactionJournalPath, "utf8")) as StoredTransaction;
	} catch {
		return fail("Could not read interrupted install transaction journal");
	}
	validateStoredTransaction(stored);
	const recovered: Transaction = {
		replacements: stored.replacements,
		createdFinalRoot: stored.createdFinalRoot,
		stagingRoot: stored.stagingRoot,
		legacyBackup: stored.legacyBackup,
		committed: stored.committed,
	};
	if (stored.committed) commitTransaction(recovered);
	else rollbackTransaction(recovered);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function launcherScripts(): Array<{ path: string; contents: string; mode: number }> {
	const nodeLauncher = `#!/bin/sh\n# pi-xz managed launcher\nexec ${shellQuote(process.execPath)} ${shellQuote(managedPath("launcher.cjs"))} \"$@\"\n`;
	const [pi, cmd, ps1] = launcherPaths();
	if (selectedPlatform !== "win32") return [{ path: pi, contents: nodeLauncher, mode: 0o755 }];
	const escapePs = (value: string): string => value.replaceAll("'", "''");
	return [
		{ path: pi, contents: nodeLauncher, mode: 0o755 },
		{
			path: cmd!,
			contents: `@echo off\r\nrem pi-xz managed launcher\r\nset /p PI_XZ_CURRENT=<"${join(installRoot, "current")}"\r\n"${process.execPath}" "${join(installRoot, "versions")}"\\%PI_XZ_CURRENT%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n`,
			mode: 0o644,
		},
		{
			path: ps1!,
			contents: `# pi-xz managed launcher\n$root='${escapePs(installRoot)}'\n$v=(Get-Content -Raw (Join-Path $root 'current')).Trim()\n$cli=Join-Path $root ('versions\\'+$v+'\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js')\n& '${escapePs(process.execPath)}' $cli @args\n`,
			mode: 0o644,
		},
	];
}

function writeLaunchers(transaction: Transaction): void {
	mkdirSync(binDir, { recursive: true, mode: 0o755 });
	const launcherRuntime = `// pi-xz managed launcher runtime\nconst fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');\nconst root=${JSON.stringify(installRoot)};const version=fs.readFileSync(path.join(root,'current'),'utf8').trim();const cli=path.join(root,'versions',version,'node_modules','@earendil-works','pi-coding-agent','dist','cli.js');\nconst result=cp.spawnSync(${JSON.stringify(process.execPath)},[cli,...process.argv.slice(2)],{stdio:'inherit',env:process.env});if(result.error)throw result.error;process.exit(result.status??1);\n`;
	atomicWrite(transaction, managedPath("launcher.cjs"), launcherRuntime, 0o644);
	for (const launcher of launcherScripts()) atomicWrite(transaction, launcher.path, launcher.contents, launcher.mode);
}

function planLegacyBackup(legacy: LegacyInstallation): LegacyBackup {
	return {
		packagePath: legacy.packagePath,
		packageBackup: `${legacy.packagePath}.pi-xz-backup-${randomUUID()}`,
		shimBackups: legacy.shimPaths.map((path) => ({ path, backup: `${path}.pi-xz-backup-${randomUUID()}` })),
	};
}

function backupLegacy(record: LegacyBackup): void {
	renameSync(record.packagePath, record.packageBackup);
	try {
		for (const shim of record.shimBackups) renameSync(shim.path, shim.backup);
	} catch (error) {
		restoreLegacy(record);
		throw error;
	}
}

function restoreLegacy(record: LegacyBackup | undefined): void {
	if (!record) return;
	if (pathExists(record.packageBackup)) {
		rmSync(record.packagePath, { recursive: true, force: true });
		renameSync(record.packageBackup, record.packagePath);
	}
	for (const shim of record.shimBackups) {
		if (!pathExists(shim.backup)) continue;
		rmSync(shim.path, { recursive: true, force: true });
		renameSync(shim.backup, shim.path);
	}
}

function finishLegacy(record: LegacyBackup | undefined): void {
	if (!record) return;
	try {
		rmSync(record.packageBackup, { recursive: true, force: true });
	} catch (error) {
		console.warn(`Could not remove completed migration backup ${record.packageBackup}: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (const shim of record.shimBackups) {
		try {
			rmSync(shim.backup, { recursive: true, force: true });
		} catch (error) {
			console.warn(`Could not remove completed migration backup ${shim.backup}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function installTarball(tarball: string, versionRoot: string): void {
	mkdirSync(versionRoot, { recursive: true, mode: 0o755 });
	writeFileSync(containedPath(versionRoot, "package.json"), `${JSON.stringify({ private: true })}\n`, { mode: 0o600 });
	if (spawnSync("npm", ["--version"], { stdio: "ignore" }).status === 0) {
		const uniqueNpmCache = containedPath(cacheDir, `npm-${randomUUID()}`);
		mkdirSync(uniqueNpmCache, { recursive: true, mode: 0o700 });
		try {
			run("npm", ["install", "--prefix", versionRoot, "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
				env: {
					...process.env,
					npm_config_cache: uniqueNpmCache,
					npm_config_update_notifier: "false",
					npm_config_audit: "false",
					npm_config_fund: "false",
					npm_config_ignore_scripts: "true",
				},
			});
		} finally {
			rmSync(uniqueNpmCache, { recursive: true, force: true });
		}
		return;
	}
	if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status !== 0) {
		return fail("npm or Bun is required to materialize the Release package");
	}
	const uniqueBunCache = containedPath(cacheDir, `bun-${randomUUID()}`);
	mkdirSync(uniqueBunCache, { recursive: true, mode: 0o700 });
	try {
		run("bun", ["install", "--cwd", versionRoot, "--ignore-scripts", "--no-save", tarball], {
			env: { ...process.env, BUN_INSTALL_CACHE_DIR: uniqueBunCache },
		});
	} finally {
		rmSync(uniqueBunCache, { recursive: true, force: true });
	}
}

function receiptFor(manifest: Manifest): Receipt {
	return manifest;
}

function writeInstallMetadata(versionRoot: string, version: string): void {
	const metadata: InstallMetadata = {
		schemaVersion: 1,
		name: ENTRY_PACKAGE,
		version,
		treeSha256: treeSha256(packagePath(versionRoot)),
	};
	writeFileSync(installMetadataPath(versionRoot), `${JSON.stringify(metadata, undefined, 2)}\n`, { mode: 0o600 });
}

function validateReceipt(value: unknown, version: string): Receipt {
	const manifest = validateManifest(value);
	const receipt = value as Receipt;
	if (manifest.distributionVersion !== version || manifest.tag !== `xz-v${version}`) return fail("Rollback receipt version mismatch");
	return receipt;
}

function verifyInstalledVersion(versionRoot: string, version: string, expected?: Manifest): Receipt {
	const receiptFile = receiptPath(version);
	requireRegularFile(receiptFile, "Rollback receipt");
	const receipt = validateReceipt(JSON.parse(readFileSync(receiptFile, "utf8")), version);
	if (expected) {
		if (
			receipt.repository !== expected.repository ||
			receipt.tag !== expected.tag ||
			receipt.package.name !== expected.package.name ||
			receipt.package.file !== expected.package.file ||
			receipt.package.bytes !== expected.package.bytes ||
			receipt.package.sha256 !== expected.package.sha256 ||
			receipt.package.integrity !== expected.package.integrity
		) {
			return fail("Existing version does not match the selected Release receipt");
		}
	}
	const archive = archivePath(versionRoot);
	requireRegularFile(archive, "Retained Release package");
	if (statSync(archive).size !== receipt.package.bytes) return fail("Retained package size does not match its receipt");
	if (sha(archive, "sha256") !== receipt.package.sha256) return fail("Retained package hash does not match its receipt");
	if (`sha512-${sha(archive, "sha512")}` !== receipt.package.integrity) return fail("Retained package integrity does not match its receipt");
	const metadataFile = installMetadataPath(versionRoot);
	requireRegularFile(metadataFile, "Installed package integrity metadata");
	const metadata = JSON.parse(readFileSync(metadataFile, "utf8")) as InstallMetadata;
	if (
		metadata.schemaVersion !== 1 ||
		metadata.name !== ENTRY_PACKAGE ||
		metadata.version !== version ||
		!/^[0-9a-f]{64}$/.test(metadata.treeSha256)
	) {
		return fail("Invalid installed package integrity metadata");
	}
	const identity = readPackageIdentity(versionRoot);
	if (identity.name !== ENTRY_PACKAGE || identity.version !== version) return fail("Installed package identity does not match its receipt");
	if (treeSha256(packagePath(versionRoot)) !== metadata.treeSha256) return fail("Installed package tree is corrupt or does not match its receipt");
	return receipt;
}

function testInjectionAllowed(): boolean {
	return Boolean(
		!process.env.CI &&
		process.env.PI_XZ_RELEASE_BASE_URL?.startsWith("http://127.0.0.1:"),
	);
}

function injectFailure(point: string): void {
	if (testInjectionAllowed() && process.env.PI_XZ_TEST_FAIL_AT === point) {
		return fail(`Injected installer failure at ${point}`);
	}
}

function injectCrash(point: string): void {
	if (testInjectionAllowed() && process.env.PI_XZ_TEST_CRASH_AT === point) process.exit(97);
}

async function installSelected(options: Options): Promise<void> {
	const legacy = legacyInstallation();
	if (legacy && options.mode !== "migrate") return fail("Legacy @xz-dev Pi detected; rerun this installer with --migrate");
	if (!legacy && options.mode === "migrate") return fail("--migrate requires an installed @xz-dev/pi-coding-agent");
	ensureLauncherOwnership(legacy);

	mkdirSync(installRoot, { recursive: true, mode: 0o755 });
	if (lstatSync(installRoot).isSymbolicLink() || !lstatSync(installRoot).isDirectory()) {
		return fail("Install root must be a real directory");
	}
	requireDirectoryWithoutSymlink(cacheDir, "Cache path");
	mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	if (cacheDir === installRoot || cacheDir.startsWith(`${installRoot}${sep}`)) {
		ensureRealContainment(installRoot, cacheDir, "Cache path");
	}
	const operationCache = containedPath(cacheDir, `download-${randomUUID()}`);
	mkdirSync(operationCache, { recursive: false, mode: 0o700 });
	const manifestPath = containedPath(operationCache, "release-manifest.json");
	let stagingRoot: string | undefined;
	let finalRoot: string | undefined;
	let createdFinal = false;
	try {
		const discovery = releaseUrls().discovery;
		await download(new URL("release-manifest.json", discovery), manifestPath, undefined, MANIFEST_MAX_BYTES);
		if (expectedManifestSha256 !== undefined) {
			if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256)) return fail("Invalid pinned release manifest sha256");
			if (sha(manifestPath, "sha256") !== expectedManifestSha256) return fail("Release manifest sha256 mismatch");
		}
		const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
		parseDistributionVersion(manifest.distributionVersion);
		const currentPath = managedPath("current");
		if (options.mode === "update" && pathExists(currentPath)) {
			const currentVersion = safeComponent(readFileSync(currentPath, "utf8").trim(), "current version");
			if (compareDistributionVersions(manifest.distributionVersion, currentVersion) < 0) {
				return fail(`Refusing to downgrade from ${currentVersion} to ${manifest.distributionVersion}; use --rollback for an installed version`);
			}
		}
		const exact = releaseUrls(manifest).exact!;
		const packageUrl = new URL(manifest.package.file, exact);
		const exactDirectory = exact.pathname.endsWith("/") ? exact.pathname : `${exact.pathname}/`;
		if (
			packageUrl.origin !== exact.origin ||
			packageUrl.pathname !== `${exactDirectory}${encodeURIComponent(manifest.package.file)}` ||
			packageUrl.search ||
			packageUrl.hash
		) {
			return fail("Package asset URL is not same-origin and exact-tag pinned");
		}
		const tarball = containedPath(operationCache, manifest.package.file);
		await download(packageUrl, tarball, manifest.package.bytes, manifest.package.bytes);
		if (sha(tarball, "sha256") !== manifest.package.sha256) return fail("Package sha256 mismatch");
		if (`sha512-${sha(tarball, "sha512")}` !== manifest.package.integrity) return fail("Package integrity mismatch");
		verifyAttestation(tarball, manifest, discovery);

		const version = safeComponent(manifest.distributionVersion, "distribution version");
		const versionsDir = managedPath("versions");
		requireDirectoryWithoutSymlink(versionsDir, "Versions path");
		requireDirectoryWithoutSymlink(managedPath("receipts"), "Receipts path");
		mkdirSync(versionsDir, { recursive: true, mode: 0o755 });
		finalRoot = containedPath(versionsDir, version);
		stagingRoot = containedPath(versionsDir, `.${version}.staging-${randomUUID()}`);
		let receipt: Receipt;
		if (pathExists(finalRoot)) {
			requireDirectoryWithoutSymlink(finalRoot, "Existing version root");
			receipt = verifyInstalledVersion(finalRoot, version, manifest);
			runSmoke(finalRoot, version);
		} else {
			installTarball(tarball, stagingRoot);
			const installed = readPackageIdentity(stagingRoot);
			if (installed.name !== ENTRY_PACKAGE || installed.version !== version) return fail("Installed package identity mismatch");
			mkdirSync(containedPath(stagingRoot, ".pi-xz"), { recursive: true, mode: 0o700 });
			copyFileSync(tarball, archivePath(stagingRoot));
			chmodSync(archivePath(stagingRoot), 0o600);
			runSmoke(stagingRoot, version);
			writeInstallMetadata(stagingRoot, version);
			receipt = receiptFor(manifest);
			renameSync(stagingRoot, finalRoot);
			createdFinal = true;
			stagingRoot = undefined;
		}

		const transaction = beginTransaction();
		transaction.createdFinalRoot = createdFinal ? finalRoot : undefined;
		transaction.stagingRoot = stagingRoot;
		writeTransactionJournal(transaction);
		let committed = false;
		try {
			if (options.mode === "migrate") {
				transaction.legacyBackup = planLegacyBackup(legacy!);
				writeTransactionJournal(transaction);
				backupLegacy(transaction.legacyBackup);
				injectCrash("legacy-backup");
			}
			writeLaunchers(transaction);
			injectFailure("launcher");
			atomicWrite(transaction, receiptPath(version), `${JSON.stringify(receipt, undefined, 2)}\n`, 0o600);
			injectFailure("receipt");
			injectCrash("receipt");
			atomicWrite(transaction, managedPath("current"), `${version}\n`, 0o600);
			injectFailure("current");
			committed = true;
			commitTransaction(transaction);
		} catch (error) {
			if (!committed) rollbackTransaction(transaction);
			throw error;
		}
	} catch (error) {
		if (stagingRoot) rmSync(stagingRoot, { recursive: true, force: true });
		if (createdFinal && finalRoot && !pathExists(managedPath("current"))) rmSync(finalRoot, { recursive: true, force: true });
		throw error;
	} finally {
		rmSync(operationCache, { recursive: true, force: true });
	}
}

function rollback(versionValue: string): void {
	recoverTransaction();
	const version = safeComponent(versionValue, "rollback version");
	const versionsDir = managedPath("versions");
	requireDirectoryWithoutSymlink(versionsDir, "Versions path");
	const root = containedPath(versionsDir, version);
	if (!pathExists(root)) return fail(`Rollback version is not installed: ${version}`);
	requireDirectoryWithoutSymlink(root, "Rollback version root");
	ensureLauncherOwnership(undefined);
	verifyInstalledVersion(root, version);
	runSmoke(root, version);
	const transaction = beginTransaction();
	try {
		writeLaunchers(transaction);
		atomicWrite(transaction, managedPath("current"), `${version}\n`, 0o600);
		commitTransaction(transaction);
	} catch (error) {
		rollbackTransaction(transaction);
		throw error;
	}
}

function acquireLock(): void {
	mkdirSync(installRoot, { recursive: true, mode: 0o755 });
	if (lstatSync(installRoot).isSymbolicLink() || !lstatSync(installRoot).isDirectory()) {
		return fail("Install root must be a real directory");
	}
	const lockParent = dirname(lockDirectory);
	const lockRelative = relative(installRoot, lockDirectory);
	const lockInsideInstallRoot = lockRelative !== ".." && !lockRelative.startsWith(`..${sep}`) && !isAbsolute(lockRelative);
	if (lockInsideInstallRoot) {
		createDirectoryWithoutSymlinkFrom(installRoot, lockParent, "Install lock parent");
	} else {
		if (!pathExists(lockParent)) return fail("Custom install lock parent must already exist");
		const parentState = lstatSync(lockParent);
		if (parentState.isSymbolicLink() || !parentState.isDirectory()) {
			return fail("Custom install lock parent must be a real directory");
		}
	}
	if (pathExists(lockDirectory)) {
		const state = lstatSync(lockDirectory);
		if (state.isSymbolicLink() || !state.isDirectory()) {
			return fail("Install lock must be a real directory");
		}
	}
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			mkdirSync(lockDirectory, { recursive: false, mode: 0o700 });
			writeFileSync(containedPath(lockDirectory, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
			return;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			let owner: { pid?: number } | undefined;
			try {
				owner = JSON.parse(readFileSync(containedPath(lockDirectory, "owner.json"), "utf8")) as { pid?: number };
			} catch {
				return fail("Another install is already in progress (install lock exists)");
			}
			if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) return fail("Another install is already in progress (install lock exists)");
			try {
				process.kill(owner.pid!, 0);
				return fail("Another install is already in progress (install lock exists)");
			} catch (probe) {
				if (!(probe instanceof Error && "code" in probe && probe.code === "ESRCH")) {
					return fail("Another install is already in progress (install lock exists)");
				}
			}
			rmSync(lockDirectory, { recursive: true, force: true });
		}
	}
	return fail("Could not acquire install lock");
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	acquireLock();
	try {
		recoverTransaction();
		if (options.mode === "rollback") rollback(options.rollbackVersion!);
		else await installSelected(options);
	} finally {
		rmSync(lockDirectory, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(`Installer verification failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
