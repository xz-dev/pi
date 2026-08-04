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
const INSTALLER = "export {};\n";
let tempDir: string;
let originalAgentDir: string | undefined;
let originalSkipVersionCheck: string | undefined;
let originalExitCode: typeof process.exitCode;

function manifest(version = LATEST_VERSION): Record<string, unknown> {
	const tag = `xz-v${version}`;
	return {
		schemaVersion: 1,
		repository: "xz-dev/pi",
		tag,
		distributionVersion: version,
		apiVersion: "0.83.0",
		commit: version === CURRENT_VERSION ? `11111111${"3".repeat(32)}` : `22222222${"3".repeat(32)}`,
		minimumNodeVersion: "22.19.0",
		package: {
			name: "@earendil-works/pi-coding-agent",
			file: `earendil-works-pi-coding-agent-${version}.tgz`,
			bytes: 1,
			sha256: "3".repeat(64),
			integrity: `sha512-${"A".repeat(86)}==`,
			bundled: true,
			packaging: "hybrid",
			networkPolicy: "external-optional-only",
			externalOptionalDependencies: {},
			allowedNetworkPackages: [],
			allowedNetworkPackagePrefixes: [],
		},
		installer: {
			file: "install.ts",
			bytes: Buffer.byteLength(INSTALLER),
			sha256: createHash("sha256").update(INSTALLER).digest("hex"),
		},
		attestation: {
			repository: "xz-dev/pi",
			signerWorkflow: "xz-dev/pi/.github/workflows/publish-github-release.yml",
			signerRef: "refs/heads/main",
			denySelfHostedRunners: true,
			subjectsFile: "attestation-subjects.txt",
		},
		bootstrap: {
			tag: `xz-v${version}`,
			baseUrl: `https://github.com/xz-dev/pi/releases/download/xz-v${version}/`,
			minimumNodeVersion: "22.19.0",
			files: { sh: "install.sh", ps1: "install.ps1" },
		},
	};
}

function stubFetch(version = LATEST_VERSION): ReturnType<typeof vi.fn> {
	const tag = `xz-v${version}`;
	const exactBase = `https://github.com/xz-dev/pi/releases/download/${tag}/`;
	const fetchMock = vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith("/releases/latest")) {
			return Response.json({
				tag_name: tag,
				draft: false,
				prerelease: false,
				assets: [
					`earendil-works-pi-coding-agent-${version}.tgz`,
					"release-manifest.json",
					"install.ts",
					"install.sh",
					"install.ps1",
					"SHA256SUMS",
					"attestation-subjects.txt",
				].map((name) => ({ name, browser_download_url: `${exactBase}${name}` })),
			});
		}
		if (url === `${exactBase}release-manifest.json`) return Response.json(manifest(version));
		if (url === `${exactBase}install.ts`) return new Response(INSTALLER);
		return new Response("not found", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function loadXzCommand(spawnMock: ReturnType<typeof vi.fn>, packageName = "@earendil-works/pi-coding-agent") {
	vi.resetModules();
	vi.doMock("../src/config.ts", async () => {
		const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
		return {
			...actual,
			DISTRIBUTION: "xz-dev",
			PACKAGE_NAME: packageName,
			VERSION: CURRENT_VERSION,
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
	rmSync(tempDir, { recursive: true, force: true });
});

describe("xz-dev pi update --self", () => {
	it("runs the exact Release installer through the current runtime without migration or shell", async () => {
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
		expect(fetchMock).toHaveBeenCalledWith(`${EXACT_BASE}install.ts`, expect.anything());
		expect(spawnMock).toHaveBeenCalledOnce();
		const call = spawnMock.mock.calls[0];
		expect(call).toBeDefined();
		const command = call?.[0];
		const args = call?.[1] as string[] | undefined;
		const options = call?.[2];
		expect(command).toBe(process.execPath);
		expect(args?.[1]).toBe("--update");
		expect(args).not.toContain("--migrate");
		expect(options).toMatchObject({ shell: false, stdio: "inherit" });
		expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			`Updated pi from ${CURRENT_VERSION} to ${LATEST_VERSION}`,
		);
	});

	it("legacy @xz-dev identity never invokes the canonical Release installer or migration", async () => {
		const fetchMock = vi.fn(async (_input: string | URL) => Response.json({ version: CURRENT_VERSION }));
		vi.stubGlobal("fetch", fetchMock);
		const spawnMock = vi.fn(
			(_command: string, _args: string[], _options: Record<string, unknown>) => new EventEmitter(),
		);
		const { handlePackageCommand } = await loadXzCommand(spawnMock, "@xz-dev/pi-coding-agent");
		vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

		expect(
			fetchMock.mock.calls.some(([input]) => String(input).includes("api.github.com/repos/xz-dev/pi/releases")),
		).toBe(false);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("ignores automatic skip for explicit checks, avoids up-to-date execution, and force executes", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
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
	});
});
