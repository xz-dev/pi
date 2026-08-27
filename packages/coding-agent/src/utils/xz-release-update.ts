import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from "node:path";
import lockfile from "proper-lockfile";
import { RELEASE_TARGET } from "../config.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";
import { extractZipArchive } from "./tools-manager.ts";
import {
	getWindowsFilesystemSnapshotRelativePath,
	loadWindowsFilesystemSnapshotHelper,
	snapshotWindowsDirectory,
	snapshotWindowsRegularFile,
	type WindowsFilesystemSnapshotHelper,
} from "./win32-filesystem-snapshot.ts";

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
const BUNDLE_POINTER_MAX_BYTES = 256;
const BUNDLE_PACKAGE_MAX_BYTES = 64 * 1024;
const BUNDLE_WRAPPER_MAX_BYTES = 16 * 1024 * 1024;
const BUNDLE_FILESYSTEM_HELPER_MAX_BYTES = 16 * 1024 * 1024;
const BUNDLE_WRAPPER_NAME = process.platform === "win32" ? "pi.exe" : "pi";
const BUNDLE_EXECUTABLE_NAME = process.platform === "win32" ? "pi-native.exe" : "pi-native";
const BUNDLE_LOCK_STALE_MS = Number.MAX_SAFE_INTEGER;
const BUNDLE_LOCK_UPDATE_MS = 60_000;
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

interface InstalledBundlePackage {
	name?: string;
	version?: string;
	piConfig?: { distribution?: string; releaseTarget?: string };
}

interface ManagedBundleInstall {
	installRoot: string;
	bundlesRoot: string;
	executableDirectory: string;
}

interface PathSnapshot {
	canonicalPath: string;
	identity: string;
}

interface RegularFileSnapshot extends PathSnapshot {
	size: number;
	contents?: Buffer;
}

interface InstalledBundleSnapshot {
	directoryIdentity: string;
	requiredFileIdentities: string[];
	filesystemHelperDigest?: string;
}

interface ActivationDestinationSnapshot {
	bundle: InstalledBundleSnapshot;
}

interface BundlePointerSnapshot {
	version: string;
	contents: Buffer;
	fileIdentity: string;
	target: InstalledBundleSnapshot;
}

interface QuarantinedBundleSnapshot {
	root: string;
	rootIdentity: string;
	bundleDirectory: string;
	bundle: InstalledBundleSnapshot;
	version: string;
}

interface BundleValidationOptions {
	detached?: boolean;
	helper?: WindowsFilesystemSnapshotHelper;
	requireFilesystemHelper?: boolean;
	requireFilesystemHelperFile?: boolean;
}

