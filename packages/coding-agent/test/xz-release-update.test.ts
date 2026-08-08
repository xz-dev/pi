import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLatestXzRelease, runXzSelfUpdate } from "../src/utils/xz-release-update.ts";
import { allowNetwork } from "./test-network-env.ts";

const VERSION = "0.83.0-xz.41.1.g11111111";
const NEW_VERSION = "0.83.0-xz.42.1.g22222222";
const TAG = `xz-v${NEW_VERSION}`;
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
const BUNDLE_NAMES = Object.fromEntries(
	BINARY_PLATFORMS.map((platform) => [
		platform,
		`pi-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`,
	]),
);

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

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const bundles = Object.fromEntries(
		BINARY_PLATFORMS.map((platform) => [
			platform,
			{ file: BUNDLE_NAMES[platform], bytes: 1024, sha256: "3".repeat(64) },
		]),
	);
	return {
		schemaVersion: 4,
		repository: "xz-dev/pi",
		tag: TAG,
		distributionVersion: NEW_VERSION,
		apiVersion: "0.83.0",
		commit: `22222222${"3".repeat(32)}`,
		packaging: "binary",
		layoutVersion: 1,
		bundles,
		requiredPaths: Object.fromEntries(BINARY_PLATFORMS.map((platform) => [platform, requiredPaths(platform)])),
		installer: {
			posix: { file: "install.sh" },
			windows: { file: "install.ps1" },
			checksums: { file: "SHA256SUMS", algorithm: "sha256" },
		},
		acceptance: { file: "binary-acceptance.json", targetCount: BINARY_PLATFORMS.length },
		attestation: {
			repository: "xz-dev/pi",
			signerWorkflow: "xz-dev/pi/.github/workflows/publish-github-release.yml",
			signerRef: "refs/heads/main",
			denySelfHostedRunners: true,
			subjectsFile: "attestation-subjects.jsonl",
		},
		...overrides,
	};
}

const INSTALLER_SH = "#!/bin/sh\nexit 0\n";
const INSTALLER_PS1 = "exit 0\n";

function sha256Sums(): string {
	const entries: Array<{ file: string; sha256: string }> = [
		...Object.values(BUNDLE_NAMES).map((file) => ({ file, sha256: "3".repeat(64) })),
		{ file: "release-manifest.json", sha256: createHash("sha256").update(JSON.stringify(manifest())).digest("hex") },
		{ file: "binary-acceptance.json", sha256: "4".repeat(64) },
		{ file: "install.sh", sha256: createHash("sha256").update(INSTALLER_SH).digest("hex") },
		{ file: "install.ps1", sha256: createHash("sha256").update(INSTALLER_PS1).digest("hex") },
	];
	return `${entries
		.sort((a, b) => a.file.localeCompare(b.file))
		.map((entry) => `${entry.sha256}  ${entry.file}`)
		.join("\n")}\n`;
}

