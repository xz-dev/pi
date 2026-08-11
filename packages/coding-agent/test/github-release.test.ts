import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const ENTRY_PACKAGE = "@earendil-works/pi-coding-agent";
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const PREPARE_SCRIPT = join(REPO_ROOT, "scripts", "prepare-github-release.mjs");
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "verify-github-release.mjs");
const LIB_URL = pathToFileURL(join(REPO_ROOT, "scripts", "lib", "github-release.mjs")).href;
const TARGETS = [
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

async function writePrebuiltFixture(directory: string, version: string) {
	const lib = await loadLib();
	for (const target of TARGETS) {
		const root = join(directory, "fixture", target);
		const info = lib.platformNativeInfo(target);
		const requiredPaths: string[] = lib.binaryRequiredPaths(target);
		for (const required of requiredPaths) {
			const path = join(root, required);
			if (required === "pi" || required === "pi.exe") continue;
			if (requiredPaths.some((candidate) => candidate.startsWith(`${required}/`))) {
				mkdirSync(path, { recursive: true });
			} else {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(
					path,
					required === "package.json"
						? `${JSON.stringify({ name: ENTRY_PACKAGE, version, piConfig: { distribution: "xz-dev", releaseTarget: target } })}\n`
						: `${required}\n`,
				);
			}
		}
		const executable = join(root, info.executable);
		writeFileSync(
			executable,
			`#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; else printf 'pi fixture help\\n'; fi\n`,
		);
		chmodSync(executable, 0o755);
		const wrapper = join(root, info.wrapper);
		writeFileSync(wrapper, `#!/bin/sh\nexec "$(dirname "$0")/${info.executable}" "$@"\n`);
		chmodSync(wrapper, 0o755);
		const archive = join(directory, lib.binaryArchiveName(target));
		run("zip", ["-q", "-r", archive, "."], root);
	}
}

function addAcceptanceEvidence(
	releaseDir: string,
	manifest: {
		commit: string;
		bundles: Record<string, { file: string; bytes: number; sha256: string }>;
	},
) {
	const records = TARGETS.map((target) => {
		const archive = join(releaseDir, manifest.bundles[target].file);
		const noticeDirectory = temporaryDirectory("pi-release-notice-fixture-");
		run("unzip", ["-q", archive, "THIRD_PARTY_NOTICES.md", "-d", noticeDirectory]);
		const notice = join(noticeDirectory, "THIRD_PARTY_NOTICES.md");
		return {
			schemaVersion: 1,
			target,
			archive: manifest.bundles[target],
			runner: { osArchitecture: target.includes("arm64") ? "arm64" : "x64" },
			executor: { emulated: false },
			tui: { observedOutput: true, cleanExit: true },
			clipboard: { loadedAndCalled: true },
			thirdPartyNotices: { file: "THIRD_PARTY_NOTICES.md", sha256: sha256(notice), bytes: statSync(notice).size },
		};
	});
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
					schemaVersion: 5,
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
	test("defines the twelve canonical target bundles and the layout version", async () => {
		const lib = await loadLib();
		expect(lib.BINARY_PLATFORMS).toEqual(TARGETS);
		expect(lib.MANIFEST_SCHEMA_VERSION).toBe(5);
		expect(lib.BUNDLE_LAYOUT_VERSION).toBe(2);
		expect(lib.PACKAGING_BINARY).toBe("binary");
		expect(lib.BINARY_PLATFORMS).toHaveLength(12);
		expect(lib.binaryArchiveName("linux-x64-gnu-modern")).toBe("pi-linux-x64-gnu-modern.zip");
		expect(lib.binaryArchiveName("windows-arm64")).toBe("pi-windows-arm64.zip");
	});

	test("provides the machine-checkable required-path inventory per platform", async () => {
		const lib = await loadLib();
		for (const platform of lib.BINARY_PLATFORMS) {
			const inventory = lib.binaryRequiredPaths(platform);
			const info = lib.platformNativeInfo(platform);
			expect(inventory).toContain(info.executable);
			expect(inventory).toContain(info.wrapper);
			expect(inventory).toContain("package.json");
			expect(inventory).toContain("photon_rs_bg.wasm");
			expect(inventory).toContain("theme");
			expect(inventory).toContain("theme/dark.json");
			expect(inventory).toContain("assets");
			expect(inventory).toContain("export-html");
			expect(inventory).toContain("docs");
			expect(inventory).toContain("examples");
			expect(inventory).toContain("node_modules/@mariozechner/clipboard");
			expect(inventory).toContain(`node_modules/@mariozechner/${info.clipboardNativePackage}`);
			expect(inventory).toContain(`node_modules/@mariozechner/clipboard/${info.clipboardNativeFile}`);
			if (info.nativeHelperDir) {
				expect(inventory).toContain(info.nativeHelperDir);
				expect(inventory).toContain(`${info.nativeHelperDir}/${info.nativeHelperFile}`);
			}
			expect(inventory).toEqual(expect.arrayContaining([...inventory]));
		}
	});

	test("darwin targets carry the native modifier helper; windows carries console-mode", async () => {
		const lib = await loadLib();
		expect(lib.platformNativeInfo("darwin-arm64").nativeHelperFile).toBe("darwin-modifiers.node");
		expect(lib.platformNativeInfo("darwin-x64-modern").nativeHelperDir).toBe("native/darwin/prebuilds/darwin-x64");
		expect(lib.platformNativeInfo("windows-x64-modern").nativeHelperDir).toBe("native/win32/prebuilds/win32-x64");
		expect(lib.platformNativeInfo("windows-arm64").nativeHelperFile).toBe("win32-console-mode.node");
		expect(lib.platformNativeInfo("linux-x64-gnu-modern").nativeHelperDir).toBeUndefined();
	});
});