export function cleanXzBundles(executablePath = process.execPath): number {
	const target = RELEASE_TARGET;
	if (!target) return fail("xz-dev Release target metadata is missing from this binary");
	const helper =
		process.platform === "win32"
			? loadWindowsFilesystemSnapshotHelper({
					candidates: [join(dirname(executablePath), getWindowsFilesystemSnapshotRelativePath())],
				})
			: undefined;
	const { installRoot, bundlesRoot, executableDirectory } = getManagedBundleInstall(executablePath, helper);
	const executableVersion = basename(executableDirectory);
	parseDistributionVersion(executableVersion);
	const installRootSnapshot = directorySnapshot(installRoot, "Pi managed install root changed", helper);
	const bundlesRootSnapshot = directorySnapshot(bundlesRoot, "Pi managed bundles root changed", helper);
	const executingSnapshot = validateInstalledBundle(executableDirectory, executableVersion, target, {
		helper,
		requireFilesystemHelper: process.platform === "win32",
	});
	const candidates = readdirSync(bundlesRoot, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				!entry.name.startsWith(".update-") &&
				!entry.name.startsWith(".cleanup-") &&
				isCompleteInstalledBundle(join(bundlesRoot, entry.name), entry.name, target, helper),
		)
		.map((entry) => entry.name);
	let removed = 0;
	for (const candidate of candidates) {
		const quarantined = withBundleInstallLock<QuarantinedBundleSnapshot | undefined>(installRoot, () => {
			const installRootAtLock = directorySnapshot(installRoot, "Pi managed install root changed", helper);
			const bundlesRootAtLock = directorySnapshot(bundlesRoot, "Pi managed bundles root changed", helper);
			const executingAtLock = validateInstalledBundle(executableDirectory, executableVersion, target, {
				helper,
				requireFilesystemHelper: process.platform === "win32",
			});
			if (
				!samePathSnapshot(installRootSnapshot, installRootAtLock) ||
				!samePathSnapshot(bundlesRootSnapshot, bundlesRootAtLock) ||
				!sameInstalledBundleSnapshot(executingSnapshot, executingAtLock)
			) {
				fail("Pi managed installation changed before cleanup");
			}
			const currentPointer = readBundlePointer(installRoot, bundlesRoot, "current", target, true, helper);
			const previousPointer = readBundlePointer(installRoot, bundlesRoot, "previous", target, false, helper);
			const protectedVersions = new Set([executableVersion, currentPointer?.version, previousPointer?.version]);
			if (protectedVersions.has(candidate)) return undefined;
			const bundleDirectory = join(bundlesRoot, candidate);
			let before: InstalledBundleSnapshot;
			try {
				before = validateInstalledBundle(bundleDirectory, candidate, target, { helper });
			} catch {
				return undefined;
			}
			const quarantine = mkdtempSync(join(bundlesRoot, ".cleanup-"));
			const detachedBundle = join(quarantine, candidate);
			try {
				const currentAtQuarantine = readBundlePointer(installRoot, bundlesRoot, "current", target, true, helper);
				const previousAtQuarantine = readBundlePointer(installRoot, bundlesRoot, "previous", target, false, helper);
				if (
					!sameBundlePointerSnapshot(currentPointer, currentAtQuarantine) ||
					!sameBundlePointerSnapshot(previousPointer, previousAtQuarantine)
				) {
					fail("Release bundle pointers changed before quarantine");
				}
				const installRootAtQuarantine = directorySnapshot(installRoot, "Pi managed install root changed", helper);
				const bundlesRootAtQuarantine = directorySnapshot(bundlesRoot, "Pi managed bundles root changed", helper);
				const executingAtQuarantine = validateInstalledBundle(executableDirectory, executableVersion, target, {
					helper,
					requireFilesystemHelper: process.platform === "win32",
				});
				if (
					!samePathSnapshot(installRootSnapshot, installRootAtQuarantine) ||
					!samePathSnapshot(bundlesRootSnapshot, bundlesRootAtQuarantine) ||
					!sameInstalledBundleSnapshot(executingSnapshot, executingAtQuarantine)
				) {
					fail("Pi managed installation changed before quarantine");
				}
				renameSync(bundleDirectory, detachedBundle);
				const after = validateInstalledBundle(detachedBundle, candidate, target, { detached: true, helper });
				if (!sameInstalledBundleSnapshot(before, after)) fail("Release bundle changed while being quarantined");
				const quarantineSnapshot = directorySnapshot(quarantine, "Release quarantine path is invalid", helper);
				return {
					root: quarantine,
					rootIdentity: quarantineSnapshot.identity,
					bundleDirectory: detachedBundle,
					bundle: after,
					version: candidate,
				};
			} catch (error) {
				if (existsSync(detachedBundle)) {
					if (existsSync(bundleDirectory)) {
						throw new Error(
							`Cannot restore quarantined bundle ${candidate}: ${bundleDirectory} already exists; bundle retained at ${detachedBundle}`,
							{ cause: error },
						);
					}
					try {
						renameSync(detachedBundle, bundleDirectory);
					} catch (restoreError: unknown) {
						const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
						throw new AggregateError(
							[error, restoreError],
							`Failed to restore quarantined bundle ${candidate}: ${message}`,
						);
					}
				}
				try {
					rmdirSync(quarantine);
				} catch {}
				throw error;
			}
		});
		if (!quarantined) continue;
		const quarantineBeforeDelete = directorySnapshot(
			quarantined.root,
			"Release quarantine changed before deletion",
			helper,
		);
		if (quarantineBeforeDelete.identity !== quarantined.rootIdentity) {
			fail("Release quarantine changed before deletion");
		}
		const bundleBeforeDelete = validateInstalledBundle(quarantined.bundleDirectory, quarantined.version, target, {
			detached: true,
			helper,
		});
		if (!sameInstalledBundleSnapshot(quarantined.bundle, bundleBeforeDelete)) {
			fail("Release quarantine changed before deletion");
		}
		removed++;
		rmSync(quarantined.root, { recursive: true, force: true });
	}
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

function samePath(left: string, right: string): boolean {
	const normalizedLeft = resolve(left);
	const normalizedRight = resolve(right);
	return process.platform === "win32"
		? toNamespacedPath(normalizedLeft).toLowerCase() === toNamespacedPath(normalizedRight).toLowerCase()
		: normalizedLeft === normalizedRight;
}

function isWithinPath(child: string, parent: string): boolean {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function failSnapshot(errorMessage: string, error: unknown): never {
	if (error instanceof Error && error.message === errorMessage) throw error;
	throw new Error(errorMessage, { cause: error });
}

function posixDirectorySnapshot(path: string, errorMessage: string): PathSnapshot {
	let direct: ReturnType<typeof lstatSync>;
	try {
		direct = lstatSync(path);
	} catch (error: unknown) {
		return failSnapshot(errorMessage, error);
	}
	if (!direct.isDirectory() || direct.isSymbolicLink()) return fail(errorMessage);
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
	} catch (error: unknown) {
		return failSnapshot(errorMessage, error);
	}
	try {
		const directory = fstatSync(fd);
		if (!directory.isDirectory() || directory.dev !== direct.dev || directory.ino !== direct.ino) {
			return fail(errorMessage);
		}
		const canonicalPath = realpathSync(path);
		const finalDirectory = fstatSync(fd);
		const finalDirect = lstatSync(path);
		if (
			!finalDirectory.isDirectory() ||
			finalDirectory.dev !== directory.dev ||
			finalDirectory.ino !== directory.ino ||
			!finalDirect.isDirectory() ||
			finalDirect.isSymbolicLink() ||
			finalDirect.dev !== directory.dev ||
			finalDirect.ino !== directory.ino
		) {
			return fail(errorMessage);
		}
		if (!samePath(canonicalPath, path)) return fail(errorMessage);
		return { canonicalPath, identity: `${directory.dev}:${directory.ino}` };
	} catch (error: unknown) {
		return failSnapshot(errorMessage, error);
	} finally {
		closeSync(fd);
	}
}

function directorySnapshot(path: string, errorMessage: string, helper?: WindowsFilesystemSnapshotHelper): PathSnapshot {
	if (process.platform !== "win32") return posixDirectorySnapshot(path, errorMessage);
	try {
		const snapshot = snapshotWindowsDirectory(path, helper);
		if (!samePath(snapshot.canonicalPath, path)) return fail(errorMessage);
		return snapshot;
	} catch (error: unknown) {
		return failSnapshot(errorMessage, error);
	}
}

function posixRegularFileSnapshot(
	path: string,
	maximumBytes: number,
	includeContents: boolean,
	errorMessage: string,
): RegularFileSnapshot {
	let direct: ReturnType<typeof lstatSync>;
	try {
		direct = lstatSync(path);
	} catch (error: unknown) {
		return failSnapshot(errorMessage, error);
	}
	if (!direct.isFile()) return fail(errorMessage);
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error: unknown) {
		return failSnapshot(errorMessage, error);
	}
	try {
		const file = fstatSync(fd);
		if (
			!file.isFile() ||
			file.dev !== direct.dev ||
			file.ino !== direct.ino ||
			file.size <= 0 ||
			file.size > maximumBytes
		) {
			return fail(errorMessage);
		}
		let contents: Buffer | undefined;
		if (includeContents) {
			const bytes = Buffer.alloc(file.size + 1);
			let offset = 0;
			while (offset < bytes.length) {
				const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
				if (count === 0) break;
				offset += count;
			}
			if (offset !== file.size) return fail(errorMessage);
			contents = bytes.subarray(0, offset);
		}
		const finalFile = fstatSync(fd);
		const canonicalPath = realpathSync(path);
		const finalDirect = lstatSync(path);
		if (
			finalFile.dev !== file.dev ||
			finalFile.ino !== file.ino ||
			finalFile.size !== file.size ||
			!finalDirect.isFile() ||
			finalDirect.isSymbolicLink() ||
			finalDirect.dev !== file.dev ||
			finalDirect.ino !== file.ino ||
			finalDirect.size !== file.size ||
			!samePath(canonicalPath, path)
		) {
			return fail(errorMessage);
		}
		return {
			canonicalPath,
			identity: `${file.dev}:${file.ino}`,
			size: file.size,
			...(contents ? { contents } : {}),
		};
	} finally {
		closeSync(fd);
	}
}

