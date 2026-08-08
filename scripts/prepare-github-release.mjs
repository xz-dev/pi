#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	INSTALL_PS1_FILENAME,
	INSTALL_SH_FILENAME,
	releaseDownloadBaseUrl,
	writeInstallBootstrap,
} from "./generate-install-bootstrap.mjs";
import {
	ATTESTATION_SIGNER_REF,
	ATTESTATION_SIGNER_WORKFLOW,
	ATTESTATION_SUBJECTS_FILENAME,
	BINARY_PLATFORMS,
	BUNDLE_LAYOUT_VERSION,
	DISTRIBUTION,
	ENTRY_PACKAGE,
	MANIFEST_SCHEMA_VERSION,
	PACKAGING_BINARY,
	REPOSITORY,
	assertBinaryBundleInventory,
	binaryArchiveName,
	binaryRequiredPaths,
	forkDistributionVersion,
	formatSha256Sums,
	readBundlePackageJson,
	resolveFullCommit,
	run,
	sha256File,
	stableStringify,
} from "./lib/github-release.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const MANIFEST_FILENAME = "release-manifest.json";
const SUMS_FILENAME = "SHA256SUMS";
const ACCEPTANCE_FILENAME = "binary-acceptance.json";

function usage() {
	return [
		"Usage: node scripts/prepare-github-release.mjs --out <dir> [--prebuilt <dir>] [--skip-deps] [--skip-build] [--platform <target>]",
		"",
		"  --out <dir>         external temporary output directory (required)",
		"  --skip-deps         skip installing cross-platform native bindings (local speed; CI builds all)",
		"  --skip-build        skip the npm package build (use when dist/ is already built)",
		`  --platform <name>   build only one target (default: all ${BINARY_PLATFORMS.length} canonical targets)`,
		"  --prebuilt <dir>    assemble an exact full candidate from matrix-built archives",
	].join("\n");
}

function parseArgs(argv) {
	const args = argv.slice(2);
	let outDir;
	let skipDeps = false;
	let skipBuild = false;
	let prebuiltDir;
	const platforms = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--out" || arg === "--platform" || arg === "--prebuilt") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}\n${usage()}`);
			if (arg === "--out") outDir = value;
			else if (arg === "--prebuilt") prebuiltDir = resolve(value);
			else platforms.push(value);
			index += 1;
		} else if (arg === "--skip-deps") skipDeps = true;
		else if (arg === "--skip-build") skipBuild = true;
		else if (arg === "--help" || arg === "-h") throw new Error(usage());
		else throw new Error(`Unknown argument: ${arg}\n${usage()}`);
	}
	if (!outDir) throw new Error(usage());
	const resolved = resolve(outDir);
	const root = resolve(process.cwd());
	const fromRoot = relative(root, resolved);
	const fromOutput = relative(resolved, root);
	const insideRoot = fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
	const containsRoot = fromOutput === "" || (fromOutput !== ".." && !fromOutput.startsWith(`..${sep}`));
	if (insideRoot || containsRoot) throw new Error("Release output directory must be an external temporary directory");
	const selected = platforms.length > 0 ? platforms : [...BINARY_PLATFORMS];
	if (new Set(selected).size !== selected.length) throw new Error("Release platforms must not contain duplicates");
	for (const platform of selected) {
		if (!BINARY_PLATFORMS.includes(platform)) {
			throw new Error(`Invalid platform ${platform}; expected one of ${BINARY_PLATFORMS.join(", ")}`);
		}
	}
	if (prebuiltDir && platforms.length > 0) throw new Error("--prebuilt cannot be combined with --platform");
	return { outDir: resolved, skipDeps, skipBuild, platforms: selected, prebuiltDir };
}

function writeJson(path, value) {
	writeFileSync(path, stableStringify(value));
}

