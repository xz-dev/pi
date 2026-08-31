import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type * as Fs from "node:fs";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import { cleanXzBundles, getLatestXzRelease, runXzSelfUpdate } from "../src/utils/xz-release-update.ts";
import { allowNetwork } from "./test-network-env.ts";

const TARGET = "linux-x64-gnu-modern";
const EXEC_PATH_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "execPath");
const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");
const ORIGINAL_EXIT_CODE = process.exitCode;
const WRAPPER_NAME = process.platform === "win32" ? "pi.exe" : "pi";
const EXECUTABLE_NAME = process.platform === "win32" ? "pi-native.exe" : "pi-native";

const fsMocks = vi.hoisted(() => ({
	lstatSync: vi.fn(),
	renameSync: vi.fn(),
	realLstatSync: undefined as typeof Fs.lstatSync | undefined,
	realRenameSync: undefined as typeof Fs.renameSync | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	fsMocks.realLstatSync = actual.lstatSync;
	fsMocks.realRenameSync = actual.renameSync;
	fsMocks.lstatSync.mockImplementation(actual.lstatSync);
	fsMocks.renameSync.mockImplementation(actual.renameSync);
	return { ...actual, lstatSync: fsMocks.lstatSync, renameSync: fsMocks.renameSync };
});

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal();
	return { ...(actual as Record<string, unknown>), RELEASE_TARGET: "linux-x64-gnu-modern" };
});

const CURRENT_VERSION = "0.84.1-xz.68.1.g11111111";
const NEXT_VERSION = "0.84.1-xz.69.1.g22222222";
const STALE_VERSION = "0.84.1-xz.67.1.g00000000";
const TAG = `xz-v${NEXT_VERSION}`;
const BUNDLE = `pi-${TARGET}.zip`;
const BUNDLE_BYTES = new TextEncoder().encode("bundle");
const BUNDLE_SHA256 = createHash("sha256").update(BUNDLE_BYTES).digest("hex");
const RELEASE_ORIGIN = "https://github.com";
const LATEST_BASE = `${RELEASE_ORIGIN}/xz-dev/pi/releases/latest/download/`;
const SUMS_URL = `${LATEST_BASE}SHA256SUMS`;
const MANIFEST_URL = `${LATEST_BASE}release-manifest.json`;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 5,
		repository: "xz-dev/pi",
		tag: TAG,
		distributionVersion: NEXT_VERSION,
		apiVersion: "0.84.1",
		commit: `22222222${"3".repeat(32)}`,
		packaging: "binary",
		layoutVersion: 2,
		bundles: {
			[TARGET]: { file: BUNDLE, bytes: BUNDLE_BYTES.byteLength, sha256: BUNDLE_SHA256 },
			"windows-arm64": { file: "pi-windows-arm64.zip", bytes: 10, sha256: "4".repeat(64) },
		},
		new_future_field: { ignored: true },
		...overrides,
	};
}

function discoveryFiles(value: Record<string, unknown> = manifest()): { manifestBytes: Uint8Array; sums: string } {
	const manifestBytes = new TextEncoder().encode(JSON.stringify(value));
	const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
	return {
		manifestBytes,
		sums: `${BUNDLE_SHA256}  ${BUNDLE}\n${manifestSha256}  release-manifest.json\n`,
	};
}

function createReleaseBundle(root: string): Uint8Array {
	const source = join(root, "release-bundle");
	mkdirSync(source);
	const wrapperName = WRAPPER_NAME;
	const executableName = EXECUTABLE_NAME;
	writeFileSync(join(source, wrapperName), "next wrapper\n");
	writeFileSync(join(source, executableName), "next binary\n");
	writeFileSync(
		join(source, "package.json"),
		`${JSON.stringify(
			{
				name: "@earendil-works/pi-coding-agent",
				version: NEXT_VERSION,
				piConfig: { distribution: "xz-dev", releaseTarget: TARGET },
			},
			null,
			2,
		)}\n`,
	);
	const archive = join(root, BUNDLE);
	const zipped = spawnSync("zip", ["-qr", archive, "."], { cwd: source });
	if (zipped.status !== 0) throw new Error(`zip failed: ${zipped.stderr?.toString() ?? ""}`);
	return readFileSync(archive);
}

