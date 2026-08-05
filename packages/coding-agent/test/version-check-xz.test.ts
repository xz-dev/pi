import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowNetwork } from "./test-network-env.ts";

const CURRENT_VERSION = "0.83.0-xz.1.1.g11111111";
const LATEST_VERSION = "0.83.0-xz.2.1.g22222222";
const TAG = `xz-v${LATEST_VERSION}`;
const EXACT_BASE = `https://github.com/xz-dev/pi/releases/download/${TAG}/`;
const INSTALLER = "export {};\n";

function fixtureManifest(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		repository: "xz-dev/pi",
		tag: TAG,
		distributionVersion: LATEST_VERSION,
		apiVersion: "0.83.0",
		commit: `22222222${"3".repeat(32)}`,
		minimumNodeVersion: "22.19.0",
		package: {
			name: "@earendil-works/pi-coding-agent",
			file: `earendil-works-pi-coding-agent-${LATEST_VERSION}.tgz`,
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
			tag: TAG,
			baseUrl: `https://github.com/xz-dev/pi/releases/download/${TAG}/`,
			minimumNodeVersion: "22.19.0",
			files: { sh: "install.sh", ps1: "install.ps1" },
		},
	};
}

function stubFetch(): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith("/releases/latest")) {
			return Response.json({
				tag_name: TAG,
				draft: false,
				prerelease: false,
				assets: [
					`earendil-works-pi-coding-agent-${LATEST_VERSION}.tgz`,
					"release-manifest.json",
					"install.ts",
					"install.sh",
					"install.ps1",
					"SHA256SUMS",
					"attestation-subjects.txt",
				].map((name) => ({ name, browser_download_url: `${EXACT_BASE}${name}` })),
			});
		}
		if (url === `${EXACT_BASE}release-manifest.json`) return Response.json(fixtureManifest());
		return new Response("not found", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function loadXzVersionCheck() {
	vi.resetModules();
	vi.doMock("../src/config.ts", async () => {
		const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
		return {
			...actual,
			DISTRIBUTION: "xz-dev",
			PACKAGE_NAME: "@earendil-works/pi-coding-agent",
		};
	});
	return import("../src/utils/version-check.ts");
}

afterEach(() => {
	vi.doUnmock("../src/config.ts");
	vi.resetModules();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	delete process.env.PI_SKIP_VERSION_CHECK;
});

describe("xz-dev version checks", () => {
	it("uses xz-dev latest GitHub Release metadata for automatic notifications", async () => {
		allowNetwork();
		const fetchMock = stubFetch();
		const { checkForNewPiVersion } = await loadXzVersionCheck();

		await expect(checkForNewPiVersion(CURRENT_VERSION)).resolves.toEqual({ version: LATEST_VERSION });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/xz-dev/pi/releases/latest");
	});

	it("preserves PI_SKIP_VERSION_CHECK for automatic checks", async () => {
		allowNetwork();
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = stubFetch();
		const { checkForNewPiVersion } = await loadXzVersionCheck();

		await expect(checkForNewPiVersion(CURRENT_VERSION)).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
