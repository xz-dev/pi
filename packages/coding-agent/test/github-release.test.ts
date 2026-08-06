import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const ENTRY_PACKAGE = "@earendil-works/pi-coding-agent";
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const PREPARE_SCRIPT = join(REPO_ROOT, "scripts", "prepare-github-release.mjs");
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "verify-github-release.mjs");
const LIB_URL = pathToFileURL(join(REPO_ROOT, "scripts", "lib", "github-release.mjs")).href;

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

async function loadLib() {
	return import(LIB_URL);
}

describe("GitHub Release binary packaging helpers", () => {
	test("defines the six canonical platform bundles and the layout version", async () => {
		const lib = await loadLib();
		expect(lib.BINARY_PLATFORMS).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"windows-arm64",
			"windows-x64",
		]);
		expect(lib.BUNDLE_LAYOUT_VERSION).toBe(1);
		expect(lib.PACKAGING_BINARY).toBe("binary");
		expect(lib.binaryArchiveName("linux-x64", "0.0.1-xz.1.1.g11111111")).toBe("pi-linux-x64.tar.gz");
		expect(lib.binaryArchiveName("windows-arm64", "0.0.1-xz.1.1.g11111111")).toBe("pi-windows-arm64.zip");
	});

	test("provides the machine-checkable required-path inventory per platform", async () => {
		const lib = await loadLib();
		for (const platform of lib.BINARY_PLATFORMS) {
			const inventory = lib.binaryRequiredPaths(platform);
			const info = lib.platformNativeInfo(platform);
			expect(inventory).toContain(info.executable);
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

	test("darwin platforms carry the native modifier helper; windows carries console-mode", async () => {
		const lib = await loadLib();
		expect(lib.platformNativeInfo("darwin-arm64").nativeHelperFile).toBe("darwin-modifiers.node");
		expect(lib.platformNativeInfo("darwin-x64").nativeHelperDir).toBe("native/darwin/prebuilds/darwin-x64");
		expect(lib.platformNativeInfo("windows-x64").nativeHelperDir).toBe("native/win32/prebuilds/win32-x64");
		expect(lib.platformNativeInfo("windows-arm64").nativeHelperFile).toBe("win32-console-mode.node");
		expect(lib.platformNativeInfo("linux-x64").nativeHelperDir).toBeUndefined();
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

	test("builds the six canonical binary bundles with downstream identity and a binary manifest", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-github-release-"));
		const hasCli = existsSync(join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js"));
		if (!hasCli) {
			expect(hasCli, "packages/coding-agent/dist/cli.js must exist before release prepare").toBe(true);
			return;
		}

		const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
		// Installer generation requires the full platform-family fixture: install.sh
		// pins all four POSIX bundles and install.ps1 pins both Windows bundles.
		const result = spawnSync(
			"node",
			[
				PREPARE_SCRIPT,
				"--out",
				tempDir,
				"--skip-deps",
				"--skip-build",
				"--platform",
				"darwin-arm64",
				"--platform",
				"darwin-x64",
				"--platform",
				"linux-arm64",
				"--platform",
				"linux-x64",
				"--platform",
				"windows-arm64",
				"--platform",
				"windows-x64",
			],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
					GITHUB_RUN_NUMBER: "129",
					GITHUB_RUN_ATTEMPT: "1",
					GITHUB_SHA: head,
				},
			},
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/binary/i);

		const basePackageJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
			version: string;
		};
		const version = `${basePackageJson.version}-xz.129.1.g${head.slice(0, 8)}`;
		const archiveFile = "pi-linux-x64.tar.gz";
		expect(existsSync(join(tempDir, archiveFile))).toBe(true);
		expect(existsSync(join(tempDir, "pi-darwin-arm64.tar.gz"))).toBe(true);
		expect(existsSync(join(tempDir, "pi-windows-x64.zip"))).toBe(true);
		expect(existsSync(join(tempDir, "release-manifest.json"))).toBe(true);
		expect(existsSync(join(tempDir, "SHA256SUMS"))).toBe(true);
		expect(existsSync(join(tempDir, "install.ts"))).toBe(false);
		expect(existsSync(join(tempDir, "install.sh"))).toBe(true);
		expect(existsSync(join(tempDir, "install.ps1"))).toBe(true);
		// The hybrid npm tarball is no longer produced.
		expect(existsSync(join(tempDir, `earendil-works-pi-coding-agent-${version}.tgz`))).toBe(false);

		const manifest = JSON.parse(readFileSync(join(tempDir, "release-manifest.json"), "utf8")) as {
			schemaVersion: number;
			repository: string;
			tag: string;
			distributionVersion: string;
			apiVersion: string;
			minimumNodeVersion: string;
			packaging: string;
			layoutVersion: number;
			bundles: Record<string, { file: string; bytes: number; sha256: string }>;
			requiredPaths: Record<string, string[]>;
			installer: {
				posix: { file: string };
				windows: { file: string };
				checksums: { file: string; algorithm: string };
			};
		};

		expect(manifest.schemaVersion).toBe(3);
		expect(manifest.repository).toBe("xz-dev/pi");
		expect(manifest.tag).toBe(`xz-v${version}`);
		expect(manifest.distributionVersion).toBe(version);
		expect(manifest.apiVersion).toBe(basePackageJson.version);
		expect(manifest.packaging).toBe("binary");
		expect(manifest.layoutVersion).toBe(1);
		expect(manifest.bundles["linux-x64"]).toMatchObject({
			file: archiveFile,
			bytes: expect.any(Number),
			sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(Object.keys(manifest.bundles).sort()).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"windows-arm64",
			"windows-x64",
		]);
		// The required-path inventory is frozen into the manifest.
		expect(manifest.requiredPaths["linux-x64"]).toEqual(
			expect.arrayContaining(["pi", "package.json", "photon_rs_bg.wasm", "theme/dark.json"]),
		);

		expect(manifest.installer).toEqual({
			posix: { file: "install.sh" },
			windows: { file: "install.ps1" },
			checksums: { file: "SHA256SUMS", algorithm: "sha256" },
		});

		const sums = parseSha256Sums(readFileSync(join(tempDir, "SHA256SUMS"), "utf8"));
		expect(sums.get(archiveFile)).toBe(manifest.bundles["linux-x64"].sha256);
		expect(sums.has("install.sh")).toBe(true);
		expect(sums.has("install.ps1")).toBe(true);
		expect(sums.has("release-manifest.json")).toBe(true);

		// Bundle package.json carries the downstream identity.
		const packageJson = JSON.parse(
			spawnSync("tar", ["-xOf", join(tempDir, archiveFile), "pi/package.json"], { encoding: "utf8" }).stdout,
		) as { name: string; version: string; piConfig?: { distribution?: string; changelogVersion?: string } };
		expect(packageJson.name).toBe(ENTRY_PACKAGE);
		expect(packageJson.version).toBe(version);
		expect(packageJson.piConfig?.distribution).toBe("xz-dev");
		expect(packageJson.piConfig?.changelogVersion).toBe(basePackageJson.version);

		// Bootstrap embeds tag/base URL pins.
		const installSh = readFileSync(join(tempDir, "install.sh"), "utf8");
		expect(installSh).toContain(manifest.tag);
		expect(installSh).toContain(`https://github.com/xz-dev/pi/releases/download/${manifest.tag}/`);
		expect(installSh).toContain("curl");
	}, 600_000);
});