function writeInstalledBundle(
	installRoot: string,
	version: string,
	overrides: { name?: string; distribution?: string; releaseTarget?: string; wrapper?: string } = {},
): string {
	const bundleDirectory = join(installRoot, "bundles", version);
	mkdirSync(bundleDirectory, { recursive: true });
	writeFileSync(join(bundleDirectory, WRAPPER_NAME), overrides.wrapper ?? `wrapper-${version}\n`);
	writeFileSync(join(bundleDirectory, EXECUTABLE_NAME), "binary\n");
	writeFileSync(
		join(bundleDirectory, "package.json"),
		`${JSON.stringify({
			name: overrides.name ?? "@earendil-works/pi-coding-agent",
			version,
			piConfig: {
				distribution: overrides.distribution ?? "xz-dev",
				releaseTarget: overrides.releaseTarget ?? TARGET,
			},
		})}\n`,
	);
	return bundleDirectory;
}

function createCleanupFixture(prefix: string): {
	root: string;
	currentBundle: string;
	previousBundle: string;
	staleBundle: string;
} {
	const root = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const currentBundle = writeInstalledBundle(root, NEXT_VERSION);
	const previousBundle = writeInstalledBundle(root, CURRENT_VERSION);
	const staleBundle = writeInstalledBundle(root, STALE_VERSION);
	// The root launcher byte-matches the "current" bundle's launcher.
	writeFileSync(join(root, WRAPPER_NAME), readFileSync(join(currentBundle, WRAPPER_NAME)));
	return { root, currentBundle, previousBundle, staleBundle };
}

function cleanupQuarantines(root: string): string[] {
	return readdirSync(join(root, "bundles"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(".cleanup-"))
		.map((entry) => join(root, "bundles", entry.name));
}

beforeEach(() => {
	fsMocks.lstatSync.mockReset();
	fsMocks.renameSync.mockReset();
	fsMocks.lstatSync.mockImplementation(fsMocks.realLstatSync!);
	fsMocks.renameSync.mockImplementation(fsMocks.realRenameSync!);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	process.exitCode = ORIGINAL_EXIT_CODE;
	if (EXEC_PATH_DESCRIPTOR) Object.defineProperty(process, "execPath", EXEC_PATH_DESCRIPTOR);
	if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
});

it("fails closed before normal startup for an invalid internal Windows snapshot probe", async () => {
	vi.stubEnv("PI_INTERNAL_WIN32_FILESYSTEM_SNAPSHOT_PROBE", "a".repeat(64));
	vi.stubEnv("PI_INTERNAL_WIN32_FILESYSTEM_SNAPSHOT_VERSION", CURRENT_VERSION);
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	process.exitCode = undefined;
	const errorSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	await expect(main(["--version"])).resolves.toBeUndefined();
	expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
		"Invalid Windows filesystem snapshot probe request",
	);
	expect(process.exitCode).toBe(1);
});