function regularFileSnapshot(
	path: string,
	maximumBytes: number,
	includeContents: boolean,
	errorMessage: string,
	helper?: WindowsFilesystemSnapshotHelper,
): RegularFileSnapshot {
	if (process.platform !== "win32") return posixRegularFileSnapshot(path, maximumBytes, includeContents, errorMessage);
	try {
		const snapshot = snapshotWindowsRegularFile(path, maximumBytes, includeContents, helper);
		if (!samePath(snapshot.canonicalPath, path) || snapshot.size <= 0) return fail(errorMessage);
		return snapshot;
	} catch (error: unknown) {
		return failSnapshot(errorMessage, error);
	}
}

function getManagedBundleInstall(
	executablePath: string,
	helper?: WindowsFilesystemSnapshotHelper,
): ManagedBundleInstall {
	const requestedExecutable = resolve(executablePath);
	const requestedExecutableDirectory = dirname(requestedExecutable);
	const requestedBundlesRoot = dirname(requestedExecutableDirectory);
	const requestedInstallRoot = dirname(requestedBundlesRoot);
	if (basename(requestedBundlesRoot) !== "bundles") {
		return fail("Pi is not running from a managed bundle installation");
	}
	const installRoot = directorySnapshot(
		requestedInstallRoot,
		"Pi managed bundle installation escapes its install root",
		helper,
	).canonicalPath;
	const bundlesRoot = directorySnapshot(
		requestedBundlesRoot,
		"Pi managed bundle installation escapes its install root",
		helper,
	).canonicalPath;
	const executableDirectory = directorySnapshot(
		requestedExecutableDirectory,
		"Pi managed bundle installation escapes its install root",
		helper,
	).canonicalPath;
	regularFileSnapshot(
		requestedExecutable,
		BUNDLE_MAX_BYTES,
		false,
		"Pi managed bundle executable is not a regular file",
		helper,
	);
	if (
		!samePath(installRoot, requestedInstallRoot) ||
		!samePath(bundlesRoot, requestedBundlesRoot) ||
		!samePath(executableDirectory, requestedExecutableDirectory) ||
		!isWithinPath(bundlesRoot, installRoot) ||
		!isWithinPath(executableDirectory, bundlesRoot) ||
		!samePath(dirname(executableDirectory), bundlesRoot)
	) {
		return fail("Pi managed bundle installation escapes its install root");
	}
	return { installRoot, bundlesRoot, executableDirectory };
}

