import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const GENERATE_URL = pathToFileURL(join(REPO_ROOT, "scripts", "generate-install-bootstrap.mjs")).href;

let tempDir: string | undefined;
let server: Server | undefined;

afterEach(() => {
	if (server) {
		server.close();
		server = undefined;
	}
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

async function loadGenerator() {
	return import(GENERATE_URL);
}

async function runCommand(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const status = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	return { status, stdout, stderr };
}

function startStaticServer(rootDir: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
			const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
			const relative = urlPath.replace(/^\/+/, "");
			const filePath = join(rootDir, relative);
			if (!filePath.startsWith(rootDir) || !existsSync(filePath)) {
				res.writeHead(404);
				res.end("not found");
				return;
			}
			const body = readFileSync(filePath);
			res.writeHead(200, { "Content-Length": body.byteLength });
			res.end(body);
		});
		httpServer.once("error", reject);
		httpServer.listen(0, "127.0.0.1", () => {
			const address = httpServer.address();
			if (!address || typeof address === "string") {
				reject(new Error("failed to bind bootstrap fixture server"));
				return;
			}
			server = httpServer;
			resolve({
				baseUrl: `http://127.0.0.1:${address.port}/`,
				close: () =>
					new Promise<void>((closeResolve, closeReject) => {
						httpServer.close((error) => (error ? closeReject(error) : closeResolve()));
					}),
			});
		});
	});
}

