import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const PREPARE_SCRIPT = join(REPO_ROOT, "scripts", "prepare-github-release.mjs");
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "verify-github-release.mjs");
const LIB_URL = pathToFileURL(join(REPO_ROOT, "scripts", "lib", "github-release.mjs")).href;
const TARGETS = [
	"freebsd-x64",
	"freebsd-arm64",
	"darwin-x64-baseline",
	"darwin-x64-modern",
	"darwin-arm64",
	"linux-x64-gnu-baseline",
	"linux-x64-gnu-modern",
	"linux-arm64-gnu",
	"linux-x64-musl-baseline",
	"linux-x64-musl-modern",
	"linux-arm64-musl",
	"windows-x64-baseline",
	"windows-x64-modern",
	"windows-arm64",
];

async function loadLib() {
	return import(LIB_URL);
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command: string, args: string[], cwd = REPO_ROOT) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	return result;
}

/**
 * Write one raw-executable fixture per target. Each file is a POSIX shell
 * script printing the requested version for `--version`, which is what
 * prepare-github-release.mjs probes. Windows `.exe` names get the same script
 * body; the probe only runs host-native targets.
 */
function writePrebuiltFixture(directory: string, version: string) {
	for (const target of TARGETS) {
		const file = join(directory, `pi-${target}${target.startsWith("windows-") ? ".exe" : ""}`);
		writeFileSync(
			file,
			`#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; else printf 'pi fixture help\\nUsage: pi\\n'; fi\n`,
		);
		chmodSync(file, 0o755);
	}
}

