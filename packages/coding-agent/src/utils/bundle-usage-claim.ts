import { existsSync, lstatSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { types as utilTypes } from "node:util";

/**
 * Kernel-held usage claims that let `pi update --clean` retire managed bundles
 * without deleting resources a live Pi process still depends on.
 *
 * Startup acquires a shared claim before bundle-dependent work; maintenance
 * acquires an exclusive claim and holds it through quarantine and resource
 * deletion. Claims live in the kernel (flock on POSIX, LockFileEx on Windows),
 * so process death releases them with no stale-state recovery.
 */

const USAGE_CLAIM_MODULE_PATH = "pi-usage-claim.node";
const GUARD_NAME = "usage.lock";
const GUARD_PAYLOAD = Buffer.from("P");
const USAGE_CLAIM_PROTOCOL = 1;

const KNOWN_REMOTE_FILESYSTEMS = new Map<bigint, string>([
	[0x6969n, "NFS"],
	[0x517bn, "SMB"],
	[0xff534d42n, "CIFS"],
	[0xfe534d42n, "SMB2"],
	[0x5346414fn, "AFS"],
	[0x00c36400n, "Ceph"],
	[0x564cn, "NCP"],
	[0x01021997n, "9P"],
]);
const warnedRemoteFilesystemTypes = new Set<bigint>();

export type UsageClaimOutcome = "acquired" | "busy";
export type ValidatedSessionClaimOutcome = UsageClaimOutcome | "stale";

export interface ScopedRetirementClaim {
	readonly kind: "scoped-retirement-claim";
	release(): void;
}

interface UsageClaimNativeModule {
	acquire(path: string, mode: "shared" | "exclusive", scope: "session" | "scoped"): UsageClaimOutcome | unknown;
	releaseScoped(handle: unknown): string;
	sessionHeld(): boolean;
}

type NativeModuleLoader = (path: string) => unknown;

let loadedModule: UsageClaimNativeModule | undefined;

export function getUsageClaimModuleRelativePath(): string {
	return join("native", "usage-claim", USAGE_CLAIM_MODULE_PATH);
}

function isUsageClaimNativeModule(value: unknown): value is UsageClaimNativeModule {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<UsageClaimNativeModule>;
	return (
		typeof candidate.acquire === "function" &&
		typeof candidate.releaseScoped === "function" &&
		typeof candidate.sessionHeld === "function"
	);
}

interface LoadOptions {
	candidates?: readonly string[];
	exists?: (path: string) => boolean;
	loadModule?: NativeModuleLoader;
}

/** Return a recognized remote filesystem name; generic FUSE is intentionally absent. */
export function knownRemoteFilesystemName(type: bigint): string | undefined {
	return KNOWN_REMOTE_FILESYSTEMS.get(type);
}

export function warnForKnownRemoteFilesystemType(type: bigint): boolean {
	const name = knownRemoteFilesystemName(type);
	if (!name || warnedRemoteFilesystemTypes.has(type)) return false;
	warnedRemoteFilesystemTypes.add(type);
	process.stderr.write(
		`Warning: Pi bundle usage locks are on ${name}; cross-host lock behavior depends on filesystem and mount configuration. Cleanup will continue.\n`,
	);
	return true;
}

/**
 * Best-effort warning only. Filesystem type never permits or blocks cleanup;
 * actual flock/LockFileEx results remain authoritative by user decision.
 */
export function warnIfKnownRemoteUsageFilesystem(path: string): void {
	try {
		warnForKnownRemoteFilesystemType(statfsSync(path, { bigint: true }).type);
	} catch {
		// Classification is advisory only. Failure to classify does not alter
		// startup or cleanup behavior.
	}
}

/** Load the packaged native usage-claim module, with no fallback backend. */
export function loadUsageClaimModule(options: LoadOptions = {}): UsageClaimNativeModule {
	if (!options.candidates && loadedModule) return loadedModule;
	const exists = options.exists ?? existsSync;
	const loadModule = options.loadModule ?? createRequire(import.meta.url);
	const candidates = options.candidates ?? [join(dirname(process.execPath), getUsageClaimModuleRelativePath())];
	const override = process.env.PI_USAGE_CLAIM_MODULE;
	const ordered = override ? [override, ...candidates] : candidates;
	const modulePath = ordered.find((candidate) => exists(candidate));
	if (!modulePath) throw new Error("Pi usage claim module is missing from this installation");
	let value: unknown;
	try {
		value = loadModule(modulePath);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not load the Pi usage claim module at ${modulePath}: ${message}`, { cause: error });
	}
	if (!isUsageClaimNativeModule(value)) {
		throw new Error(`Pi usage claim module at ${modulePath} does not expose the required API`);
	}
	if (!options.candidates) loadedModule = value;
	return value;
}

function outcomeOf(result: UsageClaimOutcome | unknown, context: string): UsageClaimOutcome {
	if (result === "acquired" || result === "busy") return result;
	throw new Error(`${context}: unexpected result ${String(result)}`);
}

/** True when this process holds its session usage claim. */
export function sessionUsageClaimHeld(module: UsageClaimNativeModule = loadUsageClaimModule()): boolean {
	return module.sessionHeld();
}

/** Acquire the process-lifetime shared claim for a validated managed bundle. */
export function acquireSessionUsageClaim(
	guardPath: string,
	module: UsageClaimNativeModule = loadUsageClaimModule(),
): UsageClaimOutcome {
	return outcomeOf(module.acquire(guardPath, "shared", "session"), "Could not acquire the session usage claim");
}

/** Acquire an exclusive claim; only an explicit native owner is authority. */
export function acquireRetirementClaim(
	guardPath: string,
	module: UsageClaimNativeModule = loadUsageClaimModule(),
): ScopedRetirementClaim | "busy" {
	const result = module.acquire(guardPath, "exclusive", "scoped");
	if (result === "busy") return result;
	// A scoped owner must be an actual N-API external value. Ordinary objects
	// (`{}`, arrays, Error instances) are not kernel ownership and must never
	// become deletion authority.
	if (!utilTypes.isExternal(result)) {
		throw new Error(`Unexpected usage-claim acquisition result: ${String(result)}`);
	}
	let released = false;
	return {
		kind: "scoped-retirement-claim",
		release() {
			if (released) return;
			module.releaseScoped(result);
			released = true;
		},
	};
}

export interface ManagedUsageClaimPaths {
	installRoot: string;
	bundlesRoot: string;
	bundleDirectory: string;
	executablePath: string;
	guardPath: string;
	modulePath: string;
	packagePath: string;
}

class NotManagedBundleExecution extends Error {}
class InvalidManagedBundleExecution extends Error {}

/** Resolve a published managed generation or classify the execution safely. */
export function resolveManagedUsageClaimPaths(executablePath: string): ManagedUsageClaimPaths {
	const requestedExecutable = resolve(executablePath);
	const bundleDirectory = dirname(requestedExecutable);
	const bundlesRoot = dirname(bundleDirectory);
	const installRoot = dirname(bundlesRoot);
	const bundlesRootName = basename(bundlesRoot);
	const bundlesRootParentName = basename(dirname(bundlesRoot));
	if (bundlesRootName !== "bundles") {
		// `<root>/bundles/.cleanup-X/V/pi-native` and
		// `.update-rejected-X/V/pi-native` are managed maintenance paths, not
		// unmanaged installations. Starting from them must fail closed.
		if (bundlesRootParentName === "bundles" && bundlesRootName.startsWith(".")) {
			throw new InvalidManagedBundleExecution("Pi is running from an unpublished bundle generation");
		}
		throw new NotManagedBundleExecution("Pi is not running from a managed bundle installation");
	}
	const bundleName = basename(bundleDirectory);
	if (!bundleName || bundleName.startsWith(".")) {
		throw new InvalidManagedBundleExecution("Pi is running from an unpublished bundle generation");
	}
	const expectedExecutable = process.platform === "win32" ? "pi-native.exe" : "pi-native";
	if (basename(requestedExecutable) !== expectedExecutable) {
		throw new InvalidManagedBundleExecution("Pi managed bundle executable name is invalid");
	}
	return {
		installRoot,
		bundlesRoot,
		bundleDirectory,
		executablePath: requestedExecutable,
		guardPath: join(bundleDirectory, GUARD_NAME),
		modulePath: join(bundleDirectory, getUsageClaimModuleRelativePath()),
		packagePath: join(bundleDirectory, "package.json"),
	};
}

interface PathIdentity {
	dev: number;
	ino: number;
}

export interface ManagedUsageClaimSnapshot {
	paths: ManagedUsageClaimPaths;
	directory: PathIdentity;
	executable: PathIdentity;
	guard: PathIdentity;
	module: PathIdentity;
	package: PathIdentity;
}

function identity(path: string, kind: "directory" | "file"): PathIdentity {
	const direct = lstatSync(path);
	if (kind === "directory" ? !direct.isDirectory() : !direct.isFile()) {
		throw new InvalidManagedBundleExecution(`Pi managed bundle ${kind} identity is invalid: ${path}`);
	}
	const canonical = realpathSync(path);
	const requested = resolve(path);
	const samePath =
		process.platform === "win32" ? canonical.toLowerCase() === requested.toLowerCase() : canonical === requested;
	if (!samePath) throw new InvalidManagedBundleExecution(`Pi managed bundle path is indirect: ${path}`);
	return { dev: direct.dev, ino: direct.ino };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/** Validate the published generation and capture every lock-relevant identity. */
export function snapshotManagedUsageClaimGeneration(paths: ManagedUsageClaimPaths): ManagedUsageClaimSnapshot {
	const directory = identity(paths.bundleDirectory, "directory");
	const executable = identity(paths.executablePath, "file");
	const guard = identity(paths.guardPath, "file");
	const module = identity(paths.modulePath, "file");
	const packageIdentity = identity(paths.packagePath, "file");
	if (!readFileSync(paths.guardPath).equals(GUARD_PAYLOAD)) {
		throw new InvalidManagedBundleExecution("Pi managed bundle usage guard payload is invalid");
	}
	const pkg = JSON.parse(readFileSync(paths.packagePath, "utf8")) as {
		name?: unknown;
		version?: unknown;
		piConfig?: { distribution?: unknown; releaseTarget?: unknown; usageClaimProtocol?: unknown };
	};
	if (
		pkg.name !== "@earendil-works/pi-coding-agent" ||
		pkg.version !== basename(paths.bundleDirectory) ||
		pkg.piConfig?.distribution !== "xz-dev" ||
		typeof pkg.piConfig.releaseTarget !== "string" ||
		pkg.piConfig.usageClaimProtocol !== USAGE_CLAIM_PROTOCOL
	) {
		throw new InvalidManagedBundleExecution("Pi managed bundle protocol declaration is invalid");
	}
	return { paths, directory, executable, guard, module, package: packageIdentity };
}

/** Acquire shared ownership, then verify it still protects the same generation. */
export function acquireValidatedSessionUsageClaim(
	before: ManagedUsageClaimSnapshot,
	module: UsageClaimNativeModule = loadUsageClaimModule(),
): ValidatedSessionClaimOutcome {
	const outcome = acquireSessionUsageClaim(before.paths.guardPath, module);
	if (outcome !== "acquired") return outcome;
	let current: ManagedUsageClaimSnapshot;
	try {
		current = snapshotManagedUsageClaimGeneration(before.paths);
	} catch {
		return "stale";
	}
	return sameIdentity(before.directory, current.directory) &&
		sameIdentity(before.executable, current.executable) &&
		sameIdentity(before.guard, current.guard) &&
		sameIdentity(before.module, current.module) &&
		sameIdentity(before.package, current.package)
		? "acquired"
		: "stale";
}

/** Register before the compiled entry evaluates bundle-dependent modules. */
export function registerSessionUsageClaimAtStartup(executablePath: string): void {
	let paths: ManagedUsageClaimPaths;
	try {
		paths = resolveManagedUsageClaimPaths(executablePath);
	} catch (error: unknown) {
		if (error instanceof NotManagedBundleExecution) return;
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
		return;
	}
	let before: ManagedUsageClaimSnapshot;
	try {
		before = snapshotManagedUsageClaimGeneration(paths);
	} catch (error: unknown) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
		return;
	}
	let outcome: ValidatedSessionClaimOutcome;
	try {
		outcome = acquireValidatedSessionUsageClaim(before);
	} catch (error: unknown) {
		process.stderr.write(`Pi cannot start: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
		return;
	}
	if (outcome === "busy") {
		process.stderr.write("Pi cannot start: this bundle is being retired by a running update or cleanup\n");
		process.exit(1);
		return;
	}
	if (outcome === "stale") {
		process.stderr.write("Pi cannot start: this bundle was retired while starting\n");
		process.exit(1);
	}
}
