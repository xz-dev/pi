#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	INSTALL_PS1_FILENAME,
	INSTALL_SH_FILENAME,
	INSTALL_TS_FILENAME,
	releaseDownloadBaseUrl,
} from "./generate-install-bootstrap.mjs";
import {
	ENTRY_PACKAGE,
	NETWORK_POLICY_EXTERNAL_OPTIONAL_ONLY,
	PACKAGING_HYBRID,
	assertNetworkPackageRequestsAllowed,
	assertNoInternalRegistryResolution,
	collectRegistryPackageRequests,
	isCiEnvironment,
	parseSha256Sums,
	readJson,
	resolveExecutable,
	run,
	sha256File,
	sha512Integrity,
	verifyExternalOptionalRuntime,
} from "./lib/github-release.mjs";

function usage() {
	return [
		"Usage: node scripts/verify-github-release.mjs <local|node|bun|all> <release-manifest.json> [--skip-bun]",
		"",
		"  local|node  isolated global npm install + --version/--help smoke",
		"  bun         isolated Bun global install + smoke",
		"  all         npm + Bun; fails if Bun is missing unless --skip-bun",
		"  --skip-bun  local-development only; refused when CI=true / GITHUB_ACTIONS",
	].join("\n");
}

function parseArgs(argv) {
	const args = argv.slice(2);
	let mode;
	let manifestArg;
	let skipBun = false;
	for (const arg of args) {
		if (arg === "--skip-bun") {
			skipBun = true;
			continue;
		}
		if (!mode) {
			mode = arg;
			continue;
		}
		if (!manifestArg) {
			manifestArg = arg;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}\n${usage()}`);
	}
	if (!manifestArg || !["local", "node", "bun", "all"].includes(mode)) {
		throw new Error(usage());
	}
	return { mode, manifestArg, skipBun };
}

function readManifest(path) {
	const manifest = readJson(path);
	const allowedKeys = new Set([
		"schemaVersion",
		"repository",
		"tag",
		"distributionVersion",
		"apiVersion",
		"commit",
		"minimumNodeVersion",
		"package",
		"installer",
		"attestation",
		"bootstrap",
	]);
	if (!manifest || typeof manifest !== "object" || Object.keys(manifest).some((key) => !allowedKeys.has(key))) {
		throw new Error("Invalid GitHub Release manifest schema");
	}
	if (manifest.schemaVersion !== 1) {
		throw new Error(`Unsupported manifest schemaVersion: ${manifest.schemaVersion}`);
	}
	const versionMatch = /^(\d+\.\d+\.\d+)-xz\.(\d+)\.(\d+)\.g([0-9a-f]{8})$/.exec(
		manifest.distributionVersion ?? "",
	);
	if (
		manifest.repository !== "xz-dev/pi" ||
		!versionMatch ||
		manifest.apiVersion !== versionMatch[1] ||
		manifest.tag !== `xz-v${manifest.distributionVersion}` ||
		!new RegExp(`^${versionMatch[4]}[0-9a-f]{32}$`).test(manifest.commit ?? "") ||
		manifest.package?.file !== `earendil-works-pi-coding-agent-${manifest.distributionVersion}.tgz` ||
		!Number.isSafeInteger(manifest.package?.bytes) ||
		manifest.package.bytes <= 0 ||
		manifest.package.bytes > 1024 * 1024 * 1024 ||
		!/^sha512-[A-Za-z0-9+/]{86}==$/.test(manifest.package?.integrity ?? "") ||
		!/^[0-9a-f]{64}$/.test(manifest.package?.sha256 ?? "")
	) {
		throw new Error("Invalid GitHub Release manifest");
	}
	if (
		manifest.attestation?.repository !== "xz-dev/pi" ||
		manifest.attestation?.signerWorkflow !== "xz-dev/pi/.github/workflows/publish-github-release.yml" ||
		manifest.attestation?.signerRef !== "refs/heads/main" ||
		manifest.attestation?.denySelfHostedRunners !== true ||
		manifest.attestation?.subjectsFile !== "attestation-subjects.txt"
	) {
		throw new Error("Manifest attestation policy is invalid or missing");
	}
	if (manifest.package.name !== ENTRY_PACKAGE) {
		throw new Error(`Manifest package name must be ${ENTRY_PACKAGE}`);
	}
	if (manifest.package.bundled !== true) {
		throw new Error("Manifest package.bundled must be true");
	}
	if (manifest.package.packaging !== PACKAGING_HYBRID) {
		throw new Error(`Manifest package.packaging must be ${PACKAGING_HYBRID}`);
	}
	if (manifest.package.networkPolicy !== NETWORK_POLICY_EXTERNAL_OPTIONAL_ONLY) {
		throw new Error(
			`Manifest package.networkPolicy must be ${NETWORK_POLICY_EXTERNAL_OPTIONAL_ONLY}`,
		);
	}
	if (
		!manifest.package.externalOptionalDependencies ||
		typeof manifest.package.externalOptionalDependencies !== "object"
	) {
		throw new Error("Manifest package.externalOptionalDependencies must be an object");
	}
	if (
		!Array.isArray(manifest.package.allowedNetworkPackages) ||
		!manifest.package.allowedNetworkPackages.every(
			(name) => typeof name === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name),
		)
	) {
		throw new Error("Manifest package.allowedNetworkPackages must be an array of registry package names");
	}
	if (!Array.isArray(manifest.package.allowedNetworkPackagePrefixes)) {
		throw new Error("Manifest package.allowedNetworkPackagePrefixes must be an array");
	}
	const externalNames = Object.keys(manifest.package.externalOptionalDependencies).sort();
	const allowedNames = [...manifest.package.allowedNetworkPackages].sort();
	if (
		JSON.stringify(externalNames) !== JSON.stringify(allowedNames) ||
		new Set(manifest.package.allowedNetworkPackages).size !== manifest.package.allowedNetworkPackages.length
	) {
		throw new Error(
			"Manifest allowedNetworkPackages must exactly match externalOptionalDependencies",
		);
	}
	const expectedPrefixes = manifest.package.allowedNetworkPackages.map((name) => `${name}-`).sort();
	const actualPrefixes = [...manifest.package.allowedNetworkPackagePrefixes].sort();
	if (JSON.stringify(expectedPrefixes) !== JSON.stringify(actualPrefixes)) {
		throw new Error("Manifest allowedNetworkPackagePrefixes must match external optional native families");
	}
	if (!manifest.installer || typeof manifest.installer !== "object") {
		throw new Error("Manifest installer field is required");
	}
	if (manifest.installer.file !== INSTALL_TS_FILENAME) {
		throw new Error(`Manifest installer.file must be ${INSTALL_TS_FILENAME}`);
	}
	if (!Number.isInteger(manifest.installer.bytes) || manifest.installer.bytes <= 0) {
		throw new Error("Manifest installer.bytes must be a positive integer");
	}
	if (typeof manifest.installer.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.installer.sha256)) {
		throw new Error("Manifest installer.sha256 must be a 64-hex digest");
	}
	if (!manifest.bootstrap || typeof manifest.bootstrap !== "object") {
		throw new Error("Manifest bootstrap field is required");
	}
	if (manifest.bootstrap.tag !== manifest.tag) {
		throw new Error("Manifest bootstrap.tag must match manifest.tag");
	}
	const expectedBaseUrl = releaseDownloadBaseUrl(manifest.tag);
	if (manifest.bootstrap.baseUrl !== expectedBaseUrl) {
		throw new Error(
			`Manifest bootstrap.baseUrl must be ${expectedBaseUrl}, got ${manifest.bootstrap.baseUrl}`,
		);
	}
	if (manifest.bootstrap.minimumNodeVersion !== manifest.minimumNodeVersion) {
		throw new Error("Manifest bootstrap.minimumNodeVersion must match minimumNodeVersion");
	}
	if (manifest.bootstrap.files?.sh !== INSTALL_SH_FILENAME) {
		throw new Error(`Manifest bootstrap.files.sh must be ${INSTALL_SH_FILENAME}`);
	}
	if (manifest.bootstrap.files?.ps1 !== INSTALL_PS1_FILENAME) {
		throw new Error(`Manifest bootstrap.files.ps1 must be ${INSTALL_PS1_FILENAME}`);
	}
	return manifest;
}

function assertAssetDigest(sums, releaseDir, fileName, expectedSha256) {
	const assetPath = join(releaseDir, fileName);
	if (!existsSync(assetPath)) {
		throw new Error(`Missing release asset: ${assetPath}`);
	}
	const actualSha = sha256File(assetPath);
	if (expectedSha256 && actualSha !== expectedSha256) {
		throw new Error(`${fileName} sha256 mismatch: expected ${expectedSha256}, file ${actualSha}`);
	}
	const sumsSha = sums.get(fileName);
	if (!sumsSha) {
		throw new Error(`SHA256SUMS missing entry for ${fileName}`);
	}
	if (sumsSha !== actualSha) {
		throw new Error(`SHA256SUMS digest for ${fileName} does not match file`);
	}
	return { path: assetPath, sha256: actualSha };
}

function assertBootstrapContent(manifest, releaseDir, installTsSha256, manifestSha256) {
	const shPath = join(releaseDir, INSTALL_SH_FILENAME);
	const ps1Path = join(releaseDir, INSTALL_PS1_FILENAME);
	const sh = readFileSync(shPath, "utf8");
	const ps1 = readFileSync(ps1Path, "utf8");

	for (const [label, content] of [
		["install.sh", sh],
		["install.ps1", ps1],
	]) {
		if (!content.includes(manifest.tag)) {
			throw new Error(`${label} does not embed release tag ${manifest.tag}`);
		}
		if (!content.includes(manifest.bootstrap.baseUrl)) {
			throw new Error(`${label} does not embed release base URL`);
		}
		if (!content.includes(manifestSha256)) {
			throw new Error(`${label} does not embed release-manifest.json sha256`);
		}
		if (!content.includes(installTsSha256)) {
			throw new Error(`${label} does not embed install.ts sha256`);
		}
		if (!content.includes(String(manifest.installer.bytes))) {
			throw new Error(`${label} does not embed install.ts byte length`);
		}
		// Bootstrap must stay thin: it may document/forward transaction flags, but
		// must not implement package materialization or managed-version switching.
		if (/\bnpm (install|pack)\b/.test(content) || /versionsDir|atomicCurrent/.test(content)) {
			throw new Error(`${label} must not contain installer transaction logic`);
		}
	}

	if (!sh.includes("curl")) {
		throw new Error("install.sh must use curl for downloads");
	}
	if (!ps1.includes("Invoke-WebRequest")) {
		throw new Error("install.ps1 must use Invoke-WebRequest for downloads");
	}
}

function assertInstallerRuntime(installTsPath) {
	// Direct execution smoke: erasable TS should parse/run under Node and print usage on bad args.
	const nodeResult = spawnSync("node", [installTsPath, "--not-a-real-flag"], {
		encoding: "utf8",
	});
	const nodeText = `${nodeResult.stdout}\n${nodeResult.stderr}`;
	if (nodeResult.status === 0) {
		throw new Error("install.ts accepted an invalid flag under node");
	}
	if (!/Usage: install\.ts/.test(nodeText) && !/install\.ts/.test(nodeText)) {
		throw new Error(`install.ts failed to run under node:\n${nodeText}`);
	}

	const bunPath = resolveExecutable("bun");
	if (bunPath) {
		const bunResult = spawnSync(bunPath, [installTsPath, "--not-a-real-flag"], {
			encoding: "utf8",
		});
		const bunText = `${bunResult.stdout}\n${bunResult.stderr}`;
		if (bunResult.status === 0) {
			throw new Error("install.ts accepted an invalid flag under bun");
		}
		if (!/Usage: install\.ts/.test(bunText) && !/install\.ts/.test(bunText)) {
			throw new Error(`install.ts failed to run under bun:\n${bunText}`);
		}
		console.log("Installer runtime ok: node + bun");
	} else {
		console.log("Installer runtime ok: node (bun not on PATH)");
	}
}

function assertChecksums(manifest, manifestPath) {
	const releaseDir = dirname(manifestPath);
	const packagePath = join(releaseDir, manifest.package.file);
	if (!existsSync(packagePath)) {
		throw new Error(`Missing package asset: ${packagePath}`);
	}
	if (readFileSync(packagePath).byteLength !== manifest.package.bytes) {
		throw new Error("Package byte length does not match manifest");
	}
	if (sha512Integrity(packagePath) !== manifest.package.integrity) {
		throw new Error("Package sha512 integrity does not match manifest");
	}
	const packageSha = sha256File(packagePath);
	if (packageSha !== manifest.package.sha256) {
		throw new Error(
			`Package sha256 mismatch: manifest ${manifest.package.sha256}, file ${packageSha}`,
		);
	}

	const sumsPath = join(releaseDir, "SHA256SUMS");
	if (!existsSync(sumsPath)) {
		throw new Error(`Missing SHA256SUMS next to manifest: ${sumsPath}`);
	}
	const sums = parseSha256Sums(readFileSync(sumsPath, "utf8"));
	const expectedPackage = sums.get(manifest.package.file);
	if (!expectedPackage) {
		throw new Error(`SHA256SUMS missing entry for ${manifest.package.file}`);
	}
	if (expectedPackage !== packageSha) {
		throw new Error("SHA256SUMS package digest does not match package file");
	}
	const manifestAsset = assertAssetDigest(sums, releaseDir, "release-manifest.json");
	if (manifestAsset.sha256 !== sha256File(manifestPath)) {
		throw new Error("SHA256SUMS release-manifest.json digest does not match manifest file");
	}

	const installerAsset = assertAssetDigest(
		sums,
		releaseDir,
		INSTALL_TS_FILENAME,
		manifest.installer.sha256,
	);
	const installTsBytes = readFileSync(installerAsset.path).byteLength;
	if (installTsBytes !== manifest.installer.bytes) {
		throw new Error(
			`install.ts size mismatch: manifest ${manifest.installer.bytes}, file ${installTsBytes}`,
		);
	}

	assertAssetDigest(sums, releaseDir, INSTALL_SH_FILENAME);
	assertAssetDigest(sums, releaseDir, INSTALL_PS1_FILENAME);
	const expectedSubjects = [
		manifest.package.file,
		"release-manifest.json",
		INSTALL_TS_FILENAME,
		INSTALL_SH_FILENAME,
		INSTALL_PS1_FILENAME,
		"SHA256SUMS",
	].sort();
	const subjectsPath = join(releaseDir, manifest.attestation.subjectsFile);
	if (!existsSync(subjectsPath)) throw new Error(`Missing attestation subjects file: ${subjectsPath}`);
	const actualSubjects = readFileSync(subjectsPath, "utf8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.sort();
	if (
		actualSubjects.some((subject) => subject !== basename(subject)) ||
		JSON.stringify(actualSubjects) !== JSON.stringify(expectedSubjects)
	) {
		throw new Error("Attestation subjects file does not contain the exact canonical Release asset inventory");
	}
	assertBootstrapContent(manifest, releaseDir, installerAsset.sha256, manifestAsset.sha256);
	assertInstallerRuntime(installerAsset.path);

	return packagePath;
}

function inspectInstalledPackage(installRoot, distributionVersion) {
	const candidates = [
		// npm global prefix layout
		join(installRoot, "lib", "node_modules", ENTRY_PACKAGE),
		join(installRoot, "lib64", "node_modules", ENTRY_PACKAGE),
		// Bun global prefix (BUN_INSTALL)
		join(installRoot, "install", "global", "node_modules", ENTRY_PACKAGE),
		// Some Bun versions nest under node_modules at the prefix root
		join(installRoot, "node_modules", ENTRY_PACKAGE),
	];
	const packageDir = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
	if (!packageDir) {
		throw new Error(`Installed package not found under global prefix ${installRoot}`);
	}
	const packageJson = readJson(join(packageDir, "package.json"));
	if (packageJson.name !== ENTRY_PACKAGE) {
		throw new Error(`Installed name ${packageJson.name}, expected ${ENTRY_PACKAGE}`);
	}
	if (packageJson.version !== distributionVersion) {
		throw new Error(
			`Installed version ${packageJson.version}, expected ${distributionVersion}`,
		);
	}
	if (packageJson.piConfig?.distribution !== "xz-dev") {
		throw new Error("Installed package missing piConfig.distribution=xz-dev");
	}
	const blob = JSON.stringify(packageJson);
	if (blob.includes("@xz-dev/") || blob.includes("npm.pkg.github.com")) {
		throw new Error("Installed package.json contains forbidden registry markers");
	}
	for (const [name, spec] of Object.entries(packageJson.dependencies ?? {})) {
		if (!name.startsWith("@earendil-works/pi-")) continue;
		if (spec !== `file:./node_modules/${name}`) {
			throw new Error(`Internal dependency ${name} is not local-bundled: ${spec}`);
		}
		if (!existsSync(join(packageDir, "node_modules", ...name.split("/"), "package.json"))) {
			throw new Error(`Bundled internal package missing: ${name}`);
		}
	}
	// External optionals must remain registry version pins (hybrid target network).
	for (const [name, spec] of Object.entries(packageJson.optionalDependencies ?? {})) {
		if (name.startsWith("@earendil-works/pi-")) {
			if (spec !== `file:./node_modules/${name}`) {
				throw new Error(`Internal optional ${name} is not local-bundled: ${spec}`);
			}
			continue;
		}
		if (typeof spec !== "string" || spec.startsWith("file:") || spec.startsWith("link:")) {
			throw new Error(
				`External optional ${name} must stay a registry version for target resolution, got ${spec}`,
			);
		}
	}
	return packageDir;
}

function runPi(executable, args, cwd) {
	const result = spawnSync(executable, args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			// Keep smoke isolated from the developer's live ~/.pi data.
			PI_CODING_AGENT_DIR: join(cwd, ".pi-verify"),
		},
	});
	if (result.status !== 0) {
		throw new Error(
			`Command failed: ${executable} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
		);
	}
	return (result.stdout ?? "").trim();
}

