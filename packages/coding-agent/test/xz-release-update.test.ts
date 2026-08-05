import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLatestXzRelease, runXzSelfUpdate } from "../src/utils/xz-release-update.ts";
import { allowNetwork } from "./test-network-env.ts";

const VERSION = "0.83.0-xz.41.1.g11111111";
const NEW_VERSION = "0.83.0-xz.42.1.g22222222";
const TAG = `xz-v${NEW_VERSION}`;
const INSTALLER = "console.log('installer');\n";
const INSTALLER_SHA256 = createHash("sha256").update(INSTALLER).digest("hex");
const RELEASE_API = "https://api.github.com/repos/xz-dev/pi/releases/latest";
const EXACT_BASE = `https://github.com/xz-dev/pi/releases/download/${TAG}/`;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		repository: "xz-dev/pi",
		tag: TAG,
		distributionVersion: NEW_VERSION,
		apiVersion: "0.83.0",
		commit: `22222222${"3".repeat(32)}`,
		minimumNodeVersion: "22.19.0",
		package: {
			name: "@earendil-works/pi-coding-agent",
			file: `earendil-works-pi-coding-agent-${NEW_VERSION}.tgz`,
			bytes: 1024,
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
			sha256: INSTALLER_SHA256,
		},
		attestation: {
			repository: "xz-dev/pi",
			signerWorkflow: "xz-dev/pi/.github/workflows/publish-github-release.yml",
			signerRef: "refs/heads/main",
			denySelfHostedRunners: true,
			subjectsFile: "attestation-subjects.txt",
			bundleFile: `sha256-${"3".repeat(64)}.jsonl`,
		},
		bootstrap: {
			tag: TAG,
			baseUrl: EXACT_BASE,
			minimumNodeVersion: "22.19.0",
			files: { sh: "install.sh", ps1: "install.ps1" },
		},
		...overrides,
	};
}

function githubRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		tag_name: TAG,
		draft: false,
		prerelease: false,
		assets: [
			`earendil-works-pi-coding-agent-${NEW_VERSION}.tgz`,
			"release-manifest.json",
			"install.ts",
			"install.sh",
			"install.ps1",
			"SHA256SUMS",
			"attestation-subjects.txt",
			`sha256-${"3".repeat(64)}.jsonl`,
		].map((name) => ({ name, browser_download_url: `${EXACT_BASE}${name}` })),
		...overrides,
	};
}

function response(value: unknown): Response {
	return Response.json(value);
}

