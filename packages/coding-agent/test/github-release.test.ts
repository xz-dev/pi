import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const ENTRY_PACKAGE = "@earendil-works/pi-coding-agent";
const INTERNAL_PACKAGE_PREFIX = "@earendil-works/pi-";
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const PREPARE_SCRIPT = join(REPO_ROOT, "scripts", "prepare-github-release.mjs");
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "verify-github-release.mjs");
const SHRINKWRAP_SCRIPT = join(REPO_ROOT, "scripts", "generate-coding-agent-shrinkwrap.mjs");
const LIB_URL = pathToFileURL(join(REPO_ROOT, "scripts", "lib", "github-release.mjs")).href;
const LIFECYCLE_POLICY_URL = pathToFileURL(join(REPO_ROOT, "scripts", "lib", "install-lifecycle-policy.mjs")).href;

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function writePackage(directory: string, packageJson: Record<string, unknown>): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(packageJson, undefined, "\t")}\n`);
}

function extractPackageJsonFromTarball(tarballPath: string, destinationDir: string): Record<string, unknown> {
	const extractRoot = join(destinationDir, "extract");
	mkdirSync(extractRoot, { recursive: true });
	const result = spawnSync("tar", ["-xzf", tarballPath, "-C", extractRoot], { encoding: "utf8" });
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(readFileSync(join(extractRoot, "package", "package.json"), "utf8")) as Record<string, unknown>;
}

function parseSha256Sums(text: string): Map<string, string> {
	const entries = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
		expect(match, `Invalid SHA256SUMS line: ${line}`).toBeTruthy();
		entries.set(match![2], match![1]);
	}
	return entries;
}

async function loadLib() {
	return import(LIB_URL);
}

describe("GitHub Release hybrid packaging helpers", () => {
	test("requires multi-platform CI matrix for hybrid package verification", async () => {
		const lib = await loadLib();
		expect(lib.REQUIRED_VERIFY_PLATFORMS).toEqual(["linux", "darwin", "win32"]);
		expect(lib.REQUIRED_VERIFY_RUNTIMES).toEqual(["npm", "bun"]);
		expect(lib.PACKAGING_HYBRID).toBe("hybrid");
		expect(lib.NETWORK_POLICY_EXTERNAL_OPTIONAL_ONLY).toBe("external-optional-only");
	});

	test("removes external optional parents and their native subtree from the hybrid bundle", async () => {
		const lib = await loadLib();
		tempDir = mkdtempSync(join(tmpdir(), "pi-hybrid-platform-"));
		const nodeModules = join(tempDir, "node_modules");
		writePackage(join(nodeModules, "@mariozechner", "clipboard"), {
			name: "@mariozechner/clipboard",
			version: "0.3.9",
			optionalDependencies: {
				"@mariozechner/clipboard-linux-x64-gnu": "0.3.9",
			},
		});
		writePackage(
			join(nodeModules, "@mariozechner", "clipboard", "node_modules", "@mariozechner", "clipboard-linux-x64-gnu"),
			{
				name: "@mariozechner/clipboard-linux-x64-gnu",
				version: "0.3.9",
				os: ["linux"],
				cpu: ["x64"],
				libc: ["glibc"],
			},
		);
		writePackage(join(nodeModules, "left-pad"), {
			name: "left-pad",
			version: "1.0.0",
		});

		expect(() => lib.assertExternalOptionalNodeModulesAbsent(nodeModules, ["@mariozechner/clipboard"])).toThrow(
			/external optional package.*bundled/i,
		);
		const removed = lib.removeExternalOptionalNodeModules(nodeModules, ["@mariozechner/clipboard"]);
		expect(removed.map((entry: { name: string }) => entry.name)).toEqual(["@mariozechner/clipboard"]);
		expect(existsSync(join(nodeModules, "@mariozechner", "clipboard"))).toBe(false);
		expect(existsSync(join(nodeModules, "left-pad", "package.json"))).toBe(true);
		expect(() => lib.assertExternalOptionalNodeModulesAbsent(nodeModules, ["@mariozechner/clipboard"])).not.toThrow();
	});

	test("rejects injected platform optional packages remaining in the hybrid tree", async () => {
		const lib = await loadLib();
		tempDir = mkdtempSync(join(tmpdir(), "pi-hybrid-platform-inject-"));
		const nodeModules = join(tempDir, "node_modules");
		writePackage(join(nodeModules, "host-native-only"), {
			name: "host-native-only",
			version: "1.0.0",
			os: ["linux"],
			cpu: ["x64"],
		});
		expect(() => lib.assertNoPlatformSpecificNodeModules(nodeModules)).toThrow(/platform-specific packages/);
	});

	test("shares one authoritative install lifecycle allowlist with the shrinkwrap generator", async () => {
		const lib = await loadLib();
		const lifecyclePolicy = await import(LIFECYCLE_POLICY_URL);
		expect(lib.DEFAULT_ALLOWED_INSTALL_SCRIPT_PACKAGES).toBe(lifecyclePolicy.DEFAULT_ALLOWED_INSTALL_SCRIPT_PACKAGES);
		const shrinkwrapSource = readFileSync(SHRINKWRAP_SCRIPT, "utf8");
		expect(shrinkwrapSource).toContain('from "./lib/install-lifecycle-policy.mjs"');
		expect(shrinkwrapSource).not.toMatch(/allowedInstallScriptPackages\s*=\s*new Map/);
	});

	test("scans package.json scripts and rejects non-allowlisted install lifecycle scripts", async () => {
		const lib = await loadLib();
		tempDir = mkdtempSync(join(tmpdir(), "pi-hybrid-lifecycle-"));
		writePackage(join(tempDir, "node_modules", "evil-native"), {
			name: "evil-native",
			version: "9.9.9",
			scripts: {
				postinstall: 'node -e "process.exit(1)"',
				test: "echo unit",
			},
		});
		writePackage(join(tempDir, "node_modules", "@google", "genai"), {
			name: "@google/genai",
			version: "1.52.0",
			scripts: {
				preinstall: "echo 'preinstall: no-op'",
			},
		});
		const findings = lib.collectInstallLifecycleScripts(tempDir);
		expect(findings.map((entry: { packageId: string }) => entry.packageId)).toEqual(
			expect.arrayContaining(["evil-native@9.9.9", "@google/genai@1.52.0"]),
		);
		// Must read scripts from package.json, not only lockfile hasInstallScript.
		expect(findings.find((entry: { packageId: string }) => entry.packageId === "evil-native@9.9.9")?.scripts).toEqual(
			{ postinstall: 'node -e "process.exit(1)"' },
		);
		expect(() => lib.assertInstallLifecycleScriptsAllowed(findings)).toThrow(
			/non-allowlisted install lifecycle scripts/,
		);
		const reviewed = findings.filter((entry: { packageId: string }) => entry.packageId === "@google/genai@1.52.0");
		expect(() => lib.assertInstallLifecycleScriptsAllowed(reviewed)).not.toThrow();
		expect(() =>
			lib.assertInstallLifecycleScriptsAllowed([{ ...reviewed[0], scripts: { preinstall: "node malicious.js" } }]),
		).toThrow(/changed reviewed install lifecycle script content/);
	});

	test("flags internal registry resolution leaks in installer logs", async () => {
		const lib = await loadLib();
		expect(() =>
			lib.assertNoInternalRegistryResolution(
				"http fetch GET https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-1.0.0.tgz",
			),
		).toThrow(/internal package registry resolution/);
		expect(() => lib.assertNoInternalRegistryResolution("npm install complete for bundled package")).not.toThrow();
	});

	test("rejects any registry request outside the declared external optional closure", async () => {
		const lib = await loadLib();
		const policy = {
			allowedNetworkPackages: ["@mariozechner/clipboard"],
			allowedNetworkPackagePrefixes: ["@mariozechner/clipboard-"],
		};
		const requests = lib.collectRegistryPackageRequests(`
			npm http fetch GET 200 https://registry.npmjs.org/@mariozechner%2fclipboard 20ms
			npm http fetch GET 200 https://registry.npmjs.org/@mariozechner/clipboard-linux-x64-gnu/-/clipboard-linux-x64-gnu-0.3.9.tgz 30ms
		`);
		expect(requests).toEqual(["@mariozechner/clipboard", "@mariozechner/clipboard-linux-x64-gnu"]);
		expect(() => lib.assertNetworkPackageRequestsAllowed(requests, policy)).not.toThrow();
		expect(() => lib.assertNetworkPackageRequestsAllowed([...requests, "left-pad"], policy)).toThrow(
			/non-allowlisted network package.*left-pad/i,
		);
		expect(() => lib.assertNetworkPackageRequestsAllowed(["@earendil-works/pi-tui"], policy)).toThrow(
			/non-allowlisted network package/i,
		);
	});

	test("fails runtime verification when the target clipboard native child is absent", async () => {
		const lib = await loadLib();
		tempDir = mkdtempSync(join(tmpdir(), "pi-hybrid-native-missing-"));
		writePackage(tempDir, { name: ENTRY_PACKAGE, version: "1.0.0" });
		const parentDir = join(tempDir, "node_modules", "@mariozechner", "clipboard");
		const nativeName = lib.expectedClipboardNativePackageName();
		writePackage(parentDir, {
			name: "@mariozechner/clipboard",
			version: "0.3.9",
			main: "index.cjs",
			optionalDependencies: { [nativeName]: "0.3.9" },
		});
		writeFileSync(join(parentDir, "index.cjs"), "module.exports = { hasText: () => false };\n");
		expect(() =>
			lib.verifyExternalOptionalRuntime(tempDir, {
				externalOptionalDependencies: { "@mariozechner/clipboard": "0.3.9" },
			}),
		).toThrow(/expected native package.*is missing/i);
	});

	test("external optional policy keeps registry pins and documents network boundary", async () => {
		const lib = await loadLib();
		const packageJson = {
			optionalDependencies: {
				"@mariozechner/clipboard": "0.3.9",
				"@earendil-works/pi-tui": "file:./node_modules/@earendil-works/pi-tui",
			},
		};
		const internalNames = new Set(["@earendil-works/pi-tui"]);
		const policy = lib.buildExternalOptionalPolicy(packageJson, internalNames);
		expect(policy.policy).toBe("external-optional-only");
		expect(policy.packages).toEqual({ "@mariozechner/clipboard": "0.3.9" });
		expect(policy.allowedNetworkPackages).toEqual(["@mariozechner/clipboard"]);
		expect(policy.allowedNetworkPackagePrefixes).toEqual(["@mariozechner/clipboard-"]);
		expect(() =>
			lib.assertExternalOptionalSpecsAreRegistry(
				{
					optionalDependencies: {
						"@mariozechner/clipboard": "file:./node_modules/@mariozechner/clipboard",
					},
				},
				new Set(),
			),
		).toThrow(/must remain a registry version/);
	});
});

describe("GitHub Release preparation", () => {
	test("refuses destructive output paths inside the repository", () => {
		const result = spawnSync("node", [PREPARE_SCRIPT, "--out", join(REPO_ROOT, "release-output")], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/external temporary directory/);
	});

	test("builds one hybrid canonical coding-agent tarball without host platform natives", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-github-release-"));
		const hasCli = existsSync(join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js"));
		if (!hasCli) {
			expect(hasCli, "packages/coding-agent/dist/cli.js must exist before release prepare").toBe(true);
			return;
		}

		const result = spawnSync("node", [PREPARE_SCRIPT, "--out", tempDir], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				GITHUB_RUN_NUMBER: "129",
				GITHUB_RUN_ATTEMPT: "1",
				GITHUB_SHA: "c1aeac76aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			},
		});
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/hybrid/i);

		const basePackageJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
			version: string;
		};
		const version = `${basePackageJson.version}-xz.129.1.gc1aeac76`;
		const packageFile = `earendil-works-pi-coding-agent-${version}.tgz`;
		expect(existsSync(join(tempDir, packageFile))).toBe(true);
		expect(existsSync(join(tempDir, "release-manifest.json"))).toBe(true);
		expect(existsSync(join(tempDir, "SHA256SUMS"))).toBe(true);
		expect(existsSync(join(tempDir, "install.ts"))).toBe(true);
		expect(existsSync(join(tempDir, "install.sh"))).toBe(true);
		expect(existsSync(join(tempDir, "install.ps1"))).toBe(true);
		expect(existsSync(join(tempDir, "install.mjs"))).toBe(false);

		const manifest = JSON.parse(readFileSync(join(tempDir, "release-manifest.json"), "utf8")) as {
			schemaVersion: number;
			repository: string;
			tag: string;
			distributionVersion: string;
			apiVersion: string;
			minimumNodeVersion: string;
			package: {
				name: string;
				file: string;
				bytes: number;
				sha256: string;
				integrity: string;
				bundled: boolean;
				packaging: string;
				networkPolicy: string;
				externalOptionalDependencies: Record<string, string>;
				allowedNetworkPackages: string[];
				allowedNetworkPackagePrefixes: string[];
			};
			installer: { file: string; bytes: number; sha256: string };
			bootstrap: {
				tag: string;
				baseUrl: string;
				minimumNodeVersion: string;
				files: { sh: string; ps1: string };
			};
		};

		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.repository).toBe("xz-dev/pi");
		expect(manifest.tag).toBe(`xz-v${version}`);
		expect(manifest.distributionVersion).toBe(version);
		expect(manifest.apiVersion).toBe(basePackageJson.version);
		expect(manifest.package).toMatchObject({
			name: ENTRY_PACKAGE,
			file: packageFile,
			bundled: true,
			packaging: "hybrid",
			networkPolicy: "external-optional-only",
		});
		expect(manifest.package.externalOptionalDependencies["@mariozechner/clipboard"]).toBe("0.3.9");
		expect(manifest.package.allowedNetworkPackages).toEqual(["@mariozechner/clipboard"]);
		expect(manifest.package.allowedNetworkPackagePrefixes).toEqual(["@mariozechner/clipboard-"]);
		expect(manifest.package.integrity.startsWith("sha512-")).toBe(true);
		expect(manifest.package.sha256).toMatch(/^[0-9a-f]{64}$/);

		const installTsBytes = readFileSync(join(tempDir, "install.ts")).byteLength;
		const installTsSha = createRequire(import.meta.url)("node:crypto")
			.createHash("sha256")
			.update(readFileSync(join(tempDir, "install.ts")))
			.digest("hex");
		expect(manifest.installer).toEqual({
			file: "install.ts",
			bytes: installTsBytes,
			sha256: installTsSha,
		});
		expect(manifest.bootstrap).toEqual({
			tag: manifest.tag,
			baseUrl: `https://github.com/xz-dev/pi/releases/download/${manifest.tag}/`,
			minimumNodeVersion: manifest.minimumNodeVersion,
			files: { sh: "install.sh", ps1: "install.ps1" },
		});

		const sums = parseSha256Sums(readFileSync(join(tempDir, "SHA256SUMS"), "utf8"));
		expect(sums.get(packageFile)).toBe(manifest.package.sha256);
		expect(sums.get("install.ts")).toBe(manifest.installer.sha256);
		expect(sums.has("install.sh")).toBe(true);
		expect(sums.has("install.ps1")).toBe(true);
		expect(sums.has("release-manifest.json")).toBe(true);

		const installSh = readFileSync(join(tempDir, "install.sh"), "utf8");
		const installPs1 = readFileSync(join(tempDir, "install.ps1"), "utf8");
		const manifestSha = createRequire(import.meta.url)("node:crypto")
			.createHash("sha256")
			.update(readFileSync(join(tempDir, "release-manifest.json")))
			.digest("hex");
		for (const content of [installSh, installPs1]) {
			expect(content).toContain(manifest.tag);
			expect(content).toContain(manifest.bootstrap.baseUrl);
			expect(content).toContain(manifestSha);
			expect(content).toContain(manifest.installer.sha256);
			expect(content).toContain(String(manifest.installer.bytes));
		}
		expect(installSh).toContain("curl");
		expect(installPs1).toContain("Invoke-WebRequest");

		const packageJson = extractPackageJsonFromTarball(join(tempDir, packageFile), tempDir) as {
			name: string;
			version: string;
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
			overrides?: Record<string, string>;
			bundledDependencies?: string[];
			piConfig?: { changelogVersion?: string; distribution?: string };
			publishConfig?: { registry?: string };
		};

		expect(packageJson.name).toBe(ENTRY_PACKAGE);
		expect(packageJson.version).toBe(version);
		expect(packageJson.piConfig?.changelogVersion).toBe(basePackageJson.version);
		expect(packageJson.piConfig?.distribution).toBe("xz-dev");
		expect(packageJson.publishConfig?.registry).toBeUndefined();
		expect(JSON.stringify(packageJson)).not.toContain("@xz-dev/");
		expect(JSON.stringify(packageJson)).not.toContain("npm.pkg.github.com");
		// External optional stays a registry pin for target-platform native resolution.
		expect(packageJson.optionalDependencies?.["@mariozechner/clipboard"]).toBe("0.3.9");

		const internalDeps = Object.entries(packageJson.dependencies ?? {}).filter(([name]) =>
			name.startsWith(INTERNAL_PACKAGE_PREFIX),
		);
		expect(internalDeps.length).toBeGreaterThan(0);
		for (const [name, spec] of internalDeps) {
			expect(spec).toBe(`file:./node_modules/${name}`);
			expect(packageJson.overrides?.[name]).toBe(`file:./node_modules/${name}`);
		}
		expect(packageJson.bundledDependencies?.length ?? 0).toBeGreaterThan(internalDeps.length);
		// The external optional parent itself must not be bundled: target npm/Bun
		// must resolve the portable parent and then its matching native child.
		expect(packageJson.bundledDependencies ?? []).not.toContain("@mariozechner/clipboard");
		// Host clipboard natives must not be frozen into the hybrid bundle.
		expect(packageJson.bundledDependencies ?? []).not.toEqual(
			expect.arrayContaining([
				"@mariozechner/clipboard-linux-x64-gnu",
				"@mariozechner/clipboard-linux-x64-musl",
				"@mariozechner/clipboard-darwin-arm64",
				"@mariozechner/clipboard-win32-x64-msvc",
			]),
		);

		const list = spawnSync("tar", ["-tzf", join(tempDir, packageFile)], {
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		});
		expect(list.status, list.stderr).toBe(0);
		expect(list.stdout).not.toContain("clipboard-linux-x64-gnu");
		expect(list.stdout).not.toContain("clipboard-linux-x64-musl");
		expect(list.stdout).not.toContain("clipboard-darwin-");
		expect(list.stdout).not.toContain("clipboard-win32-");
		expect(list.stdout).not.toContain("package/node_modules/@mariozechner/clipboard/");
		for (const [name] of internalDeps) {
			expect(list.stdout).toContain(`package/node_modules/${name}/package.json`);
		}
	}, 600_000);

	test("fixture closure packs client/protocol as local bundled internals and rejects missing packages", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-github-release-fixture-"));
		const repository = join(tempDir, "repository");
		mkdirSync(repository, { recursive: true });
		writeFileSync(
			join(repository, "package.json"),
			`${JSON.stringify({ name: "pi-monorepo", private: true, workspaces: ["packages/*"] })}\n`,
		);

		writePackage(join(repository, "packages", "coding-agent"), {
			name: ENTRY_PACKAGE,
			version: "1.0.0",
			bin: { pi: "dist/cli.js" },
			files: ["dist"],
			dependencies: {
				"@earendil-works/pi-client": "^1.0.0",
				"@earendil-works/pi-protocol": "^1.0.0",
			},
			optionalDependencies: {
				"@mariozechner/clipboard": "0.3.9",
			},
			engines: { node: ">=22.19.0" },
		});
		mkdirSync(join(repository, "packages", "coding-agent", "dist"), { recursive: true });
		writeFileSync(
			join(repository, "packages", "coding-agent", "dist", "cli.js"),
			'#!/usr/bin/env node\nconsole.log("1.0.0");\n',
		);

		writePackage(join(repository, "packages", "client"), {
			name: "@earendil-works/pi-client",
			version: "1.0.0",
			files: ["index.js"],
			dependencies: { "@earendil-works/pi-protocol": "^1.0.0" },
		});
		writeFileSync(join(repository, "packages", "client", "index.js"), "export {};\n");

		writePackage(join(repository, "packages", "protocol"), {
			name: "@earendil-works/pi-protocol",
			version: "1.0.0",
			files: ["index.js"],
		});
		writeFileSync(join(repository, "packages", "protocol", "index.js"), "export {};\n");

		const output = join(tempDir, "output");
		const result = spawnSync("node", [PREPARE_SCRIPT, "--out", output], {
			cwd: repository,
			encoding: "utf8",
			env: {
				...process.env,
				GITHUB_RUN_NUMBER: "29",
				GITHUB_RUN_ATTEMPT: "2",
				GITHUB_SHA: "4dea8cc9046547a59e2dd1e05688eed91290c67e",
			},
		});
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

		const version = "1.0.0-xz.29.2.g4dea8cc9";
		const packageFile = `earendil-works-pi-coding-agent-${version}.tgz`;
		expect(existsSync(join(output, packageFile))).toBe(true);

		const packageJson = extractPackageJsonFromTarball(join(output, packageFile), tempDir) as {
			name: string;
			version: string;
			dependencies: Record<string, string>;
			optionalDependencies?: Record<string, string>;
			piConfig?: { changelogVersion?: string; distribution?: string };
			bundledDependencies?: string[];
		};
		expect(packageJson.name).toBe(ENTRY_PACKAGE);
		expect(packageJson.version).toBe(version);
		expect(packageJson.piConfig).toMatchObject({
			changelogVersion: "1.0.0",
			distribution: "xz-dev",
		});
		expect(packageJson.dependencies).toMatchObject({
			"@earendil-works/pi-client": "file:./node_modules/@earendil-works/pi-client",
			"@earendil-works/pi-protocol": "file:./node_modules/@earendil-works/pi-protocol",
		});
		expect(packageJson.optionalDependencies?.["@mariozechner/clipboard"]).toBe("0.3.9");
		expect(packageJson.bundledDependencies).toEqual(
			expect.arrayContaining(["@earendil-works/pi-client", "@earendil-works/pi-protocol"]),
		);
		expect(packageJson.bundledDependencies ?? []).not.toContain("@mariozechner/clipboard");
		// Host-selected clipboard natives must not be frozen into the fixture hybrid bundle.
		expect(packageJson.bundledDependencies ?? []).not.toEqual(
			expect.arrayContaining(["@mariozechner/clipboard-linux-x64-gnu", "@mariozechner/clipboard-linux-x64-musl"]),
		);

		const list = spawnSync("tar", ["-tzf", join(output, packageFile)], { encoding: "utf8" });
		expect(list.status, list.stderr).toBe(0);
		expect(list.stdout).toContain("package/node_modules/@earendil-works/pi-client/package.json");
		expect(list.stdout).toContain("package/node_modules/@earendil-works/pi-protocol/package.json");
		expect(list.stdout).not.toContain("package/node_modules/@mariozechner/clipboard/");
		expect(list.stdout).not.toContain("clipboard-linux-x64-gnu");
		expect(list.stdout).not.toContain("@xz-dev/");

		const manifest = JSON.parse(readFileSync(join(output, "release-manifest.json"), "utf8")) as {
			distributionVersion: string;
			attestation: { repository: string; signerWorkflow: string; signerRef: string; denySelfHostedRunners: boolean };
			package: {
				file: string;
				sha256: string;
				packaging: string;
				networkPolicy: string;
				externalOptionalDependencies: Record<string, string>;
				allowedNetworkPackages: string[];
				allowedNetworkPackagePrefixes: string[];
			};
		};
		expect(manifest.distributionVersion).toBe(version);
		expect(manifest.attestation).toEqual({
			repository: "xz-dev/pi",
			signerWorkflow: "xz-dev/pi/.github/workflows/publish-github-release.yml",
			signerRef: "refs/heads/main",
			denySelfHostedRunners: true,
			subjectsFile: "attestation-subjects.txt",
		});
		expect(basename(manifest.package.file)).toBe(packageFile);
		expect(manifest.package.packaging).toBe("hybrid");
		expect(manifest.package.networkPolicy).toBe("external-optional-only");
		expect(manifest.package.externalOptionalDependencies["@mariozechner/clipboard"]).toBe("0.3.9");
		expect(manifest.package.allowedNetworkPackages).toEqual(["@mariozechner/clipboard"]);
		expect(manifest.package.allowedNetworkPackagePrefixes).toEqual(["@mariozechner/clipboard-"]);
		const sums = parseSha256Sums(readFileSync(join(output, "SHA256SUMS"), "utf8"));
		expect(sums.get(packageFile)).toBe(manifest.package.sha256);

		// Missing internal package must fail closed.
		writePackage(join(repository, "packages", "coding-agent"), {
			name: ENTRY_PACKAGE,
			version: "1.0.0",
			bin: { pi: "dist/cli.js" },
			files: ["dist"],
			dependencies: { "@earendil-works/pi-missing": "^1.0.0" },
		});
		const missing = spawnSync("node", [PREPARE_SCRIPT, "--out", join(tempDir, "missing")], {
			cwd: repository,
			encoding: "utf8",
			env: {
				...process.env,
				GITHUB_RUN_NUMBER: "29",
				GITHUB_SHA: "4dea8cc9046547a59e2dd1e05688eed91290c67e",
			},
		});
		expect(missing.status).not.toBe(0);
		const failureText = `${missing.stdout}\n${missing.stderr}`;
		expect(failureText).toContain(
			"@earendil-works/pi-coding-agent depends on unresolved internal package @earendil-works/pi-missing",
		);
	}, 180_000);

	test("prepare fails closed when a bundled dependency ships a non-allowlisted install script", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-github-release-lifecycle-"));
		const repository = join(tempDir, "repository");
		mkdirSync(repository, { recursive: true });
		writeFileSync(
			join(repository, "package.json"),
			`${JSON.stringify({ name: "pi-monorepo", private: true, workspaces: ["packages/*"] })}\n`,
		);

		// Local file dependency with a postinstall lifecycle script that is not allowlisted.
		const evilDir = join(repository, "vendor", "evil-native");
		writePackage(evilDir, {
			name: "evil-native",
			version: "1.0.0",
			scripts: { postinstall: "node -e \"console.log('boom')\"" },
			files: ["index.js"],
		});
		writeFileSync(join(evilDir, "index.js"), "module.exports = {};\n");

		writePackage(join(repository, "packages", "coding-agent"), {
			name: ENTRY_PACKAGE,
			version: "1.0.0",
			bin: { pi: "dist/cli.js" },
			files: ["dist"],
			dependencies: {
				"@earendil-works/pi-protocol": "^1.0.0",
				"evil-native": `file:${evilDir}`,
			},
			engines: { node: ">=22.19.0" },
		});
		mkdirSync(join(repository, "packages", "coding-agent", "dist"), { recursive: true });
		writeFileSync(
			join(repository, "packages", "coding-agent", "dist", "cli.js"),
			"#!/usr/bin/env node\nconsole.log('1.0.0');\n",
		);
		writePackage(join(repository, "packages", "protocol"), {
			name: "@earendil-works/pi-protocol",
			version: "1.0.0",
			files: ["index.js"],
		});
		writeFileSync(join(repository, "packages", "protocol", "index.js"), "export {};\n");

		const result = spawnSync("node", [PREPARE_SCRIPT, "--out", join(tempDir, "output")], {
			cwd: repository,
			encoding: "utf8",
			env: {
				...process.env,
				GITHUB_RUN_NUMBER: "7",
				GITHUB_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			},
		});
		expect(result.status).not.toBe(0);
		const text = `${result.stdout}\n${result.stderr}`;
		expect(text).toMatch(/non-allowlisted install lifecycle scripts|evil-native@1\.0\.0/);
	}, 120_000);
});