function captureRun(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env ?? process.env,
		maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.error) {
		throw new Error(`Command failed to start: ${[command, ...args].join(" ")}\n${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}\n${output}`);
	}
	return output;
}

/**
 * Real global npm install into an isolated prefix (not a local project install).
 * Network is allowed only so target-style external optional natives can resolve;
 * installer output is scanned to ensure internal Pi packages stay local/bundled.
 */
function assertTargetExternalResolution(output, packageDir, packagePolicy, options = {}) {
	assertNoInternalRegistryResolution(output);
	const requestedPackages = collectRegistryPackageRequests(output).filter(
		// npm's update notifier may probe its own package independently of install
		// resolution. It is disabled below; tolerate a probe from older npm clients.
		(name) => name !== "npm",
	);
	assertNetworkPackageRequestsAllowed(requestedPackages, packagePolicy, {
		requireDeclared: options.requireDeclaredRequest !== false,
	});
	// Installed parent + target-native load is authoritative when a runtime's
	// logs/cache do not expose registry requests (notably Bun global installs).
	verifyExternalOptionalRuntime(packageDir, packagePolicy);
}

function npmInvocation() {
	if (process.platform === "win32") {
		const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
		if (existsSync(npmCli)) return { command: process.execPath, prefixArgs: [npmCli] };
	}
	const npm = resolveExecutable("npm");
	if (!npm) throw new Error("npm is not available on PATH");
	return { command: npm, prefixArgs: [] };
}