function samePathSnapshot(left: PathSnapshot, right: PathSnapshot): boolean {
	return left.identity === right.identity && samePath(left.canonicalPath, right.canonicalPath);
}

function readBoundedRegularFile(
	path: string,
	maximumBytes: number,
	errorMessage: string,
	helper?: WindowsFilesystemSnapshotHelper,
): string {
	const snapshot = regularFileSnapshot(path, maximumBytes, true, errorMessage, helper);
	if (!snapshot.contents) return fail(errorMessage);
	return snapshot.contents.toString("utf8");
}

function validateInstalledBundle(
	bundleDirectory: string,
	version: string,
	target: string,
	options: BundleValidationOptions = {},
): InstalledBundleSnapshot {
	const { detached = false, helper, requireFilesystemHelper = false, requireFilesystemHelperFile = false } = options;
	const isStaging = basename(bundleDirectory).startsWith(".update-");
	if (!isStaging && !detached && basename(bundleDirectory) !== version) {
		fail("Release bundle path is invalid");
	}
	const parent = directorySnapshot(dirname(bundleDirectory), "Release bundle path is invalid", helper);
	const directory = directorySnapshot(bundleDirectory, "Release bundle path is invalid", helper);
	if (
		!samePath(directory.canonicalPath, bundleDirectory) ||
		!samePath(parent.canonicalPath, dirname(bundleDirectory))
	) {
		fail("Release bundle path is invalid");
	}
	const requiredFileIdentities: string[] = [];
	for (const [required, maximum] of [
		[BUNDLE_WRAPPER_NAME, BUNDLE_WRAPPER_MAX_BYTES],
		[BUNDLE_EXECUTABLE_NAME, BUNDLE_MAX_BYTES],
		["package.json", BUNDLE_PACKAGE_MAX_BYTES],
	] as const) {
		const snapshot = regularFileSnapshot(
			join(bundleDirectory, required),
			maximum,
			false,
			`Release bundle is missing required path ${required}`,
			helper,
		);
		requiredFileIdentities.push(snapshot.identity);
	}
	let filesystemHelperDigest: string | undefined;
	if (requireFilesystemHelper || requireFilesystemHelperFile) {
		const helperPath = join(bundleDirectory, getWindowsFilesystemSnapshotRelativePath());
		const helperSnapshot = regularFileSnapshot(
			helperPath,
			BUNDLE_FILESYSTEM_HELPER_MAX_BYTES,
			true,
			"Release bundle is missing the Windows filesystem snapshot helper",
			helper,
		);
		requiredFileIdentities.push(helperSnapshot.identity);
		if (!helperSnapshot.contents) fail("Release bundle Windows filesystem snapshot helper is unreadable");
		filesystemHelperDigest = createHash("sha256").update(helperSnapshot.contents).digest("hex");
		if (requireFilesystemHelper) {
			loadValidatedBundledWindowsFilesystemSnapshotHelper(
				bundleDirectory,
				directory.identity,
				"Release bundle Windows filesystem snapshot helper failed validation",
			);
		}
	}
	let pkg: InstalledBundlePackage;
	try {
		pkg = JSON.parse(
			readBoundedRegularFile(
				join(bundleDirectory, "package.json"),
				BUNDLE_PACKAGE_MAX_BYTES,
				"Release bundle package.json is invalid",
				helper,
			),
		);
	} catch {
		fail("Release bundle package.json is invalid");
	}
	if (
		pkg.name !== "@earendil-works/pi-coding-agent" ||
		pkg.version !== version ||
		pkg.piConfig?.distribution !== "xz-dev" ||
		pkg.piConfig.releaseTarget !== target
	) {
		fail("Release bundle package identity mismatch");
	}
	return { directoryIdentity: directory.identity, requiredFileIdentities, filesystemHelperDigest };
}

function loadValidatedBundledWindowsFilesystemSnapshotHelper(
	bundleDirectory: string,
	expectedDirectoryIdentity: string,
	errorMessage: string,
): WindowsFilesystemSnapshotHelper {
	try {
		const helperPath = join(bundleDirectory, getWindowsFilesystemSnapshotRelativePath());
		const bundledHelper = loadWindowsFilesystemSnapshotHelper({ candidates: [helperPath] });
		const bundledDirectory = snapshotWindowsDirectory(bundleDirectory, bundledHelper);
		if (
			!samePath(bundledDirectory.canonicalPath, bundleDirectory) ||
			bundledDirectory.identity !== expectedDirectoryIdentity
		) {
			fail(errorMessage);
		}
		return bundledHelper;
	} catch (error: unknown) {
		return failSnapshot(errorMessage, error);
	}
}

function sameInstalledBundleSnapshot(left: InstalledBundleSnapshot, right: InstalledBundleSnapshot): boolean {
	return (
		left.directoryIdentity === right.directoryIdentity &&
		left.requiredFileIdentities.length === right.requiredFileIdentities.length &&
		left.requiredFileIdentities.every((identity, index) => identity === right.requiredFileIdentities[index]) &&
		left.filesystemHelperDigest === right.filesystemHelperDigest
	);
}