describe("GitHub Release install bootstrap generator", () => {
	test("embeds exact tag, base URL, manifest sha, and install.ts pin", async () => {
		const gen = await loadGenerator();
		const pins = {
			tag: "xz-v1.2.3-xz.9.1.gabcdef12",
			baseUrl: "https://github.com/xz-dev/pi/releases/download/xz-v1.2.3-xz.9.1.gabcdef12/",
			manifestSha256: "a".repeat(64),
			installTsSha256: "b".repeat(64),
			installTsBytes: 4242,
			minimumNodeVersion: "22.19.0",
		};
		const sh = gen.generateInstallSh(pins);
		const ps1 = gen.generateInstallPs1(pins);

		for (const content of [sh, ps1]) {
			expect(content).toContain(pins.tag);
			expect(content).toContain(pins.baseUrl);
			expect(content).toContain(pins.manifestSha256);
			expect(content).toContain(pins.installTsSha256);
			expect(content).toContain(String(pins.installTsBytes));
			expect(content).toContain("22.19.0");
			// Thin bootstrap only — no transaction machinery.
			expect(content).not.toMatch(/\bnpm install\b/);
			expect(content).not.toContain("atomicCurrent");
			expect(content).not.toContain("versionsDir");
		}
		expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
		expect(sh).toContain("curl");
		expect(sh).toContain('exec "$RUNTIME" "$INSTALL_TS_PATH" "$@"');
		expect(ps1).toContain("Invoke-WebRequest");
		expect(ps1).toContain("@args");
	});

	test("declares GitHub CLI as a required provenance verifier", async () => {
		const gen = await loadGenerator();
		const pins = {
			tag: "xz-v1.2.3-xz.9.1.gabcdef12",
			baseUrl: "https://github.com/xz-dev/pi/releases/download/xz-v1.2.3-xz.9.1.gabcdef12/",
			manifestSha256: "a".repeat(64),
			installTsSha256: "b".repeat(64),
			installTsBytes: 4242,
			minimumNodeVersion: "22.19.0",
		};
		expect(gen.generateInstallSh(pins)).toMatch(/GitHub CLI \(gh\) is required/);
		expect(gen.generateInstallPs1(pins)).toMatch(/GitHub CLI \(gh\) is required/);
	});

	test("rejects invalid pin inputs", async () => {
		const gen = await loadGenerator();
		expect(() =>
			gen.generateInstallSh({
				tag: "xz-v1",
				baseUrl: "https://example.test/no-slash",
				manifestSha256: "a".repeat(64),
				installTsSha256: "b".repeat(64),
				installTsBytes: 10,
			}),
		).toThrow(/exact xz Release tag|exact xz-dev\/pi Release tag URL/);
		expect(() =>
			gen.generateInstallSh({
				tag: "xz-v1.2.3-xz.9.1.gabcdef12",
				baseUrl: "https://github.com/xz-dev/pi/releases/download/xz-v1.2.3-xz.9.1.gabcdef12/",
				manifestSha256: "not-hex",
				installTsSha256: "b".repeat(64),
				installTsBytes: 10,
			}),
		).toThrow(/manifestSha256/);
	});

	test("bootstrap downloads pinned assets, verifies digests, selects node, and forwards args", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-github-release-bootstrap-"));
		const releaseDir = join(tempDir, "release");
		mkdirSync(releaseDir, { recursive: true });

		// Stub install.ts: prove the selected runtime executed it with forwarded args.
		const installTs = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const out = process.env.PI_BOOTSTRAP_PROBE_OUT;
if (!out) throw new Error("missing PI_BOOTSTRAP_PROBE_OUT");
writeFileSync(
	out,
	JSON.stringify({
		argv: process.argv.slice(2),
		baseUrl: process.env.PI_XZ_RELEASE_BASE_URL ?? null,
		exactBaseUrl: process.env.PI_XZ_RELEASE_EXACT_BASE_URL ?? null,
		manifestSha256: process.env.PI_XZ_RELEASE_MANIFEST_SHA256 ?? null,
		runtime: process.version ? \`node:\${process.version}\` : "unknown",
	}),
);
`;
		const installTsPath = join(releaseDir, "install.ts");
		writeFileSync(installTsPath, installTs);
		const installTsSha256 = sha256(installTs);
		const installTsBytes = Buffer.byteLength(installTs);

		const tag = "xz-v0.0.0-xz.1.1.g11111111";
		const manifest = {
			schemaVersion: 1,
			tag,
			distributionVersion: "0.0.0-xz.1.1.g11111111",
			commit: "1".repeat(40),
			installer: {
				file: "install.ts",
				bytes: installTsBytes,
				sha256: installTsSha256,
			},
		};
		const manifestBody = `${JSON.stringify(manifest, undefined, "\t")}\n`;
		const manifestPath = join(releaseDir, "release-manifest.json");
		writeFileSync(manifestPath, manifestBody);
		writeFileSync(join(releaseDir, "attestation-subjects.txt"), '{"fixture":"bundle"}\n');
		const manifestSha256 = sha256(manifestBody);
		const fakeBin = join(tempDir, "bin");
		mkdirSync(fakeBin);
		writeFileSync(
			join(fakeBin, "gh"),
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(tempDir, "gh-args.txt"))}\n`,
			{ mode: 0o755 },
		);

		const fixtureServer = await startStaticServer(releaseDir);
		try {
			const gen = await loadGenerator();
			const written = gen.writeInstallBootstrap(releaseDir, {
				tag,
				baseUrl: fixtureServer.baseUrl,
				manifestSha256,
				installTsSha256,
				installTsBytes,
				minimumNodeVersion: "22.19.0",
			});
			chmodSync(written.sh.path, 0o755);

			const probeOut = join(tempDir, "probe.json");
			const result = await runCommand("sh", [written.sh.path, "--migrate", "--extra"], {
				...process.env,
				PATH: `${fakeBin}:${process.env.PATH}`,
				PI_BOOTSTRAP_PROBE_OUT: probeOut,
			});
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(existsSync(probeOut)).toBe(true);
			const probe = JSON.parse(readFileSync(probeOut, "utf8")) as {
				argv: string[];
				baseUrl: string | null;
				exactBaseUrl: string | null;
				manifestSha256: string | null;
			};
			expect(probe.argv).toEqual(["--migrate", "--extra"]);
			expect(probe.baseUrl).toBe(fixtureServer.baseUrl);
			expect(probe.exactBaseUrl).toBe(fixtureServer.baseUrl);
			expect(probe.manifestSha256).toBe(manifestSha256);
			const ghArgs = readFileSync(join(tempDir, "gh-args.txt"), "utf8").split(/\r?\n/);
			expect(ghArgs).toEqual(
				expect.arrayContaining(["--bundle", "--source-digest", "1".repeat(40), "--deny-self-hosted-runners"]),
			);
		} finally {
			await fixtureServer.close();
			server = undefined;
		}
	});

	test("bootstrap fails closed on install.ts digest mismatch", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-github-release-bootstrap-bad-"));
		const releaseDir = join(tempDir, "release");
		mkdirSync(releaseDir, { recursive: true });

		const installTs = "export {}\n";
		writeFileSync(join(releaseDir, "install.ts"), installTs);
		const invalidDigestTag = "xz-v0.0.0-xz.2.1.g22222222";
		const manifestBody = `${JSON.stringify({ tag: invalidDigestTag, schemaVersion: 1 }, undefined, "\t")}\n`;
		writeFileSync(join(releaseDir, "release-manifest.json"), manifestBody);
		writeFileSync(join(releaseDir, "attestation-subjects.txt"), '{"fixture":"bundle"}\n');

		const fixtureServer = await startStaticServer(releaseDir);
		try {
			const gen = await loadGenerator();
			const written = gen.writeInstallBootstrap(releaseDir, {
				tag: invalidDigestTag,
				baseUrl: fixtureServer.baseUrl,
				manifestSha256: sha256(manifestBody),
				// Wrong pin on purpose.
				installTsSha256: "c".repeat(64),
				installTsBytes: Buffer.byteLength(installTs),
			});
			chmodSync(written.sh.path, 0o755);
			const result = await runCommand("sh", [written.sh.path]);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/install\.ts sha256 mismatch/i);
		} finally {
			await fixtureServer.close();
			server = undefined;
		}
	});
});
