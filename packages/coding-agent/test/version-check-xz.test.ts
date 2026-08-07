import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowNetwork } from "./test-network-env.ts";

const CURRENT_VERSION = "0.83.0-xz.1.1.g11111111";
const LATEST_VERSION = "0.83.0-xz.2.1.g22222222";
const TAG = `xz-v${LATEST_VERSION}`;
const EXACT_BASE = `https://github.com/xz-dev/pi/releases/download/${TAG}/`;
const LATEST_MANIFEST = "https://github.com/xz-dev/pi/releases/latest/download/release-manifest.json";
const BINARY_PLATFORMS = [
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

function requiredPaths(platform: string): string[] {
	const common = [
		platform.startsWith("windows-") ? "pi.exe" : "pi",
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"THIRD_PARTY_NOTICES.md",
		"photon_rs_bg.wasm",
		"theme",
		"theme/dark.json",
		"theme/light.json",
		"theme/theme-schema.json",
		"assets",
		"export-html",
		"docs",
		"examples",
		"node_modules/@mariozechner/clipboard",
	];
	const native: Record<string, string[]> = {
		"darwin-x64-baseline": [
			"clipboard-darwin-x64",
			"clipboard.darwin-x64.node",
			"native/darwin/prebuilds/darwin-x64",
			"darwin-modifiers.node",
		],
		"darwin-x64-modern": [
			"clipboard-darwin-x64",
			"clipboard.darwin-x64.node",
			"native/darwin/prebuilds/darwin-x64",
			"darwin-modifiers.node",
		],
		"darwin-arm64": [
			"clipboard-darwin-arm64",
			"clipboard.darwin-arm64.node",
			"native/darwin/prebuilds/darwin-arm64",
			"darwin-modifiers.node",
		],
		"linux-x64-gnu-baseline": ["clipboard-linux-x64-gnu", "clipboard.linux-x64-gnu.node"],
		"linux-x64-gnu-modern": ["clipboard-linux-x64-gnu", "clipboard.linux-x64-gnu.node"],
		"linux-arm64-gnu": ["clipboard-linux-arm64-gnu", "clipboard.linux-arm64-gnu.node"],
		"linux-x64-musl-baseline": ["clipboard-linux-x64-musl", "clipboard.linux-x64-musl.node"],
		"linux-x64-musl-modern": ["clipboard-linux-x64-musl", "clipboard.linux-x64-musl.node"],
		"linux-arm64-musl": ["clipboard-linux-arm64-musl", "clipboard.linux-arm64-musl.node"],
		"windows-x64-baseline": [
			"clipboard-win32-x64-msvc",
			"clipboard.win32-x64-msvc.node",
			"native/win32/prebuilds/win32-x64",
			"win32-console-mode.node",
		],
		"windows-x64-modern": [
			"clipboard-win32-x64-msvc",
			"clipboard.win32-x64-msvc.node",
			"native/win32/prebuilds/win32-x64",
			"win32-console-mode.node",
		],
		"windows-arm64": [
			"clipboard-win32-arm64-msvc",
			"clipboard.win32-arm64-msvc.node",
			"native/win32/prebuilds/win32-arm64",
			"win32-console-mode.node",
		],
	};
	const [packageName, nativeFile, helperDir, helperFile] = native[platform];
	common.push(`node_modules/@mariozechner/${packageName}`, `node_modules/@mariozechner/clipboard/${nativeFile}`);
	if (platform.includes("-musl")) {
		common.push("clipboard-native-provenance.json");
		common.push(`node_modules/@mariozechner/${packageName}/LICENSE`);
	}
	if (helperDir && helperFile) common.push(helperDir, `${helperDir}/${helperFile}`);
	return common;
}

function fixtureManifest(): Record<string, unknown> {
	return {
		schemaVersion: 4,
		repository: "xz-dev/pi",
		tag: TAG,
		distributionVersion: LATEST_VERSION,
		apiVersion: "0.83.0",
		commit: `22222222${"3".repeat(32)}`,
		packaging: "binary",
		layoutVersion: 1,
		bundles: Object.fromEntries(
			BINARY_PLATFORMS.map((platform) => [
				platform,
				{
					file: `pi-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`,
					bytes: 1024,
					sha256: "3".repeat(64),
				},
			]),
		),
		requiredPaths: Object.fromEntries(BINARY_PLATFORMS.map((platform) => [platform, requiredPaths(platform)])),
		installer: {
			posix: { file: "install.sh" },
			windows: { file: "install.ps1" },
			checksums: { file: "SHA256SUMS", algorithm: "sha256" },
		},
		attestation: {
			repository: "xz-dev/pi",
			signerWorkflow: "xz-dev/pi/.github/workflows/publish-github-release.yml",
			signerRef: "refs/heads/main",
			denySelfHostedRunners: true,
			subjectsFile: "attestation-subjects.jsonl",
		},
	};
}

function sha256Sums(): string {
	const entries = [
		...BINARY_PLATFORMS.map((platform) => ({
			file: `pi-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`,
			sha256: "3".repeat(64),
		})),
		{
			file: "release-manifest.json",
			sha256: createHash("sha256").update(JSON.stringify(fixtureManifest())).digest("hex"),
		},
		{ file: "install.sh", sha256: "a".repeat(64) },
		{ file: "install.ps1", sha256: "b".repeat(64) },
	];
	return `${entries
		.sort((a, b) => a.file.localeCompare(b.file))
		.map((entry) => `${entry.sha256}  ${entry.file}`)
		.join("\n")}\n`;
}

function stubFetch(): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url === LATEST_MANIFEST) return Response.json(fixtureManifest());
		if (url === `${EXACT_BASE}SHA256SUMS`) return new Response(sha256Sums());
		return new Response("not found", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function loadXzVersionCheck(distribution = "xz-dev", installMethod: "bun-binary" | "npm" = "bun-binary") {
	vi.resetModules();
	vi.doMock("../src/config.ts", async () => {
		const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
		return {
			...actual,
			DISTRIBUTION: distribution,
			PACKAGE_NAME: "@earendil-works/pi-coding-agent",
			detectInstallMethod: () => installMethod,
		};
	});
	const mod = await import("../src/utils/version-check.ts");
	return { checkForNewPiVersion: mod.checkForNewPiVersion };
}

afterEach(() => {
	vi.doUnmock("../src/config.ts");
	vi.resetModules();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	delete process.env.PI_SKIP_VERSION_CHECK;
});

describe("xz-dev version checks", () => {
	it("uses xz-dev latest release-manifest.json for automatic notifications", async () => {
		allowNetwork();
		const fetchMock = stubFetch();
		const { checkForNewPiVersion } = await loadXzVersionCheck();

		await expect(checkForNewPiVersion(CURRENT_VERSION)).resolves.toEqual({ version: LATEST_VERSION });
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://github.com/xz-dev/pi/releases/latest/download/release-manifest.json",
		);
	});

	it("preserves PI_SKIP_VERSION_CHECK for automatic checks", async () => {
		allowNetwork();
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = stubFetch();
		const { checkForNewPiVersion } = await loadXzVersionCheck();

		await expect(checkForNewPiVersion(CURRENT_VERSION)).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not route an xz-dev source (non-binary) version upstream", async () => {
		allowNetwork();
		const fetchMock = stubFetch();
		const { checkForNewPiVersion } = await loadXzVersionCheck("xz-dev", "npm");

		await expect(checkForNewPiVersion("0.83.0")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
