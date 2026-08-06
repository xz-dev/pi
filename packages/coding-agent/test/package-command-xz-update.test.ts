import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowNetwork } from "./test-network-env.ts";

const CURRENT_VERSION = "0.83.0-xz.1.1.g11111111";
const LATEST_VERSION = "0.83.0-xz.2.1.g22222222";
const TAG = `xz-v${LATEST_VERSION}`;
const EXACT_BASE = `https://github.com/xz-dev/pi/releases/download/${TAG}/`;
const LATEST_MANIFEST = "https://github.com/xz-dev/pi/releases/latest/download/release-manifest.json";
const INSTALLER_SH = "#!/bin/sh\nexec node install.ts --update\n";
const INSTALLER_PS1 = "& node install.ts --update\n";
let tempDir: string;
let originalAgentDir: string | undefined;
let originalSkipVersionCheck: string | undefined;
let originalExitCode: typeof process.exitCode;
let originalPlatform: NodeJS.Platform;

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

function manifest(version = LATEST_VERSION): Record<string, unknown> {
	const tag = `xz-v${version}`;
	const commit = version === CURRENT_VERSION ? `11111111${"3".repeat(32)}` : `22222222${"3".repeat(32)}`;
	const bundles = Object.fromEntries(
		BINARY_PLATFORMS.map((platform) => [
			platform,
			{
				file: `pi-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`,
				bytes: 1024,
				sha256: "3".repeat(64),
			},
		]),
	);
	return {
		schemaVersion: 4,
		repository: "xz-dev/pi",
		tag,
		distributionVersion: version,
		apiVersion: "0.83.0",
		commit,
		packaging: "binary",
		layoutVersion: 1,
		bundles,
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
			subjectsFile: "attestation-subjects.txt",
		},
	};
}

function sha256Sums(version = LATEST_VERSION): string {
	const entries = [
		...BINARY_PLATFORMS.map((platform) => ({
			file: `pi-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`,
			sha256: "3".repeat(64),
		})),
		{
			file: "release-manifest.json",
			sha256: createHash("sha256")
				.update(JSON.stringify(manifest(version)))
				.digest("hex"),
		},
		{ file: "install.sh", sha256: createHash("sha256").update(INSTALLER_SH).digest("hex") },
		{ file: "install.ps1", sha256: createHash("sha256").update(INSTALLER_PS1).digest("hex") },
	];
	return `${entries
		.sort((a, b) => a.file.localeCompare(b.file))
		.map((entry) => `${entry.sha256}  ${entry.file}`)
		.join("\n")}\n`;
}

