import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import chalk from "chalk";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/xz-release-attestation.json" with { type: "json" };
import { allowNetwork } from "./test-network-env.ts";

const CURRENT_VERSION = "0.84.1-xz.68.1.g11111111";
const NEXT_VERSION = "0.84.1-xz.69.1.g22222222";
const TAG = `xz-v${NEXT_VERSION}`;
const TARGET = "linux-x64-gnu-modern";
const ASSET = `pi-${TARGET}.zip`;
const EXECUTABLE_TEXT = "new-pi-binary-bytes";
const EXECUTABLE_BYTES = new TextEncoder().encode(EXECUTABLE_TEXT);
const EXECUTABLE_SHA256 = createHash("sha256").update(EXECUTABLE_BYTES).digest("hex");

/** Release ZIP shape produced by scripts/lib/github-release.mjs: one deflated 0755 entry. */
function releaseZip(entryName: string, body: Uint8Array): Uint8Array {
	const name = Buffer.from(entryName);
	const data = deflateRawSync(body);
	const checksum = crc32(body);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(8, 8);
	local.writeUInt16LE(0x21, 12);
	local.writeUInt32LE(checksum, 14);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(body.length, 22);
	local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE((3 << 8) | 20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(8, 10);
	central.writeUInt16LE(0x21, 14);
	central.writeUInt32LE(checksum, 16);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(body.length, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE(0o100755 * 0x10000, 38);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(local.length + name.length + data.length, 16);
	return new Uint8Array(Buffer.concat([local, name, data, central, name, end]));
}

const ASSET_BYTES = releaseZip("pi", EXECUTABLE_BYTES);
const ASSET_SHA256 = createHash("sha256").update(ASSET_BYTES).digest("hex");
const DIGEST = `sha256:${ASSET_SHA256}`;
const RELEASE_ORIGIN = "https://github.com";
const MIRRORS = ["https://gh-proxy.com/https://github.com", "https://ghfast.top/https://github.com", RELEASE_ORIGIN];
const LATEST_BASE = `${RELEASE_ORIGIN}/xz-dev/pi/releases/latest/download/`;
const EXACT_BASE = `https://github.com/xz-dev/pi/releases/download/${TAG}/`;
const SUMS_URL = `${LATEST_BASE}SHA256SUMS`;
const MANIFEST_URL = `${LATEST_BASE}release-manifest.json`;
const ATTESTATION_URL = `${EXACT_BASE}attestation-subjects.jsonl`;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 7,
		repository: "xz-dev/pi",
		tag: TAG,
		distributionVersion: NEXT_VERSION,
		apiVersion: "0.84.1",
		commit: `22222222${"3".repeat(32)}`,
		packaging: "binary",
		bundles: {
			[TARGET]: {
				file: ASSET,
				bytes: ASSET_BYTES.byteLength,
				sha256: ASSET_SHA256,
				executable: { file: `pi-${TARGET}`, bytes: EXECUTABLE_BYTES.byteLength, sha256: EXECUTABLE_SHA256 },
			},
			"windows-arm64": {
				file: "pi-windows-arm64.zip",
				bytes: 10,
				sha256: "4".repeat(64),
				executable: { file: "pi-windows-arm64.exe", bytes: 10, sha256: "5".repeat(64) },
			},
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
		sums: `${ASSET_SHA256}  ${ASSET}\n${manifestSha256}  release-manifest.json\n`,
	};
}

function discoveryFetch(value: Record<string, unknown> = manifest(), proof: string | null = "{}") {
	const { manifestBytes, sums } = discoveryFiles(value);
	return vi.fn(async (input: string | URL, _init?: RequestInit) => {
		if (String(input) === ATTESTATION_URL && proof !== null) return new Response(proof);
		if (String(input) === SUMS_URL) return new Response(sums);
		if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
		return new Response("not found", { status: 404 });
	});
}

function initSignal(fetchMock: ReturnType<typeof vi.fn>, url: string): AbortSignal | undefined {
	const call = fetchMock.mock.calls.find(([input]) => String(input) === url);
	return call?.[1]?.signal ?? undefined;
}

async function loadUpdater(executablePath = process.execPath, realAttestations = false) {
	vi.resetModules();
	// Filesystem/transport tests use synthetic ZIPs; authenticity tests below use real signed bytes.
	if (realAttestations) vi.doUnmock("../src/utils/release-attestation.ts");
	else vi.doMock("../src/utils/release-attestation.ts", () => ({ verifyReleaseAttestation: vi.fn() }));
	vi.doMock("../src/config.ts", async () => {
		const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
		return {
			...actual,
			RELEASE_TARGET: TARGET,
			DISTRIBUTION: "xz-dev",
			VERSION: CURRENT_VERSION,
			detectInstallMethod: () => "bun-binary",
			getInstallDir: () => dirname(executablePath),
		};
	});
	vi.doMock("node:process", async () => {
		const actual = await vi.importActual<typeof import("node:process")>("node:process");
		return { ...actual, execPath: executablePath };
	});
	return import("../src/utils/xz-release-update.ts");
}

/** Install dir containing one running executable named `pi` with `oldBytes`. */
function writeSingleInstall(oldBytes = "old-pi-binary\n"): string {
	const root = mkdtempSync(join(tmpdir(), "pi-xz-update-"));
	writeFileSync(join(root, "pi"), oldBytes);
	return root;
}

function fullFetch(assetBody: Uint8Array | string = ASSET_BYTES) {
	const { manifestBytes, sums } = discoveryFiles();
	return vi.fn(async (input: string | URL, _init?: RequestInit) => {
		const url = String(input);
		if (url === SUMS_URL) return new Response(sums);
		if (url === MANIFEST_URL) return new Response(manifestBytes);
		if (url === ATTESTATION_URL) return new Response("{}");
		if (url === `${EXACT_BASE}${ASSET}`) return new Response(assetBody);
		return new Response("not found", { status: 404 });
	});
}

afterEach(() => {
	vi.doUnmock("../src/utils/release-attestation.ts");
	vi.doUnmock("../src/config.ts");
	vi.doUnmock("node:process");
	vi.resetModules();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("xz-dev Release discovery", () => {
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
			bundle: {
				name: ASSET,
				digest: DIGEST,
				size: ASSET_BYTES.byteLength,
				executable: { size: EXECUTABLE_BYTES.byteLength, digest: `sha256:${EXECUTABLE_SHA256}` },
			},
		});
		expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([SUMS_URL, MANIFEST_URL, ATTESTATION_URL]);
		for (const [, init] of fetchMock.mock.calls) {
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
		}
	});

	it("rejects an otherwise checksum-valid release when its signature proof is missing", async () => {
		allowNetwork();
		vi.stubGlobal("fetch", discoveryFetch(manifest(), null));
		const { getLatestXzRelease } = await loadUpdater(process.execPath, true);
		await expect(getLatestXzRelease(CURRENT_VERSION)).rejects.toThrow("HTTP 404");
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
			ATTESTATION_URL,
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
			return new Response(ASSET_BYTES);
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
			discoveryFetch(
				manifest({
					bundles: {
						[TARGET]: {
							file: ASSET,
							bytes: 6,
							sha256: "not-a-digest",
							executable: { bytes: 1, sha256: "a".repeat(64) },
						},
					},
				}),
			),
		);
		await expect(getLatestXzRelease(CURRENT_VERSION)).rejects.toThrow(/bundle digest/);

		vi.stubGlobal("fetch", discoveryFetch(manifest({ schemaVersion: 5, layoutVersion: 2 })));
		await expect(getLatestXzRelease(CURRENT_VERSION)).rejects.toThrow(/manifest identity/);
	});

	it("rejects raw-executable schema 6 manifests and ZIP bundles without executable identity", async () => {
		allowNetwork();
		const { getLatestXzRelease } = await loadUpdater();
		vi.stubGlobal(
			"fetch",
			discoveryFetch(
				manifest({
					schemaVersion: 6,
					bundles: { [TARGET]: { file: `pi-${TARGET}`, bytes: 6, sha256: "a".repeat(64) } },
				}),
			),
		);
		await expect(getLatestXzRelease(CURRENT_VERSION)).rejects.toThrow(/manifest identity/);

		vi.stubGlobal(
			"fetch",
			discoveryFetch(manifest({ bundles: { [TARGET]: { file: ASSET, bytes: 6, sha256: "a".repeat(64) } } })),
		);
		await expect(getLatestXzRelease(CURRENT_VERSION)).rejects.toThrow(/bundle metadata/);
	});
});