function validateWindowsFilesystemSnapshotProbe(
	probeExecutablePath: string,
	bundleDirectory: string,
	version: string,
	expected: InstalledBundleSnapshot,
): void {
	if (process.platform !== "win32") return;
	const nonce = randomBytes(32).toString("hex");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_INTERNAL_WIN32_FILESYSTEM_SNAPSHOT_PROBE: nonce,
		PI_INTERNAL_WIN32_FILESYSTEM_SNAPSHOT_VERSION: version,
		PI_INTERNAL_WIN32_FILESYSTEM_SNAPSHOT_BUNDLE: bundleDirectory,
	};
	delete env.NODE_OPTIONS;
	delete env.BUN_OPTIONS;
	const result = spawnSync(probeExecutablePath, [], {
		cwd: dirname(probeExecutablePath),
		env,
		encoding: "utf8",
		maxBuffer: 64 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
		windowsHide: true,
	});
	if (result.error || result.status !== 0 || result.signal) {
		const detail = result.error?.message ?? (result.stderr.trim() || `exit status ${result.status ?? "unknown"}`);
		fail(`Release bundle Windows filesystem snapshot helper probe failed: ${detail}`);
	}
	let report: unknown;
	try {
		report = JSON.parse(result.stdout);
	} catch {
		fail("Release bundle Windows filesystem snapshot helper probe returned invalid output");
	}
	if (
		!isRecord(report) ||
		report.nonce !== nonce ||
		report.directoryIdentity !== expected.directoryIdentity ||
		report.filesystemHelperDigest !== expected.filesystemHelperDigest ||
		!Array.isArray(report.requiredFileIdentities) ||
		report.requiredFileIdentities.length !== expected.requiredFileIdentities.length ||
		!report.requiredFileIdentities.every(
			(identity, index) => typeof identity === "string" && identity === expected.requiredFileIdentities[index],
		)
	) {
		fail("Release bundle Windows filesystem snapshot helper probe returned inconsistent results");
	}
}

function validateActivationDestination(
	probeExecutablePath: string,
	bundleDirectory: string,
	version: string,
	target: string,
	executingHelper?: WindowsFilesystemSnapshotHelper,
): ActivationDestinationSnapshot {
	const snapshot = validateInstalledBundle(bundleDirectory, version, target, {
		helper: executingHelper,
		requireFilesystemHelperFile: process.platform === "win32",
	});
	validateWindowsFilesystemSnapshotProbe(probeExecutablePath, bundleDirectory, version, snapshot);
	return { bundle: snapshot };
}

function readBundlePointer(
	installRoot: string,
	bundlesRoot: string,
	name: "current" | "previous",
	target: string,
	required = name === "current",
	helper?: WindowsFilesystemSnapshotHelper,
): BundlePointerSnapshot | undefined {
	const path = join(installRoot, name);
	if (!existsSync(path)) {
		if (!required) return undefined;
		return fail(`Invalid ${name} bundle pointer`);
	}
	try {
		const pointer = regularFileSnapshot(
			path,
			BUNDLE_POINTER_MAX_BYTES,
			true,
			`Invalid ${name} bundle pointer`,
			helper,
		);
		if (!pointer.contents) return fail(`Invalid ${name} bundle pointer`);
		const version = pointer.contents.toString("utf8").trim();
		parseDistributionVersion(version);
		const targetSnapshot = validateInstalledBundle(join(bundlesRoot, version), version, target, { helper });
		return { version, contents: pointer.contents, fileIdentity: pointer.identity, target: targetSnapshot };
	} catch {
		return fail(`Invalid ${name} bundle pointer`);
	}
}

function sameBundlePointerSnapshot(
	left: BundlePointerSnapshot | undefined,
	right: BundlePointerSnapshot | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.version === right.version &&
		left.contents.equals(right.contents) &&
		left.fileIdentity === right.fileIdentity &&
		sameInstalledBundleSnapshot(left.target, right.target)
	);
}

function isCompleteInstalledBundle(
	bundleDirectory: string,
	version: string,
	target: string,
	helper?: WindowsFilesystemSnapshotHelper,
): boolean {
	try {
		parseDistributionVersion(version);
		validateInstalledBundle(bundleDirectory, version, target, { helper });
		return true;
	} catch {
		return false;
	}
}

function withBundleInstallLock<T>(installRoot: string, action: () => T): T {
	const updatePath = join(installRoot, "update");
	let release: () => void;
	try {
		release = lockfile.lockSync(updatePath, {
			lockfilePath: join(installRoot, "update.lock"),
			realpath: false,
			stale: BUNDLE_LOCK_STALE_MS,
			update: BUNDLE_LOCK_UPDATE_MS,
		});
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
			return fail("Another Pi update or cleanup is already running");
		}
		throw error;
	}
	try {
		return action();
	} finally {
		release();
	}
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