function stubFetch(manifestValue: unknown = manifest(), sumsValue: string = sha256Sums()): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url === LATEST_MANIFEST) return Response.json(manifestValue);
		if (url === `${EXACT_BASE}SHA256SUMS`) return new Response(sumsValue);
		if (url === `${EXACT_BASE}install.sh`) return new Response(INSTALLER_SH);
		if (url === `${EXACT_BASE}install.ps1`) return new Response(INSTALLER_PS1);
		return new Response("not found", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("xz-dev GitHub Release binary updates", () => {
	it("discovers the latest release-manifest.json and validates the exact binary contract", async () => {
		allowNetwork();
		const fetchMock = stubFetch();

		const release = await getLatestXzRelease(VERSION);
		expect(release).toMatchObject({
			version: NEW_VERSION,
			exactBaseUrl: EXACT_BASE,
			manifest: { tag: TAG, packaging: "binary", schemaVersion: 4 },
		});
		expect(release?.installerName).toBe(process.platform === "win32" ? "install.ps1" : "install.sh");
		expect(release?.manifestSha256).toBe(createHash("sha256").update(JSON.stringify(manifest())).digest("hex"));
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			LATEST_MANIFEST,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\//),
					accept: "application/json",
				}),
			}),
		);
	});

	it("rejects non-binary, malformed, wrong-repo, wrong-attestation, and legacy v3 manifests", async () => {
		allowNetwork();
		stubFetch(manifest({ schemaVersion: 3 }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/manifest identity/);

		stubFetch(manifest({ schemaVersion: 2 }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/manifest identity/);

		stubFetch(manifest({ packaging: "hybrid" }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/manifest identity/);

		stubFetch(manifest({ repository: "evil/pi" }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/manifest identity/);

		stubFetch(manifest({ layoutVersion: 2 }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/manifest identity/);

		stubFetch(
			manifest({
				attestation: {
					repository: "xz-dev/pi",
					signerWorkflow: "evil/workflow.yml",
					signerRef: "refs/heads/main",
					denySelfHostedRunners: true,
					subjectsFile: "attestation-subjects.jsonl",
				},
			}),
		);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/attestation policy/);
	});

	it("requires exact binary acceptance metadata and its checksum asset", async () => {
		allowNetwork();
		stubFetch(manifest({ acceptance: undefined }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/acceptance metadata/);

		stubFetch(manifest({ acceptance: { file: "other.json", targetCount: BINARY_PLATFORMS.length } }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/acceptance metadata/);

		const sumsWithoutAcceptance = sha256Sums()
			.split("\n")
			.filter((line) => !line.includes("binary-acceptance.json"))
			.join("\n");
		stubFetch(manifest(), sumsWithoutAcceptance);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/exact canonical release asset inventory/);
	});

	it("rejects manifests that do not cover the exact twelve platform bundles", async () => {
		allowNetwork();
		const reduced = manifest();
		delete (reduced as Record<string, unknown>).bundles;
		(reduced as Record<string, unknown>).bundles = Object.fromEntries(
			Object.entries(manifest().bundles as Record<string, unknown>).slice(0, 11),
		);
		stubFetch(reduced);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/twelve canonical platforms/);

		const wrongName = manifest();
		(wrongName.bundles as Record<string, Record<string, unknown>>)["linux-x64-gnu-modern"] = {
			...((wrongName.bundles as Record<string, Record<string, unknown>>)["linux-x64-gnu-modern"] as object),
			file: "pi-linux-x64-gnu-modern.other",
		};
		stubFetch(wrongName);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/Invalid bundle metadata/);
	});

	it("requires the exact v4 schemaVersion 12-target inventory with musl provenance", async () => {
		allowNetwork();
		stubFetch();
		const release = await getLatestXzRelease(VERSION);
		expect(release?.manifest.schemaVersion).toBe(4);
		const platforms = Object.keys(release!.manifest.bundles).sort();
		expect(platforms).toEqual([...BINARY_PLATFORMS].sort());
		expect(platforms).toHaveLength(12);
		// Each musl bundle must require the reproducible native provenance file
		// and the musl clipboard package LICENSE.
		for (const platform of BINARY_PLATFORMS) {
			if (!platform.includes("-musl")) continue;
			const muslPackage = platform.includes("arm64") ? "clipboard-linux-arm64-musl" : "clipboard-linux-x64-musl";
			expect(release!.manifest.requiredPaths[platform]).toContain("clipboard-native-provenance.json");
			expect(release!.manifest.requiredPaths[platform]).toContain(
				`node_modules/@mariozechner/${muslPackage}/LICENSE`,
			);
		}
	});

	it("rejects manifests whose tag/commit/version disagree", async () => {
		allowNetwork();
		stubFetch(manifest({ tag: "xz-v0.83.0-xz.99.1.g99999999" }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/tag\/version mismatch/);

		stubFetch(manifest({ commit: `99999999${"3".repeat(32)}` }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/commit\/version mismatch/);

		stubFetch(manifest({ apiVersion: "0.84.0" }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/API\/version mismatch/);
	});

	it("requires a requiredPaths inventory for every platform", async () => {
		allowNetwork();
		const missingPaths = manifest();
		delete (missingPaths.requiredPaths as Record<string, unknown>)["windows-x64-modern"];
		stubFetch(missingPaths);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/requiredPaths must cover exactly/);
	});

	it("rejects unsafe required paths", async () => {
		allowNetwork();
		const badPaths = manifest();
		const linux = [...(badPaths.requiredPaths as Record<string, string[]>)["linux-x64-gnu-modern"]];
		linux.push("../escape");
		(badPaths.requiredPaths as Record<string, string[]>)["linux-x64-gnu-modern"] = linux;
		stubFetch(badPaths);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/does not match canonical inventory/);
	});

	it("rejects a malformed or empty SHA256SUMS", async () => {
		allowNetwork();
		stubFetch(manifest(), "not a valid sums file\n");
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/SHA256SUMS/);

		stubFetch(manifest(), "");
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/Empty SHA256SUMS/);
	});

	it("rejects exact-tag SHA256SUMS that does not authenticate the discovered manifest", async () => {
		allowNetwork();
		stubFetch(
			manifest(),
			sha256Sums().replace(createHash("sha256").update(JSON.stringify(manifest())).digest("hex"), "0".repeat(64)),
		);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/release-manifest\.json sha256 mismatch/);
	});

	it("rejects SHA256SUMS missing the host installer", async () => {
		allowNetwork();
		const installer = process.platform === "win32" ? "install.ps1" : "install.sh";
		const sumsWithout = sha256Sums()
			.split("\n")
			.filter((line) => !line.includes(installer))
			.join("\n");
		stubFetch(manifest(), sumsWithout);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/exact canonical release asset inventory/);
	});

	it("reports failed downloads with an HTTP status", async () => {
		allowNetwork();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 404 })),
		);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/HTTP 404/);
	});

	it("rejects a manifest redirected outside the trusted GitHub asset CDN", async () => {
		allowNetwork();
		const fetchMock = stubFetch();
		const untrusted = Response.json(manifest());
		Object.defineProperties(untrusted, {
			redirected: { value: true },
			url: { value: "https://example.test/file" },
		});
		fetchMock.mockImplementationOnce(async () => untrusted);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/trusted GitHub asset CDN/);
	});

	it("rejects forged installer metadata before downloading or spawning", async () => {
		allowNetwork();
		const fetchMock = stubFetch();
		const release = await getLatestXzRelease(VERSION);
		fetchMock.mockClear();
		const spawnMock = vi.fn();

		await expect(
			runXzSelfUpdate({ ...release!, installerUrl: "https://example.test/install.sh" }, VERSION, false, {
				spawn: spawnMock as never,
			}),
		).rejects.toThrow(/not the exact xz-dev tag asset/);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("rejects an oversized installer before spawning", async () => {
		allowNetwork();
		stubFetch();
		const release = await getLatestXzRelease(VERSION);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("x", { headers: { "content-length": String(1024 * 1024 + 1) } })),
		);
		const spawnMock = vi.fn();

		await expect(runXzSelfUpdate(release!, VERSION, false, { spawn: spawnMock as never })).rejects.toThrow(
			/exceeds the allowed size/,
		);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("invokes the exact POSIX installer through sh with the internal update flag", async () => {
		allowNetwork();
		const fetchMock = stubFetch();
		const release = await getLatestXzRelease(VERSION);
		expect(release).toBeDefined();
		let invoked: { command: string; args: string[]; options: Record<string, unknown> } | undefined;
		const spawnMock = vi.fn((command: string, args: readonly string[], options: Record<string, unknown>) => {
			invoked = { command, args: [...args], options };
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("close", 0, null));
			return child;
		});
		await runXzSelfUpdate(release!, VERSION, false, { spawn: spawnMock as never });

		expect(fetchMock).toHaveBeenCalledWith(
			`${EXACT_BASE}install.sh`,
			expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": expect.any(String) }) }),
		);
		expect(invoked?.command).toBe("sh");
		expect(invoked?.args).toEqual([expect.stringContaining("install.sh"), "--update"]);
		expect(invoked?.args).not.toContain("--force");
		expect(invoked?.options).toMatchObject({
			shell: false,
			stdio: "inherit",
			env: {
				PI_XZ_RELEASE_BASE_URL: EXACT_BASE,
				PI_XZ_RELEASE_EXACT_BASE_URL: EXACT_BASE,
				PI_XZ_RELEASE_MANIFEST_SHA256: release!.manifestSha256,
			},
		});
	});

	it("does not invoke the installer when its downloaded bytes mismatch SHA256SUMS", async () => {
		allowNetwork();
		stubFetch();
		const release = await getLatestXzRelease(VERSION);
		const tamperedInstaller = `${INSTALLER_SH}# tampered
`;
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url === LATEST_MANIFEST) return Response.json(manifest());
			if (url === `${EXACT_BASE}SHA256SUMS`) return new Response(sha256Sums());
			if (url === `${EXACT_BASE}install.sh`) return new Response(tamperedInstaller);
			if (url === `${EXACT_BASE}install.ps1`) return new Response(INSTALLER_PS1);
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const spawnMock = vi.fn();
		await expect(runXzSelfUpdate(release!, VERSION, false, { spawn: spawnMock as never })).rejects.toThrow(
			/sha256 mismatch/,
		);
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