describe("xz-dev native Release cleanup and activation safety", () => {
	it("runs update --clean through main and reports success", async () => {
		const { root, currentBundle, previousBundle, staleBundle } = createCleanupFixture("pi-xz-clean-main");
		Object.defineProperty(process, "execPath", {
			value: join(currentBundle, EXECUTABLE_NAME),
			configurable: true,
		});
		process.exitCode = undefined;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(main(["update", "--clean"])).resolves.toBeUndefined();
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Removed 2 old bundles");
			expect(errorSpy).not.toHaveBeenCalled();
			if (process.platform === "win32") expect(exitSpy).not.toHaveBeenCalled();
			else expect(exitSpy).toHaveBeenCalledWith(0);
			expect(process.exitCode).toBeUndefined();
			expect(existsSync(currentBundle)).toBe(true);
			// The launcher-matched version is protected even though it is not
			// the executing one; the executing version is protected too.
			expect(existsSync(previousBundle)).toBe(false);
			expect(existsSync(staleBundle)).toBe(false);
			expect(cleanupQuarantines(root)).toEqual([]);
			expect(existsSync(join(root, "update.lock"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports update --clean failures through the public package command", async () => {
		const root = join(tmpdir(), `pi-xz-clean-command-error-${process.pid}-${Date.now()}`);
		const currentBundle = writeInstalledBundle(root, NEXT_VERSION);
		const staleBundle = writeInstalledBundle(root, CURRENT_VERSION);
		writeFileSync(join(root, WRAPPER_NAME), readFileSync(join(currentBundle, WRAPPER_NAME)));
		rmSync(join(staleBundle, EXECUTABLE_NAME));
		Object.defineProperty(process, "execPath", {
			value: join(currentBundle, EXECUTABLE_NAME),
			configurable: true,
		});
		process.exitCode = undefined;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			// Removing a required file from the executing bundle fails closed.
			rmSync(join(currentBundle, WRAPPER_NAME));
			await expect(handlePackageCommand(["update", "--clean"])).resolves.toBe(true);
			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"Release bundle is missing required path",
			);
			expect(process.exitCode).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("cleans only stale complete bundles while preserving active, rollback, staging, and unknown entries", () => {
		const root = join(tmpdir(), `pi-xz-clean-${process.pid}-${Date.now()}`);
		const currentVersion = "0.84.1-xz.70.1.g33333333";
		const previousVersion = NEXT_VERSION;
		const staleVersion = CURRENT_VERSION;
		const currentBundle = writeInstalledBundle(root, currentVersion);
		const previousBundle = writeInstalledBundle(root, previousVersion);
		const staleBundle = writeInstalledBundle(root, staleVersion);
		const wrongPackage = writeInstalledBundle(root, "0.84.1-xz.67.1.g00000000", { name: "attacker-package" });
		const wrongDistribution = writeInstalledBundle(root, "0.84.1-xz.65.1.gdddddddd", {
			distribution: "upstream",
		});
		const wrongTarget = writeInstalledBundle(root, "0.84.1-xz.66.1.gffffffff", { releaseTarget: "windows-arm64" });
		const incomplete = writeInstalledBundle(root, "0.84.1-xz.64.1.gcccccccc");
		rmSync(join(incomplete, WRAPPER_NAME));
		const staging = join(root, "bundles", ".update-in-progress");
		const detached = join(root, "bundles", ".cleanup-interrupted");
		const foreign = join(root, "bundles", "foreign-data");
		mkdirSync(staging);
		mkdirSync(detached);
		mkdirSync(foreign);
		writeFileSync(join(foreign, "notes.txt"), "keep\n");
		writeFileSync(join(root, WRAPPER_NAME), readFileSync(join(currentBundle, WRAPPER_NAME)));
		try {
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(2);
			expect(existsSync(currentBundle)).toBe(true);
			// Only the executing (launcher-matched) version survives.
			expect(existsSync(previousBundle)).toBe(false);
			expect(existsSync(staleBundle)).toBe(false);
			expect(existsSync(wrongPackage)).toBe(true);
			expect(existsSync(wrongDistribution)).toBe(true);
			expect(existsSync(wrongTarget)).toBe(true);
			expect(existsSync(incomplete)).toBe(true);
			expect(existsSync(staging)).toBe(true);
			expect(existsSync(detached)).toBe(true);
			expect(existsSync(foreign)).toBe(true);
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves the executing and launcher-matched bundles, removes others", () => {
		const root = join(tmpdir(), `pi-xz-clean-executing-${process.pid}-${Date.now()}`);
		const executingBundle = writeInstalledBundle(root, CURRENT_VERSION);
		const launcherBundle = writeInstalledBundle(root, NEXT_VERSION);
		const staleVersion = "0.84.1-xz.67.1.g00000000";
		const staleBundle = writeInstalledBundle(root, staleVersion);
		writeFileSync(join(root, WRAPPER_NAME), readFileSync(join(launcherBundle, WRAPPER_NAME)));
		try {
			expect(cleanXzBundles(join(executingBundle, EXECUTABLE_NAME))).toBe(1);
			expect(existsSync(executingBundle)).toBe(true);
			expect(existsSync(launcherBundle)).toBe(true);
			expect(existsSync(staleBundle)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves every bundle whose launcher matches the root launcher", () => {
		const root = join(tmpdir(), `pi-xz-clean-duplicate-launcher-${process.pid}-${Date.now()}`);
		const executingBundle = writeInstalledBundle(root, CURRENT_VERSION);
		const launcherBundle = writeInstalledBundle(root, NEXT_VERSION);
		const duplicateVersion = "0.84.1-xz.70.1.g33333333";
		const duplicateBundle = writeInstalledBundle(root, duplicateVersion, {
			wrapper: readFileSync(join(launcherBundle, WRAPPER_NAME), "utf8"),
		});
		const staleBundle = writeInstalledBundle(root, STALE_VERSION);
		writeFileSync(join(root, WRAPPER_NAME), readFileSync(join(launcherBundle, WRAPPER_NAME)));
		try {
			expect(cleanXzBundles(join(executingBundle, EXECUTABLE_NAME))).toBe(1);
			expect(existsSync(executingBundle)).toBe(true);
			expect(existsSync(launcherBundle)).toBe(true);
			expect(existsSync(duplicateBundle)).toBe(true);
			expect(existsSync(staleBundle)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("restores a quarantined bundle when post-rename revalidation fails", () => {
		const { root, currentBundle, staleBundle } = createCleanupFixture("pi-xz-clean-restore");
		const validationError = new Error("detached validation failed");
		let detachedBundle = "";
		let validationFailed = false;
		fsMocks.renameSync.mockImplementation((source, destination) => {
			fsMocks.realRenameSync!(source, destination);
			if (source === staleBundle) detachedBundle = String(destination);
		});
		fsMocks.lstatSync.mockImplementation((path, options) => {
			if (!validationFailed && detachedBundle && path === join(detachedBundle, WRAPPER_NAME)) {
				validationFailed = true;
				throw validationError;
			}
			return fsMocks.realLstatSync!(path, options as never);
		});
		try {
			const error = (() => {
				try {
					cleanXzBundles(join(currentBundle, EXECUTABLE_NAME));
					return undefined;
				} catch (error: unknown) {
					return error;
				}
			})();
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("Release bundle is missing required path");
			expect((error as Error & { cause?: unknown }).cause).toBe(validationError);
			expect(fsMocks.renameSync).toHaveBeenNthCalledWith(1, staleBundle, detachedBundle);
			expect(fsMocks.renameSync).toHaveBeenNthCalledWith(2, detachedBundle, staleBundle);
			expect(existsSync(currentBundle)).toBe(true);
			expect(existsSync(detachedBundle)).toBe(false);
			expect(cleanupQuarantines(root)).toEqual([]);
			expect(existsSync(join(root, "update.lock"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains quarantine and both errors when restoration fails", () => {
		const { root, currentBundle, staleBundle } = createCleanupFixture("pi-xz-clean-restore-error");
		const validationError = new Error("detached validation failed");
		const restoreError = new Error("restore rename failed");
		let detachedBundle = "";
		let renameCount = 0;
		let validationFailed = false;
		fsMocks.renameSync.mockImplementation((source, destination) => {
			renameCount++;
			if (renameCount === 2) throw restoreError;
			fsMocks.realRenameSync!(source, destination);
			if (source === staleBundle) detachedBundle = String(destination);
		});
		fsMocks.lstatSync.mockImplementation((path, options) => {
			if (!validationFailed && detachedBundle && path === join(detachedBundle, WRAPPER_NAME)) {
				validationFailed = true;
				throw validationError;
			}
			return fsMocks.realLstatSync!(path, options as never);
		});
		try {
			const error = (() => {
				try {
					cleanXzBundles(join(currentBundle, EXECUTABLE_NAME));
					return undefined;
				} catch (error: unknown) {
					return error;
				}
			})();
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).message).toBe(
				`Failed to restore quarantined bundle ${STALE_VERSION}: ${restoreError.message}`,
			);
			expect((error as AggregateError).errors).toHaveLength(2);
			expect((error as AggregateError).errors[0]).toMatchObject({ cause: validationError });
			expect((error as AggregateError).errors[1]).toBe(restoreError);
			expect(existsSync(currentBundle)).toBe(true);
			expect(cleanupQuarantines(root)).toEqual([dirname(detachedBundle)]);
			expect(existsSync(join(root, "update.lock"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not overwrite an original-path conflict while restoring quarantine", () => {
		const { root, currentBundle, staleBundle } = createCleanupFixture("pi-xz-clean-restore-conflict");
		const validationError = new Error("detached validation failed");
		const conflictMarker = join(staleBundle, "conflict-marker");
		let detachedBundle = "";
		let validationFailed = false;
		fsMocks.renameSync.mockImplementation((source, destination) => {
			fsMocks.realRenameSync!(source, destination);
			if (source === staleBundle) {
				detachedBundle = String(destination);
				mkdirSync(staleBundle);
				writeFileSync(conflictMarker, "keep\n");
			}
		});
		fsMocks.lstatSync.mockImplementation((path, options) => {
			if (!validationFailed && detachedBundle && path === join(detachedBundle, WRAPPER_NAME)) {
				validationFailed = true;
				throw validationError;
			}
			return fsMocks.realLstatSync!(path, options as never);
		});
		try {
			const error = (() => {
				try {
					cleanXzBundles(join(currentBundle, EXECUTABLE_NAME));
					return undefined;
				} catch (error: unknown) {
					return error;
				}
			})();
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(
				`Cannot restore quarantined bundle ${STALE_VERSION}: ${staleBundle} already exists; bundle retained at ${detachedBundle}`,
			);
			expect((error as Error & { cause?: unknown }).cause).toMatchObject({ cause: validationError });
			expect(fsMocks.renameSync).toHaveBeenCalledOnce();
			expect(readFileSync(conflictMarker, "utf8")).toBe("keep\n");
			expect(existsSync(currentBundle)).toBe(true);
			expect(cleanupQuarantines(root)).toEqual([dirname(detachedBundle)]);
			expect(existsSync(join(root, "update.lock"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves the installation unchanged when detaching a stale bundle fails", () => {
		if (process.platform === "win32") return;
		const root = join(tmpdir(), `pi-xz-clean-error-${process.pid}-${Date.now()}`);
		const currentBundle = writeInstalledBundle(root, NEXT_VERSION);
		const previousBundle = writeInstalledBundle(root, CURRENT_VERSION);
		const staleBundle = writeInstalledBundle(root, "0.84.1-xz.67.1.g00000000");
		writeFileSync(join(root, WRAPPER_NAME), readFileSync(join(currentBundle, WRAPPER_NAME)));
		const bundlesRoot = join(root, "bundles");
		statSync(bundlesRoot);
		try {
			chmodSync(bundlesRoot, 0o500);
			expect(() => cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toThrow();
			expect(existsSync(currentBundle)).toBe(true);
			expect(existsSync(previousBundle)).toBe(true);
			expect(existsSync(staleBundle)).toBe(true);
		} finally {
			chmodSync(bundlesRoot, 0o700);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses recursive deletion when the quarantine root is replaced after unlock", () => {
		const { root, currentBundle, staleBundle } = createCleanupFixture("pi-xz-clean-delete-race");
		let quarantineRoot = "";
		let savedQuarantine = "";
		let quarantineSnapshotCount = 0;
		fsMocks.lstatSync.mockImplementation((path, options) => {
			if (typeof path === "string" && basename(path).startsWith(".cleanup-")) {
				quarantineRoot ||= path;
				quarantineSnapshotCount++;
				if (quarantineSnapshotCount === 5) {
					savedQuarantine = `${quarantineRoot}.saved`;
					fsMocks.realRenameSync!(quarantineRoot, savedQuarantine);
					mkdirSync(quarantineRoot);
				}
			}
			return fsMocks.realLstatSync!(path, options as never);
		});
		try {
			expect(() => cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toThrow(
				"Release quarantine changed before deletion",
			);
			expect(existsSync(staleBundle)).toBe(false);
			expect(existsSync(join(savedQuarantine, STALE_VERSION, WRAPPER_NAME))).toBe(true);
			expect(existsSync(quarantineRoot)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves the launcher-matched bundle unchanged when post-lock quarantine deletion fails", () => {
		if (process.platform === "win32") return;
		const root = join(tmpdir(), `pi-xz-clean-delete-error-${process.pid}-${Date.now()}`);
		const currentBundle = writeInstalledBundle(root, NEXT_VERSION);
		const staleBundle = writeInstalledBundle(root, "0.84.1-xz.67.1.g00000000");
		writeFileSync(join(root, WRAPPER_NAME), readFileSync(join(currentBundle, WRAPPER_NAME)));
		const lockedDirectory = join(staleBundle, "locked");
		mkdirSync(lockedDirectory);
		writeFileSync(join(lockedDirectory, "keep"), "keep\n");
		chmodSync(lockedDirectory, 0o500);
		try {
			expect(() => cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toThrow();
			expect(existsSync(currentBundle)).toBe(true);
			expect(existsSync(staleBundle)).toBe(false);
			expect(existsSync(join(root, "update.lock"))).toBe(false);
			const quarantine = readdirSync(join(root, "bundles"), { withFileTypes: true }).find((entry) =>
				entry.name.startsWith(".cleanup-"),
			);
			expect(quarantine).toBeDefined();
			chmodSync(join(root, "bundles", quarantine!.name, "0.84.1-xz.67.1.g00000000"), 0o700);
		} finally {
			for (const entry of readdirSync(join(root, "bundles"), { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const entryPath = join(root, "bundles", entry.name);
				chmodSync(entryPath, 0o700);
				for (const child of readdirSync(entryPath, { withFileTypes: true })) {
					if (!child.isDirectory()) continue;
					const childPath = join(entryPath, child.name);
					chmodSync(childPath, 0o700);
					for (const grandchild of readdirSync(childPath, { withFileTypes: true })) {
						if (grandchild.isDirectory()) chmodSync(join(childPath, grandchild.name), 0o700);
					}
				}
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects symlinked managed roots and required bundle files", () => {
		if (process.platform === "win32") return;
		const root = join(tmpdir(), `pi-xz-clean-symlink-${process.pid}-${Date.now()}`);
		const realRoot = join(root, "real");
		const linkedRoot = join(root, "linked");
		const version = CURRENT_VERSION;
		const bundle = writeInstalledBundle(realRoot, version);
		writeFileSync(join(realRoot, "current"), `${version}\n`);
		mkdirSync(linkedRoot, { recursive: true });
		symlinkSync(join(realRoot, "bundles"), join(linkedRoot, "bundles"), "dir");
		try {
			expect(() => cleanXzBundles(join(linkedRoot, "bundles", version, EXECUTABLE_NAME))).toThrow(
				/managed bundle installation/,
			);

			rmSync(join(bundle, WRAPPER_NAME));
			symlinkSync(join(bundle, EXECUTABLE_NAME), join(bundle, WRAPPER_NAME));
			expect(() => cleanXzBundles(join(bundle, EXECUTABLE_NAME))).toThrow(/required path pi/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("serializes cleanup with release activation", () => {
		if (process.platform === "win32") return;
		const root = join(tmpdir(), `pi-xz-clean-lock-${process.pid}-${Date.now()}`);
		const oldBundle = writeInstalledBundle(root, CURRENT_VERSION);
		writeFileSync(join(root, "update"), "");
		const release = lockfile.lockSync(join(root, "update"), { realpath: false });
		try {
			expect(() => cleanXzBundles(join(oldBundle, EXECUTABLE_NAME))).toThrow(
				"Another Pi update or cleanup is already running",
			);
			expect(existsSync(oldBundle)).toBe(true);
		} finally {
			release();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails activation before publication while cleanup holds the install lock", async () => {
		if (process.platform === "win32") return;
		allowNetwork();
		const root = join(tmpdir(), `pi-xz-update-lock-${process.pid}-${Date.now()}`);
		const oldBundle = writeInstalledBundle(root, CURRENT_VERSION);
		writeFileSync(join(root, WRAPPER_NAME), "old root wrapper\n");
		try {
			const bytes = createReleaseBundle(root);
			const value = manifest({
				bundles: {
					[TARGET]: {
						file: BUNDLE,
						bytes: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
				},
			});
			const { manifestBytes, sums } = discoveryFiles(value);
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL) => {
					if (String(input) === SUMS_URL) return new Response(sums);
					if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
					return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
				}),
			);
			writeFileSync(join(root, "update"), "");
			const releaseLock = lockfile.lockSync(join(root, "update"), { realpath: false });
			try {
				const latest = await getLatestXzRelease(CURRENT_VERSION);
				await expect(
					runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
						executablePath: join(oldBundle, EXECUTABLE_NAME),
						writeProgress: () => {},
					}),
				).rejects.toThrow("Another Pi update or cleanup is already running");
			} finally {
				releaseLock();
			}
			expect(existsSync(join(root, "bundles", NEXT_VERSION))).toBe(false);
			expect(readFileSync(join(root, WRAPPER_NAME), "utf8")).toBe("old root wrapper\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an invalid executing managed bundle before publication", async () => {
		allowNetwork();
		const root = join(tmpdir(), `pi-xz-update-executing-${process.pid}-${Date.now()}`);
		const executingBundle = writeInstalledBundle(root, CURRENT_VERSION);
		const activeBundle = writeInstalledBundle(root, STALE_VERSION);
		rmSync(join(executingBundle, WRAPPER_NAME));
		try {
			const bytes = createReleaseBundle(root);
			const value = manifest({
				bundles: {
					[TARGET]: {
						file: BUNDLE,
						bytes: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
				},
			});
			const { manifestBytes, sums } = discoveryFiles(value);
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL) => {
					if (String(input) === SUMS_URL) return new Response(sums);
					if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
					return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
				}),
			);

			const latest = await getLatestXzRelease(CURRENT_VERSION);
			await expect(
				runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
					executablePath: join(executingBundle, EXECUTABLE_NAME),
					writeProgress: () => {},
				}),
			).rejects.toThrow(`Release bundle is missing required path ${WRAPPER_NAME}`);
			expect(existsSync(activeBundle)).toBe(true);
			expect(existsSync(join(root, "bundles", NEXT_VERSION))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects symlinked or non-directory lock anchors", () => {
		if (process.platform === "win32") return;
		for (const kind of ["symlink", "file"] as const) {
			const root = join(tmpdir(), `pi-xz-lock-anchor-${kind}-${process.pid}-${Date.now()}`);
			const bundle = writeInstalledBundle(root, CURRENT_VERSION);
			const anchor = join(root, "update.lock");
			if (kind === "symlink") symlinkSync(join(bundle, EXECUTABLE_NAME), anchor);
			else writeFileSync(anchor, "not a lock directory\n");
			try {
				expect(() => cleanXzBundles(join(bundle, EXECUTABLE_NAME))).toThrow();
				expect(existsSync(bundle)).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("quarantines an invalid unactivated destination before retrying installation", async () => {
		if (process.platform === "win32") return;
		allowNetwork();
		const root = join(tmpdir(), `pi-xz-update-rejected-destination-${process.pid}-${Date.now()}`);
		const oldBundle = writeInstalledBundle(root, CURRENT_VERSION);
		writeFileSync(join(root, WRAPPER_NAME), "old root wrapper\n");
		const invalidDestination = writeInstalledBundle(root, NEXT_VERSION);
		rmSync(join(invalidDestination, EXECUTABLE_NAME));
		try {
			const bytes = createReleaseBundle(root);
			const value = manifest({
				bundles: {
					[TARGET]: {
						file: BUNDLE,
						bytes: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
				},
			});
			const { manifestBytes, sums } = discoveryFiles(value);
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL) => {
					if (String(input) === SUMS_URL) return new Response(sums);
					if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
					return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
				}),
			);

			const latest = await getLatestXzRelease(CURRENT_VERSION);
			await expect(
				runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
					executablePath: join(oldBundle, EXECUTABLE_NAME),
					writeProgress: () => {},
				}),
			).resolves.toBeUndefined();

			expect(existsSync(join(root, "bundles", NEXT_VERSION, EXECUTABLE_NAME))).toBe(true);
			const rejected = readdirSync(join(root, "bundles"), { withFileTypes: true }).filter(
				(entry) => entry.isDirectory() && entry.name.startsWith(".update-rejected-"),
			);
			expect(rejected).toHaveLength(1);
			expect(existsSync(join(root, "bundles", rejected[0].name, NEXT_VERSION, WRAPPER_NAME))).toBe(true);
			expect(existsSync(join(root, "bundles", rejected[0].name, NEXT_VERSION, EXECUTABLE_NAME))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("installs a release-builder bundle and atomically activates its layout", async () => {
		if (process.platform === "win32") return;
		allowNetwork();
		const root = join(tmpdir(), `pi-xz-update-success-${process.pid}-${Date.now()}`);
		const oldBundle = writeInstalledBundle(root, CURRENT_VERSION);
		writeFileSync(join(root, WRAPPER_NAME), "old root wrapper\n");
		try {
			const bytes = createReleaseBundle(root);
			const value = manifest({
				bundles: {
					[TARGET]: {
						file: BUNDLE,
						bytes: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
				},
			});
			const { manifestBytes, sums } = discoveryFiles(value);
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL) => {
					if (String(input) === SUMS_URL) return new Response(sums);
					if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
					return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
				}),
			);

			const latest = await getLatestXzRelease(CURRENT_VERSION);
			await expect(
				runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
					executablePath: join(oldBundle, EXECUTABLE_NAME),
					writeProgress: () => {},
				}),
			).resolves.toBeUndefined();

			const destination = join(root, "bundles", NEXT_VERSION);
			const pkg = JSON.parse(readFileSync(join(destination, "package.json"), "utf8")) as {
				name: string;
				version: string;
				piConfig: { distribution: string; releaseTarget: string };
			};
			expect(pkg).toMatchObject({
				name: "@earendil-works/pi-coding-agent",
				version: NEXT_VERSION,
				piConfig: { distribution: "xz-dev", releaseTarget: TARGET },
			});
			expect(readFileSync(join(root, WRAPPER_NAME), "utf8")).toBe("next wrapper\n");
			expect(readFileSync(join(destination, EXECUTABLE_NAME), "utf8")).toBe("next binary\n");
			expect(existsSync(oldBundle)).toBe(true);
			expect(existsSync(destination)).toBe(true);
			expect(statSync(join(root, WRAPPER_NAME)).mode & 0o111).not.toBe(0);
			expect(statSync(join(destination, EXECUTABLE_NAME)).mode & 0o111).not.toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips copying the root launcher when the new bundle ships an identical one", async () => {
		if (process.platform === "win32") return;
		allowNetwork();
		const root = join(tmpdir(), `pi-xz-update-same-wrapper-${process.pid}-${Date.now()}`);
		const oldBundle = writeInstalledBundle(root, CURRENT_VERSION);
		// Root launcher already byte-matches the incoming bundle's launcher.
		writeFileSync(join(root, WRAPPER_NAME), "next wrapper\n");
		try {
			const bytes = createReleaseBundle(root);
			const value = manifest({
				bundles: {
					[TARGET]: {
						file: BUNDLE,
						bytes: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
				},
			});
			const { manifestBytes, sums } = discoveryFiles(value);
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL) => {
					if (String(input) === SUMS_URL) return new Response(sums);
					if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
					return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
				}),
			);

			const latest = await getLatestXzRelease(CURRENT_VERSION);
			await expect(
				runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
					executablePath: join(oldBundle, EXECUTABLE_NAME),
					writeProgress: () => {},
				}),
			).resolves.toBeUndefined();

			expect(readFileSync(join(root, WRAPPER_NAME), "utf8")).toBe("next wrapper\n");
			expect(existsSync(join(root, "bundles", NEXT_VERSION))).toBe(true);
			expect(existsSync(oldBundle)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