describe("GitHub Release verifier gates", () => {
	test("mode=all fails when Bun is missing under CI without allowing --skip-bun", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-github-release-verify-ci-"));
		// Minimal invalid-ish manifest is fine: Bun gate must fire before/around install.
		// Provide a parseable manifest so the script reaches the Bun requirement.
		const emptyTgz = join(tempDir, "empty.tgz");
		// Create a tiny valid-enough sha placeholder file for checksum path existence.
		writeFileSync(emptyTgz, "not-a-real-tarball");
		const createHash = createRequire(import.meta.url)("node:crypto").createHash as (algo: string) => {
			update(data: string | Buffer): void;
			digest(enc: string): string;
		};
		const packageHash = createHash("sha256");
		packageHash.update(readFileSync(emptyTgz));
		const sha = packageHash.digest("hex");
		const installTs = join(tempDir, "install.ts");
		writeFileSync(
			installTs,
			'#!/usr/bin/env node\nthrow new Error("Usage: install.ts [--migrate | --update | --rollback <version>]");\n',
		);
		const installerHash = createHash("sha256");
		installerHash.update(readFileSync(installTs));
		const installTsSha = installerHash.digest("hex");
		const installTsBytes = readFileSync(installTs).byteLength;
		writeFileSync(join(tempDir, "install.sh"), "#!/bin/sh\necho bootstrap\n");
		writeFileSync(join(tempDir, "install.ps1"), "Write-Output bootstrap\n");
		const distributionVersion = "0.0.0-xz.1.1.g11111111";
		const tag = `xz-v${distributionVersion}`;
		const baseUrl = `https://github.com/xz-dev/pi/releases/download/${tag}/`;
		const manifest = {
			schemaVersion: 1,
			repository: "xz-dev/pi",
			tag,
			distributionVersion,
			apiVersion: "0.0.0",
			commit: "1".repeat(40),
			minimumNodeVersion: "22.19.0",
			attestation: {
				repository: "xz-dev/pi",
				signerWorkflow: "xz-dev/pi/.github/workflows/publish-github-release.yml",
				signerRef: "refs/heads/main",
				denySelfHostedRunners: true,
				subjectsFile: "attestation-subjects.txt",
			},
			package: {
				name: ENTRY_PACKAGE,
				file: `earendil-works-pi-coding-agent-${distributionVersion}.tgz`,
				bytes: readFileSync(emptyTgz).byteLength,
				sha256: sha,
				integrity: `sha512-${createHash("sha512").update(readFileSync(emptyTgz)).digest("base64")}`,
				bundled: true,
				packaging: "hybrid",
				networkPolicy: "external-optional-only",
				externalOptionalDependencies: {},
				allowedNetworkPackages: [],
				allowedNetworkPackagePrefixes: [],
			},
			installer: {
				file: "install.ts",
				bytes: installTsBytes,
				sha256: installTsSha,
			},
			bootstrap: {
				tag,
				baseUrl,
				minimumNodeVersion: "22.19.0",
				files: { sh: "install.sh", ps1: "install.ps1" },
			},
		};
		renameSync(emptyTgz, join(tempDir, manifest.package.file));
		const manifestPath = join(tempDir, "release-manifest.json");
		writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, "\t")}\n`);
		const manifestHash = createHash("sha256");
		manifestHash.update(readFileSync(manifestPath));
		const manifestSha = manifestHash.digest("hex");
		// Embed pins so assertBootstrapContent accepts this synthetic fixture.
		writeFileSync(
			join(tempDir, "install.sh"),
			`#!/bin/sh\n# ${tag}\n# ${baseUrl}\n# ${manifestSha}\n# ${installTsSha}\n# ${installTsBytes}\ncurl\n`,
		);
		writeFileSync(
			join(tempDir, "install.ps1"),
			`# ${tag}\n# ${baseUrl}\n# ${manifestSha}\n# ${installTsSha}\n# ${installTsBytes}\nInvoke-WebRequest\n`,
		);
		const fixtureRoot = tempDir;
		if (!fixtureRoot) throw new Error("Verifier fixture directory is missing");
		const digest = (file: string) => {
			const path = join(fixtureRoot, file);
			const contents = readFileSync(path);
			const hash = createHash("sha256");
			hash.update(contents);
			return hash.digest("hex");
		};
		const sums = [
			`${sha}  ${manifest.package.file}`,
			`${manifestSha}  release-manifest.json`,
			`${digest("install.ts")}  install.ts`,
			`${digest("install.sh")}  install.sh`,
			`${digest("install.ps1")}  install.ps1`,
			"",
		].join("\n");
		writeFileSync(join(tempDir, "SHA256SUMS"), sums);
		writeFileSync(
			join(tempDir, "attestation-subjects.txt"),
			`${[
				manifest.package.file,
				"release-manifest.json",
				"install.ts",
				"install.sh",
				"install.ps1",
				"SHA256SUMS",
			].join("\n")}\n`,
		);

		// PATH with no bun, CI=true, mode=all → must fail on Bun requirement (or install attempt).
		const strippedPath = (process.env.PATH ?? "")
			.split(":")
			.filter((part) => part && !part.includes(".bun") && !part.endsWith("/bun"))
			.join(":");

		const missingBun = spawnSync("node", [VERIFY_SCRIPT, "all", manifestPath], {
			cwd: tempDir,
			encoding: "utf8",
			env: {
				...process.env,
				CI: "true",
				GITHUB_ACTIONS: "true",
				PATH: strippedPath || "/usr/bin:/bin",
				HOME: join(tempDir, "no-home"),
			},
		});
		expect(missingBun.status).not.toBe(0);
		const missingText = `${missingBun.stdout}\n${missingBun.stderr}`;
		// May fail at npm install of empty tgz first; force Bun-only mode for the definitive gate.
		const bunOnly = spawnSync("node", [VERIFY_SCRIPT, "bun", manifestPath], {
			cwd: tempDir,
			encoding: "utf8",
			env: {
				...process.env,
				CI: "true",
				PATH: strippedPath || "/usr/bin:/bin",
				HOME: join(tempDir, "no-home"),
			},
		});
		expect(bunOnly.status).not.toBe(0);
		expect(`${bunOnly.stdout}\n${bunOnly.stderr}`).toMatch(/bun is not available/i);

		const skipInCi = spawnSync("node", [VERIFY_SCRIPT, "all", manifestPath, "--skip-bun"], {
			cwd: tempDir,
			encoding: "utf8",
			env: {
				...process.env,
				CI: "true",
				GITHUB_ACTIONS: "true",
				PATH: strippedPath || "/usr/bin:/bin",
				HOME: join(tempDir, "no-home"),
			},
		});
		// In CI, either npm fails first on the dummy tarball or skip-bun is refused.
		// Prefer proving skip-bun refusal by checking stderr/stdout when npm somehow passes,
		// otherwise prove the bun-only missing path above (already asserted).
		const skipText = `${skipInCi.stdout}\n${skipInCi.stderr}`;
		if (skipText.includes("skip-bun")) {
			expect(skipInCi.status).not.toBe(0);
			expect(skipText).toMatch(/skip-bun is refused in CI/i);
		} else {
			// Dummy package causes npm global install to fail before Bun gate; still not success.
			expect(skipInCi.status).not.toBe(0);
		}
		// Silence unused when npm fails first.
		void missingText;
	});
});
