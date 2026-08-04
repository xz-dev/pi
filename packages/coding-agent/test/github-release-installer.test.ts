import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const INSTALLER = join(REPO_ROOT, "scripts", "install.ts");
const FIXTURES = join(import.meta.dirname, "fixtures", "github-release-installer");
const VERSION_1 = "0.82.1-xz.100.1.g11111111";
const VERSION_2 = "0.82.1-xz.101.1.g22222222";
const ENTRY_PACKAGE = "@earendil-works/pi-coding-agent";
const LEGACY_PACKAGE = "@xz-dev/pi-coding-agent";

type Release = {
	directory: string;
	manifest: Record<string, unknown>;
	packageFile: string;
};

type Invocation = {
	status: number | null;
	stdout: string;
	stderr: string;
};

type Sandbox = {
	directory: string;
	home: string;
	codingAgentDirectory: string;
	root: string;
	bin: string;
	cache: string;
	lock: string;
	legacyPrefix: string;
	homeSentinel: string;
	codingAgentSentinel: string;
};

let suiteDirectory: string;
let release1: Release;
let release2: Release;
let brokenRelease: Release;
let server: Server;
let foreignServer: Server;
let releaseBaseUrl: string;
let foreignBaseUrl: string;
let foreignRequestCount = 0;
let latestSwitchTo: Release | undefined;
let discoveredByTag: Map<string, Release>;

function digest(algorithm: "sha256" | "sha512", path: string): string {
	return createHash(algorithm)
		.update(readFileSync(path))
		.digest(algorithm === "sha512" ? "base64" : "hex");
}

function makeRelease(
	name: string,
	version: string,
	options: { brokenHelp?: boolean; brokenImport?: boolean } = {},
): Release {
	const directory = join(suiteDirectory, name);
	const source = join(directory, "source", "package");
	mkdirSync(source, { recursive: true });
	cpSync(join(FIXTURES, "package"), source, { recursive: true });
	const packageJsonPath = join(source, "package.json");
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
	packageJson.version = version;
	writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, undefined, "\t")}\n`);
	if (options.brokenHelp) {
		writeFileSync(
			join(source, "dist", "cli.js"),
			"#!/usr/bin/env node\nif (process.argv.includes('--help')) process.exit(42);\nconsole.log('broken fixture');\n",
		);
	}
	if (options.brokenImport) {
		writeFileSync(join(source, "dist", "index.js"), "throw new Error('broken fixture import');\n");
	}

	const packageFile = `earendil-works-pi-coding-agent-${version}.tgz`;
	const packagePath = join(directory, packageFile);
	const packed = spawnSync("tar", ["-czf", packagePath, "-C", join(directory, "source"), "package"], {
		encoding: "utf8",
	});
	if (packed.status !== 0) throw new Error(`Could not create installer fixture: ${packed.stderr}`);

	const installerPath = join(directory, "install.ts");
	writeFileSync(installerPath, "// fixture installer asset\n");
	const packageBytes = readFileSync(packagePath).byteLength;
	const installerBytes = readFileSync(installerPath).byteLength;
	const manifest = {
		schemaVersion: 1,
		repository: "xz-dev/pi",
		tag: `xz-v${version}`,
		distributionVersion: version,
		apiVersion: "0.82.1",
		commit: version === VERSION_1 ? "1".repeat(40) : "2".repeat(40),
		minimumNodeVersion: "22.19.0",
		package: {
			name: ENTRY_PACKAGE,
			file: packageFile,
			bytes: packageBytes,
			sha256: digest("sha256", packagePath),
			integrity: `sha512-${digest("sha512", packagePath)}`,
			bundled: true,
			packaging: "hybrid",
			networkPolicy: "external-optional-only",
			externalOptionalDependencies: {},
			allowedNetworkPackages: [],
			allowedNetworkPackagePrefixes: [],
		},
		installer: {
			file: "install.ts",
			bytes: installerBytes,
			sha256: digest("sha256", installerPath),
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
	writeFileSync(join(directory, "release-manifest.json"), `${JSON.stringify(manifest, undefined, 2)}\n`);
	return { directory, manifest, packageFile };
}

function mutateRelease(name: string, source: Release, mutate: (manifest: Record<string, any>) => void): Release {
	const directory = join(suiteDirectory, name);
	cpSync(source.directory, directory, { recursive: true });
	const manifest = structuredClone(source.manifest) as Record<string, any>;
	mutate(manifest);
	writeFileSync(join(directory, "release-manifest.json"), `${JSON.stringify(manifest, undefined, 2)}\n`);
	return { directory, manifest, packageFile: source.packageFile };
}

function makeSandbox(name: string): Sandbox {
	const directory = mkdtempSync(join(tmpdir(), `pi-installer-${name}-`));
	const home = join(directory, "home");
	const codingAgentDirectory = join(directory, "configured-pi-agent");
	const root = join(directory, "install-root");
	const bin = join(directory, "bin");
	const cache = join(directory, "cache");
	const lock = join(directory, "install.lock");
	const legacyPrefix = join(directory, "legacy-prefix");
	const homeSentinel = join(home, ".pi", "user-data-sentinel.json");
	const codingAgentSentinel = join(codingAgentDirectory, "configured-agent-sentinel.json");
	mkdirSync(dirname(homeSentinel), { recursive: true });
	mkdirSync(codingAgentDirectory, { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(homeSentinel, '{"mustRemain":"home-byte-for-byte"}\n');
	writeFileSync(codingAgentSentinel, '{"mustRemain":"agent-byte-for-byte"}\n');
	return {
		directory,
		home,
		codingAgentDirectory,
		root,
		bin,
		cache,
		lock,
		legacyPrefix,
		homeSentinel,
		codingAgentSentinel,
	};
}

function installerEnvironment(
	sandbox: Sandbox,
	baseUrl = releaseBaseUrl,
	overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: sandbox.home,
		PI_CODING_AGENT_DIR: sandbox.codingAgentDirectory,
		XDG_DATA_HOME: join(sandbox.home, ".local", "share"),
		XDG_BIN_HOME: sandbox.bin,
		PI_XZ_INSTALL_ROOT: sandbox.root,
		PI_XZ_BIN_DIR: sandbox.bin,
		PI_XZ_CACHE_DIR: sandbox.cache,
		PI_XZ_INSTALL_LOCK: sandbox.lock,
		PI_XZ_RELEASE_BASE_URL: baseUrl,
		PI_XZ_RELEASE_EXACT_BASE_URL: `${baseUrl}releases/download/{tag}/`,
		PI_XZ_SKIP_ATTESTATION: "1",
		PI_XZ_LEGACY_PREFIX: sandbox.legacyPrefix,
		...overrides,
	};
}

async function invoke(
	runtime: string,
	sandbox: Sandbox,
	args: string[] = [],
	baseUrl = releaseBaseUrl,
	overrides: NodeJS.ProcessEnv = {},
): Promise<Invocation> {
	const child = spawn(runtime, [INSTALLER, ...args], {
		cwd: sandbox.directory,
		env: installerEnvironment(sandbox, baseUrl, overrides),
		stdio: ["ignore", "pipe", "pipe"],
	});
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

function expectSuccess(result: Invocation): void {
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function currentVersion(sandbox: Sandbox): string {
	return readFileSync(join(sandbox.root, "current"), "utf8").trim();
}

function installedPackage(sandbox: Sandbox, version: string): string {
	return join(sandbox.root, "versions", version, "node_modules", ...ENTRY_PACKAGE.split("/"));
}

function assertUserDataUntouched(sandbox: Sandbox): void {
	expect(readFileSync(sandbox.homeSentinel, "utf8")).toBe('{"mustRemain":"home-byte-for-byte"}\n');
	expect(readFileSync(sandbox.codingAgentSentinel, "utf8")).toBe('{"mustRemain":"agent-byte-for-byte"}\n');
	expect(readdirSync(join(sandbox.home, ".pi"))).toEqual(["user-data-sentinel.json"]);
	expect(readdirSync(sandbox.codingAgentDirectory)).toEqual(["configured-agent-sentinel.json"]);
}

function installLegacy(
	sandbox: Sandbox,
	shimContents?: string,
	selectedPlatform: "linux" | "win32" = "linux",
): { packageDirectory: string; shim: string; shims: string[] } {
	const packageDirectory = join(
		sandbox.legacyPrefix,
		...(selectedPlatform === "win32" ? [] : ["lib"]),
		"node_modules",
		...LEGACY_PACKAGE.split("/"),
	);
	cpSync(join(FIXTURES, "legacy"), packageDirectory, { recursive: true });
	const expectedCli = join(packageDirectory, "dist", "cli.js");
	const shim = join(sandbox.bin, "pi");
	if (selectedPlatform === "win32") {
		const shims = [shim, `${shim}.cmd`, `${shim}.ps1`];
		writeFileSync(shims[0], shimContents ?? `#!/bin/sh\n"${process.execPath}" "${expectedCli}" "$@"\n`, {
			mode: 0o755,
		});
		writeFileSync(shims[1], `@ECHO off\r\n"${process.execPath}" "${expectedCli}" %*\r\n`);
		writeFileSync(shims[2], `& '${process.execPath}' '${expectedCli}' @args\n`);
		return { packageDirectory, shim, shims };
	}
	if (shimContents === undefined) {
		symlinkSync(
			join("..", "legacy-prefix", "lib", "node_modules", ...LEGACY_PACKAGE.split("/"), "dist", "cli.js"),
			shim,
		);
	} else {
		writeFileSync(shim, shimContents, { mode: 0o755 });
	}
	return { packageDirectory, shim, shims: [shim] };
}