function addAcceptanceEvidence(
	releaseDir: string,
	manifest: {
		commit: string;
		bundles: Record<string, { executable: { file: string; bytes: number; sha256: string } }>;
	},
) {
	const records = TARGETS.map((target) => ({
		schemaVersion: 1,
		target,
		asset: manifest.bundles[target].executable,
		runner: { osArchitecture: target.includes("arm64") ? "arm64" : "x64" },
		// Only FreeBSD arm64 is accepted under QEMU TCG emulation.
		executor: { emulated: target === "freebsd-arm64" },
		tui: { observedOutput: true, cleanExit: true },
		clipboard: { loadedAndCalled: true },
	}));
	const manifestPath = join(releaseDir, "release-manifest.json");
	const acceptancePath = join(releaseDir, "binary-acceptance.json");
	writeFileSync(
		acceptancePath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				manifest: {
					file: "release-manifest.json",
					sha256: sha256(manifestPath),
					schemaVersion: 7,
					commit: manifest.commit,
				},
				targetCount: TARGETS.length,
				targets: records,
			},
			null,
			2,
		)}\n`,
	);
	const sumsPath = join(releaseDir, "SHA256SUMS");
	const sums = readFileSync(sumsPath, "utf8").trimEnd().split("\n");
	sums.push(`${sha256(acceptancePath)}  binary-acceptance.json`);
	sums.sort((left, right) => left.slice(66).localeCompare(right.slice(66)));
	writeFileSync(sumsPath, `${sums.join("\n")}\n`);
	const subjectsPath = join(releaseDir, "attestation-subjects.jsonl");
	writeFileSync(subjectsPath, `${readFileSync(subjectsPath, "utf8").trimEnd()}\nbinary-acceptance.json\n`);
}

describe("GitHub Release binary packaging helpers", () => {
	test("defines the fourteen canonical raw executables", async () => {
		const lib = await loadLib();
		expect(lib.BINARY_PLATFORMS).toEqual(TARGETS);
		expect(lib.MANIFEST_SCHEMA_VERSION).toBe(7);
		expect(lib.BUNDLE_LAYOUT_VERSION).toBeUndefined();
		expect(lib.PACKAGING_BINARY).toBe("binary");
		expect(lib.BINARY_PLATFORMS).toHaveLength(14);
		expect(lib.binaryArchiveName("linux-x64-gnu-modern")).toBe("pi-linux-x64-gnu-modern");
		expect(lib.binaryArchiveName("windows-arm64")).toBe("pi-windows-arm64.exe");
		expect(lib.releaseArchiveName("linux-x64-gnu-modern")).toBe("pi-linux-x64-gnu-modern.zip");
		expect(lib.releaseArchiveName("windows-arm64")).toBe("pi-windows-arm64.zip");
		expect(lib.releaseEntryName("windows-arm64")).toBe("pi.exe");
		expect(lib.releaseEntryName("darwin-arm64")).toBe("pi");
	});

	test("executable asset check requires a regular nonzero executable file", async () => {
		const lib = await loadLib();
		const dir = temporaryDirectory("pi-executable-check-");
		const posix = join(dir, "pi-linux-x64-gnu-baseline");
		writeFileSync(posix, "x\n");
		chmodSync(posix, 0o644);
		expect(() => lib.assertExecutableAsset(posix, "linux-x64-gnu-baseline")).toThrow(/execute bit/);
		chmodSync(posix, 0o755);
		expect(() => lib.assertExecutableAsset(posix, "linux-x64-gnu-baseline")).not.toThrow();
		const empty = join(dir, "pi-linux-x64-gnu-modern");
		writeFileSync(empty, "");
		chmodSync(empty, 0o755);
		expect(() => lib.assertExecutableAsset(empty, "linux-x64-gnu-modern")).toThrow(/empty/);
		const windows = join(dir, "pi-windows-x64-modern.exe");
		writeFileSync(windows, "MZ");
		// Windows executables do not require the POSIX x bit.
		expect(() => lib.assertExecutableAsset(windows, "windows-x64-modern")).not.toThrow();
		mkdirSync(join(dir, "pi-darwin-arm64"));
		expect(() => lib.assertExecutableAsset(join(dir, "pi-darwin-arm64"), "darwin-arm64")).toThrow(/regular file/);
	});

	test("all platforms declare the matching native platform helper", async () => {
		const lib = await loadLib();
		expect(lib.platformNativeInfo("freebsd-x64").nativeHelperDir).toBe("native/freebsd/prebuilds/freebsd-x64");
		expect(lib.platformNativeInfo("freebsd-x64").nativeHelperFile).toBe("freebsd-platform-x11.node");
		expect(lib.platformNativeInfo("freebsd-arm64").nativeHelperDir).toBe("native/freebsd/prebuilds/freebsd-arm64");
		expect(lib.platformNativeInfo("darwin-arm64").nativeHelperFile).toBe("darwin-platform.node");
		expect(lib.platformNativeInfo("darwin-x64-modern").nativeHelperDir).toBe("native/darwin/prebuilds/darwin-x64");
		expect(lib.platformNativeInfo("windows-x64-modern").nativeHelperDir).toBe("native/win32/prebuilds/win32-x64");
		expect(lib.platformNativeInfo("windows-arm64").nativeHelperFile).toBe("win32-platform.node");
		expect(lib.platformNativeInfo("linux-x64-gnu-modern").nativeHelperDir).toBe("native/linux/prebuilds/linux-x64");
		expect(lib.platformNativeInfo("linux-arm64-musl").nativeHelperFile).toBe("linux-platform-x11.node");
	});
});

describe("GitHub Release ZIP archive", () => {
	test("round-trips one 0755 entry and rejects every other shape", async () => {
		const lib = await loadLib();
		const body = Buffer.from("#!/bin/sh\necho pi\n".repeat(1000));
		const archive: Buffer = lib.createReleaseArchive("pi", body);
		expect(lib.readReleaseArchive(archive, "pi").equals(body)).toBe(true);
		expect(() => lib.readReleaseArchive(archive, "pi.exe")).toThrow();
		expect(() => lib.readReleaseArchive(Buffer.concat([archive, Buffer.from("x")]), "pi")).toThrow(/end record/);
		expect(() => lib.readReleaseArchive(archive.subarray(0, 40), "pi")).toThrow(/truncated/);
		const corrupt = Buffer.from(archive);
		corrupt[40] ^= 0xff;
		expect(() => lib.readReleaseArchive(corrupt, "pi")).toThrow();
		const stored = Buffer.from(archive);
		stored.writeUInt16LE(0, 8);
		expect(() => lib.readReleaseArchive(stored, "pi")).toThrow(/local entry/);
	});
});

describe("GitHub Release preparation (raw executables)", () => {
	test("refuses destructive output paths inside the repository", () => {
		const result = spawnSync("node", [PREPARE_SCRIPT, "--out", join(REPO_ROOT, "release-output")], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/external temporary directory/);
	});

	test("assembles the exact schema-v7 ZIP Release from fourteen prebuilt executables", async () => {
		const prebuilt = temporaryDirectory("pi-release-prebuilt-");
		const output = temporaryDirectory("pi-release-output-");
		const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
		const apiVersion = JSON.parse(
			readFileSync(join(REPO_ROOT, "packages", "coding-agent", "package.json"), "utf8"),
		).version;
		const version = `${apiVersion}-xz.501.1.g${head.slice(0, 8)}`;
		writePrebuiltFixture(prebuilt, version);
		const prepared = spawnSync(
			"node",
			[PREPARE_SCRIPT, "--out", output, "--prebuilt", prebuilt, ...TARGETS.flatMap((t) => ["--platform", t])],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: { ...process.env, GITHUB_RUN_NUMBER: "501", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: head },
			},
		);
		expect(prepared.status, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);
		const manifest = JSON.parse(readFileSync(join(output, "release-manifest.json"), "utf8"));
		expect(manifest.schemaVersion).toBe(7);
		expect(Object.keys(manifest.bundles)).toEqual(TARGETS);
		expect(manifest.layoutVersion).toBeUndefined();
		expect(manifest.acceptance).toEqual({ file: "binary-acceptance.json", targetCount: TARGETS.length });
		const lib = await loadLib();
		const sums = lib.parseSha256Sums(readFileSync(join(output, "SHA256SUMS"), "utf8"));
		// ZIP archives + manifest + THIRD_PARTY_NOTICES.md; raw executables are not Release assets.
		expect(sums.size).toBe(TARGETS.length + 2);
		for (const target of TARGETS) {
			const bundle = manifest.bundles[target];
			expect(bundle.file).toBe(`pi-${target}.zip`);
			expect(sums.get(bundle.file)).toBe(sha256(join(output, bundle.file)));
			expect(bundle.executable.file).toBe(lib.binaryArchiveName(target));
			expect(sums.has(bundle.executable.file)).toBe(false);
			const inner = lib.readTargetArchive(join(output, bundle.file), target);
			expect(createHash("sha256").update(inner).digest("hex")).toBe(bundle.executable.sha256);
			expect(inner.equals(readFileSync(join(prebuilt, bundle.executable.file)))).toBe(true);
		}
		// The ZIP extracts with the system unzip to the exact executable, mode 0755.
		const extracted = temporaryDirectory("pi-release-extract-");
		run("unzip", ["-q", join(output, "pi-linux-x64-gnu-modern.zip"), "-d", extracted]);
		expect(sha256(join(extracted, "pi"))).toBe(manifest.bundles["linux-x64-gnu-modern"].executable.sha256);
		expect(statSync(join(extracted, "pi")).mode & 0o777).toBe(0o755);
		run("unzip", ["-q", join(output, "pi-windows-arm64.zip"), "-d", extracted]);
		expect(sha256(join(extracted, "pi.exe"))).toBe(manifest.bundles["windows-arm64"].executable.sha256);
		expect(sums.get("THIRD_PARTY_NOTICES.md")).toBe(sha256(join(output, "THIRD_PARTY_NOTICES.md")));
	});

	test("local verifier validates the full candidate and smoke-tests a host-native executable", async () => {
		const prebuilt = temporaryDirectory("pi-release-verify-prebuilt-");
		const output = temporaryDirectory("pi-release-verify-output-");
		const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
		const apiVersion = JSON.parse(
			readFileSync(join(REPO_ROOT, "packages", "coding-agent", "package.json"), "utf8"),
		).version;
		const version = `${apiVersion}-xz.502.1.g${head.slice(0, 8)}`;
		writePrebuiltFixture(prebuilt, version);
		const prepared = spawnSync(
			"node",
			[PREPARE_SCRIPT, "--out", output, "--prebuilt", prebuilt, ...TARGETS.flatMap((t) => ["--platform", t])],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: { ...process.env, GITHUB_RUN_NUMBER: "502", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: head },
			},
		);
		expect(prepared.status, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);
		const manifest = JSON.parse(readFileSync(join(output, "release-manifest.json"), "utf8"));
		addAcceptanceEvidence(output, manifest);
		const verified = spawnSync("node", [VERIFY_SCRIPT, "local", join(output, "release-manifest.json")], {
			cwd: output,
			encoding: "utf8",
			env: { ...process.env, PI_XZ_VERIFY_TARGET: "linux-x64-gnu-modern" },
		});
		expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0);
		expect(verified.stdout).toContain(`Host-native executable smoke ok: ${version}`);
		expect(verified.stdout).toContain("local: exact Release assets and binary contract verified");
	}, 60_000);
});