function verifyWithNpm(packagePath, manifest) {
	const npm = npmInvocation();
	const prefix = mkdtempSync(join(tmpdir(), "pi-github-release-npm-prefix-"));
	const cache = mkdtempSync(join(tmpdir(), "pi-github-release-npm-cache-"));
	const home = mkdtempSync(join(tmpdir(), "pi-github-release-npm-home-"));
	try {
		const output = captureRun(
			npm.command,
			[
				...npm.prefixArgs,
				"install",
				"-g",
				"--prefix",
				prefix,
				"--cache",
				cache,
				"--ignore-scripts",
				"--no-fund",
				"--no-audit",
				"--loglevel",
				"verbose",
				packagePath,
			],
			{
				cwd: home,
				env: {
					...process.env,
					HOME: home,
					npm_config_prefix: prefix,
					npm_config_cache: cache,
					NPM_CONFIG_PREFIX: prefix,
					NPM_CONFIG_CACHE: cache,
					// Avoid user global config rewriting the prefix.
					npm_config_userconfig: join(home, ".npmrc"),
					npm_config_globalconfig: join(home, "global-npmrc"),
					npm_config_update_notifier: "false",
					NPM_CONFIG_UPDATE_NOTIFIER: "false",
				},
			},
		);
		const packageDir = inspectInstalledPackage(prefix, manifest.distributionVersion);
		assertTargetExternalResolution(output, packageDir, manifest.package);
		const executable = join(
			prefix,
			"bin",
			process.platform === "win32" ? "pi.cmd" : "pi",
		);
		if (!existsSync(executable)) {
			throw new Error(`npm global install did not create ${executable}`);
		}
		const version = runPi(executable, ["--version"], home);
		if (version !== manifest.distributionVersion) {
			throw new Error(`npm global pi --version returned ${version}`);
		}
		runPi(executable, ["--help"], home);
		console.log(`npm global verify ok: ${version}`);
	} finally {
		rmSync(prefix, { force: true, recursive: true });
		rmSync(cache, { force: true, recursive: true });
		rmSync(home, { force: true, recursive: true });
	}
}