function stubReleaseFetch(
	releaseValue: unknown = githubRelease(),
	manifestValue: unknown = manifest(),
	installer = INSTALLER,
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url === RELEASE_API) return response(releaseValue);
		if (url === `${EXACT_BASE}release-manifest.json`) return response(manifestValue);
		if (url === `${EXACT_BASE}install.ts`) return new Response(installer);
		return new Response("not found", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("xz-dev GitHub Release updates", () => {
	it("discovers a published non-prerelease latest Release and validates its exact manifest", async () => {
		allowNetwork();
		const fetchMock = stubReleaseFetch();

		await expect(getLatestXzRelease(VERSION)).resolves.toMatchObject({
			version: NEW_VERSION,
			manifestSha256: createHash("sha256").update(JSON.stringify(manifest())).digest("hex"),
			discoveryBaseUrl: EXACT_BASE,
			exactBaseUrl: EXACT_BASE,
			manifest: { tag: TAG, distributionVersion: NEW_VERSION },
		});
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			RELEASE_API,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\//),
					accept: "application/vnd.github+json",
				}),
			}),
		);
	});

	it("rejects draft, prerelease, malformed, cross-origin, and wrong attestation Releases", async () => {
		allowNetwork();
		stubReleaseFetch(githubRelease({ draft: true }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/published and non-prerelease/);

		stubReleaseFetch(
			githubRelease({
				assets: [
					{ name: "release-manifest.json", browser_download_url: "https://example.test/release-manifest.json" },
				],
			}),
		);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/asset URL/);

		stubReleaseFetch(githubRelease(), manifest({ schemaVersion: 2 }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/manifest identity/);

		stubReleaseFetch(
			githubRelease(),
			manifest({
				attestation: {
					repository: "xz-dev/pi",
					signerWorkflow: "evil/workflow.yml",
					signerRef: "refs/heads/main",
					denySelfHostedRunners: true,
					subjectsFile: "attestation-subjects.txt",
					bundleFile: `sha256-${"3".repeat(64)}.jsonl`,
				},
			}),
		);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/attestation policy/);

		stubReleaseFetch(
			githubRelease(),
			manifest({
				attestation: {
					repository: "xz-dev/pi",
					signerWorkflow: "xz-dev/pi/.github/workflows/publish-github-release.yml",
					signerRef: "refs/heads/main",
					denySelfHostedRunners: true,
				},
			}),
		);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/attestation policy/);

		stubReleaseFetch(
			githubRelease(),
			manifest({
				package: {
					...(manifest().package as Record<string, unknown>),
					externalOptionalDependencies: { "@mariozechner/clipboard": "file:../host" },
					allowedNetworkPackages: ["@mariozechner/clipboard"],
					allowedNetworkPackagePrefixes: ["@mariozechner/clipboard-"],
				},
			}),
		);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/external optional dependency version/);
	});

	it.each([
		["missing", githubRelease({ assets: (githubRelease().assets as unknown[]).slice(0, -1) })],
		[
			"extra",
			githubRelease({
				assets: [
					...(githubRelease().assets as unknown[]),
					{ name: "foreign.txt", browser_download_url: `${EXACT_BASE}foreign.txt` },
				],
			}),
		],
	])("rejects a %s canonical Release asset inventory", async (_kind, release) => {
		allowNetwork();
		stubReleaseFetch(release);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/exact canonical asset inventory/);
	});

	it("rejects a required Release asset whose URL is not exact-tag pinned", async () => {
		allowNetwork();
		const assets = (githubRelease().assets as Array<Record<string, unknown>>).map((asset) =>
			asset.name === "SHA256SUMS"
				? { ...asset, browser_download_url: `https://github.com/xz-dev/pi/releases/download/wrong/SHA256SUMS` }
				: asset,
		);
		stubReleaseFetch(githubRelease({ assets }));
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/exact-tag pinned/);
	});

	it("allows GitHub's Release CDN redirect but rejects other redirected hosts", async () => {
		allowNetwork();
		const fetchMock = stubReleaseFetch();
		fetchMock.mockImplementationOnce(async () => response(githubRelease()));
		const trusted = Response.json(manifest());
		Object.defineProperties(trusted, {
			redirected: { value: true },
			url: { value: "https://release-assets.githubusercontent.com/github-production-release-asset/file" },
		});
		fetchMock.mockImplementationOnce(async () => trusted);
		await expect(getLatestXzRelease(VERSION)).resolves.toBeDefined();

		fetchMock.mockReset();
		fetchMock.mockImplementationOnce(async () => response(githubRelease()));
		const untrusted = Response.json(manifest());
		Object.defineProperties(untrusted, {
			redirected: { value: true },
			url: { value: "https://example.test/file" },
		});
		fetchMock.mockImplementationOnce(async () => untrusted);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/trusted GitHub asset CDN/);
	});

	it("reports GitHub API rate limits actionably", async () => {
		allowNetwork();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("rate limited", { status: 403 })),
		);
		await expect(getLatestXzRelease(VERSION)).rejects.toThrow(/HTTP 403.*rate limit.*retry later/i);
	});

	it("downloads the exact-tag installer, verifies its hash, and runs it with the current Node or Bun runtime", async () => {
		allowNetwork();
		const fetchMock = stubReleaseFetch();
		const release = await getLatestXzRelease(VERSION);
		expect(release).toBeDefined();
		const runtime = "/runtime/current-node-or-bun";
		const originalExecPath = process.execPath;
		Object.defineProperty(process, "execPath", { value: runtime, configurable: true });
		let invoked: { command: string; args: string[]; options: Record<string, unknown> } | undefined;
		const spawnMock = vi.fn((command: string, args: readonly string[], options: Record<string, unknown>) => {
			invoked = { command, args: [...args], options };
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("close", 0, null));
			return child;
		});
		try {
			await runXzSelfUpdate(release!, VERSION, { spawn: spawnMock as never });
		} finally {
			Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		}

		expect(fetchMock).toHaveBeenCalledWith(
			`${EXACT_BASE}install.ts`,
			expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": expect.any(String) }) }),
		);
		expect(invoked?.command).toBe(runtime);
		expect(invoked?.args[1]).toBe("--update");
		expect(invoked?.args).not.toContain("--migrate");
		expect(invoked?.options).toMatchObject({
			shell: false,
			stdio: "inherit",
			env: {
				PI_XZ_RELEASE_BASE_URL: EXACT_BASE,
				PI_XZ_RELEASE_EXACT_BASE_URL: EXACT_BASE,
				PI_XZ_RELEASE_MANIFEST_SHA256: release!.manifestSha256,
			},
		});
		expect(invoked?.command).not.toMatch(/(?:sh|bash|powershell|\.ps1)$/i);
	});

	it("does not execute install.ts when its exact manifest hash does not match", async () => {
		allowNetwork();
		stubReleaseFetch();
		const release = await getLatestXzRelease(VERSION);
		const tampered = INSTALLER.replace("installer", "installes");
		stubReleaseFetch(githubRelease(), manifest(), tampered);
		const spawnMock = vi.fn();
		await expect(runXzSelfUpdate(release!, VERSION, { spawn: spawnMock as never })).rejects.toThrow(
			/sha256 mismatch/,
		);
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