function main() {
	const { outDir, skipDeps, skipBuild, platforms, prebuiltDir } = parseArgs(process.argv);
	const rootPackageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	if (rootPackageJson.name !== "pi-monorepo") throw new Error("Run this script from the repository root");
	const entryPackageJson = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "coding-agent", "package.json"), "utf8"));
	const apiVersion = entryPackageJson.version;
	const distributionVersion = forkDistributionVersion(apiVersion);
	const commit = resolveFullCommit();
	const tag = `xz-v${distributionVersion}`;

	rmSync(outDir, { force: true, recursive: true });
	mkdirSync(outDir, { recursive: true });
	const workDir = prebuiltDir ?? join(outDir, "work");
	if (!prebuiltDir) mkdirSync(workDir, { recursive: true });
	const buildArgs = [
		"scripts/build-binaries.sh",
		"--skip-install",
		...(skipDeps ? ["--skip-deps"] : []),
		...(skipBuild ? ["--skip-build"] : []),
		"--out",
		workDir,
		"--distribution-version",
		distributionVersion,
	];
	for (const platform of platforms) buildArgs.push("--platform", platform);
	if (!prebuiltDir) run("bash", buildArgs, { cwd: REPO_ROOT });

	const bundles = {};
	const requiredPaths = {};
	for (const platform of platforms) {
		const archiveName = binaryArchiveName(platform);
		const archivePath = join(workDir, archiveName);
		if (!existsSync(archivePath)) throw new Error(`Missing built bundle archive: ${archivePath}`);
		assertBinaryBundleInventory(archivePath, platform);
		const bundledPackageJson = readBundlePackageJson(archivePath, platform);
		if (bundledPackageJson.name !== ENTRY_PACKAGE) throw new Error(`${platform} bundle has unexpected package name`);
		if (bundledPackageJson.version !== distributionVersion) throw new Error(`${platform} bundle has unexpected version`);
		if (bundledPackageJson.piConfig?.distribution !== DISTRIBUTION) {
			throw new Error(`${platform} bundle missing piConfig.distribution=${DISTRIBUTION}`);
		}
		const destination = join(outDir, archiveName);
		renameSync(archivePath, destination);
		bundles[platform] = {
			file: archiveName,
			bytes: readFileSync(destination).byteLength,
			sha256: sha256File(destination),
		};
		requiredPaths[platform] = binaryRequiredPaths(platform);
	}

	const baseUrl = releaseDownloadBaseUrl(tag);
	const manifest = {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		repository: REPOSITORY,
		tag,
		distributionVersion,
		apiVersion,
		commit,
		packaging: PACKAGING_BINARY,
		layoutVersion: BUNDLE_LAYOUT_VERSION,
		bundles,
		requiredPaths,
		installer: {
			posix: { file: INSTALL_SH_FILENAME },
			windows: { file: INSTALL_PS1_FILENAME },
			checksums: { file: SUMS_FILENAME, algorithm: "sha256" },
		},
		acceptance: { file: ACCEPTANCE_FILENAME, targetCount: BINARY_PLATFORMS.length },
		attestation: {
			repository: REPOSITORY,
			signerWorkflow: `${REPOSITORY}/${ATTESTATION_SIGNER_WORKFLOW}`,
			signerRef: ATTESTATION_SIGNER_REF,
			denySelfHostedRunners: true,
			subjectsFile: ATTESTATION_SUBJECTS_FILENAME,
		},
	};
	const manifestPath = join(outDir, MANIFEST_FILENAME);
	writeJson(manifestPath, manifest);
	const manifestSha256 = sha256File(manifestPath);
	const installers = writeInstallBootstrap(outDir, {
		tag,
		baseUrl,
		manifestSha256,
		commit,
		distributionVersion,
		bundles,
		attestation: manifest.attestation,
	});

	const checksummedAssets = [
		...Object.values(bundles).map((entry) => entry.file),
		MANIFEST_FILENAME,
		INSTALL_SH_FILENAME,
		INSTALL_PS1_FILENAME,
	];
	const sumsPath = join(outDir, SUMS_FILENAME);
	writeFileSync(
		sumsPath,
		formatSha256Sums(checksummedAssets.map((file) => ({ file, sha256: sha256File(join(outDir, file)) }))),
	);
	const attestationSubjects = [...checksummedAssets, SUMS_FILENAME];
	const subjectsPath = join(outDir, ATTESTATION_SUBJECTS_FILENAME);
	writeFileSync(subjectsPath, `${attestationSubjects.join("\n")}\n`);

	if (manifestSha256 !== sha256File(manifestPath)) throw new Error("release-manifest.json changed after installer pin");
	writeFileSync(join(outDir, "version"), `${distributionVersion}\n`);
	writeFileSync(join(outDir, "tag"), `${tag}\n`);

	console.log(`Prepared GitHub Release ${tag} (${PACKAGING_BINARY})`);
	console.log(`Bundles: ${platforms.length}`);
	console.log(manifestPath);
	console.log(installers.sh.path);
	console.log(installers.ps1.path);
	console.log(sumsPath);
	console.log(subjectsPath);
}

main();
