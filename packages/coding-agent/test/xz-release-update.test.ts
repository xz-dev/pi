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
const BUNDLE_SHA256 = createHash("sha256").update(BUNDLE_BYTES).digest("hex");
const DIGEST = `sha256:${BUNDLE_SHA256}`;
const RELEASE_ORIGIN = "https://github.com";
const LATEST_BASE = `${RELEASE_ORIGIN}/xz-dev/pi/releases/latest/download/`;
const EXACT_BASE = `https://github.com/xz-dev/pi/releases/download/${TAG}/`;
const SUMS_URL = `${LATEST_BASE}SHA256SUMS`;
const MANIFEST_URL = `${LATEST_BASE}release-manifest.json`;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 5,
		repository: "xz-dev/pi",
		tag: TAG,
		distributionVersion: NEXT_VERSION,
		apiVersion: "0.84.1",
		commit: `22222222${"3".repeat(32)}`,
		packaging: "binary",
		layoutVersion: 2,
		bundles: {
			[TARGET]: { file: BUNDLE, bytes: BUNDLE_BYTES.byteLength, sha256: BUNDLE_SHA256 },
			"windows-arm64": { file: "pi-windows-arm64.zip", bytes: 10, sha256: "4".repeat(64) },
		},
		new_future_field: { ignored: true },
		...overrides,
	};
}

function discoveryFiles(value: Record<string, unknown> = manifest()): { manifestBytes: Uint8Array; sums: string } {
	const manifestBytes = new TextEncoder().encode(JSON.stringify(value));
	const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
	return {
		manifestBytes,
		sums: `${BUNDLE_SHA256}  ${BUNDLE}\n${manifestSha256}  release-manifest.json\n`,
	};
}

