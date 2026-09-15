import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanXzBundles } from "../src/utils/xz-release-update.ts";
import { buildUsageClaimFixture } from "./usage-claim-fixture.ts";

// Bundle usage-claim protocol tests (clean-running-bundle-usage-lock).
//
// These tests exercise the real native usage-claim module: session claims
// held by independent child processes block cleanup retirement, and cleanup
// holds its exclusive claim through quarantine and guard-last deletion.

const TARGET = "linux-x64-gnu-modern";
const WRAPPER_NAME = "pi";
const EXECUTABLE_NAME = "pi-native";
const GUARD_NAME = "usage.lock";
const CURRENT_VERSION = "0.84.1-xz.68.1.g11111111";
const STALE_VERSION = "0.84.1-xz.67.1.g00000000";

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal();
	return { ...(actual as Record<string, unknown>), RELEASE_TARGET: "linux-x64-gnu-modern" };
});

const claimModuleArtifact = buildUsageClaimFixture();

function writeInstalledBundle(installRoot: string, version: string): string {
	const bundleDirectory = join(installRoot, "bundles", version);
	mkdirSync(bundleDirectory, { recursive: true });
	writeFileSync(join(bundleDirectory, WRAPPER_NAME), `wrapper-${version}\n`);
	writeFileSync(join(bundleDirectory, EXECUTABLE_NAME), "binary\n");
	writeFileSync(
		join(bundleDirectory, "package.json"),
		`${JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version,
			piConfig: { distribution: "xz-dev", releaseTarget: TARGET, usageClaimProtocol: 1 },
		})}\n`,
	);
	mkdirSync(join(bundleDirectory, "native", "usage-claim"), { recursive: true });
	writeFileSync(join(bundleDirectory, GUARD_NAME), "P");
	writeFileSync(
		join(bundleDirectory, "native", "usage-claim", "pi-usage-claim.node"),
		readFileSync(claimModuleArtifact),
	);
	return bundleDirectory;
}

function createFixture(prefix: string): { root: string; currentBundle: string; staleBundle: string } {
	const root = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const currentBundle = writeInstalledBundle(root, CURRENT_VERSION);
	const staleBundle = writeInstalledBundle(root, STALE_VERSION);
	writeFileSync(join(root, WRAPPER_NAME), readFileSync(join(currentBundle, WRAPPER_NAME)));
	return { root, currentBundle, staleBundle };
}

// A child process holding a session (shared) claim on a guard file.
function spawnSessionHolder(guardPath: string) {
	const child = spawn(
		process.execPath,
		[
			"--eval",
			`const m = require(${JSON.stringify(claimModuleArtifact)});
if (m.acquire(${JSON.stringify(guardPath)}, "shared", "session") !== "acquired") process.exit(3);
setInterval(() => {}, 1000);`,
		],
		{ stdio: "ignore" },
	);
	return child;
}