/**
 * Real Bun global install into an isolated BUN_INSTALL directory.
 */
function verifyWithBun(packagePath, manifest) {
	const bun = resolveExecutable("bun");
	if (!bun) {
		throw new Error("bun is not available on PATH (or ~/.bun/bin)");
	}
	const installDirectory = mkdtempSync(join(tmpdir(), "pi-github-release-bun-"));
	const home = mkdtempSync(join(tmpdir(), "pi-github-release-bun-home-"));
	const cache = mkdtempSync(join(tmpdir(), "pi-github-release-bun-cache-"));
	try {
		const output = captureRun(
			bun,
			["install", "--global", "--ignore-scripts", packagePath],
			{
				cwd: home,
				env: {
					...process.env,
					HOME: home,
					BUN_INSTALL: installDirectory,
					BUN_INSTALL_CACHE_DIR: cache,
				},
			},
		);
		const packageDir = inspectInstalledPackage(
			installDirectory,
			manifest.distributionVersion,
		);
		assertTargetExternalResolution(output, packageDir, manifest.package, {
			requireDeclaredRequest: false,
		});
		const executable = join(
			installDirectory,
			"bin",
			process.platform === "win32" ? "pi.exe" : "pi",
		);
		const fallback = join(installDirectory, "bin", "pi");
		const piBin = existsSync(executable) ? executable : fallback;
		if (!existsSync(piBin)) {
			throw new Error(`Bun global install did not create ${executable}`);
		}
		const version = runPi(piBin, ["--version"], home);
		if (version !== manifest.distributionVersion) {
			throw new Error(`bun global pi --version returned ${version}`);
		}
		runPi(piBin, ["--help"], home);
		console.log(`Bun global verify ok: ${version}`);
	} finally {
		rmSync(installDirectory, { force: true, recursive: true });
		rmSync(home, { force: true, recursive: true });
		rmSync(cache, { force: true, recursive: true });
	}
}