describe("GitHub Release verifier gates", () => {
	test("local mode verifies a linux-x64 bundle and runs the host-native smoke", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-github-release-verify-"));
		const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
		const result = spawnSync(
			"node",
			[
				PREPARE_SCRIPT,
				"--out",
				tempDir,
				"--skip-deps",
				"--skip-build",
				"--platform",
				"darwin-arm64",
				"--platform",
				"darwin-x64",
				"--platform",
				"linux-arm64",
				"--platform",
				"linux-x64",
				"--platform",
				"windows-arm64",
				"--platform",
				"windows-x64",
			],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
					GITHUB_RUN_NUMBER: "130",
					GITHUB_RUN_ATTEMPT: "1",
					GITHUB_SHA: head,
				},
			},
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const verify = spawnSync("node", [VERIFY_SCRIPT, "local", join(tempDir, "release-manifest.json")], {
			cwd: tempDir,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
			},
		});
		expect(verify.status, `${verify.stdout}\n${verify.stderr}`).toBe(0);
		expect(`${verify.stdout}\n${verify.stderr}`).toMatch(/Host-native bundle smoke ok/i);
	}, 600_000);
});

function parseSha256Sums(text: string): Map<string, string> {
	const entries = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
		expect(match, `Invalid SHA256SUMS line: ${line}`).toBeTruthy();
		entries.set(match![2], match![1]);
	}
	return entries;
}
