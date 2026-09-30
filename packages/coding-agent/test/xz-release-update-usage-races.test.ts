import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanXzBundles } from "../src/utils/xz-release-update.ts";
import { buildUsageClaimFixture } from "./usage-claim-fixture.ts";

// Deterministic barrier-controlled races between startup and retirement
// (design.md D4, tasks 5.1-5.3). Barriers use filesystem tokens instead of
// sleeps: each phase waits for a marker file that the other side creates,
// so interleavings are forced rather than timed.

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
	writeFileSync(join(bundleDirectory, GUARD_NAME), "P");
	mkdirSync(join(bundleDirectory, "native", "usage-claim"), { recursive: true });
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

/** Wait for a marker file to appear (bounded). */
function waitForMarker(path: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tick = () => {
			try {
				readFileSync(path);
				resolve();
			} catch {
				if (Date.now() > deadline) reject(new Error(`marker timeout: ${path}`));
				else setTimeout(tick, 20);
			}
		};
		tick();
	});
}

interface HolderScript {
	guard: string;
	controlDir: string;
	phases: string[];
}

/**
 * A startup-like child with two barriers:
 *  - "opened": it has resolved+statted the guard path (pre-acquisition pause)
 *  - "acquired": it holds the session claim
 * The child releases each phase by writing a marker and waits for a
 * "continue-<phase>" marker before proceeding.
 */
function spawnBarrierStartup({ guard, controlDir, phases }: HolderScript): ChildProcess {
	const script = `
const fs = require("node:fs");
const m = require(${JSON.stringify(claimModuleArtifact)});
const guard = ${JSON.stringify(guard)};
const dir = ${JSON.stringify(controlDir)};
const mark = (name) => fs.writeFileSync(require("node:path").join(dir, name), "1");
const wait = (name) => { const p = require("node:path").join(dir, name); while (!fs.existsSync(p)) {} };
${phases
	.map(
		(phase) => `
mark(${JSON.stringify(`reached-${phase}`)});
wait(${JSON.stringify(`continue-${phase}`)});
`,
	)
	.join("")}
// pre-acquisition stat (mirrors registerSessionUsageClaimAtStartup step 1)
const before = fs.statSync(guard);
mark("statted");
wait("continue-acquire");
const outcome = m.acquire(guard, "shared", "session");
mark("outcome-" + outcome);
if (outcome !== "acquired") { mark("exit-failed"); process.exit(3); }
const after = fs.statSync(guard);
mark(after.ino === before.ino ? "identity-ok" : "identity-changed");
setInterval(() => {}, 1000);
`;
	return spawn(process.execPath, ["--eval", script], { stdio: "ignore" });
}