function discoveryFetch(value: Record<string, unknown> = manifest()) {
	const { manifestBytes, sums } = discoveryFiles(value);
	return vi.fn(async (input: string | URL, _init?: RequestInit) => {
		if (String(input) === SUMS_URL) return new Response(sums);
		if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
		return new Response("not found", { status: 404 });
	});
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
	it("discovers this binary's target from checksum-verified public latest/download assets", async () => {
		allowNetwork();
		const fetchMock = discoveryFetch();
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease } = await loadUpdater();

		await expect(getLatestXzRelease(CURRENT_VERSION)).resolves.toMatchObject({
			version: NEXT_VERSION,
			tag: TAG,
			commit: `22222222${"3".repeat(32)}`,
			exactBaseUrl: EXACT_BASE,
			bundle: { name: BUNDLE, digest: DIGEST, size: BUNDLE_BYTES.byteLength },
		});
		expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([SUMS_URL, MANIFEST_URL]);
		for (const [, init] of fetchMock.mock.calls) {
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
		}
	});

	it("restarts discovery from SHA256SUMS after a manifest body transport failure", async () => {
		allowNetwork();
		const { manifestBytes, sums } = discoveryFiles();
		let manifestAttempts = 0;
		const fetchMock = vi.fn(async (input: string | URL) => {
			if (String(input) === SUMS_URL) return new Response(sums);
			if (String(input) === MANIFEST_URL && manifestAttempts++ === 0) {
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(manifestBytes.subarray(0, 1));
							controller.error(new Error("manifest stream failed"));
						},
					}),
				);
			}
			return new Response(manifestBytes);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease } = await loadUpdater();

		await expect(getLatestXzRelease(CURRENT_VERSION, { retry: true })).resolves.toMatchObject({
			version: NEXT_VERSION,
		});
		expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
			SUMS_URL,
			MANIFEST_URL,
			SUMS_URL,
			MANIFEST_URL,
		]);
	});

	it("does not retry transient discovery failures by default", async () => {
		allowNetwork();
		const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease } = await loadUpdater();

		await expect(getLatestXzRelease(CURRENT_VERSION)).rejects.toThrow("GitHub Release request failed: HTTP 503");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("does not retry integrity failures", async () => {
		allowNetwork();
		const { manifestBytes, sums } = discoveryFiles();
		const corrupt = manifestBytes.slice();
		corrupt[corrupt.byteLength - 1] = " ".charCodeAt(0);
		const fetchMock = vi.fn(async (input: string | URL) => new Response(String(input) === SUMS_URL ? sums : corrupt));
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease } = await loadUpdater();

		await expect(getLatestXzRelease(CURRENT_VERSION, { retry: true })).rejects.toThrow(/manifest sha256 mismatch/);
		expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([SUMS_URL, MANIFEST_URL]);
	});

	it("stops retrying discovery after three whole attempts", async () => {
		allowNetwork();
		const { sums } = discoveryFiles();
		const fetchMock = vi.fn(
			async (input: string | URL) =>
				new Response(String(input) === SUMS_URL ? sums : "timeout", {
					status: String(input) === SUMS_URL ? 200 : 504,
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease } = await loadUpdater();

		await expect(getLatestXzRelease(CURRENT_VERSION, { retry: true })).rejects.toThrow(
			"GitHub Release request failed: HTTP 504",
		);
		expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
			SUMS_URL,
			MANIFEST_URL,
			SUMS_URL,
			MANIFEST_URL,
			SUMS_URL,
			MANIFEST_URL,
		]);
	});

	it("rejects a corrupt manifest before parsing or requesting a bundle", async () => {
		allowNetwork();
		const { manifestBytes, sums } = discoveryFiles();
		const corrupt = manifestBytes.slice();
		corrupt[corrupt.byteLength - 1] = " ".charCodeAt(0);
		const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
			if (String(input) === SUMS_URL) return new Response(sums);
			if (String(input) === MANIFEST_URL) return new Response(corrupt);
			return new Response(BUNDLE_BYTES);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease } = await loadUpdater();

		await expect(getLatestXzRelease(CURRENT_VERSION)).rejects.toThrow(/manifest sha256 mismatch/);
		expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([SUMS_URL, MANIFEST_URL]);
	});

	it("requires one strict SHA256SUMS entry for release-manifest.json", async () => {
		allowNetwork();
		const { manifestBytes } = discoveryFiles();
		const digest = createHash("sha256").update(manifestBytes).digest("hex");
		const { getLatestXzRelease } = await loadUpdater();
		for (const sums of [
			`${digest} *release-manifest.json\n`,
			`${digest}  release-manifest.json\n${digest}  release-manifest.json\n`,
		]) {
			const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
				if (String(input) === SUMS_URL) return new Response(sums);
				return new Response(manifestBytes);
			});
			vi.stubGlobal("fetch", fetchMock);
			await expect(getLatestXzRelease(CURRENT_VERSION)).rejects.toThrow(/SHA256SUMS/);
			expect(fetchMock).toHaveBeenCalledOnce();
		}
	});

	it("rejects invalid manifest identity and target digest", async () => {
		allowNetwork();
		const { getLatestXzRelease } = await loadUpdater();
		vi.stubGlobal("fetch", discoveryFetch(manifest({ repository: "attacker/pi" })));
		await expect(getLatestXzRelease(CURRENT_VERSION)).rejects.toThrow(/manifest identity/);

		vi.stubGlobal(
			"fetch",
			discoveryFetch(manifest({ bundles: { [TARGET]: { file: BUNDLE, bytes: 6, sha256: "not-a-digest" } } })),
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
			const value = manifest({
				bundles: {
					[TARGET]: {
						file: BUNDLE,
						bytes: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
				},
			});
			const { manifestBytes, sums } = discoveryFiles(value);
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL, _init?: RequestInit) => {
					if (String(input) === SUMS_URL) return new Response(sums);
					if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
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

	it("does not classify a bundle HTTP failure as retryable discovery", async () => {
		allowNetwork();
		const root = join(tmpdir(), `pi-xz-update-${process.pid}-${Date.now()}`);
		const oldBundle = join(root, "bundles", CURRENT_VERSION);
		mkdirSync(oldBundle, { recursive: true });
		writeFileSync(join(root, "current"), `${CURRENT_VERSION}\n`);
		const { manifestBytes, sums } = discoveryFiles();
		const fetchMock = vi.fn(async (input: string | URL) => {
			if (String(input) === SUMS_URL) return new Response(sums);
			if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
			return new Response("unavailable", { status: 503 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(join(oldBundle, "pi-native"));
		try {
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			const error = await runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
				executablePath: join(oldBundle, "pi-native"),
			}).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("GitHub Release request failed: HTTP 503");
			expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
				SUMS_URL,
				MANIFEST_URL,
				`${EXACT_BASE}${BUNDLE}`,
			]);
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
		const { manifestBytes, sums } = discoveryFiles();
		const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
			if (String(input) === SUMS_URL) return new Response(sums);
			if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
			if (String(input) === `${EXACT_BASE}${BUNDLE}`)
				return new Response("broken", { headers: { "content-length": String(BUNDLE_BYTES.byteLength) } });
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(join(oldBundle, "pi-native"));
		try {
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			await expect(
				runXzSelfUpdate(latest!, CURRENT_VERSION, false, { executablePath: join(oldBundle, "pi-native") }),
			).rejects.toThrow(/sha256 mismatch/);
			expect(readFileSync(join(root, "current"), "utf8")).toBe(`${CURRENT_VERSION}\n`);
			expect(readFileSync(join(root, "previous"), "utf8")).toBe("older\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