export function runWindowsFilesystemSnapshotProbe(): boolean {
	const nonce = process.env.PI_INTERNAL_WIN32_FILESYSTEM_SNAPSHOT_PROBE;
	if (nonce === undefined) return false;
	try {
		const version = process.env.PI_INTERNAL_WIN32_FILESYSTEM_SNAPSHOT_VERSION;
		const requestedBundleDirectory = process.env.PI_INTERNAL_WIN32_FILESYSTEM_SNAPSHOT_BUNDLE;
		if (
			process.platform !== "win32" ||
			!/^[0-9a-f]{64}$/.test(nonce) ||
			!version ||
			!requestedBundleDirectory ||
			!isAbsolute(requestedBundleDirectory) ||
			!RELEASE_TARGET
		) {
			fail("Invalid Windows filesystem snapshot probe request");
		}
		const bundleDirectory = resolve(requestedBundleDirectory);
		if (!samePath(bundleDirectory, requestedBundleDirectory))
			fail("Invalid Windows filesystem snapshot probe request");
		parseDistributionVersion(version);
		const executableDirectory = dirname(process.execPath);
		const parentDirectory = dirname(executableDirectory);
		const managedExecution = basename(parentDirectory) === "bundles";
		const installRoot = managedExecution ? dirname(parentDirectory) : executableDirectory;
		const bundlesRoot = join(installRoot, "bundles");
		const trustedHelper = loadWindowsFilesystemSnapshotHelper({
			candidates: [join(executableDirectory, getWindowsFilesystemSnapshotRelativePath())],
		});
		if (managedExecution) {
			const managed = getManagedBundleInstall(process.execPath, trustedHelper);
			if (
				!samePath(managed.installRoot, installRoot) ||
				!samePath(managed.bundlesRoot, bundlesRoot) ||
				!samePath(managed.executableDirectory, executableDirectory)
			) {
				fail("Invalid Windows filesystem snapshot probe request");
			}
		} else {
			const installRootSnapshot = directorySnapshot(
				installRoot,
				"Invalid Windows filesystem snapshot probe request",
				trustedHelper,
			);
			const bundlesRootSnapshot = directorySnapshot(
				bundlesRoot,
				"Invalid Windows filesystem snapshot probe request",
				trustedHelper,
			);
			if (
				!samePath(installRootSnapshot.canonicalPath, installRoot) ||
				!samePath(bundlesRootSnapshot.canonicalPath, bundlesRoot) ||
				!isWithinPath(bundlesRootSnapshot.canonicalPath, installRootSnapshot.canonicalPath)
			) {
				fail("Invalid Windows filesystem snapshot probe request");
			}
		}
		if (
			!samePath(dirname(bundleDirectory), bundlesRoot) ||
			(basename(bundleDirectory) !== version && !basename(bundleDirectory).startsWith(".update-"))
		) {
			fail("Invalid Windows filesystem snapshot probe request");
		}
		const trustedSnapshot = validateInstalledBundle(bundleDirectory, version, RELEASE_TARGET, {
			helper: trustedHelper,
			requireFilesystemHelperFile: true,
		});
		const helper = loadWindowsFilesystemSnapshotHelper({
			candidates: [join(bundleDirectory, getWindowsFilesystemSnapshotRelativePath())],
		});
		const snapshot = validateInstalledBundle(bundleDirectory, version, RELEASE_TARGET, {
			helper,
			requireFilesystemHelperFile: true,
		});
		if (!sameInstalledBundleSnapshot(trustedSnapshot, snapshot)) {
			fail("Release bundle Windows filesystem snapshot helper returned inconsistent results");
		}
		process.stdout.write(`${JSON.stringify({ nonce, ...snapshot })}\n`);
	} catch (error: unknown) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
	return true;
}