function requireBunOrSkip(mode, skipBun) {
	const bun = resolveExecutable("bun");
	if (bun) return bun;
	if (mode === "bun") {
		throw new Error("bun is not available on PATH (or ~/.bun/bin)");
	}
	if (mode === "all") {
		if (skipBun) {
			if (isCiEnvironment()) {
				throw new Error(
					"--skip-bun is refused in CI; install Bun (exact trusted 1.3.x) so the all gate can run",
				);
			}
			console.warn(
				"warning: --skip-bun: skipping Bun global verify (local development only)",
			);
			return undefined;
		}
		throw new Error(
			"bun is required for mode=all; install Bun or pass --skip-bun for local development only",
		);
	}
	return undefined;
}

const { mode, manifestArg, skipBun } = parseArgs(process.argv);
const manifestPath = resolve(manifestArg);
const manifest = readManifest(manifestPath);
const packagePath = assertChecksums(manifest, manifestPath);

if (mode === "local" || mode === "node" || mode === "all") {
	verifyWithNpm(packagePath, manifest);
}
if (mode === "bun" || mode === "all") {
	const bun = requireBunOrSkip(mode, skipBun);
	if (bun || mode === "bun") {
		// mode=bun always attempts; mode=all only when bun resolved (or already threw).
		if (mode === "bun" || bun) {
			verifyWithBun(packagePath, manifest);
		}
	}
}
