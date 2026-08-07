import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const VERSION = "0.82.1-xz.1.1.g11111111";
const COMMIT = "1".repeat(40);
const TAG = `xz-v${VERSION}`;
let server: Server | undefined;
let baseUrl: string;
let releaseDir: string | undefined;

function sha(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

beforeAll(async () => {
	const fixtureDir = mkdtempSync(join(tmpdir(), "pi-native-installer-release-"));
	releaseDir = fixtureDir;
	// Real bundles wrap files under a top-level pi/ directory (build-binaries.sh
	// layout); install.sh unwraps exactly that wrapper before the staging smoke.
	const bundle = join(releaseDir, "pi");
	mkdirSync(bundle, { recursive: true });
	writeFileSync(join(bundle, "pi"), `#!/bin/sh\ncase "$1" in --version) echo ${VERSION};; --help) exit 0;; esac\n`, {
		mode: 0o755,
	});
	writeFileSync(
		join(bundle, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version: VERSION,
			piConfig: { distribution: "xz-dev" },
		}),
	);
	writeFileSync(join(bundle, "README.md"), "fixture\n");
	writeFileSync(join(bundle, "photon_rs_bg.wasm"), "wasm\n");
	const archive = join(releaseDir, "pi-linux-x64-gnu-modern.tar.gz");
	const packed = spawnSync("tar", ["-czf", archive, "-C", releaseDir, "pi"]);
	expect(packed.status).toBe(0);
	const archiveBytes = readFileSync(archive).byteLength;
	const archiveSha = sha(archive);
	// install.sh pins all nine POSIX bundles; install.ps1 pins all three Windows
	// bundles. This test executes the current GNU host target; the other archives
	// are metadata-only fixture pins with canonical names.
	const bundleFiles = {
		"darwin-x64-baseline": "pi-darwin-x64-baseline.tar.gz",
		"darwin-x64-modern": "pi-darwin-x64-modern.tar.gz",
		"darwin-arm64": "pi-darwin-arm64.tar.gz",
		"linux-x64-gnu-baseline": "pi-linux-x64-gnu-baseline.tar.gz",
		"linux-x64-gnu-modern": "pi-linux-x64-gnu-modern.tar.gz",
		"linux-arm64-gnu": "pi-linux-arm64-gnu.tar.gz",
		"linux-x64-musl-baseline": "pi-linux-x64-musl-baseline.tar.gz",
		"linux-x64-musl-modern": "pi-linux-x64-musl-modern.tar.gz",
		"linux-arm64-musl": "pi-linux-arm64-musl.tar.gz",
		"windows-x64-baseline": "pi-windows-x64-baseline.zip",
		"windows-x64-modern": "pi-windows-x64-modern.zip",
		"windows-arm64": "pi-windows-arm64.zip",
	};
	for (const file of Object.values(bundleFiles)) copyFileSync(archive, join(releaseDir, file));
	const bundles = Object.fromEntries(
		Object.entries(bundleFiles).map(([platform, file]) => [
			platform,
			{ file, bytes: archiveBytes, sha256: archiveSha },
		]),
	);
	const manifest = {
		schemaVersion: 4,
		repository: "xz-dev/pi",
		tag: TAG,
		distributionVersion: VERSION,
		apiVersion: "0.82.1",
		commit: COMMIT,
		packaging: "binary",
		layoutVersion: 1,
		bundles,
		requiredPaths: Object.fromEntries(
			Object.keys(bundles).map((platform) => [
				platform,
				["pi", "pi/package.json", "pi/README.md", "pi/photon_rs_bg.wasm"],
			]),
		),
		acceptance: { file: "binary-acceptance.json", targetCount: 12 },
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
	writeFileSync(join(releaseDir, "release-manifest.json"), `${JSON.stringify(manifest)}\n`);
	const manifestSha = sha(join(releaseDir, "release-manifest.json"));
	const generator = await import(join(ROOT, "scripts", "generate-install-bootstrap.mjs"));
	generator.writeInstallBootstrap(releaseDir, {
		tag: TAG,
		baseUrl: "http://127.0.0.1/",
		manifestSha256: manifestSha,
		commit: COMMIT,
		distributionVersion: VERSION,
		bundles: manifest.bundles,
		attestation: manifest.attestation,
	});
	writeFileSync(
		join(releaseDir, "SHA256SUMS"),
		`${manifestSha}  release-manifest.json\n${Object.values(bundleFiles)
			.map((file) => `${archiveSha}  ${file}`)
			.join(
				"\n",
			)}\n${sha(join(releaseDir, "install.sh"))}  install.sh\n${sha(join(releaseDir, "install.ps1"))}  install.ps1\n`,
	);
	writeFileSync(
		join(releaseDir, "attestation-subjects.jsonl"),
		`${Object.values(bundleFiles).join("\n")}\nrelease-manifest.json\ninstall.sh\ninstall.ps1\nSHA256SUMS\n`,
	);
	const fixtureServer = createServer((request, response) => {
		const file = join(fixtureDir, new URL(request.url ?? "/", baseUrl).pathname.slice(1));
		try {
			response.end(readFileSync(file));
		} catch {
			response.writeHead(404).end();
		}
	});
	server = fixtureServer;
	await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
	const address = fixtureServer.address();
	if (!address || typeof address === "string") throw new Error("server did not bind");
	baseUrl = `http://127.0.0.1:${address.port}/`;
	const script = readFileSync(join(releaseDir, "install.sh"), "utf8").replaceAll("http://127.0.0.1/", baseUrl);
	writeFileSync(join(releaseDir, "install.sh"), script, { mode: 0o755 });
});

afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
	if (releaseDir) rmSync(releaseDir, { recursive: true, force: true });
});

function runProcess(
	command: string,
	args: string[],
	options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	// Async spawn: the fixture HTTP server runs in this process, and a blocking
	// spawnSync would starve the event loop and deadlock install.sh's downloads.
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

describe("generated POSIX installer", () => {
	test("installs a real tar bundle and activates a quoted root launcher", async () => {
		const sandbox = mkdtempSync(join(tmpdir(), "pi-installer-sandbox-"));
		const bin = join(sandbox, "bin");
		const root = join(sandbox, "root with spaces");
		mkdirSync(bin, { recursive: true });
		const fakeGh = join(sandbox, "gh");
		writeFileSync(fakeGh, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		if (!releaseDir) throw new Error("installer fixture was not initialized");
		const result = await runProcess("sh", [join(releaseDir, "install.sh")], {
			env: {
				...process.env,
				PATH: `${sandbox}:${process.env.PATH}`,
				HOME: sandbox,
				XDG_BIN_HOME: bin,
				PI_XZ_INSTALL_ROOT: root,
			},
		});
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(readFileSync(join(root, "current"), "utf8").trim()).toBe(VERSION);
		const launched = spawnSync(join(bin, "pi"), ["--version"], { encoding: "utf8" });
		expect(launched.status).toBe(0);
		expect(launched.stdout.trim()).toBe(VERSION);
		rmSync(sandbox, { recursive: true, force: true });
	}, 60_000);
});