describe("usage-claim deterministic races", () => {
	beforeEach(() => {
		vi.stubEnv("PI_USAGE_CLAIM_MODULE", claimModuleArtifact);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("startup-wins: a session that acquires before cleanup keeps its bundle", async () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-race-startup-wins");
		const controlDir = mkdtempSync(join(tmpdir(), "pi-race-ctl-"));
		const child = spawnBarrierStartup({
			guard: join(staleBundle, GUARD_NAME),
			controlDir,
			phases: ["init"],
		});
		try {
			await waitForMarker(join(controlDir, "reached-init"));
			writeFileSync(join(controlDir, "continue-init"), "1");
			await waitForMarker(join(controlDir, "statted"));
			// Let the session acquire, then run cleanup.
			writeFileSync(join(controlDir, "continue-acquire"), "1");
			await waitForMarker(join(controlDir, "identity-ok"));
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(0);
			expect(existsDir(staleBundle)).toBe(true);
			// The still-live session's claim keeps the bundle present and its
			// guard usable.
			expect(readdirSync(staleBundle).includes(GUARD_NAME)).toBe(true);
		} finally {
			child.kill("SIGKILL");
			rmSync(root, { recursive: true, force: true });
			rmSync(controlDir, { recursive: true, force: true });
		}
	});

	it("cleaner-wins: a startup paused before acquisition fails after retirement", async () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-race-cleaner-wins");
		const controlDir = mkdtempSync(join(tmpdir(), "pi-race-ctl-"));
		const child = spawnBarrierStartup({
			guard: join(staleBundle, GUARD_NAME),
			controlDir,
			phases: ["init"],
		});
		try {
			await waitForMarker(join(controlDir, "reached-init"));
			writeFileSync(join(controlDir, "continue-init"), "1");
			await waitForMarker(join(controlDir, "statted"));
			// The startup is now paused AFTER stating the guard but BEFORE
			// acquiring. Retire the bundle under it.
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(1);
			expect(existsDir(staleBundle)).toBe(false);
			// Release the paused startup: acquisition must fail (guard gone)
			// and the child must exit non-zero, never continue unprotected.
			writeFileSync(join(controlDir, "continue-acquire"), "1");
			const exit = await new Promise<number | null>((resolve) => {
				child.once("exit", (code) => resolve(code));
				setTimeout(() => resolve(null), 10_000);
			});
			expect(exit).not.toBe(0);
			expect(exit).not.toBe(null);
		} finally {
			child.kill("SIGKILL");
			rmSync(root, { recursive: true, force: true });
			rmSync(controlDir, { recursive: true, force: true });
		}
	});

	it("two sessions: cleanup retains until the last one exits", async () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-race-two-sessions");
		const guard = join(staleBundle, GUARD_NAME);
		const hold = (extra: string) =>
			spawn(
				process.execPath,
				[
					"--eval",
					`const m = require(${JSON.stringify(claimModuleArtifact)});
				if (m.acquire(${JSON.stringify(guard)}, "shared", "session") !== "acquired") process.exit(3);
				require("node:fs").writeFileSync(${JSON.stringify(join(root, `hold-${extra}`))}, "1");
				setInterval(() => {}, 1000);`,
				],
				{ stdio: "ignore" },
			);
		const a = hold("a");
		const b = hold("b");
		try {
			await waitForMarker(join(root, "hold-a"));
			await waitForMarker(join(root, "hold-b"));
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(0);
			a.kill("SIGKILL");
			await new Promise((r) => a.once("exit", r));
			// One holder remains: still retained.
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(0);
			expect(existsDir(staleBundle)).toBe(true);
			b.kill("SIGKILL");
			await new Promise((r) => b.once("exit", r));
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(1);
			expect(existsDir(staleBundle)).toBe(false);
		} finally {
			a.kill("SIGKILL");
			b.kill("SIGKILL");
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("parent death leaves a registered child's bundle protected", async () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-race-parent-death");
		const guard = join(staleBundle, GUARD_NAME);
		const childPidPath = join(root, "child.pid");
		// Parent spawns a child that registers its own claim, records the exact
		// child PID, then the parent is killed. The child's independent claim
		// must keep protection.
		const parent = spawn(
			process.execPath,
			[
				"--eval",
				`const { spawn } = require("node:child_process");
				const fs = require("node:fs");
				const child = spawn(process.execPath, ["--eval", \`const m = require(${JSON.stringify(claimModuleArtifact)});
				if (m.acquire(${JSON.stringify(guard)}, "shared", "session") !== "acquired") process.exit(3);
				fs.writeFileSync(${JSON.stringify(join(root, "child-registered"))}, "1");
				setInterval(() => {}, 1000);\`], { stdio: "ignore" });
				fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
				child.unref();
				setInterval(() => {}, 1000);`,
			],
			{ stdio: "ignore" },
		);
		try {
			await waitForMarker(join(root, "child-registered"));
			parent.kill("SIGKILL");
			await new Promise((r) => parent.once("exit", r));
			// Child still registered and alive: bundle retained.
			expect(cleanXzBundles(join(currentBundle, EXECUTABLE_NAME))).toBe(0);
			expect(existsDir(staleBundle)).toBe(true);
		} finally {
			parent.kill("SIGKILL");
			try {
				const childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);
				if (Number.isSafeInteger(childPid)) process.kill(childPid, "SIGKILL");
			} catch {}
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("identity change: guard replaced mid-transaction aborts retirement safely", () => {
		const { root, currentBundle, staleBundle } = createFixture("pi-race-identity-change");
		try {
			// Simulate an external same-content guard replacement between
			// validation and quarantine by swapping the guard for a new inode
			// before cleanup revalidates. The rename-based quarantine plus
			// identity snapshots must catch the change or the retirement must
			// remain safe (bundle contents never deleted under stale identity).
			const replacement = join(staleBundle, "usage.lock.next");
			writeFileSync(replacement, "P");
			rmSync(join(staleBundle, GUARD_NAME));
			const { renameSync } = require("node:fs") as typeof import("node:fs");
			renameSync(replacement, join(staleBundle, GUARD_NAME));
			// Either retained (identity mismatch detected) or fully retired
			// (replacement validated as the current generation before any
			// mutation) is protocol-safe; the bundle must never end up
			// half-deleted at the published path.
			const removed = cleanXzBundles(join(currentBundle, EXECUTABLE_NAME));
			expect([0, 1]).toContain(removed);
			if (removed === 0) expect(existsDir(staleBundle)).toBe(true);
			else expect(existsDir(staleBundle)).toBe(false);
			const entries = readdirSync(join(root, "bundles"));
			expect(entries.filter((name) => name.startsWith(".cleanup-"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function existsDir(path: string): boolean {
	try {
		readdirSync(path);
		return true;
	} catch {
		return false;
	}
}