describe("GitHub Release preparation (binary bundles)", () => {
	test("refuses destructive output paths inside the repository", () => {
		const result = spawnSync("node", [PREPARE_SCRIPT, "--out", join(REPO_ROOT, "release-output")], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/external temporary directory/);
	});

	test("assembles the exact schema-v5 Release from twelve prebuilt archives", async () => {
		const prebuilt = temporaryDirectory("pi-release-prebuilt-");
		const output = temporaryDirectory("pi-release-output-");
		const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
		const apiVersion = JSON.parse(
			readFileSync(join(REPO_ROOT, "packages", "coding-agent", "package.json"), "utf8"),
		).version;
		const version = `${apiVersion}-xz.501.1.g${head.slice(0, 8)}`;
		await writePrebuiltFixture(prebuilt, version);
		const prepared = spawnSync("node", [PREPARE_SCRIPT, "--out", output, "--prebuilt", prebuilt], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: { ...process.env, GITHUB_RUN_NUMBER: "501", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: head },
		});
		expect(prepared.status, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);
		const manifest = JSON.parse(readFileSync(join(output, "release-manifest.json"), "utf8"));
		expect(manifest.schemaVersion).toBe(5);
		expect(Object.keys(manifest.bundles)).toEqual(TARGETS);
		expect(manifest.acceptance).toEqual({ file: "binary-acceptance.json", targetCount: 12 });
		const lib = await loadLib();
		const sums = lib.parseSha256Sums(readFileSync(join(output, "SHA256SUMS"), "utf8"));
		expect(sums.size).toBe(13);
		for (const target of TARGETS) {
			const bundle = manifest.bundles[target];
			expect(bundle.file).toBe(lib.binaryArchiveName(target));
			expect(sums.get(bundle.file)).toBe(sha256(join(output, bundle.file)));
		}
	});

	test("local verifier validates the full candidate and smoke-tests a host-native archive", async () => {
		const prebuilt = temporaryDirectory("pi-release-verify-prebuilt-");
		const output = temporaryDirectory("pi-release-verify-output-");
		const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
		const apiVersion = JSON.parse(
			readFileSync(join(REPO_ROOT, "packages", "coding-agent", "package.json"), "utf8"),
		).version;
		const version = `${apiVersion}-xz.502.1.g${head.slice(0, 8)}`;
		await writePrebuiltFixture(prebuilt, version);
		const prepared = spawnSync("node", [PREPARE_SCRIPT, "--out", output, "--prebuilt", prebuilt], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: { ...process.env, GITHUB_RUN_NUMBER: "502", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: head },
		});
		expect(prepared.status, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);
		const manifest = JSON.parse(readFileSync(join(output, "release-manifest.json"), "utf8"));
		addAcceptanceEvidence(output, manifest);
		const verified = spawnSync("node", [VERIFY_SCRIPT, "local", join(output, "release-manifest.json")], {
			cwd: output,
			encoding: "utf8",
			env: { ...process.env, PI_XZ_VERIFY_TARGET: "linux-x64-gnu-modern" },
		});
		expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0);
		expect(verified.stdout).toContain(`Host-native bundle smoke ok: ${version}`);
		expect(verified.stdout).toContain("local: exact Release assets and binary contract verified");
	}, 60_000);
});