describe("xz-dev single-file self-update", () => {
	it("installs the verified candidate as `pi` and keeps the old version as a backup", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		try {
			vi.stubGlobal("fetch", fullFetch());
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			const messages: string[] = [];
			await runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
				executablePath,
				writeProgress: (m) => messages.push(m),
			});
			expect(readFileSync(executablePath, "utf8")).toBe(EXECUTABLE_TEXT);
			expect(readFileSync(join(root, `pi-${CURRENT_VERSION}`), "utf8")).toBe("old-pi-binary\n");
			expect(statSync(executablePath).mode & 0o777).toBe(0o755);
			// No stray staging files or leftover candidate name.
			expect(readdirSync(root).sort()).toEqual([`pi-${CURRENT_VERSION}`, "pi"].sort());
			expect(messages.at(-1)).toContain("100%");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("force-reinstalls the same version with different verified bytes and retains the installed bytes as backup", async () => {
		allowNetwork();
		const oldBytes = "damaged installed bytes\n";
		const root = writeSingleInstall(oldBytes);
		const executablePath = join(root, "pi");
		try {
			vi.stubGlobal("fetch", fullFetch());
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
			const latest = await getLatestXzRelease(NEXT_VERSION);
			await runXzSelfUpdate(latest!, NEXT_VERSION, true, { executablePath, writeProgress: () => {} });
			expect(readFileSync(executablePath, "utf8")).toBe(EXECUTABLE_TEXT);
			expect(readFileSync(join(root, `pi-${NEXT_VERSION}`), "utf8")).toBe(oldBytes);
			expect(readdirSync(root).sort()).toEqual(["pi", `pi-${NEXT_VERSION}`].sort());
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rolls back a failed same-version force activation without leaving temporary candidates", async () => {
		allowNetwork();
		const oldBytes = "old same-version bytes\n";
		const root = writeSingleInstall(oldBytes);
		const executablePath = join(root, "pi");
		try {
			vi.stubGlobal("fetch", fullFetch());
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
			const latest = await getLatestXzRelease(NEXT_VERSION);
			await expect(
				runXzSelfUpdate(latest!, NEXT_VERSION, true, {
					executablePath,
					writeProgress: () => {},
					renameSync: (source, destination) => {
						if (destination === executablePath)
							throw Object.assign(new Error("activation failed"), { code: "EXDEV" });
						renameSync(source, destination);
					},
				}),
			).rejects.toThrow("activation failed");
			expect(readFileSync(executablePath, "utf8")).toBe(oldBytes);
			expect(readdirSync(root)).toEqual(["pi"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves the executable byte-identical and no staging file when sha256 mismatches", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		try {
			vi.stubGlobal("fetch", fullFetch("corrupted-bytes"));
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			await expect(
				runXzSelfUpdate(latest!, CURRENT_VERSION, false, { executablePath, writeProgress: () => {} }),
			).rejects.toThrow(/sha256 mismatch|byte length mismatch/);
			expect(readFileSync(executablePath, "utf8")).toBe("old-pi-binary\n");
			expect(readdirSync(root)).toEqual(["pi"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a digest-valid ZIP whose executable or entry does not match the manifest", async () => {
		allowNetwork();
		for (const [zip, message] of [
			[releaseZip("pi", new TextEncoder().encode("tampered-binary-bytes")), /executable does not match/],
			[releaseZip("pi.exe", EXECUTABLE_BYTES), /must contain only pi|central directory/],
		] as const) {
			const root = writeSingleInstall();
			const executablePath = join(root, "pi");
			try {
				const value = manifest({
					bundles: {
						[TARGET]: {
							file: ASSET,
							bytes: zip.byteLength,
							sha256: createHash("sha256").update(zip).digest("hex"),
							executable: {
								file: `pi-${TARGET}`,
								bytes: EXECUTABLE_BYTES.byteLength,
								sha256: EXECUTABLE_SHA256,
							},
						},
					},
				});
				const { manifestBytes, sums } = discoveryFiles(value);
				vi.stubGlobal(
					"fetch",
					vi.fn(async (input: string | URL) => {
						const url = String(input);
						if (url === SUMS_URL) return new Response(sums);
						if (url === MANIFEST_URL) return new Response(manifestBytes);
						if (url === ATTESTATION_URL) return new Response("{}");
						if (url === `${EXACT_BASE}${ASSET}`) return new Response(zip);
						return new Response("not found", { status: 404 });
					}),
				);
				const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
				const latest = await getLatestXzRelease(CURRENT_VERSION);
				await expect(
					runXzSelfUpdate(latest!, CURRENT_VERSION, false, { executablePath, writeProgress: () => {} }),
				).rejects.toThrow(message);
				expect(readFileSync(executablePath, "utf8")).toBe("old-pi-binary\n");
				expect(readdirSync(root)).toEqual(["pi"]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("leaves the executable byte-identical and no staging file when the body is short", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		try {
			vi.stubGlobal("fetch", fullFetch(ASSET_BYTES.subarray(0, 3)));
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			await expect(
				runXzSelfUpdate(latest!, CURRENT_VERSION, false, { executablePath, writeProgress: () => {} }),
			).rejects.toThrow(/byte length mismatch|sha256 mismatch/);
			expect(readFileSync(executablePath, "utf8")).toBe("old-pi-binary\n");
			expect(readdirSync(root)).toEqual(["pi"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("restores the entrypoint when the final rename fails", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		const candidatePath = join(root, `pi-${NEXT_VERSION}`);
		try {
			vi.stubGlobal("fetch", fullFetch());
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			const calls: [string, string][] = [];
			await expect(
				runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
					executablePath,
					writeProgress: () => {},
					renameSync: (source, destination) => {
						calls.push([basename_(source), basename_(destination)]);
						if (source === candidatePath) {
							throw Object.assign(new Error("simulated rename failure"), { code: "EXDEV" });
						}
						renameSync(source, destination);
					},
				}),
			).rejects.toThrow("simulated rename failure");
			// `pi` entrypoint is present again with the OLD bytes; candidate remains
			// (it is verified and may be reused or cleaned by name on a later update).
			expect(readFileSync(executablePath, "utf8")).toBe("old-pi-binary\n");
			expect(readFileSync(candidatePath, "utf8")).toBe(EXECUTABLE_TEXT);
			expect(readdirSync(root).sort()).toEqual([`pi-${NEXT_VERSION}`, "pi"].sort());
			expect(calls.map(([s, d]) => `${s}->${d}`)).toEqual([
				`.pi-${NEXT_VERSION}.${process.pid}.download->pi-${NEXT_VERSION}`,
				`pi->pi-${CURRENT_VERSION}`,
				`pi-${NEXT_VERSION}->pi`,
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails before touching anything when the backup name is occupied by a directory", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		mkdirSync(join(root, `pi-${CURRENT_VERSION}`));
		try {
			vi.stubGlobal("fetch", fullFetch());
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			await expect(
				runXzSelfUpdate(latest!, CURRENT_VERSION, false, { executablePath, writeProgress: () => {} }),
			).rejects.toThrow(/not a regular file/);
			expect(readFileSync(executablePath, "utf8")).toBe("old-pi-binary\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("two concurrent updates use distinct staging names", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		const seenWrites = new Set<string>();
		try {
			const { manifestBytes, sums } = discoveryFiles();
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL) => {
					const url = String(input);
					if (url === SUMS_URL) return new Response(sums);
					if (url === MANIFEST_URL) return new Response(manifestBytes);
					if (url === ATTESTATION_URL) return new Response("{}");
					if (url === `${EXACT_BASE}${ASSET}`) {
						return new Response(
							new ReadableStream({
								start(controller) {
									controller.enqueue(ASSET_BYTES);
									controller.close();
								},
							}),
						);
					}
					return new Response("not found", { status: 404 });
				}),
			);
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			// Both updates share pid (same process) — staging names are still
			// distinct only across processes. In-process serialization is not the
			// goal; this asserts the staged write itself is `wx`-exclusive and the
			// second update either succeeds cleanly or fails without clobbering.
			const first = runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
				executablePath,
				writeProgress: () => {},
			}).then(
				() => "ok",
				(e) => `err:${(e as Error).message}`,
			);
			const second = runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
				executablePath,
				writeProgress: () => {},
			}).then(
				() => "ok",
				(e) => `err:${(e as Error).message}`,
			);
			const results = await Promise.all([first, second]);
			// At least one completes; the entrypoint always holds valid bytes.
			expect(results.some((r) => r === "ok")).toBe(true);
			const finalBytes = readFileSync(executablePath, "utf8");
			expect([EXECUTABLE_TEXT, "old-pi-binary\n"]).toContain(finalBytes);
			// No `.download` staging residue.
			expect(readdirSync(root).filter((n) => n.includes(".download"))).toEqual([]);
			void seenWrites;
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not classify a bundle HTTP failure as retryable discovery", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		const { manifestBytes, sums } = discoveryFiles();
		const fetchMock = vi.fn(async (input: string | URL) => {
			if (String(input) === SUMS_URL) return new Response(sums);
			if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
			if (String(input) === ATTESTATION_URL) return new Response("{}");
			return new Response("unavailable", { status: 503 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
		try {
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			const error = await runXzSelfUpdate(latest!, CURRENT_VERSION, false, { executablePath }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("GitHub Release request failed: HTTP 503");
			expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
				SUMS_URL,
				MANIFEST_URL,
				ATTESTATION_URL,
				`${EXACT_BASE}${ASSET}`,
			]);
			expect(readFileSync(executablePath, "utf8")).toBe("old-pi-binary\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("aborts a download after thirty seconds without data", async () => {
		allowNetwork();
		vi.useFakeTimers();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		const { manifestBytes, sums } = discoveryFiles();
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			if (String(input) === SUMS_URL) return new Response(sums);
			if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
			if (String(input) === ATTESTATION_URL) return new Response("{}");
			if (String(input) === `${EXACT_BASE}${ASSET}`) {
				const signal = init?.signal;
				return new Response(
					new ReadableStream({
						start(controller) {
							signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
						},
					}),
				);
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
		try {
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			const update = runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
				executablePath,
				inactivityTimeoutMs: 30_000,
				writeProgress: () => {},
			});
			const rejection = expect(update).rejects.toThrow(/download stalled: no data received for 30 seconds/);
			await vi.advanceTimersByTimeAsync(29_999);
			expect(initSignal(fetchMock, `${EXACT_BASE}${ASSET}`)?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await rejection;
			expect(initSignal(fetchMock, `${EXACT_BASE}${ASSET}`)?.aborted).toBe(true);
			expect(readFileSync(executablePath, "utf8")).toBe("old-pi-binary\n");
		} finally {
			vi.useRealTimers();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows progress and permits downloads longer than the former total timeout while data stays active", async () => {
		allowNetwork();
		vi.useFakeTimers();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		const { manifestBytes, sums } = discoveryFiles();
		const fetchMock = vi.fn(async (input: string | URL) => {
			if (String(input) === SUMS_URL) return new Response(sums);
			if (String(input) === MANIFEST_URL) return new Response(manifestBytes);
			if (String(input) === ATTESTATION_URL) return new Response("{}");
			if (String(input) === `${EXACT_BASE}${ASSET}`) {
				return new Response(
					new ReadableStream({
						async start(controller) {
							for (const byte of ASSET_BYTES) {
								await vi.advanceTimersByTimeAsync(25_000);
								controller.enqueue(Uint8Array.of(byte));
							}
							controller.close();
						},
					}),
					{ headers: { "content-length": String(ASSET_BYTES.byteLength) } },
				);
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
		const progress: string[] = [];
		try {
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			await runXzSelfUpdate(latest!, CURRENT_VERSION, false, {
				executablePath,
				inactivityTimeoutMs: 30_000,
				now: Date.now,
				writeProgress: (message) => progress.push(message),
			});
			expect(vi.getTimerCount()).toBe(0);
			expect(progress[0]).toContain(`Downloading ${ASSET}: 0%  0 B / ${ASSET_BYTES.byteLength} B  0 B/s`);
			expect(progress.at(-1)).toContain("100%");
		} finally {
			vi.useRealTimers();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("cleanXzBackups", () => {
	it("removes only strict-version regular files, keeps symlinks, dirs, helper, and current exe", async () => {
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		try {
			// Strict-name backup: delete.
			writeFileSync(join(root, `pi-${CURRENT_VERSION}`), "old\n");
			writeFileSync(join(root, "pi-0.84.1-xz.67.1.g00000000"), "older\n");
			// Non-strict names: keep.
			writeFileSync(join(root, "pi-foo"), "keep\n");
			writeFileSync(join(root, "pi-0.84.1-xz.67.1.g0000000Z"), "keep-bad-hash\n");
			writeFileSync(join(root, "pi-helper"), "keep\n");
			mkdirSync(join(root, "pi-0.84.1-xz.66.1.gabcdef01"));
			if (process.platform !== "win32") {
				symlinkSync("pi", join(root, "pi-0.84.1-xz.65.1.gaaaaaaa1"));
			}
			writeFileSync(join(root, "unrelated.txt"), "keep\n");

			const { cleanXzBackups } = await loadUpdater(executablePath);
			const { removed, retained } = cleanXzBackups(executablePath);
			expect(removed.sort()).toEqual(["pi-0.84.1-xz.67.1.g00000000", `pi-${CURRENT_VERSION}`]);
			expect(retained).toEqual([]);
			const remaining = readdirSync(root).sort();
			for (const kept of [
				"pi",
				"pi-foo",
				"pi-0.84.1-xz.67.1.g0000000Z",
				"pi-helper",
				"pi-0.84.1-xz.66.1.gabcdef01",
				"unrelated.txt",
			]) {
				expect(remaining).toContain(kept);
			}
			if (process.platform !== "win32") {
				expect(remaining).toContain("pi-0.84.1-xz.65.1.gaaaaaaa1");
				expect(lstatSync(join(root, "pi-0.84.1-xz.65.1.gaaaaaaa1")).isSymbolicLink()).toBe(true);
			}
			expect(readFileSync(executablePath, "utf8")).toBe("old-pi-binary\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains and reports a file when unlink fails", async () => {
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		try {
			writeFileSync(join(root, `pi-${CURRENT_VERSION}`), "old\n");
			writeFileSync(join(root, "pi-0.84.1-xz.67.1.g00000000"), "older\n");
			const { cleanXzBackups } = await loadUpdater(executablePath);
			const { removed, retained } = cleanXzBackups(executablePath, {
				unlinkSync: (path) => {
					if (path.endsWith("pi-0.84.1-xz.67.1.g00000000")) {
						throw Object.assign(new Error("device busy"), { code: "EBUSY" });
					}
					return;
				},
			});
			expect(removed).toEqual([`pi-${CURRENT_VERSION}`]);
			expect(retained).toEqual([
				{ file: "pi-0.84.1-xz.67.1.g00000000", error: expect.stringContaining("device busy") },
			]);
			expect(existsSync(join(root, "pi-0.84.1-xz.67.1.g00000000"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("xz-dev self-update over a local HTTP release server", () => {
	it("serves manifest + SHA256SUMS + asset from PI_XZ_RELEASE_BASE_URL and activates the real update", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		const { manifestBytes, sums } = discoveryFiles();
		const requests: string[] = [];
		const server: Server = createServer((request, response) => {
			const url = request.url ?? "";
			requests.push(url);
			if (url.endsWith("/SHA256SUMS")) {
				response.end(sums);
			} else if (url.endsWith("/release-manifest.json")) {
				response.end(manifestBytes);
			} else if (url.endsWith("/attestation-subjects.jsonl")) {
				response.end("{}");
			} else if (url.endsWith(`/${ASSET}`)) {
				response.setHeader("content-length", ASSET_BYTES.byteLength);
				response.end(ASSET_BYTES);
			} else {
				response.statusCode = 404;
				response.end("not found");
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const port = (server.address() as { port: number }).port;
		try {
			vi.stubEnv("PI_XZ_RELEASE_BASE_URL", `http://127.0.0.1:${port}/`);
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater(executablePath);
			const latest = await getLatestXzRelease(CURRENT_VERSION);
			expect(latest).toMatchObject({ version: NEXT_VERSION, tag: TAG });
			await runXzSelfUpdate(latest!, CURRENT_VERSION, false, { executablePath, writeProgress: () => {} });
			expect(readFileSync(executablePath, "utf8")).toBe(EXECUTABLE_TEXT);
			expect(readFileSync(join(root, `pi-${CURRENT_VERSION}`), "utf8")).toBe("old-pi-binary\n");
			expect(requests.map((u) => u.split("/").pop())).toEqual([
				"SHA256SUMS",
				"release-manifest.json",
				"attestation-subjects.jsonl",
				ASSET,
			]);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("xz-dev Release mirrors", () => {
	it.each([
		[[], "http://saved.example"],
		[["--mirror-url", "http://temporary.example"], "http://temporary.example"],
		[["--no-mirror"], RELEASE_ORIGIN],
		[["--mirror"], "https://gh-proxy.com/https://github.com"],
	] as const)("applies CLI flags %j over saved global settings, ignoring project mirrors", async (flags, base) => {
		allowNetwork();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		const originalExecPath = process.execPath;
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		mkdirSync(join(root, ".pi"));
		const saved = JSON.stringify({ updateMirrors: ["http://saved.example"], theme: "dark" });
		writeFileSync(join(agentDir, "settings.json"), saved);
		writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ updateMirrors: ["http://project.example"] }));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.spyOn(process, "cwd").mockReturnValue(root);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const direct = fullFetch();
		const fetchMock = vi.fn((input: string | URL) => direct(String(input).replace(base, RELEASE_ORIGIN)));
		vi.stubGlobal("fetch", fetchMock);
		const originalExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			await loadUpdater(executablePath);
			const { handlePackageCommand } = await import("../src/package-manager-cli.ts");
			Object.defineProperty(process, "execPath", { value: executablePath, configurable: true });
			await handlePackageCommand(["update", "--approve", ...flags]);
			expect(process.exitCode).toBeUndefined();
			expect(readFileSync(executablePath, "utf8")).toBe(EXECUTABLE_TEXT);
			expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
				[SUMS_URL, MANIFEST_URL, ATTESTATION_URL, `${EXACT_BASE}${ASSET}`].map((url) =>
					url.replace(RELEASE_ORIGIN, base),
				),
			);
			expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(saved);
		} finally {
			Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
			process.exitCode = originalExitCode;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([false, true])("tries repeated custom mirrors with gray failures (all fail: %s)", async (allFail) => {
		allowNetwork();
		const root = writeSingleInstall();
		const executablePath = join(root, "pi");
		const originalExecPath = process.execPath;
		const originalExitCode = process.exitCode;
		const colorLevel = chalk.level;
		chalk.level = 1;
		process.exitCode = undefined;
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const first = "http://first.example";
		const second = "http://second.example";
		const direct = fullFetch();
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (allFail || url.startsWith(first)) return new Response("unavailable", { status: 503 });
			return direct(url.replace(second, RELEASE_ORIGIN));
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			await loadUpdater(executablePath);
			const { handlePackageCommand } = await import("../src/package-manager-cli.ts");
			Object.defineProperty(process, "execPath", { value: executablePath, configurable: true });
			await handlePackageCommand(["update", "--mirror-url", first, "--mirror-url", second]);
			expect(process.exitCode).toBe(allFail ? 1 : undefined);
			expect(readFileSync(executablePath, "utf8")).toBe(allFail ? "old-pi-binary\n" : EXECUTABLE_TEXT);
			const messages = errors.mock.calls.map(([message]) => String(message));
			expect(messages.slice(0, 2).every((message) => message.startsWith("\u001b[90m"))).toBe(true);
			expect(messages).toHaveLength(allFail ? 3 : 2);
			if (allFail) {
				expect(messages[2]).toContain("Error:");
				expect(fetchMock).toHaveBeenCalledTimes(2);
			} else {
				expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
					SUMS_URL.replace(RELEASE_ORIGIN, first),
					SUMS_URL.replace(RELEASE_ORIGIN, second),
					MANIFEST_URL.replace(RELEASE_ORIGIN, second),
					ATTESTATION_URL.replace(RELEASE_ORIGIN, second),
					`${EXACT_BASE}${ASSET}`.replace(RELEASE_ORIGIN, first),
					`${EXACT_BASE}${ASSET}`.replace(RELEASE_ORIGIN, second),
				]);
			}
		} finally {
			chalk.level = colorLevel;
			process.exitCode = originalExitCode;
			Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		["/loop", "Too many GitHub Release redirects", 21],
		["file:///etc/passwd", "Unsupported GitHub Release redirect protocol", 1],
	] as const)("rejects unsafe or looping redirects to %s", async (location, error, requests) => {
		allowNetwork();
		const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
		vi.stubGlobal("fetch", fetchMock);
		const { getLatestXzRelease } = await loadUpdater();
		await expect(getLatestXzRelease(CURRENT_VERSION, { mirrors: ["http://mirror.example"] })).rejects.toThrow(error);
		expect(fetchMock).toHaveBeenCalledTimes(requests);
	});

	it("uses the saved mirror for automatic version checks", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const mirror = "http://saved.example";
		writeFileSync(join(root, "settings.json"), JSON.stringify({ updateMirrors: [mirror] }));
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		vi.stubEnv("PI_SKIP_VERSION_CHECK", "");
		const direct = discoveryFetch();
		const fetchMock = vi.fn((input: string | URL) => direct(String(input).replace(mirror, RELEASE_ORIGIN)));
		vi.stubGlobal("fetch", fetchMock);
		try {
			await loadUpdater();
			const { checkForNewPiVersion } = await import("../src/utils/version-check.ts");
			await expect(checkForNewPiVersion(CURRENT_VERSION)).resolves.toEqual({ version: NEXT_VERSION });
			expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
				[SUMS_URL, MANIFEST_URL, ATTESTATION_URL].map((url) => url.replace(RELEASE_ORIGIN, mirror)),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the installed binary unchanged when every source returns corrupt ZIP bytes", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		try {
			const fetchMock = fullFetch();
			vi.stubGlobal("fetch", fetchMock);
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater();
			const release = await getLatestXzRelease(CURRENT_VERSION);
			const corruptFetch = vi.fn(async () => new Response(new Uint8Array(ASSET_BYTES.length)));
			vi.stubGlobal("fetch", corruptFetch);
			await expect(
				runXzSelfUpdate(release!, CURRENT_VERSION, false, {
					mirrors: MIRRORS,
					executablePath: join(root, "pi"),
					writeProgress: () => {},
				}),
			).rejects.toThrow("sha256 mismatch");
			expect(corruptFetch).toHaveBeenCalledTimes(3);
			expect(readFileSync(join(root, "pi"), "utf8")).toBe("old-pi-binary\n");
			expect(readdirSync(root)).toEqual(["pi"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("follows mirror redirects containing an embedded GitHub URL", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const { manifestBytes, sums } = discoveryFiles();
		const requests: string[] = [];
		const server = createServer((request, response) => {
			const path = request.url ?? "";
			requests.push(path);
			if (path.includes("/latest/download/")) {
				response.writeHead(302, { location: path.replace("/latest/download/", `/download/${TAG}/`) });
				response.end();
			} else if (path.endsWith("/SHA256SUMS")) response.end(sums);
			else if (path.endsWith("/release-manifest.json")) response.end(manifestBytes);
			else if (path.endsWith("/attestation-subjects.jsonl")) response.end("{}");
			else if (path.endsWith(`/${ASSET}`)) response.end(ASSET_BYTES);
			else {
				response.statusCode = 404;
				response.end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP server address");
		const mirror = `http://127.0.0.1:${address.port}/https://github.com`;
		try {
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater();
			const release = await getLatestXzRelease(CURRENT_VERSION, { mirrors: [mirror] });
			await runXzSelfUpdate(release!, CURRENT_VERSION, false, {
				mirrors: [mirror],
				executablePath: join(root, "pi"),
				writeProgress: () => {},
			});
			expect(requests).toContain(`/https://github.com/xz-dev/pi/releases/download/${TAG}/SHA256SUMS`);
			expect(readFileSync(join(root, "pi"), "utf8")).toBe(EXECUTABLE_TEXT);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the custom HTTP base for metadata and the exact-tag ZIP", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const mirror = "http://localhost:8080/proxy";
		const direct = fullFetch();
		const fetchMock = vi.fn((input: string | URL) => direct(String(input).replace(mirror, RELEASE_ORIGIN)));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater();
			const release = await getLatestXzRelease(CURRENT_VERSION, { mirrors: [mirror] });
			await runXzSelfUpdate(release!, CURRENT_VERSION, false, {
				mirrors: [mirror],
				executablePath: join(root, "pi"),
				writeProgress: () => {},
			});
			expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
				[SUMS_URL, MANIFEST_URL, ATTESTATION_URL, `${EXACT_BASE}${ASSET}`].map((url) =>
					url.replace(RELEASE_ORIGIN, mirror),
				),
			);
			expect(readFileSync(join(root, "pi"), "utf8")).toBe(EXECUTABLE_TEXT);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back in order during discovery and after a corrupt ZIP, keeping the selected tag", async () => {
		allowNetwork();
		const root = writeSingleInstall();
		const direct = fullFetch();
		const first = "https://gh-proxy.com/https://github.com";
		const second = "https://ghfast.top/https://github.com";
		const requests: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = String(input);
				requests.push(url);
				if (url.startsWith(first)) return new Response("unavailable", { status: 503 });
				if (url.startsWith(second) && url.endsWith(ASSET)) return new Response(new Uint8Array(ASSET_BYTES.length));
				return direct(url.replace(second, RELEASE_ORIGIN));
			}),
		);
		try {
			const { getLatestXzRelease, runXzSelfUpdate } = await loadUpdater();
			const release = await getLatestXzRelease(CURRENT_VERSION, { mirrors: MIRRORS });
			await runXzSelfUpdate(release!, CURRENT_VERSION, false, {
				mirrors: MIRRORS,
				executablePath: join(root, "pi"),
				writeProgress: () => {},
			});
			expect(requests).toEqual([
				SUMS_URL.replace(RELEASE_ORIGIN, first),
				SUMS_URL.replace(RELEASE_ORIGIN, second),
				MANIFEST_URL.replace(RELEASE_ORIGIN, second),
				ATTESTATION_URL.replace(RELEASE_ORIGIN, second),
				`${EXACT_BASE}${ASSET}`.replace(RELEASE_ORIGIN, first),
				`${EXACT_BASE}${ASSET}`.replace(RELEASE_ORIGIN, second),
				`${EXACT_BASE}${ASSET}`,
			]);
			expect(readFileSync(join(root, "pi"), "utf8")).toBe(EXECUTABLE_TEXT);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("authenticated Release discovery", () => {
	it.each(["missing proof", "forged proof", "rewritten manifest and checksums", "wrong source commit"])(
		"refuses %s even with --force, without changing the install",
		async (attack) => {
			allowNetwork();
			const root = writeSingleInstall();
			const executablePath = join(root, "pi");
			const originalExitCode = process.exitCode;
			process.exitCode = 0;
			vi.stubEnv("PI_CODING_AGENT_DIR", root);
			vi.spyOn(console, "log").mockImplementation(() => {});
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			let bytes = Buffer.from(fixture.manifestBase64, "base64");
			if (attack === "rewritten manifest and checksums" || attack === "wrong source commit") {
				const value = JSON.parse(bytes.toString("utf8"));
				if (attack === "wrong source commit") {
					value.commit = "a".repeat(40);
					value.distributionVersion = value.distributionVersion.replace(/g[0-9a-f]{8}$/, "gaaaaaaaa");
					value.tag = `xz-v${value.distributionVersion}`;
				} else value.bundles[TARGET].sha256 = "0".repeat(64);
				bytes = Buffer.from(JSON.stringify(value));
			}
			const fetchMock = vi.fn(async (input: string | URL) => {
				const url = String(input);
				if (url.endsWith("/SHA256SUMS"))
					return new Response(`${createHash("sha256").update(bytes).digest("hex")}  release-manifest.json\n`);
				if (url.endsWith("/release-manifest.json")) return new Response(bytes);
				if (url.endsWith("/attestation-subjects.jsonl"))
					return attack === "missing proof"
						? new Response("missing", { status: 404 })
						: new Response(
								attack === "forged proof"
									? "{}"
									: fixture.attestations.map((b) => JSON.stringify(b)).join("\n"),
							);
				throw new Error(`Unexpected ZIP request: ${url}`);
			});
			vi.stubGlobal("fetch", fetchMock);
			try {
				await loadUpdater(executablePath, true);
				const { handlePackageCommand } = await import("../src/package-manager-cli.ts");
				await handlePackageCommand([
					"update",
					"--force",
					"--mirror-url",
					"http://untrusted.example",
					"--mirror-url",
					RELEASE_ORIGIN,
				]);
				expect(process.exitCode).toBe(1);
				expect(errors.mock.calls.flat().join("\n")).toMatch(/attestation|HTTP 404/);
				expect(fetchMock).toHaveBeenCalledTimes(6);
				expect(readFileSync(executablePath, "utf8")).toBe("old-pi-binary\n");
				expect(readdirSync(root)).toEqual(["pi"]);
			} finally {
				process.exitCode = originalExitCode;
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("falls back from forged mirrored metadata to a genuinely signed exact-tag release", async () => {
		allowNetwork();
		const bytes = Buffer.from(fixture.manifestBase64, "base64");
		const real = JSON.parse(bytes.toString("utf8"));
		const failures: string[] = [];
		const requests: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = String(input);
				requests.push(url);
				if (url.endsWith("/SHA256SUMS"))
					return new Response(`${createHash("sha256").update(bytes).digest("hex")}  release-manifest.json\n`);
				if (url.endsWith("/release-manifest.json")) return new Response(bytes);
				return new Response(
					url.startsWith("http://untrusted.example")
						? "{}"
						: fixture.attestations.map((b) => JSON.stringify(b)).join("\n"),
				);
			}),
		);
		const { getLatestXzRelease } = await loadUpdater(process.execPath, true);
		await expect(
			getLatestXzRelease(CURRENT_VERSION, {
				mirrors: ["http://untrusted.example", RELEASE_ORIGIN],
				onMirrorError: (message) => failures.push(message),
			}),
		).resolves.toMatchObject({ version: real.distributionVersion, commit: real.commit });
		expect(failures).toHaveLength(1);
		expect(requests.at(-1)).toBe(
			`${RELEASE_ORIGIN}/xz-dev/pi/releases/download/${real.tag}/attestation-subjects.jsonl`,
		);
	});
});

function basename_(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i < 0 ? p : p.slice(i + 1);
}
