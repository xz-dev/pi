#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
	ATTESTATION_SIGNER_REF,
	ATTESTATION_SIGNER_WORKFLOW,
	ATTESTATION_SUBJECTS_FILENAME,
	BINARY_PLATFORMS,
	DISTRIBUTION,
	ENTRY_PACKAGE,
	MANIFEST_SCHEMA_VERSION,
	PACKAGING_BINARY,
	REPOSITORY,
	assertExecutableAsset,
	binaryArchiveName,
	forkDistributionVersion,
	formatSha256Sums,
	platformNativeInfo,
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
const NOTICES_FILENAME = "THIRD_PARTY_NOTICES.md";

function usage() {
	return [
		"Usage: node scripts/prepare-github-release.mjs --out <dir> [--prebuilt <dir>] [--skip-deps] [--skip-build] [--platform <target>]",
		"",
		"  --out <dir>         external temporary output directory (required)",
		"  --skip-deps         skip installing cross-platform native bindings (local speed; CI builds all)",
		"  --skip-build        skip the npm package build (use when dist/ is already built)",
		`  --platform <name>   build only selected targets (repeatable; default: all ${BINARY_PLATFORMS.length} canonical targets)`,
		"  --prebuilt <dir>    assemble a candidate from matrix-built raw executables",
		"  --distribution-version <v>  expected probed version (default: derived from GITHUB_RUN_* + commit)",
		"  --commit <sha>      manifest commit (default: HEAD); needed for locally versioned fixtures",
		"",
		"  With --prebuilt and no --platform, the directory must contain every canonical",
		"  executable; combine --prebuilt with --platform to verify a subset locally.",
	].join("\n");
}

function parseArgs(argv) {
	const args = argv.slice(2);
	let outDir;
	let skipDeps = false;
	let skipBuild = false;
	let prebuiltDir;
	let distributionVersion;
	let commit;
	const platforms = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--out" || arg === "--platform" || arg === "--prebuilt" || arg === "--distribution-version" || arg === "--commit") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}\n${usage()}`);
			if (arg === "--out") outDir = value;
			else if (arg === "--prebuilt") prebuiltDir = resolve(value);
			else if (arg === "--distribution-version") distributionVersion = value;
			else if (arg === "--commit") commit = value;
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
	return { outDir: resolved, skipDeps, skipBuild, platforms: selected, prebuiltDir, distributionVersion, commit };
}

function writeJson(path, value) {
	writeFileSync(path, stableStringify(value));
}

function hostOs() {
	if (process.platform === "darwin") return "darwin";
	if (process.platform === "win32") return "windows";
	return "linux";
}

/**
 * Read the package metadata embedded into a compiled candidate by running
 * `<exe> --version` under an isolated HOME with PI_OFFLINE=1. Foreign
 * executables (Windows on Linux, macOS anywhere else, FreeBSD, arm64 on x64)
 * cannot run on the host; their presence and non-emptiness are asserted and
 * the manifest sha256 still binds their bytes.
 */
function probeCandidate(executablePath, platform) {
	assertExecutableAsset(executablePath, platform);
	const target = platformNativeInfo(platform);
	const runnable = target.os === hostOs() && target.arch === (process.arch === "arm64" ? "arm64" : "x64") && (target.libc ?? "gnu") !== "musl";
	if (!runnable) return undefined;
	const home = mkdtempSync(join(tmpdir(), "pi-release-probe-"));
	try {
		const version = run(executablePath, ["--version"], {
			capture: true,
			env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", PI_OFFLINE: "1", NODE_ENV: "production" },
		}).trim();
		if (!/^\d+\.\d+\.\d+-xz\.\d+\.\d+\.g[0-9a-f]{8}$/.test(version)) {
			throw new Error(`${platform} executable --version returned unexpected output: ${JSON.stringify(version)}`);
		}
		return version;
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

function main() {
	const { outDir, skipDeps, skipBuild, platforms, prebuiltDir, distributionVersion: requestedVersion, commit: requestedCommit } = parseArgs(process.argv);
	const rootPackageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	if (rootPackageJson.name !== "pi-monorepo") throw new Error("Run this script from the repository root");
	const entryPackageJson = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "coding-agent", "package.json"), "utf8"));
	const apiVersion = entryPackageJson.version;
	const distributionVersion = requestedVersion ?? forkDistributionVersion(apiVersion);
	if (!/^\d+\.\d+\.\d+-xz\.\d+\.\d+\.g[0-9a-f]{8}$/.test(distributionVersion)) {
		throw new Error(`Invalid distribution version: ${distributionVersion}`);
	}
	const commit = requestedCommit ?? resolveFullCommit();
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Invalid commit: ${commit}`);
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
	for (const platform of platforms) {
		const assetName = binaryArchiveName(platform);
		const executablePath = join(workDir, assetName);
		if (!existsSync(executablePath)) throw new Error(`Missing built release executable: ${executablePath}`);
		const probedVersion = probeCandidate(executablePath, platform);
		if (probedVersion !== undefined && probedVersion !== distributionVersion) {
			throw new Error(`${platform} executable reports ${probedVersion}, expected ${distributionVersion}`);
		}
		const destination = join(outDir, assetName);
		// --prebuilt inputs are matrix artifacts: copy so the input directory stays
		// intact for repeated local verification runs.
		if (prebuiltDir) copyFileSync(executablePath, destination);
		else renameSync(executablePath, destination);
		bundles[platform] = {
			file: assetName,
			bytes: readFileSync(destination).byteLength,
			sha256: sha256File(destination),
		};
	}

	// One release-level license notice for the whole dependency closure; the
	// single-file executables embed everything, so there is no per-target bundle
	// to carry it.
	run("node", [join(SCRIPT_DIR, "generate-third-party-notices.mjs"), join(outDir, NOTICES_FILENAME)], { cwd: REPO_ROOT });
	const notices = { file: NOTICES_FILENAME, bytes: readFileSync(join(outDir, NOTICES_FILENAME)).byteLength, sha256: sha256File(join(outDir, NOTICES_FILENAME)) };

	const manifest = {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		repository: REPOSITORY,
		tag,
		distributionVersion,
		apiVersion,
		commit,
		packaging: PACKAGING_BINARY,
		bundles,
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
	const checksummedAssets = [
		...Object.values(bundles).map((entry) => entry.file),
		MANIFEST_FILENAME,
		NOTICES_FILENAME,
	];
	const sumsPath = join(outDir, SUMS_FILENAME);
	writeFileSync(
		sumsPath,
		formatSha256Sums(checksummedAssets.map((file) => ({ file, sha256: sha256File(join(outDir, file)) }))),
	);
	const attestationSubjects = [...checksummedAssets, SUMS_FILENAME];
	const subjectsPath = join(outDir, ATTESTATION_SUBJECTS_FILENAME);
	writeFileSync(subjectsPath, `${attestationSubjects.join("\n")}\n`);

	writeFileSync(join(outDir, "version"), `${distributionVersion}\n`);
	writeFileSync(join(outDir, "tag"), `${tag}\n`);

	console.log(`Prepared GitHub Release ${tag} (${PACKAGING_BINARY})`);
	console.log(`Executables: ${platforms.length}`);
	console.log(`Notices: ${notices.sha256}`);
	console.log(manifestPath);
	console.log(sumsPath);
	console.log(subjectsPath);
}

main();