describe("bundle usage-claim cleanup protocol", () => {
	beforeEach(() => {
		// Point the claim loader at this worker's source-current artifact: the
		// Vitest process runs from node, not from a managed bundle.
		vi.stubEnv("PI_USAGE_CLAIM_MODULE", claimModuleArtifact);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("retains a bundle whose guard is held by a live session and removes it after exit", async () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-claim-live-session");
		const holder = spawnSessionHolder(join(staleBundle, GUARD_NAME));
		try {
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(0);
			expect(existsSync(staleBundle)).toBe(true);
			expect(readdirSync(join(root, "bundles")).sort()).toEqual([CURRENT_VERSION, STALE_VERSION].sort());

			holder.kill("SIGKILL");
			await new Promise((resolve) => holder.once("exit", resolve));
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(1);
			expect(existsSync(staleBundle)).toBe(false);
			expect(existsSync(currentBundle)).toBe(true);
			expect(readdirSync(join(root, "bundles"))).toEqual([CURRENT_VERSION]);
			expect(readdirSync(join(root, "bundles")).filter((name) => name.startsWith(".cleanup-"))).toEqual([]);
		} finally {
			holder.kill("SIGKILL");
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains a bundle with a missing guard instead of treating it as unused", () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-claim-missing-guard");
		try {
			rmSync(join(staleBundle, GUARD_NAME));
			// The bundle is incomplete (guard is a required path), so it is not
			// a cleanup candidate at all: it stays untouched.
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(0);
			expect(existsSync(staleBundle)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains every candidate when the claim backend cannot be acquired", async () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-claim-broken-module");
		const claim = await import("../src/utils/bundle-usage-claim.ts");
		const acquireSpy = vi.spyOn(claim, "acquireRetirementClaim").mockImplementation(() => {
			throw new Error("Pi usage claim module is missing from this installation");
		});
		try {
			// Every exclusive acquisition fails; unknown never becomes permission
			// to delete, so the candidate is retained.
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(0);
			expect(acquireSpy).toHaveBeenCalled();
			expect(existsSync(staleBundle)).toBe(true);
		} finally {
			acquireSpy.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses same-version replacement while a live session holds the destination", async () => {
		const root = join(tmpdir(), `pi-claim-replace-live-${process.pid}-${Date.now()}`);
		const currentBundle = writeInstalledBundle(root, CURRENT_VERSION);
		const targetBundle = writeInstalledBundle(root, STALE_VERSION);
		writeFileSync(join(root, WRAPPER_NAME), readFileSync(join(currentBundle, WRAPPER_NAME)));
		const holder = spawnSessionHolder(join(targetBundle, GUARD_NAME));
		const claim = await import("../src/utils/bundle-usage-claim.ts");
		const spy = vi.spyOn(claim, "acquireRetirementClaim");
		try {
			await new Promise((resolve) => setTimeout(resolve, 500));
			// A same-version replacement of a live bundle is refused: an
			// exclusive claim on the live guard is busy and the bundle stays
			// untouched.
			expect(claim.acquireRetirementClaim(join(targetBundle, GUARD_NAME))).toBe("busy");
			expect(spy).toHaveBeenCalled();
			expect(existsSync(targetBundle)).toBe(true);
		} finally {
			spy.mockRestore();
			holder.kill("SIGKILL");
			await new Promise((resolve) => holder.once("exit", () => setTimeout(resolve, 100)));
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains a candidate when the installed launcher cannot be read", () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-claim-unreadable-launcher");
		try {
			chmodSync(join(root, WRAPPER_NAME), 0o000);
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(0);
			expect(existsSync(staleBundle)).toBe(true);
		} finally {
			chmodSync(join(root, WRAPPER_NAME), 0o644);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains a candidate whose guard is unreadable by permissions", () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-claim-access-denied");
		try {
			chmodSync(join(staleBundle, GUARD_NAME), 0o000);
			// open() for R/W fails with EACCES -> acquisition error -> retain.
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(0);
			expect(existsSync(staleBundle)).toBe(true);
		} finally {
			chmodSync(join(staleBundle, GUARD_NAME), 0o644);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains an invalid-format candidate without legacy detection or repair", () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-claim-invalid-format");
		const foreign = join(root, "bundles", "not-a-version");
		mkdirSync(foreign, { recursive: true });
		writeFileSync(join(foreign, "data.txt"), "x\n");
		try {
			// Invalid version format is not a complete candidate; it is never
			// touched, never adapted, never deleted.
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(1);
			expect(existsSync(join(foreign, "data.txt"))).toBe(true);
			expect(existsSync(staleBundle)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("removes a stale bundle completely including the guard-last finalization", () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-claim-guard-last");
		try {
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(1);
			expect(existsSync(staleBundle)).toBe(false);
			const leftovers = readdirSync(join(root, "bundles")).filter((name) => name.startsWith("."));
			expect(leftovers).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
