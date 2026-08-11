import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowNetwork } from "./test-network-env.ts";

const CURRENT_VERSION = "0.84.1-xz.68.1.g11111111";
const NEXT_VERSION = "0.84.1-xz.69.1.g22222222";
const TAG = `xz-v${NEXT_VERSION}`;
const TARGET = "linux-x64-gnu-modern";
const BUNDLE = `pi-${TARGET}.zip`;
const BUNDLE_BYTES = new TextEncoder().encode("bundle");
const DIGEST = `sha256:${createHash("sha256").update(BUNDLE_BYTES).digest("hex")}`;
const EXACT_BASE = `https://github.com/xz-dev/pi/releases/download/${TAG}/`;
const LATEST_RELEASE = "https://api.github.com/repos/xz-dev/pi/releases/latest";

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		tag_name: TAG,
		target_commitish: `22222222${"3".repeat(32)}`,
		draft: false,
		prerelease: false,
		new_future_field: { ignored: true },
		assets: [
			{
				name: BUNDLE,
				browser_download_url: `${EXACT_BASE}${BUNDLE}`,
				size: BUNDLE_BYTES.byteLength,
				digest: DIGEST,
			},
			{ name: "pi-windows-arm64.zip", browser_download_url: `${EXACT_BASE}pi-windows-arm64.zip` },
		],
		...overrides,
	};
}

async function loadUpdater(executablePath = process.execPath) {
	vi.resetModules();
	vi.doMock("../src/config.ts", async () => {
		const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
		return { ...actual, RELEASE_TARGET: TARGET };
	});
	vi.doMock("node:process", async () => {
		const actual = await vi.importActual<typeof import("node:process")>("node:process");
		return { ...actual, execPath: executablePath };
	});
	return import("../src/utils/xz-release-update.ts");
}

afterEach(() => {
	vi.doUnmock("../src/config.ts");
	vi.doUnmock("node:process");
	vi.resetModules();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("xz-dev native Release updates", () => {
	it("discovers only this binary's exact target and ignores new metadata", async () => {
		allowNetwork();
		const fetchMock = vi.fn(async (input: string | URL) => {
			if (String(input) === LATEST_RELEASE) return Response.json(release());
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease } = await loadUpdater();

		await expect(getLatestXzRelease(CURRENT_VERSION)).resolves.toMatchObject({
			version: NEXT_VERSION,
			tag: TAG,
			commit: `22222222${"3".repeat(32)}`,
			exactBaseUrl: EXACT_BASE,
			bundle: { name: BUNDLE, digest: DIGEST },
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("rejects forged exact-tag URLs and invalid digests", async () => {
		allowNetwork();
		const { getLatestXzRelease } = await loadUpdater();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json(
					release({
						assets: [
							{
								name: BUNDLE,
								browser_download_url: "https://example.test/bundle.zip",
								size: 6,
								digest: DIGEST,
							},
						],
					}),
				),
			),
		);
		await expect(getLatestXzRelease(CURRENT_VERSION)).rejects.toThrow(/exact xz-dev tag asset/);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json(
					release({
						assets: [
							{
								name: BUNDLE,
								browser_download_url: `${EXACT_BASE}${BUNDLE}`,
								size: 6,
								digest: "sha256:not-a-digest",
							},
						],
					}),
				),
			),
		);
		await expect(getLatestXzRelease(CURRENT_VERSION)).rejects.toThrow(/bundle digest/);
	});

	it("rejects unsafe ZIP entries before extraction", async () => {
		if (process.platform === "win32") return;
		allowNetwork();
		const root = join(tmpdir(), `pi-xz-update-${process.pid}-${Date.now()}`);
		const oldBundle = join(root, "bundles", CURRENT_VERSION);
		mkdirSync(oldBundle, { recursive: true });
		writeFileSync(join(root, "current"), `${CURRENT_VERSION}\n`);
		try {
			const source = join(root, "source");
			mkdirSync(source);
			writeFileSync(join(root, "escape"), "unsafe\n");
			const archive = join(root, BUNDLE);
			const { spawnSync } = await import("node:child_process");
			const zipped = spawnSync("zip", ["-q", archive, "../escape"], { cwd: source });
			expect(zipped.status).toBe(0);
			const bytes = readFileSync(archive);
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL) => {
					if (String(input) === LATEST_RELEASE)
						return Response.json(
							release({
								assets: [
									{
										name: BUNDLE,
										browser_download_url: `${EXACT_BASE}${BUNDLE}`,
										size: bytes.byteLength,
										digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
									},
								],
							}),
						);
					return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
				}),
			);
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater();
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			await expect(
				runXzSelfUpdate(latest!, CURRENT_VERSION, false, { executablePath: join(oldBundle, "pi-native") }),
			).rejects.toThrow(/Unsafe Release bundle ZIP entry/);
			expect(readFileSync(join(root, "current"), "utf8")).toBe(`${CURRENT_VERSION}\n`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves activation pointers unchanged when bundle digest fails", async () => {
		allowNetwork();
		const root = join(tmpdir(), `pi-xz-update-${process.pid}-${Date.now()}`);
		const oldBundle = join(root, "bundles", CURRENT_VERSION);
		mkdirSync(oldBundle, { recursive: true });
		writeFileSync(join(root, "current"), `${CURRENT_VERSION}\n`);
		writeFileSync(join(root, "previous"), "older\n");
		const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(join(oldBundle, "pi-native"));
		const fetchMock = vi.fn(async (input: string | URL) => {
			if (String(input) === LATEST_RELEASE) return Response.json(release());
			if (String(input) === `${EXACT_BASE}${BUNDLE}`)
				return new Response("wrong", { headers: { "content-length": "5" } });
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			await expect(
				runXzSelfUpdate(latest!, CURRENT_VERSION, false, { executablePath: join(oldBundle, "pi-native") }),
			).rejects.toThrow(/byte length mismatch|sha256 mismatch/);
			expect(readFileSync(join(root, "current"), "utf8")).toBe(`${CURRENT_VERSION}\n`);
			expect(readFileSync(join(root, "previous"), "utf8")).toBe("older\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