function pathState(
	path: string,
): { type: "missing" } | { type: "symlink"; target: string } | { type: "file"; contents: Buffer; mode: number } {
	if (!existsSync(path)) return { type: "missing" };
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) return { type: "symlink", target: readlinkSync(path) };
	return { type: "file", contents: readFileSync(path), mode: stat.mode & 0o777 };
}

function plantVersion(sandbox: Sandbox, version: string): void {
	const target = installedPackage(sandbox, version);
	cpSync(join(FIXTURES, "package"), target, { recursive: true });
	const packageJsonPath = join(target, "package.json");
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	packageJson.version = version;
	writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, undefined, 2)}\n`);
}

function launcherOutput(sandbox: Sandbox, args: string[] = ["--version"]): Invocation {
	const result = spawnSync(join(sandbox.bin, "pi"), args, {
		cwd: sandbox.directory,
		env: installerEnvironment(sandbox),
		encoding: "utf8",
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

beforeAll(async () => {
	suiteDirectory = mkdtempSync(join(tmpdir(), "pi-installer-releases-"));
	release1 = makeRelease("v1", VERSION_1);
	release2 = makeRelease("v2", VERSION_2);
	brokenRelease = makeRelease("broken", VERSION_2, { brokenHelp: true });
	let activeRelease = release1;
	discoveredByTag = new Map();
	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://fixture.invalid");
		const requested = basename(url.pathname) || "release-manifest.json";
		const exactMatch = url.pathname.match(/\/releases\/download\/([^/]+)\//);
		const selected = exactMatch ? discoveredByTag.get(decodeURIComponent(exactMatch[1])) : activeRelease;
		if (!selected) {
			response.writeHead(404).end("unknown release tag");
			return;
		}
		const path = join(selected.directory, requested);
		if (!existsSync(path)) {
			response.writeHead(404).end("not found");
			return;
		}
		const bytes = readFileSync(path);
		if (!exactMatch && requested === "release-manifest.json") {
			discoveredByTag.set(String(selected.manifest.tag), selected);
			if (latestSwitchTo) {
				activeRelease = latestSwitchTo;
				latestSwitchTo = undefined;
			}
		}
		response.writeHead(200, {
			"content-type": requested.endsWith(".json") ? "application/json" : "application/octet-stream",
		});
		response.end(bytes);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture server did not bind TCP");
	releaseBaseUrl = `http://127.0.0.1:${address.port}/`;
	foreignServer = createServer((_request, response) => {
		foreignRequestCount += 1;
		response.writeHead(200, { "content-type": "application/octet-stream" });
		response.end(readFileSync(join(release1.directory, release1.packageFile)));
	});
	await new Promise<void>((resolve) => foreignServer.listen(0, "127.0.0.1", resolve));
	const foreignAddress = foreignServer.address();
	if (!foreignAddress || typeof foreignAddress === "string")
		throw new Error("Foreign fixture server did not bind TCP");
	foreignBaseUrl = `http://127.0.0.1:${foreignAddress.port}/`;
	(server as Server & { useRelease?: (release: Release) => void }).useRelease = (release: Release) => {
		activeRelease = release;
		discoveredByTag.set(String(release.manifest.tag), release);
	};
});