export async function runXzSelfUpdate(
	release: XzLatestRelease,
	currentVersion: string,
	_force = false,
	options: XzSelfUpdateOptions = {},
): Promise<void> {
	if (!RELEASE_TARGET) return fail("xz-dev Release target metadata is missing from this binary");
	const target = RELEASE_TARGET;
	const executablePath = options.executablePath ?? process.execPath;
	const executableDirectory = dirname(executablePath);
	const parentDirectory = dirname(executableDirectory);
	const managedExecution = basename(parentDirectory) === "bundles";
	const installRoot = managedExecution ? dirname(parentDirectory) : executableDirectory;
	const bundlesRoot = join(installRoot, "bundles");
	const destination = join(bundlesRoot, release.version);
	const wrapperName = BUNDLE_WRAPPER_NAME;
	const executableName = BUNDLE_EXECUTABLE_NAME;
	const currentPath = join(installRoot, "current");
	const previousPath = join(installRoot, "previous");
	const helper =
		process.platform === "win32"
			? loadWindowsFilesystemSnapshotHelper({
					candidates: [join(executableDirectory, getWindowsFilesystemSnapshotRelativePath())],
				})
			: undefined;
	let executingVersion: string;
	let executingSnapshot: InstalledBundleSnapshot;
	if (managedExecution) {
		const managed = getManagedBundleInstall(executablePath, helper);
		if (
			!samePath(managed.installRoot, installRoot) ||
			!samePath(managed.bundlesRoot, bundlesRoot) ||
			!samePath(managed.executableDirectory, executableDirectory)
		) {
			fail("Pi managed bundle installation is invalid before staging");
		}
		executingVersion = basename(executableDirectory);
		parseDistributionVersion(executingVersion);
		executingSnapshot = validateInstalledBundle(executableDirectory, executingVersion, target, {
			helper,
			requireFilesystemHelper: process.platform === "win32",
		});
	} else {
		executingVersion = currentVersion;
		parseDistributionVersion(executingVersion);
		executingSnapshot = validateInstalledBundle(executableDirectory, executingVersion, target, {
			detached: true,
			helper,
			requireFilesystemHelper: process.platform === "win32",
		});
	}
	const directory = mkdtempSync(join(tmpdir(), "pi-xz-self-update-"));
	const archive = join(directory, release.bundle.name);
	mkdirSync(bundlesRoot, { recursive: true });
	const installRootSnapshot = directorySnapshot(installRoot, "Pi self-update install root is invalid", helper);
	const bundlesRootSnapshot = directorySnapshot(bundlesRoot, "Pi self-update bundles root is invalid", helper);
	if (
		!samePath(installRootSnapshot.canonicalPath, installRoot) ||
		!samePath(bundlesRootSnapshot.canonicalPath, bundlesRoot) ||
		!isWithinPath(bundlesRootSnapshot.canonicalPath, installRootSnapshot.canonicalPath)
	) {
		fail("Pi self-update bundles root escapes its install root");
	}
	const staging = mkdtempSync(join(bundlesRoot, ".update-"));
	try {
		await downloadBundle(release, currentVersion, archive, options);
		extractZipArchive(archive, staging, release.bundle.name);
		const stagingSnapshot = validateInstalledBundle(staging, release.version, target, {
			helper,
			requireFilesystemHelperFile: process.platform === "win32",
		});
		const stagingDestination = validateActivationDestination(
			executablePath,
			staging,
			release.version,
			target,
			helper,
		);
		if (!sameInstalledBundleSnapshot(stagingSnapshot, stagingDestination.bundle)) {
			fail("Release bundle Windows filesystem snapshot helper returned inconsistent results");
		}
		withBundleInstallLock(installRoot, () => {
			const installRootAtActivation = directorySnapshot(installRoot, "Pi self-update install root changed", helper);
			const bundlesRootAtActivation = directorySnapshot(bundlesRoot, "Pi self-update bundles root changed", helper);
			if (
				!samePathSnapshot(installRootSnapshot, installRootAtActivation) ||
				!samePathSnapshot(bundlesRootSnapshot, bundlesRootAtActivation) ||
				!isWithinPath(bundlesRootAtActivation.canonicalPath, installRootAtActivation.canonicalPath)
			) {
				fail("Pi self-update install layout changed before activation");
			}
			let executingAtActivation: InstalledBundleSnapshot;
			if (managedExecution) {
				const managed = getManagedBundleInstall(executablePath, helper);
				if (
					!samePath(managed.installRoot, installRoot) ||
					!samePath(managed.bundlesRoot, bundlesRoot) ||
					!samePath(managed.executableDirectory, executableDirectory)
				) {
					fail("Pi managed bundle installation changed before activation");
				}
				parseDistributionVersion(executingVersion);
				executingAtActivation = validateInstalledBundle(executableDirectory, executingVersion, target, {
					helper,
					requireFilesystemHelper: process.platform === "win32",
				});
			} else {
				executingAtActivation = validateInstalledBundle(executableDirectory, executingVersion, target, {
					detached: true,
					helper,
					requireFilesystemHelper: process.platform === "win32",
				});
			}
			if (!sameInstalledBundleSnapshot(executingSnapshot, executingAtActivation)) {
				fail("Pi executing bundle changed before activation");
			}
			const activePointer = readBundlePointer(installRoot, bundlesRoot, "current", target, managedExecution, helper);
			const rollbackPointer = readBundlePointer(installRoot, bundlesRoot, "previous", target, false, helper);
			if (!activePointer && rollbackPointer) fail("Invalid previous bundle pointer");
			const activeVersion = activePointer?.version;
			const rollbackVersion = rollbackPointer?.version;

			const stagingAtInstall = validateInstalledBundle(staging, release.version, target, {
				helper,
				requireFilesystemHelperFile: process.platform === "win32",
			});
			if (!sameInstalledBundleSnapshot(stagingSnapshot, stagingAtInstall)) {
				fail("Release bundle changed before installation");
			}
			const protectedVersions = new Set([
				activeVersion,
				rollbackVersion,
				managedExecution ? basename(executableDirectory) : undefined,
			]);
			let existingDestination: ActivationDestinationSnapshot | undefined;
			if (existsSync(destination)) {
				if (protectedVersions.has(release.version)) {
					existingDestination = validateActivationDestination(
						executablePath,
						destination,
						release.version,
						target,
						helper,
					);
				} else {
					const rejectedRoot = mkdtempSync(join(bundlesRoot, ".update-rejected-"));
					const rejectedDestination = join(rejectedRoot, release.version);
					try {
						renameSync(destination, rejectedDestination);
					} catch (quarantineError: unknown) {
						try {
							rmdirSync(rejectedRoot);
						} catch {}
						throw new Error(`Failed to quarantine existing unactivated bundle ${release.version}`, {
							cause: quarantineError,
						});
					}
				}
			}
			const installedFromStaging = !existingDestination;
			if (installedFromStaging) renameSync(staging, destination);
			const installedDestination = existingDestination ?? {
				bundle: validateInstalledBundle(destination, release.version, target, {
					helper,
					requireFilesystemHelperFile: process.platform === "win32",
				}),
			};
			if (installedFromStaging && !sameInstalledBundleSnapshot(stagingSnapshot, installedDestination.bundle)) {
				fail("Release bundle changed while being installed");
			}

			const executingBeforeWrapper = validateInstalledBundle(executableDirectory, executingVersion, target, {
				detached: !managedExecution,
				helper,
				requireFilesystemHelper: process.platform === "win32",
			});
			if (!sameInstalledBundleSnapshot(executingSnapshot, executingBeforeWrapper)) {
				fail("Pi executing bundle changed before wrapper activation");
			}
			if (process.platform !== "win32") {
				const nextWrapper = join(installRoot, `.${wrapperName}.next-${process.pid}`);
				copyFileSync(join(destination, wrapperName), nextWrapper);
				chmodSync(nextWrapper, 0o755);
				chmodSync(join(destination, executableName), 0o755);
				renameSync(nextWrapper, join(installRoot, wrapperName));
			}

			const pointerTransaction = mkdtempSync(join(installRoot, ".update-pointers-"));
			let retainPointerTransaction = false;
			try {
				const nextCurrent = join(pointerTransaction, "current.next");
				writeFileSync(nextCurrent, `${release.version}\n`, { flag: "wx" });
				const publishPrevious = activeVersion !== undefined && activeVersion !== release.version;
				const nextPrevious = join(pointerTransaction, "previous.next");
				const originalPrevious = join(pointerTransaction, "previous.original");
				const failedPrevious = join(pointerTransaction, "previous.failed");
				let originalPreviousMoved = false;
				let nextPreviousPublished = false;
				const restorePrevious = (activationError: unknown): never => {
					try {
						if (nextPreviousPublished) {
							rmSync(previousPath, { force: true });
							nextPreviousPublished = false;
						}
						if (originalPreviousMoved) {
							renameSync(originalPrevious, previousPath);
							originalPreviousMoved = false;
						}
					} catch (restoreError: unknown) {
						retainPointerTransaction = true;
						throw new AggregateError(
							[activationError, restoreError],
							`Failed to restore Pi activation pointers; recovery data retained at ${pointerTransaction}`,
						);
					}
					throw activationError;
				};

				if (publishPrevious) {
					writeFileSync(nextPrevious, `${activeVersion}\n`, { flag: "wx" });
					writeFileSync(failedPrevious, `${activeVersion}\n`, { flag: "wx" });
				}
				if (managedExecution || process.platform === "win32") {
					const executingAtPublication = validateInstalledBundle(executableDirectory, executingVersion, target, {
						detached: !managedExecution,
						helper,
						requireFilesystemHelper: process.platform === "win32",
					});
					if (!sameInstalledBundleSnapshot(executingSnapshot, executingAtPublication)) {
						fail("Pi executing bundle changed before pointer publication");
					}
				}
				const currentAtPublication = readBundlePointer(
					installRoot,
					bundlesRoot,
					"current",
					target,
					managedExecution,
					helper,
				);
				const previousAtPublication = readBundlePointer(
					installRoot,
					bundlesRoot,
					"previous",
					target,
					false,
					helper,
				);
				if (
					!sameBundlePointerSnapshot(activePointer, currentAtPublication) ||
					!sameBundlePointerSnapshot(rollbackPointer, previousAtPublication)
				) {
					fail("Pi activation pointers changed before publication");
				}
				const installRootAtPublication = directorySnapshot(
					installRoot,
					"Pi self-update install root changed before pointer publication",
					helper,
				);
				const bundlesRootAtPublication = directorySnapshot(
					bundlesRoot,
					"Pi self-update bundles root changed before pointer publication",
					helper,
				);
				if (
					!samePathSnapshot(installRootSnapshot, installRootAtPublication) ||
					!samePathSnapshot(bundlesRootSnapshot, bundlesRootAtPublication)
				) {
					fail("Pi self-update install layout changed before pointer publication");
				}
				const destinationAtPublication = validateInstalledBundle(destination, release.version, target, {
					helper,
					requireFilesystemHelperFile: process.platform === "win32",
				});
				if (!sameInstalledBundleSnapshot(installedDestination.bundle, destinationAtPublication)) {
					fail("Release bundle changed before activation pointer publication");
				}
				if (publishPrevious) {
					if (rollbackVersion !== undefined) {
						renameSync(previousPath, originalPrevious);
						originalPreviousMoved = true;
					}
					try {
						renameSync(nextPrevious, previousPath);
						nextPreviousPublished = true;
					} catch (error: unknown) {
						restorePrevious(error);
					}
				}
				try {
					renameSync(nextCurrent, currentPath);
				} catch (error: unknown) {
					restorePrevious(error);
				}
			} finally {
				if (!retainPointerTransaction) {
					try {
						rmSync(pointerTransaction, { recursive: true, force: true });
					} catch {}
				}
			}
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
		rmSync(staging, { recursive: true, force: true });
	}
}