function stubFetch(version = LATEST_VERSION): ReturnType<typeof vi.fn> {
	const exactBase = `https://github.com/xz-dev/pi/releases/download/xz-v${version}/`;
	const fetchMock = vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url === LATEST_MANIFEST) return Response.json(manifest(version));
		if (url === `${exactBase}SHA256SUMS`) return new Response(sha256Sums(version));
		if (url === `${exactBase}install.sh`) return new Response(INSTALLER_SH);
		if (url === `${exactBase}install.ps1`) return new Response(INSTALLER_PS1);
		return new Response("not found", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function loadXzCommand(
	spawnMock: ReturnType<typeof vi.fn>,
	packageName = "@earendil-works/pi-coding-agent",
	installMethod: "bun-binary" | "npm" = "bun-binary",
) {
	vi.resetModules();
	vi.doMock("../src/config.ts", async () => {
		const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
		return {
			...actual,
			DISTRIBUTION: "xz-dev",
			PACKAGE_NAME: packageName,
			VERSION: CURRENT_VERSION,
			detectInstallMethod: () => installMethod,
		};
	});
	vi.doMock("node:child_process", async () => {
		const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		return { ...actual, spawn: spawnMock };
	});
	return import("../src/package-manager-cli.ts");
}

beforeEach(() => {
	allowNetwork();
	tempDir = join(tmpdir(), `pi-xz-package-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
	originalExitCode = process.exitCode;
	originalPlatform = process.platform;
	process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "{}\n");
	process.exitCode = undefined;
});

afterEach(() => {
	vi.doUnmock("../src/config.ts");
	vi.doUnmock("node:child_process");
	vi.resetModules();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalSkipVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
	else process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	process.exitCode = originalExitCode;
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	rmSync(tempDir, { recursive: true, force: true });
});

describe("xz-dev pi update --self", () => {
	it("runs the exact POSIX installer through sh without migration or shell", async () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		const fetchMock = stubFetch();
		const spawnMock = vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => {
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("close", 0, null));
			return child;
		});
		const { handlePackageCommand } = await loadXzCommand(spawnMock);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

		expect(process.exitCode).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(`${EXACT_BASE}install.sh`, expect.anything());
		expect(spawnMock).toHaveBeenCalledOnce();
		const call = spawnMock.mock.calls[0];
		expect(call).toBeDefined();
		const command = call?.[0];
		const args = call?.[1] as string[] | undefined;
		const options = call?.[2];
		expect(command).toBe("sh");
		expect(args?.[0]).toContain("install.sh");
		expect(args).toContain("--update");
		expect(args).not.toContain("--migrate");
		expect(options).toMatchObject({ shell: false, stdio: "inherit" });
		expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			`Updated pi from ${CURRENT_VERSION} to ${LATEST_VERSION}`,
		);
	});

	it("runs the exact PowerShell installer on Windows without migration or shell", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const fetchMock = stubFetch();
		const spawnMock = vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => {
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("close", 0, null));
			return child;
		});
		const { handlePackageCommand } = await loadXzCommand(spawnMock);
		vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

		expect(fetchMock).toHaveBeenCalledWith(`${EXACT_BASE}install.ps1`, expect.anything());
		const call = spawnMock.mock.calls[0];
		const command = call?.[0];
		const args = call?.[1] as string[] | undefined;
		expect(command).toBe("powershell");
		expect(args?.some((arg) => arg.endsWith("install.ps1"))).toBe(true);
		expect(args).toContain("--update");
		expect(args).not.toContain("--migrate");
	});

	it("legacy @xz-dev identity never invokes the canonical Release installer", async () => {
		const fetchMock = vi.fn(async (_input: string | URL) => Response.json({ version: CURRENT_VERSION }));
		vi.stubGlobal("fetch", fetchMock);
		const spawnMock = vi.fn(
			(_command: string, _args: string[], _options: Record<string, unknown>) => new EventEmitter(),
		);
		const { handlePackageCommand } = await loadXzCommand(spawnMock, "@xz-dev/pi-coding-agent");
		vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

		expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("ignores automatic skip for explicit checks, avoids up-to-date execution, and force executes", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		const fetchMock = stubFetch(CURRENT_VERSION);
		const spawnMock = vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => {
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("close", 0, null));
			return child;
		});
		const { handlePackageCommand } = await loadXzCommand(spawnMock);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);
		expect(fetchMock).toHaveBeenCalled();
		expect(spawnMock).not.toHaveBeenCalled();
		expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("already up to date");

		await expect(handlePackageCommand(["update", "--self", "--force"])).resolves.toBe(true);
		expect(spawnMock).toHaveBeenCalledOnce();
		expect(spawnMock.mock.calls[0]?.[1]).toEqual([expect.stringContaining("install.sh"), "--update", "--force"]);
	});

	it("prints source-checkout guidance and never runs an installer for an xz-dev source build", async () => {
		const fetchMock = vi.fn(async (_input: string | URL) => Response.json({ version: LATEST_VERSION }));
		vi.stubGlobal("fetch", fetchMock);
		const spawnMock = vi.fn();
		const { handlePackageCommand } = await loadXzCommand(spawnMock, "@earendil-works/pi-coding-agent", "npm");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(spawnMock).not.toHaveBeenCalled();
		const output = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(output).toContain("source checkout");
		expect(output).toContain("git -C <xz-dev-pi-checkout> pull --ff-only");
	});
});