afterAll(async () => {
	await Promise.all([
		new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
		new Promise<void>((resolve, reject) => foreignServer.close((error) => (error ? reject(error) : resolve()))),
	]);
	rmSync(suiteDirectory, { recursive: true, force: true });
});

function serve(release: Release): void {
	(server as Server & { useRelease: (value: Release) => void }).useRelease(release);
}

describe("GitHub Release installer external behavior", () => {
	test("fresh install creates a stable version root, receipt, current pointer, and working launcher", async () => {
		serve(release1);
		const sandbox = makeSandbox("fresh");
		try {
			expectSuccess(await invoke(process.execPath, sandbox));
			expect(currentVersion(sandbox)).toBe(VERSION_1);
			expect(existsSync(join(installedPackage(sandbox, VERSION_1), "dist", "cli.js"))).toBe(true);
			if (process.platform !== "win32") {
				expect(statSync(sandbox.root).mode & 0o022).toBe(0);
				expect(statSync(join(sandbox.root, "receipts", `${VERSION_1}.json`)).mode & 0o022).toBe(0);
			}
			const receipt = JSON.parse(
				readFileSync(join(sandbox.root, "receipts", `${VERSION_1}.json`), "utf8"),
			) as Record<string, any>;
			expect(receipt).toEqual(release1.manifest);
			const installMetadata = JSON.parse(
				readFileSync(join(sandbox.root, "versions", VERSION_1, ".pi-xz", "install.json"), "utf8"),
			) as Record<string, unknown>;
			expect(installMetadata).toMatchObject({
				schemaVersion: 1,
				name: ENTRY_PACKAGE,
				version: VERSION_1,
				treeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			});
			const launched = launcherOutput(sandbox);
			expectSuccess(launched);
			expect(launched.stdout.trim()).toBe(VERSION_1);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test.each([
		["distributionVersion", "../escaped"],
		["distributionVersion", "..\\escaped"],
		["distributionVersion", "%2e%2e%2fescaped"],
		["distributionVersion", "/absolute"],
		["distributionVersion", "//host/share"],
		["distributionVersion", "C:\\escaped"],
		["distributionVersion", "\\\\host\\share"],
		["distributionVersion", "version?query"],
		["distributionVersion", "version#fragment"],
		["distributionVersion", "version\ncontrol"],
		["tag", "xz-v../escaped"],
		["tag", "xz-v..\\escaped"],
		["tag", "xz-v%2e%2e%2fescaped"],
		["tag", "//host/release"],
		["tag", "xz-v1?query"],
		["tag", "xz-v1#fragment"],
		["package.file", "../asset.tgz"],
		["package.file", "..\\asset.tgz"],
		["package.file", "%2e%2e%2fasset.tgz"],
		["package.file", "/tmp/asset.tgz"],
		["package.file", "//host/asset.tgz"],
		["package.file", "C:\\tmp\\asset.tgz"],
		["package.file", "\\\\host\\share\\asset.tgz"],
		["package.file", "asset.tgz?query"],
		["package.file", "asset.tgz#fragment"],
		["package.file", "asset.tgz\ncontrol"],
	])("rejects unsafe manifest %s value %j before creating install artifacts", async (field, value) => {
		const release = mutateRelease(
			`unsafe-${String(field).replaceAll(".", "-")}-${createHash("sha256").update(String(value)).digest("hex").slice(0, 8)}`,
			release1,
			(manifest) => {
				if (field === "package.file") manifest.package.file = value;
				else manifest[field] = value;
				if (field === "distributionVersion") manifest.tag = `xz-v${value}`;
			},
		);
		serve(release);
		const sandbox = makeSandbox("unsafe-manifest");
		try {
			const result = await invoke(process.execPath, sandbox);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/invalid|unsafe|manifest|version|file|component/i);
			expect(existsSync(join(sandbox.root, "current"))).toBe(false);
			expect(existsSync(join(sandbox.root, "versions"))).toBe(false);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("rejects a downloaded manifest that differs from the caller's digest pin", async () => {
		serve(release1);
		const sandbox = makeSandbox("manifest-digest-pin");
		try {
			const result = await invoke(process.execPath, sandbox, [], releaseBaseUrl, {
				PI_XZ_RELEASE_MANIFEST_SHA256: "f".repeat(64),
			});
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/manifest sha256 mismatch/);
			expect(existsSync(join(sandbox.root, "versions"))).toBe(false);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("pins the package asset to the immutable exact tag when latest changes after discovery", async () => {
		serve(release1);
		latestSwitchTo = release2;
		const sandbox = makeSandbox("latest-toctou");
		try {
			expectSuccess(await invoke(process.execPath, sandbox));
			expect(currentVersion(sandbox)).toBe(VERSION_1);
			expect(launcherOutput(sandbox).stdout.trim()).toBe(VERSION_1);
		} finally {
			latestSwitchTo = undefined;
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test.each(["cache", "versions", "receipts"])(
		"rejects a managed %s symlink without writing outside the install root",
		async (name) => {
			serve(release1);
			const sandbox = makeSandbox(`containment-${name}`);
			const outside = join(sandbox.directory, `outside-${name}`);
			mkdirSync(sandbox.root, { recursive: true });
			mkdirSync(outside);
			const managedPath = name === "cache" ? sandbox.cache : join(sandbox.root, name);
			symlinkSync(outside, managedPath, "dir");
			try {
				const result = await invoke(process.execPath, sandbox);
				expect(result.status).not.toBe(0);
				expect(`${result.stdout}\n${result.stderr}`).toMatch(/symlink|directory|unsafe|root/i);
				expect(readdirSync(outside)).toEqual([]);
				expect(existsSync(join(sandbox.root, "current"))).toBe(false);
			} finally {
				rmSync(sandbox.directory, { recursive: true, force: true });
			}
		},
	);

	test("rejects a cross-origin package asset without requesting it", async () => {
		const release = mutateRelease("cross-origin-package", release1, (manifest) => {
			manifest.package.file = `${foreignBaseUrl}${release1.packageFile}`;
		});
		serve(release);
		const sandbox = makeSandbox("cross-origin-package");
		foreignRequestCount = 0;
		try {
			const result = await invoke(process.execPath, sandbox);
			expect(result.status).not.toBe(0);
			expect(foreignRequestCount).toBe(0);
			expect(existsSync(join(sandbox.root, "current"))).toBe(false);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("refuses a detected legacy package without explicit --migrate and names the required command", async () => {
		serve(release1);
		const sandbox = makeSandbox("migration-required");
		try {
			const legacy = installLegacy(sandbox);
			const originalTarget = readlinkSync(legacy.shim);
			const result = await invoke(process.execPath, sandbox);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toContain("--migrate");
			expect(existsSync(legacy.packageDirectory)).toBe(true);
			expect(lstatSync(legacy.shim).isSymbolicLink()).toBe(true);
			expect(readlinkSync(legacy.shim)).toBe(originalTarget);
			expect(existsSync(join(sandbox.root, "current"))).toBe(false);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("explicit --migrate refuses an unknown shim even when the legacy package exists", async () => {
		serve(release1);
		const sandbox = makeSandbox("migrate-unknown-shim");
		try {
			const unknown = "#!/bin/sh\necho user-owned-wrapper\n";
			const legacy = installLegacy(sandbox, unknown);
			const result = await invoke(process.execPath, sandbox, ["--migrate"]);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/unknown|owned|refus|shim/i);
			expect(existsSync(legacy.packageDirectory)).toBe(true);
			expect(readFileSync(legacy.shim, "utf8")).toBe(unknown);
			expect(existsSync(join(sandbox.root, "current"))).toBe(false);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("explicit --migrate requires the legacy shim to target the npm package CLI exactly", async () => {
		serve(release1);
		const sandbox = makeSandbox("migrate-wrong-package-target");
		try {
			const legacy = installLegacy(sandbox);
			rmSync(legacy.shim);
			symlinkSync(
				join("..", "legacy-prefix", "lib", "node_modules", ...LEGACY_PACKAGE.split("/"), "package.json"),
				legacy.shim,
			);
			const targetBefore = readlinkSync(legacy.shim);
			const result = await invoke(process.execPath, sandbox, ["--migrate"]);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/unknown|owned|target|shim/i);
			expect(existsSync(legacy.packageDirectory)).toBe(true);
			expect(readlinkSync(legacy.shim)).toBe(targetBefore);
			expect(existsSync(join(sandbox.root, "current"))).toBe(false);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("explicit --migrate replaces only the owned legacy package and shim", async () => {
		serve(release1);
		const sandbox = makeSandbox("migrate");
		try {
			const legacy = installLegacy(sandbox);
			expectSuccess(await invoke(process.execPath, sandbox, ["--migrate"]));
			expect(existsSync(legacy.packageDirectory)).toBe(false);
			expect(currentVersion(sandbox)).toBe(VERSION_1);
			const launched = launcherOutput(sandbox);
			expectSuccess(launched);
			expect(launched.stdout.trim()).toBe(VERSION_1);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("accepts an already exact Release base from bootstrap and self-update", async () => {
		serve(release1);
		const sandbox = makeSandbox("already-exact-base");
		try {
			const exactBase = `${releaseBaseUrl}releases/download/${release1.manifest.tag}/`;
			expectSuccess(
				await invoke(process.execPath, sandbox, [], releaseBaseUrl, {
					PI_XZ_RELEASE_BASE_URL: exactBase,
					PI_XZ_RELEASE_EXACT_BASE_URL: exactBase,
				}),
			);
			expect(currentVersion(sandbox)).toBe(VERSION_1);
			expect(launcherOutput(sandbox).stdout.trim()).toBe(VERSION_1);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("update atomically switches current and explicit rollback reactivates the retained version", async () => {
		const sandbox = makeSandbox("update-rollback");
		try {
			serve(release1);
			expectSuccess(await invoke(process.execPath, sandbox));
			serve(release2);
			expectSuccess(await invoke(process.execPath, sandbox, ["--update"]));
			expect(currentVersion(sandbox)).toBe(VERSION_2);
			expect(existsSync(installedPackage(sandbox, VERSION_1))).toBe(true);
			expect(existsSync(installedPackage(sandbox, VERSION_2))).toBe(true);
			expectSuccess(await invoke(process.execPath, sandbox, ["--rollback", VERSION_1]));
			expect(currentVersion(sandbox)).toBe(VERSION_1);
			expect(launcherOutput(sandbox).stdout.trim()).toBe(VERSION_1);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("update refuses a latest-discovery downgrade and preserves current", async () => {
		const sandbox = makeSandbox("update-downgrade");
		try {
			serve(release2);
			expectSuccess(await invoke(process.execPath, sandbox));
			serve(release1);
			const failed = await invoke(process.execPath, sandbox, ["--update"]);
			expect(failed.status).not.toBe(0);
			expect(`${failed.stdout}\n${failed.stderr}`).toMatch(/refusing to downgrade/i);
			expect(currentVersion(sandbox)).toBe(VERSION_2);
			expect(launcherOutput(sandbox).stdout.trim()).toBe(VERSION_2);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test.each([
		["POSIX traversal", "../outside"],
		["Windows traversal", "..\\outside"],
		["encoded traversal", "%2e%2e%2foutside"],
		["POSIX absolute", "/outside"],
		["protocol-relative", "//host/outside"],
		["Windows drive", "C:\\outside"],
		["Windows UNC", "\\\\host\\outside"],
		["query", "version?outside"],
		["fragment", "version#outside"],
		["control", "version\noutside"],
		["unsafe filename version", "bad/name"],
	])("rollback rejects an unsafe %s", async (_name, version) => {
		const sandbox = makeSandbox(`rollback-${_name.replaceAll(" ", "-")}`);
		try {
			serve(release1);
			expectSuccess(await invoke(process.execPath, sandbox));
			const result = await invoke(process.execPath, sandbox, ["--rollback", version]);
			expect(result.status).not.toBe(0);
			expect(currentVersion(sandbox)).toBe(VERSION_1);
			expect(launcherOutput(sandbox).stdout.trim()).toBe(VERSION_1);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("rollback rejects a planted version without a matching receipt", async () => {
		const sandbox = makeSandbox("rollback-no-receipt");
		try {
			serve(release1);
			expectSuccess(await invoke(process.execPath, sandbox));
			const planted = "0.82.1-xz.999.1.g99999999";
			plantVersion(sandbox, planted);
			const result = await invoke(process.execPath, sandbox, ["--rollback", planted]);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/receipt|integrity|installed/i);
			expect(currentVersion(sandbox)).toBe(VERSION_1);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test.each([
		[
			"package name",
			(receipt: Record<string, any>) => {
				receipt.package.name = "@attacker/pi";
			},
		],
		[
			"package version",
			(receipt: Record<string, any>) => {
				receipt.distributionVersion = VERSION_2;
				receipt.tag = `xz-v${VERSION_2}`;
			},
		],
		[
			"package hash",
			(receipt: Record<string, any>) => {
				receipt.package.sha256 = "0".repeat(64);
			},
		],
		[
			"package integrity",
			(receipt: Record<string, any>) => {
				receipt.package.integrity = `sha512-${"A".repeat(86)}==`;
			},
		],
	])("rollback rejects a receipt with a mismatched %s", async (_name, mutate) => {
		const sandbox = makeSandbox(`rollback-receipt-${_name.replaceAll(" ", "-")}`);
		try {
			serve(release1);
			expectSuccess(await invoke(process.execPath, sandbox));
			const path = join(sandbox.root, "receipts", `${VERSION_1}.json`);
			const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
			mutate(receipt);
			writeFileSync(path, `${JSON.stringify(receipt, undefined, 2)}\n`);
			const result = await invoke(process.execPath, sandbox, ["--rollback", VERSION_1]);
			expect(result.status).not.toBe(0);
			expect(currentVersion(sandbox)).toBe(VERSION_1);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("rollback rejects a retained version whose package no longer matches its receipt", async () => {
		const sandbox = makeSandbox("rollback-corrupt");
		try {
			serve(release1);
			expectSuccess(await invoke(process.execPath, sandbox));
			serve(release2);
			expectSuccess(await invoke(process.execPath, sandbox, ["--update"]));
			writeFileSync(
				join(installedPackage(sandbox, VERSION_1), "dist", "index.js"),
				"export const tampered = true;\n",
			);
			const result = await invoke(process.execPath, sandbox, ["--rollback", VERSION_1]);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/integrity|hash|receipt|corrupt/i);
			expect(currentVersion(sandbox)).toBe(VERSION_2);
			expect(launcherOutput(sandbox).stdout.trim()).toBe(VERSION_2);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("failed update leaves the old current pointer and launcher active", async () => {
		const sandbox = makeSandbox("failed-update");
		try {
			serve(release1);
			expectSuccess(await invoke(process.execPath, sandbox));
			serve(brokenRelease);
			const failed = await invoke(process.execPath, sandbox, ["--update"]);
			expect(failed.status).not.toBe(0);
			expect(currentVersion(sandbox)).toBe(VERSION_1);
			const launched = launcherOutput(sandbox);
			expectSuccess(launched);
			expect(launched.stdout.trim()).toBe(VERSION_1);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test.each(["launcher", "receipt", "current"])(
		"failed update at %s restores the prior managed launcher, current, and receipts and removes its new version",
		async (failurePoint) => {
			const sandbox = makeSandbox(`update-failure-${failurePoint}`);
			try {
				serve(release1);
				expectSuccess(await invoke(process.execPath, sandbox));
				const prior = {
					launcher: pathState(join(sandbox.bin, "pi")),
					current: pathState(join(sandbox.root, "current")),
					receipt: pathState(join(sandbox.root, "receipts", `${VERSION_1}.json`)),
				};
				serve(release2);
				const failed = await invoke(process.execPath, sandbox, ["--update"], releaseBaseUrl, {
					PI_XZ_TEST_FAIL_AT: failurePoint,
				});
				expect(failed.status).not.toBe(0);
				expect(pathState(join(sandbox.bin, "pi"))).toEqual(prior.launcher);
				expect(pathState(join(sandbox.root, "current"))).toEqual(prior.current);
				expect(pathState(join(sandbox.root, "receipts", `${VERSION_1}.json`))).toEqual(prior.receipt);
				expect(existsSync(join(sandbox.root, "receipts", `${VERSION_2}.json`))).toBe(false);
				expect(existsSync(installedPackage(sandbox, VERSION_2))).toBe(false);
				expect(launcherOutput(sandbox).stdout.trim()).toBe(VERSION_1);
			} finally {
				rmSync(sandbox.directory, { recursive: true, force: true });
			}
		},
	);

	test("an existing version directory is verified rather than trusted before activation", async () => {
		const sandbox = makeSandbox("existing-version");
		try {
			serve(release1);
			plantVersion(sandbox, VERSION_1);
			const plantedPath = join(installedPackage(sandbox, VERSION_1), "dist", "index.js");
			writeFileSync(plantedPath, "export const planted = true;\n");
			const plantedBefore = readFileSync(plantedPath);
			const result = await invoke(process.execPath, sandbox);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/integrity|existing|receipt|version/i);
			expect(readFileSync(plantedPath)).toEqual(plantedBefore);
			expect(existsSync(join(sandbox.root, "current"))).toBe(false);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("refuses attestation bypass in CI and production-like environments", async () => {
		serve(release1);
		const sandbox = makeSandbox("attestation-bypass");
		try {
			const result = await invoke(process.execPath, sandbox, [], releaseBaseUrl, {
				CI: "true",
				PI_XZ_SKIP_ATTESTATION: "1",
			});
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/attestation|bypass|skip|CI/i);
			expect(existsSync(join(sandbox.root, "current"))).toBe(false);
			expect(existsSync(join(sandbox.root, "versions"))).toBe(false);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("attestation verifies the exact downloaded package with the manifest repository", async () => {
		const marker = join(suiteDirectory, "attestation-arguments.json");
		const fakeGh = join(suiteDirectory, "fake-gh.mjs");
		writeFileSync(
			fakeGh,
			`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
			{ mode: 0o755 },
		);
		chmodSync(fakeGh, 0o755);
		serve(release1);
		const sandbox = makeSandbox("attestation-success");
		try {
			expectSuccess(
				await invoke(process.execPath, sandbox, [], releaseBaseUrl, {
					PI_XZ_SKIP_ATTESTATION: "",
					PI_XZ_GH_COMMAND: fakeGh,
				}),
			);
			const args = JSON.parse(readFileSync(marker, "utf8")) as string[];
			expect(args.slice(0, 2)).toEqual(["attestation", "verify"]);
			expect(args[2]).toMatch(new RegExp(`${release1.packageFile.replaceAll(".", "\\.")}$`));
			expect(args).toEqual(
				expect.arrayContaining([
					"--repo",
					"xz-dev/pi",
					"--signer-workflow",
					"xz-dev/pi/.github/workflows/publish-github-release.yml",
					"--source-ref",
					"refs/heads/main",
					"--source-digest",
					"1111111111111111111111111111111111111111",
					"--deny-self-hosted-runners",
				]),
			);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
			rmSync(marker, { force: true });
			rmSync(fakeGh, { force: true });
		}
	});

	test("verifies provenance before executing package smoke code", async () => {
		const marker = join(suiteDirectory, "smoke-before-provenance-marker");
		const executableRelease = makeRelease("provenance-order", VERSION_2, {
			brokenHelp: false,
		});
		const cli = join(executableRelease.directory, "source", "package", "dist", "cli.js");
		writeFileSync(
			cli,
			`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed\\n");\nconsole.log(process.argv.includes("--version") ? ${JSON.stringify(VERSION_2)} : "Usage: pi [options]");\n`,
		);
		// Rebuild the tarball after adding the execution marker.
		rmSync(join(executableRelease.directory, executableRelease.packageFile));
		const packed = spawnSync(
			"tar",
			[
				"-czf",
				join(executableRelease.directory, executableRelease.packageFile),
				"-C",
				join(executableRelease.directory, "source"),
				"package",
			],
			{ encoding: "utf8" },
		);
		expect(packed.status, packed.stderr).toBe(0);
		const packagePath = join(executableRelease.directory, executableRelease.packageFile);
		const manifest = executableRelease.manifest as Record<string, any>;
		manifest.package.bytes = statSync(packagePath).size;
		manifest.package.sha256 = digest("sha256", packagePath);
		manifest.package.integrity = `sha512-${digest("sha512", packagePath)}`;
		writeFileSync(
			join(executableRelease.directory, "release-manifest.json"),
			`${JSON.stringify(manifest, undefined, 2)}\n`,
		);
		serve(executableRelease);
		const sandbox = makeSandbox("provenance-order");
		try {
			const result = await invoke(process.execPath, sandbox, [], releaseBaseUrl, {
				PI_XZ_SKIP_ATTESTATION: "",
				PI_XZ_GH_COMMAND: join(sandbox.directory, "missing-gh"),
			});
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/attestation|provenance|gh/i);
			expect(existsSync(marker)).toBe(false);
			expect(existsSync(installedPackage(sandbox, VERSION_2))).toBe(false);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("package import smoke must pass before a version is published", async () => {
		const badImport = makeRelease("broken-import", VERSION_2, { brokenImport: true });
		serve(badImport);
		const sandbox = makeSandbox("broken-import");
		try {
			const result = await invoke(process.execPath, sandbox);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/import|smoke|verification/i);
			expect(existsSync(installedPackage(sandbox, VERSION_2))).toBe(false);
			expect(existsSync(join(sandbox.root, "current"))).toBe(false);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("failed explicit migration restores the old package and owned shim byte-for-byte", async () => {
		serve(brokenRelease);
		const sandbox = makeSandbox("failed-migration");
		try {
			const legacy = installLegacy(sandbox);
			const packageBefore = readFileSync(join(legacy.packageDirectory, "dist", "cli.js"));
			const shimBefore = readlinkSync(legacy.shim);
			const failed = await invoke(process.execPath, sandbox, ["--migrate"]);
			expect(failed.status).not.toBe(0);
			expect(`${failed.stdout}\n${failed.stderr}`).toMatch(/smoke|verification|--help/i);
			expect(`${failed.stdout}\n${failed.stderr}`).not.toContain("MODULE_NOT_FOUND");
			expect(readFileSync(join(legacy.packageDirectory, "dist", "cli.js"))).toEqual(packageBefore);
			expect(lstatSync(legacy.shim).isSymbolicLink()).toBe(true);
			expect(readlinkSync(legacy.shim)).toBe(shimBefore);
			const oldCli = spawnSync(process.execPath, [legacy.shim], {
				encoding: "utf8",
			});
			expect(oldCli.status, oldCli.stderr).toBe(0);
			expect(oldCli.stdout.trim()).toBe("legacy-pi-0.81.0-xz.99");
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test.each(["launcher", "receipt", "current"])(
		"migration failure while writing %s restores every prior managed artifact and removes the new version",
		async (failurePoint) => {
			serve(release1);
			const sandbox = makeSandbox(`migration-failure-${failurePoint}`);
			try {
				const legacy = installLegacy(sandbox);
				mkdirSync(sandbox.root, { recursive: true });
				writeFileSync(join(sandbox.root, "current"), "prior-version\n");
				mkdirSync(join(sandbox.root, "receipts"), { recursive: true });
				writeFileSync(join(sandbox.root, "receipts", `${VERSION_1}.json`), "prior-receipt\n");
				writeFileSync(join(sandbox.bin, "pi-xz-prior"), "prior-managed-artifact\n");
				const prior = {
					legacyPackage: readFileSync(join(legacy.packageDirectory, "dist", "cli.js")),
					shim: pathState(legacy.shim),
					current: pathState(join(sandbox.root, "current")),
					receipt: pathState(join(sandbox.root, "receipts", `${VERSION_1}.json`)),
				};
				const result = await invoke(process.execPath, sandbox, ["--migrate"], releaseBaseUrl, {
					PI_XZ_TEST_FAIL_AT: failurePoint,
				});
				expect(result.status).not.toBe(0);
				expect(readFileSync(join(legacy.packageDirectory, "dist", "cli.js"))).toEqual(prior.legacyPackage);
				expect(pathState(legacy.shim)).toEqual(prior.shim);
				expect(pathState(join(sandbox.root, "current"))).toEqual(prior.current);
				expect(pathState(join(sandbox.root, "receipts", `${VERSION_1}.json`))).toEqual(prior.receipt);
				expect(existsSync(installedPackage(sandbox, VERSION_1))).toBe(false);
				expect(
					readdirSync(sandbox.root).filter((name) => name.includes("staging") || name.includes("backup")),
				).toEqual([]);
				assertUserDataUntouched(sandbox);
			} finally {
				rmSync(sandbox.directory, { recursive: true, force: true });
			}
		},
	);

	test("recovers a prior journal left by an interrupted atomic journal replacement", async () => {
		const sandbox = makeSandbox("prior-journal-recovery");
		mkdirSync(sandbox.root, { recursive: true });
		const prior = join(sandbox.root, ".install-transaction.json.prior-00000000-0000-4000-8000-000000000000");
		writeFileSync(prior, `${JSON.stringify({ schemaVersion: 1, replacements: [] })}\n`);
		try {
			const result = await invoke(process.execPath, sandbox, ["--rollback", VERSION_1]);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/Rollback version is not installed/);
			expect(existsSync(prior)).toBe(false);
			expect(existsSync(join(sandbox.root, ".install-transaction.json"))).toBe(false);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("rejects a tampered transaction journal without touching its injected target", async () => {
		const sandbox = makeSandbox("tampered-journal");
		const outside = join(sandbox.directory, "outside-sentinel");
		writeFileSync(outside, "must remain\n");
		mkdirSync(sandbox.root, { recursive: true });
		writeFileSync(
			join(sandbox.root, ".install-transaction.json"),
			`${JSON.stringify({ schemaVersion: 1, replacements: [{ target: outside, temporary: `${outside}.pi-xz-new-00000000-0000-4000-8000-000000000000` }] })}\n`,
		);
		try {
			const result = await invoke(process.execPath, sandbox, ["--rollback", VERSION_1]);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/transaction target is outside managed files/);
			expect(readFileSync(outside, "utf8")).toBe("must remain\n");
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test.each(["legacy-backup", "receipt"])(
		"a migration crashed at %s is recovered from its durable journal before retry",
		async (crashPoint) => {
			serve(release1);
			const sandbox = makeSandbox(`migration-crash-recovery-${crashPoint}`);
			try {
				const legacy = installLegacy(sandbox);
				const packageBefore = readFileSync(join(legacy.packageDirectory, "dist", "cli.js"));
				const shimBefore = pathState(legacy.shim);
				const crashed = await invoke(process.execPath, sandbox, ["--migrate"], releaseBaseUrl, {
					PI_XZ_TEST_CRASH_AT: crashPoint,
				});
				expect(crashed.status).toBe(97);
				expect(existsSync(join(sandbox.root, ".install-transaction.json"))).toBe(true);

				expectSuccess(await invoke(process.execPath, sandbox, ["--migrate"]));
				expect(currentVersion(sandbox)).toBe(VERSION_1);
				expect(existsSync(legacy.packageDirectory)).toBe(false);
				expect(existsSync(join(sandbox.root, ".install-transaction.json"))).toBe(false);
				expect(
					readdirSync(sandbox.root).filter((name) => name.includes("backup") || name.includes("staging")),
				).toEqual([]);
				expect(packageBefore.byteLength).toBeGreaterThan(0);
				expect(shimBefore.type).toBe("symlink");
			} finally {
				rmSync(sandbox.directory, { recursive: true, force: true });
			}
		},
	);

	test("simulated Windows current replacement recovers if interrupted after backing up the destination", async () => {
		const sandbox = makeSandbox("windows-current-crash");
		const environment = { PI_XZ_TEST_PLATFORM: "win32" };
		try {
			serve(release1);
			expectSuccess(await invoke(process.execPath, sandbox, [], releaseBaseUrl, environment));
			serve(release2);
			const crashed = await invoke(process.execPath, sandbox, ["--update"], releaseBaseUrl, {
				...environment,
				PI_XZ_TEST_CRASH_AT: "current-backup",
			});
			expect(crashed.status).toBe(97);
			expect(existsSync(join(sandbox.root, ".install-transaction.json"))).toBe(true);

			expectSuccess(await invoke(process.execPath, sandbox, ["--update"], releaseBaseUrl, environment));
			expect(currentVersion(sandbox)).toBe(VERSION_2);
			expect(existsSync(join(sandbox.root, ".install-transaction.json"))).toBe(false);
			expect(readFileSync(join(sandbox.bin, "pi.cmd"), "utf8")).toContain("pi-xz managed launcher");
			expect(readFileSync(join(sandbox.bin, "pi.ps1"), "utf8")).toContain("pi-xz managed launcher");
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("simulated Windows update replaces current safely and preserves both managed launchers", async () => {
		const sandbox = makeSandbox("windows-update");
		const environment = { PI_XZ_TEST_PLATFORM: "win32" };
		try {
			serve(release1);
			expectSuccess(await invoke(process.execPath, sandbox, [], releaseBaseUrl, environment));
			serve(release2);
			expectSuccess(await invoke(process.execPath, sandbox, ["--update"], releaseBaseUrl, environment));
			expect(currentVersion(sandbox)).toBe(VERSION_2);
			expect(readFileSync(join(sandbox.bin, "pi.cmd"), "utf8")).toContain("pi-xz managed launcher");
			expect(readFileSync(join(sandbox.bin, "pi.ps1"), "utf8")).toContain("pi-xz managed launcher");
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test.each(["pi", "pi.cmd", "pi.ps1"])(
		"simulated Windows migration refuses an unknown %s shim and leaves the full set untouched",
		async (unknownName) => {
			serve(release1);
			const sandbox = makeSandbox(`windows-unknown-${unknownName.replace(".", "-")}`);
			try {
				const legacy = installLegacy(sandbox, undefined, "win32");
				writeFileSync(join(sandbox.bin, unknownName), "user-owned wrapper\n");
				const before = new Map(legacy.shims.map((path) => [path, pathState(path)]));
				const result = await invoke(process.execPath, sandbox, ["--migrate"], releaseBaseUrl, {
					PI_XZ_TEST_PLATFORM: "win32",
				});
				expect(result.status).not.toBe(0);
				for (const [path, state] of before) expect(pathState(path)).toEqual(state);
				expect(existsSync(legacy.packageDirectory)).toBe(true);
				expect(existsSync(join(sandbox.root, "current"))).toBe(false);
			} finally {
				rmSync(sandbox.directory, { recursive: true, force: true });
			}
		},
	);

	test("simulated Windows migration failure restores pi, pi.cmd, and pi.ps1 byte-for-byte", async () => {
		serve(release1);
		const sandbox = makeSandbox("windows-restore-shims");
		try {
			const legacy = installLegacy(sandbox, undefined, "win32");
			const before = new Map(legacy.shims.map((path) => [path, pathState(path)]));
			const result = await invoke(process.execPath, sandbox, ["--migrate"], releaseBaseUrl, {
				PI_XZ_TEST_PLATFORM: "win32",
				PI_XZ_TEST_FAIL_AT: "current",
			});
			expect(result.status).not.toBe(0);
			for (const [path, state] of before) expect(pathState(path)).toEqual(state);
			expect(existsSync(legacy.packageDirectory)).toBe(true);
			expect(existsSync(installedPackage(sandbox, VERSION_1))).toBe(false);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("rejects a missing lock below a symlinked parent without creating anything outside", async () => {
		serve(release1);
		const sandbox = makeSandbox("lock-parent-symlink");
		const outside = join(sandbox.directory, "outside-locks");
		const linkedParent = join(sandbox.root, "linked-locks");
		mkdirSync(outside);
		mkdirSync(sandbox.root, { recursive: true });
		symlinkSync(outside, linkedParent, "dir");
		const escapedLock = join(linkedParent, "install.lock");
		try {
			const result = await invoke(process.execPath, sandbox, [], releaseBaseUrl, {
				PI_XZ_INSTALL_LOCK: escapedLock,
			});
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/lock parent.*symbolic link/i);
			expect(existsSync(join(outside, "install.lock"))).toBe(false);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("rejects a concurrent install while another transaction holds the install lock", async () => {
		serve(release1);
		const sandbox = makeSandbox("lock");
		try {
			mkdirSync(sandbox.lock);
			const result = await invoke(process.execPath, sandbox);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/lock|another install|in progress/i);
			expect(existsSync(join(sandbox.root, "current"))).toBe(false);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("uses an isolated npm cache so a network failure cannot succeed from shared cached data", async () => {
		serve(release1);
		const sandbox = makeSandbox("offline-cache");
		try {
			mkdirSync(sandbox.cache, { recursive: true });
			writeFileSync(
				join(sandbox.cache, release1.packageFile),
				readFileSync(join(release1.directory, release1.packageFile)),
			);
			const unavailable = "http://127.0.0.1:1/";
			const result = await invoke(process.execPath, sandbox, [], unavailable, {
				PI_XZ_RELEASE_EXACT_BASE_URL: `${unavailable}releases/download/{tag}/`,
			});
			expect(result.status).not.toBe(0);
			expect(existsSync(join(sandbox.root, "current"))).toBe(false);
			expect(existsSync(join(sandbox.root, "versions"))).toBe(false);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("recovers a stale install lock but never steals a live one", async () => {
		serve(release1);
		const sandbox = makeSandbox("stale-lock");
		try {
			mkdirSync(sandbox.lock);
			writeFileSync(
				join(sandbox.lock, "owner.json"),
				`${JSON.stringify({ pid: 999999999, createdAt: new Date(0).toISOString() })}\n`,
			);
			expectSuccess(await invoke(process.execPath, sandbox));
			expect(currentVersion(sandbox)).toBe(VERSION_1);
			expect(existsSync(sandbox.lock)).toBe(false);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("refuses to overwrite an unknown pi shim", async () => {
		serve(release1);
		const sandbox = makeSandbox("unknown-shim");
		try {
			const unknown = "#!/bin/sh\necho user-owned-wrapper\n";
			writeFileSync(join(sandbox.bin, "pi"), unknown, { mode: 0o755 });
			const result = await invoke(process.execPath, sandbox);
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/unknown|not owned|refus|shim|launcher/i);
			expect(readFileSync(join(sandbox.bin, "pi"), "utf8")).toBe(unknown);
			expect(existsSync(join(sandbox.root, "current"))).toBe(false);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test("materializes the Release with Bun when npm is unavailable", async () => {
		if (!existsSync(join(process.env.HOME ?? "", ".bun", "bin", "bun"))) return;
		serve(release1);
		const sandbox = makeSandbox("bun-only-materialize");
		const pathDirectory = join(sandbox.directory, "runtime-path");
		mkdirSync(pathDirectory, { recursive: true });
		symlinkSync(process.execPath, join(pathDirectory, "node"));
		symlinkSync(join(process.env.HOME ?? "", ".bun", "bin", "bun"), join(pathDirectory, "bun"));
		try {
			expectSuccess(await invoke(process.execPath, sandbox, [], releaseBaseUrl, { PATH: pathDirectory }));
			const launcher = readFileSync(join(sandbox.bin, "pi"), "utf8");
			expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
			expect(launcher).toContain(process.execPath);
			expect(currentVersion(sandbox)).toBe(VERSION_1);
			expect(launcherOutput(sandbox).stdout.trim()).toBe(VERSION_1);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});

	test.each([
		["Node", process.execPath],
		...(process.env.PATH && spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0
			? [["Bun", "bun"]]
			: []),
	])("the same erasable install.ts executes directly with %s", async (_name, runtime) => {
		serve(release1);
		const sandbox = makeSandbox(`runtime-${String(_name).toLowerCase()}`);
		try {
			expectSuccess(await invoke(runtime, sandbox));
			expect(currentVersion(sandbox)).toBe(VERSION_1);
			expect(launcherOutput(sandbox).stdout.trim()).toBe(VERSION_1);
			assertUserDataUntouched(sandbox);
		} finally {
			rmSync(sandbox.directory, { recursive: true, force: true });
		}
	});
});
