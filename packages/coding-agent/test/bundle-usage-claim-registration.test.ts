import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireRetirementClaim,
	acquireValidatedSessionUsageClaim,
	knownRemoteFilesystemName,
	registerSessionUsageClaimAtStartup,
	resolveManagedUsageClaimPaths,
	snapshotManagedUsageClaimGeneration,
	warnForKnownRemoteFilesystemType,
} from "../src/utils/bundle-usage-claim.ts";
import { buildUsageClaimFixture } from "./usage-claim-fixture.ts";

const VERSION = "0.84.1-xz.68.1.g11111111";
const GUARD_NAME = "usage.lock";
const claimModuleArtifact = buildUsageClaimFixture();

function tempRoot(prefix: string): string {
	return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function writeManagedBundle(root: string, version = VERSION): string {
	const bundle = join(root, "bundles", version);
	mkdirSync(join(bundle, "native", "usage-claim"), { recursive: true });
	writeFileSync(join(bundle, "pi-native"), "binary\n");
	writeFileSync(join(bundle, GUARD_NAME), "P");
	writeFileSync(join(bundle, "native", "usage-claim", "pi-usage-claim.node"), "module\n");
	writeFileSync(
		join(bundle, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version,
			piConfig: { distribution: "xz-dev", releaseTarget: "linux-x64-gnu-modern", usageClaimProtocol: 1 },
		}),
	);
	return bundle;
}

describe("session usage-claim registration", () => {
	const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

	beforeEach(() => {
		vi.stubEnv("PI_USAGE_CLAIM_MODULE", claimModuleArtifact);
		exitSpy.mockClear();
		stderrSpy.mockClear();
	});

	afterEach(() => vi.unstubAllEnvs());

	it("skips only a positively unmanaged layout", () => {
		const root = tempRoot("pi-reg-unmanaged");
		mkdirSync(root, { recursive: true });
		try {
			registerSessionUsageClaimAtStartup(join(root, "pi-native"));
			expect(exitSpy).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed for missing protocol artifacts", () => {
		const root = tempRoot("pi-reg-invalid");
		const bundle = join(root, "bundles", VERSION);
		mkdirSync(bundle, { recursive: true });
		try {
			registerSessionUsageClaimAtStartup(join(bundle, "pi-native"));
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(stderrSpy).toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects staging and quarantine executions instead of treating them as unmanaged", () => {
		const root = tempRoot("pi-reg-maintenance-path");
		const staging = join(root, "bundles", ".update-123");
		const quarantine = join(root, "bundles", ".cleanup-123", VERSION);
		mkdirSync(staging, { recursive: true });
		mkdirSync(quarantine, { recursive: true });
		try {
			registerSessionUsageClaimAtStartup(join(staging, "pi-native"));
			registerSessionUsageClaimAtStartup(join(quarantine, "pi-native"));
			expect(exitSpy).toHaveBeenCalledTimes(2);
			expect(stderrSpy.mock.calls.map(([m]) => String(m)).join("\n")).toContain("unpublished bundle generation");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when a retirement transaction owns the guard", () => {
		const root = tempRoot("pi-reg-busy");
		const bundle = writeManagedBundle(root);
		const guard = join(bundle, GUARD_NAME);
		try {
			const claim = acquireRetirementClaim(guard);
			expect(claim).not.toBe("busy");
			registerSessionUsageClaimAtStartup(join(bundle, "pi-native"));
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(stderrSpy.mock.calls.map(([m]) => String(m)).join("")).toContain("being retired");
			(claim as { release(): void }).release();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects unexpected native acquisition objects before creating deletion authority", () => {
		type NativeModule = NonNullable<Parameters<typeof acquireRetirementClaim>[1]>;
		for (const invalid of [{}, [], new Error("not an external")]) {
			const releaseScoped = vi.fn();
			const invalidModule: NativeModule = {
				acquire: () => invalid,
				releaseScoped,
				sessionHeld: () => false,
			};
			expect(() => acquireRetirementClaim("/unused/guard", invalidModule)).toThrow(/Unexpected usage-claim/);
			expect(releaseScoped).not.toHaveBeenCalled();
		}
	});

	it("session ownership survives forced GC and is not inherited as session state", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--expose-gc",
				"--eval",
				`const { spawnSync } = require("node:child_process");
				const fs = require("node:fs");
				const os = require("node:os");
				const path = require("node:path");
				const m = require(${JSON.stringify(claimModuleArtifact)});
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claim-gc-"));
				const guard = path.join(root, "usage.lock"); fs.writeFileSync(guard, "P");
				if (m.acquire(guard, "shared", "session") !== "acquired") process.exit(3);
				for (let i = 0; i < 5; i++) global.gc();
				if (!m.sessionHeld()) process.exit(4);
				const child = spawnSync(process.execPath, ["--eval", \`const m=require(${JSON.stringify(claimModuleArtifact)});process.stdout.write(String(m.sessionHeld()))\`], { encoding: "utf8" });
				if (child.stdout !== "false") process.exit(5);
				fs.rmSync(root, { recursive: true, force: true });`,
			],
			{ encoding: "utf8", timeout: 20_000 },
		);
		expect(result.status).toBe(0);
	});

	it("warns for known remote filesystems but not generic FUSE", () => {
		expect(knownRemoteFilesystemName(0x6969n)).toBe("NFS");
		expect(knownRemoteFilesystemName(0x65735546n)).toBeUndefined();
		expect(warnForKnownRemoteFilesystemType(0x6969n)).toBe(true);
		expect(stderrSpy.mock.calls.map(([m]) => String(m)).join("")).toContain("Cleanup will continue");
		stderrSpy.mockClear();
		expect(warnForKnownRemoteFilesystemType(0x65735546n)).toBe(false);
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("production revalidation rejects a replaced guard generation", () => {
		const root = tempRoot("pi-reg-stale-inode");
		const bundle = writeManagedBundle(root);
		const guard = join(bundle, GUARD_NAME);
		try {
			const paths = resolveManagedUsageClaimPaths(join(bundle, "pi-native"));
			const before = snapshotManagedUsageClaimGeneration(paths);
			const replacement = join(bundle, "usage.lock.next");
			writeFileSync(replacement, "P");
			renameSync(replacement, guard);
			expect(acquireValidatedSessionUsageClaim(before)).toBe("stale");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
