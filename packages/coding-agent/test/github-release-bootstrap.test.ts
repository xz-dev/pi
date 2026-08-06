import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const GENERATE_URL = pathToFileURL(join(REPO_ROOT, "scripts", "generate-install-bootstrap.mjs")).href;
const VERSION = "1.2.3-xz.9.1.gabcdef12";
const TAG = `xz-v${VERSION}`;
const COMMIT = `abcdef12${"3".repeat(32)}`;
let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function bundles(): Record<string, { file: string; bytes: number; sha256: string }> {
	return Object.fromEntries(
		["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"].map((platform) => [
			platform,
			{
				file: `pi-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`,
				bytes: 42,
				sha256: sha256(platform),
			},
		]),
	);
}

function pins() {
	return {
		tag: TAG,
		baseUrl: `https://github.com/xz-dev/pi/releases/download/${TAG}/`,
		manifestSha256: "a".repeat(64),
		commit: COMMIT,
		distributionVersion: VERSION,
		bundles: bundles(),
		attestation: {
			repository: "xz-dev/pi",
			signerWorkflow: "xz-dev/pi/.github/workflows/publish-github-release.yml",
			signerRef: "refs/heads/main",
			denySelfHostedRunners: true,
			subjectsFile: "attestation-subjects.txt",
		},
	};
}

async function loadGenerator() {
	return import(GENERATE_URL);
}

describe("GitHub Release native installer generator", () => {
	test("embeds exact immutable release and bundle pins without Node or Bun", async () => {
		const generator = await loadGenerator();
		const options = pins();
		const sh = generator.generateInstallSh(options);
		const ps1 = generator.generateInstallPs1(options);

		for (const content of [sh, ps1]) {
			expect(content).toContain(TAG);
			expect(content).toContain(COMMIT);
			expect(content).toContain(options.manifestSha256);
			expect(content).toContain("gh");
			expect(content).toContain("deny-self-hosted-runners");
			expect(content).not.toMatch(/install\.ts|npm install|require_cmd (?:node|bun)\b|exec\s+(?:node|bun)\b/i);
		}
		expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
		expect(sh).toContain("pi-linux-x64.tar.gz");
		expect(ps1).toContain("pi-windows-x64.zip");
	});

	test("requires complete canonical POSIX and Windows bundle pins", async () => {
		const generator = await loadGenerator();
		const incomplete = pins();
		delete incomplete.bundles["darwin-arm64"];
		expect(() => generator.generateInstallSh(incomplete)).toThrow(/four canonical POSIX/);

		const missingWindows = pins();
		delete missingWindows.bundles["windows-arm64"];
		expect(() => generator.generateInstallPs1(missingWindows)).toThrow(/two canonical Windows/);
	});

	test("rejects mutable or malformed release identity", async () => {
		const generator = await loadGenerator();
		expect(() =>
			generator.generateInstallSh({ ...pins(), baseUrl: "https://github.com/xz-dev/pi/releases/latest/download/" }),
		).toThrow(/exact xz-dev\/pi Release tag URL/);
		expect(() => generator.generateInstallSh({ ...pins(), commit: "not-a-commit" })).toThrow(/40-hex commit/);
		expect(() => generator.generateInstallSh({ ...pins(), manifestSha256: "not-hex" })).toThrow(/manifestSha256/);
	});

	test("writes standalone install.sh and install.ps1 assets", async () => {
		const generator = await loadGenerator();
		tempDir = mkdtempSync(join(tmpdir(), "pi-native-installers-"));
		const written = generator.writeInstallBootstrap(tempDir, pins());
		expect(readFileSync(written.sh.path, "utf8")).toContain("Pi GitHub Release native installer");
		expect(readFileSync(written.ps1.path, "utf8")).toContain("Pi GitHub Release native installer");
	});
});
