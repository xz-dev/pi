import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const moduleRequire = createRequire(import.meta.url);
const SNAPSHOT_API_VERSION = 1;

export interface WindowsDirectorySnapshot {
	canonicalPath: string;
	identity: string;
}

export interface WindowsRegularFileSnapshot extends WindowsDirectorySnapshot {
	size: number;
	contents?: Buffer;
}

export interface WindowsFilesystemSnapshotHelper {
	apiVersion: 1;
	snapshotDirectory(path: string): WindowsDirectorySnapshot;
	snapshotRegularFile(path: string, maximumBytes: number, includeContents: boolean): WindowsRegularFileSnapshot;
}

type NativeModuleLoader = (path: string) => unknown;

interface WindowsFilesystemSnapshotLoaderOptions {
	arch?: NodeJS.Architecture;
	candidates?: readonly string[];
	exists?: (path: string) => boolean;
	loadModule?: NativeModuleLoader;
}

let loadedHelper: WindowsFilesystemSnapshotHelper | undefined;

export function getWindowsFilesystemSnapshotRelativePath(arch = process.arch): string {
	if (arch !== "x64" && arch !== "arm64") {
		throw new Error(`Unsupported Windows filesystem snapshot architecture: ${arch}`);
	}
	return join("native", "win32", "prebuilds", `win32-${arch}`, "pi-filesystem-snapshot.node");
}

function isWindowsFilesystemSnapshotHelper(value: unknown): value is WindowsFilesystemSnapshotHelper {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		apiVersion?: unknown;
		snapshotDirectory?: unknown;
		snapshotRegularFile?: unknown;
	};
	return (
		candidate.apiVersion === SNAPSHOT_API_VERSION &&
		typeof candidate.snapshotDirectory === "function" &&
		typeof candidate.snapshotRegularFile === "function"
	);
}

function hasValidIdentity(identity: unknown): identity is string {
	return typeof identity === "string" && /^[0-9a-f]{16}:[0-9a-f]{32}$/.test(identity);
}

function isWindowsDirectorySnapshot(value: unknown): value is WindowsDirectorySnapshot {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { canonicalPath?: unknown; identity?: unknown };
	return (
		typeof candidate.canonicalPath === "string" &&
		candidate.canonicalPath.length > 0 &&
		hasValidIdentity(candidate.identity)
	);
}

function isWindowsRegularFileSnapshot(
	value: unknown,
	maximumBytes: number,
	includeContents: boolean,
): value is WindowsRegularFileSnapshot {
	if (!isWindowsDirectorySnapshot(value)) return false;
	const candidate = value as { size?: unknown; contents?: unknown };
	if (
		!Number.isSafeInteger(candidate.size) ||
		(candidate.size as number) < 0 ||
		(candidate.size as number) > maximumBytes
	) {
		return false;
	}
	if (!includeContents) return candidate.contents === undefined;
	return Buffer.isBuffer(candidate.contents) && candidate.contents.byteLength === candidate.size;
}

export function snapshotWindowsDirectory(
	path: string,
	helper = loadWindowsFilesystemSnapshotHelper(),
): WindowsDirectorySnapshot {
	const snapshot = helper.snapshotDirectory(path);
	if (!isWindowsDirectorySnapshot(snapshot)) {
		throw new Error("Pi Windows filesystem snapshot helper returned an invalid directory snapshot");
	}
	return snapshot;
}

export function snapshotWindowsRegularFile(
	path: string,
	maximumBytes: number,
	includeContents: boolean,
	helper = loadWindowsFilesystemSnapshotHelper(),
): WindowsRegularFileSnapshot {
	const snapshot = helper.snapshotRegularFile(path, maximumBytes, includeContents);
	if (!isWindowsRegularFileSnapshot(snapshot, maximumBytes, includeContents)) {
		throw new Error("Pi Windows filesystem snapshot helper returned an invalid regular-file snapshot");
	}
	return snapshot;
}

export function loadWindowsFilesystemSnapshotHelper(
	options: WindowsFilesystemSnapshotLoaderOptions = {},
): WindowsFilesystemSnapshotHelper {
	if (!options.candidates && loadedHelper) return loadedHelper;
	const arch = options.arch ?? process.arch;
	const candidates = options.candidates ?? [
		join(dirname(process.execPath), getWindowsFilesystemSnapshotRelativePath(arch)),
	];
	const exists = options.exists ?? existsSync;
	const loadModule = options.loadModule ?? moduleRequire;
	const modulePath = candidates.find((candidate) => exists(candidate));
	if (!modulePath) throw new Error("Pi Windows filesystem snapshot helper is missing");

	let value: unknown;
	try {
		value = loadModule(modulePath);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not load Pi Windows filesystem snapshot helper at ${modulePath}: ${message}`, {
			cause: error,
		});
	}
	if (!isWindowsFilesystemSnapshotHelper(value)) {
		throw new Error(`Pi Windows filesystem snapshot helper at ${modulePath} has an invalid API`);
	}
	if (!options.candidates) loadedHelper = value;
	return value;
}
