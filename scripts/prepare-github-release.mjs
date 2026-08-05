#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	INSTALL_PS1_FILENAME,
	INSTALL_SH_FILENAME,
	INSTALL_TS_FILENAME,
	releaseDownloadBaseUrl,
	writeInstallBootstrap,
} from "./generate-install-bootstrap.mjs";
import {
	ATTESTATION_SIGNER_REF,
	ATTESTATION_SIGNER_WORKFLOW,
	ATTESTATION_SUBJECTS_FILENAME,
	DISTRIBUTION,
	ENTRY_PACKAGE,
	MANIFEST_SCHEMA_VERSION,
	NETWORK_POLICY_EXTERNAL_OPTIONAL_ONLY,
	PACKAGING_HYBRID,
	REPOSITORY,
	assertExternalOptionalNodeModulesAbsent,
	assertExternalOptionalSpecsAreRegistry,
	assertInstallLifecycleScriptsAllowed,
	assertNoPlatformSpecificNodeModules,
	buildExternalOptionalPolicy,
	collectInstallLifecycleScripts,
	forkDistributionVersion,
	formatSha256Sums,
	listTopLevelNodeModulesPackages,
	localInternalDependencyPath,
	minimumNodeVersionFromEngines,
	readJson,
	removeExternalOptionalNodeModules,
	removePlatformSpecificNodeModules,
	resolveFullCommit,
	resolveInternalClosure,
	rewriteDependencyMap,
	run,
	sha256File,
	sha512Integrity,
	stableStringify,
	tarballBasename,
} from "./lib/github-release.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const args = argv.slice(2);
	let outDir;
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === "--out") {
			outDir = args[i + 1];
			i += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${args[i]}`);
	}
	if (!outDir) {
		throw new Error("Usage: node scripts/prepare-github-release.mjs --out <dir>");
	}
	const resolved = resolve(outDir);
	const root = resolve(process.cwd());
	const relativeToRoot = relative(root, resolved);
	const rootRelativeToOutput = relative(resolved, root);
	const outputInsideRoot = relativeToRoot === "" || (!relativeToRoot.startsWith(`..${sep}`) && relativeToRoot !== "..");
	const outputContainsRoot = rootRelativeToOutput === "" ||
		(!rootRelativeToOutput.startsWith(`..${sep}`) && rootRelativeToOutput !== "..");
	if (outputInsideRoot || outputContainsRoot) {
		throw new Error("Release output directory must be an external temporary directory");
	}
	return { outDir: resolved };
}

function writeJson(path, value) {
	writeFileSync(path, stableStringify(value));
}

function packWorkspacePackage(packageDir, destinationDir) {
	const output = run("npm", ["pack", "--json", "--pack-destination", destinationDir], {
		capture: true,
		cwd: packageDir,
	});
	const packResult = JSON.parse(output);
	const packed = Array.isArray(packResult) ? packResult[0] : packResult;
	if (!packed?.filename) {
		throw new Error(`npm pack returned incomplete metadata for ${packageDir}`);
	}
	return {
		filename: packed.filename,
		path: join(destinationDir, packed.filename),
		integrity: packed.integrity,
	};
}

function extractTarball(tarballPath, destinationDir) {
	mkdirSync(destinationDir, { recursive: true });
	const result = spawnSync("tar", ["-xzf", tarballPath, "-C", destinationDir], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`Failed to extract ${tarballPath}: ${result.stderr || result.stdout}`);
	}
}

function fileSpecifier(fromDirectory, absoluteFile) {
	const relativePath = relative(fromDirectory, absoluteFile).replaceAll("\\", "/");
	return `file:${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}`;
}

function rewriteInternalSpecs(dependencies, internalNames) {
	return rewriteDependencyMap(dependencies, (name) => {
		if (!internalNames.has(name)) return undefined;
		return localInternalDependencyPath(name);
	});
}

function rewriteInternalToTarballSpecs(dependencies, internalTarballs, fromDirectory) {
	return rewriteDependencyMap(dependencies, (name) => {
		const tarball = internalTarballs.get(name);
		if (!tarball) return undefined;
		return fileSpecifier(fromDirectory, tarball.path);
	});
}

function assertNoForbiddenPackageFields(packageJson) {
	const blob = JSON.stringify(packageJson);
	if (blob.includes("@xz-dev/")) {
		throw new Error("Prepared package.json still references @xz-dev/*");
	}
	if (blob.includes("npm.pkg.github.com")) {
		throw new Error("Prepared package.json still references npm.pkg.github.com");
	}
	if (packageJson.publishConfig?.registry) {
		throw new Error("Prepared package.json must not set publishConfig.registry");
	}
}

function buildInternalOverrides(internalNames) {
	return Object.fromEntries(
		[...internalNames].sort().map((name) => [name, localInternalDependencyPath(name)]),
	);
}

function byteLength(path) {
	return readFileSync(path).byteLength;
}

function main() {
	const { outDir } = parseArgs(process.argv);
	const repoRoot = process.cwd();
	const rootPackageJson = readJson(join(repoRoot, "package.json"));
	if (rootPackageJson.name !== "pi-monorepo") {
		throw new Error("Run this script from the repository root");
	}
	if (!Array.isArray(rootPackageJson.workspaces)) {
		throw new Error("Root package.json must declare workspaces");
	}

	const packages = resolveInternalClosure(repoRoot, rootPackageJson.workspaces, ENTRY_PACKAGE);
	const entry = packages.find((pkg) => pkg.sourceName === ENTRY_PACKAGE);
	if (!entry || packages.at(-1) !== entry) {
		throw new Error("Coding-agent must be the final package in the internal closure");
	}

	const baseVersion = entry.packageJson.version;
	const distributionVersion = forkDistributionVersion(baseVersion);
	const commit = resolveFullCommit();
	const tag = `xz-v${distributionVersion}`;
	const internalNames = new Set(packages.map((pkg) => pkg.sourceName));

	rmSync(outDir, { force: true, recursive: true });
	const workDir = join(outDir, "work");
	const internalTarballDir = join(workDir, "internal-tarballs");
	const packageDir = join(workDir, "package");
	mkdirSync(internalTarballDir, { recursive: true });

	const internalTarballs = new Map();
	for (const pkg of packages) {
		const absolutePackageDir = join(repoRoot, pkg.directory);
		if (pkg.sourceName === ENTRY_PACKAGE && !existsSync(join(absolutePackageDir, "dist", "cli.js"))) {
			throw new Error(
				`${pkg.directory}/dist/cli.js is missing; build packages before prepare-github-release`,
			);
		}
		const packed = packWorkspacePackage(absolutePackageDir, internalTarballDir);
		internalTarballs.set(pkg.sourceName, {
			...packed,
			sourceName: pkg.sourceName,
			directory: pkg.directory,
		});
	}

	const entryTarball = internalTarballs.get(ENTRY_PACKAGE);
	extractTarball(entryTarball.path, workDir);
	if (!existsSync(join(packageDir, "package.json"))) {
		throw new Error("Extracted entry tarball did not produce work/package/package.json");
	}

	const stagePackageJsonPath = join(packageDir, "package.json");
	const stagePackageJson = readJson(stagePackageJsonPath);

	// Point internal deps at sibling packed tarballs for a closed stage install.
	stagePackageJson.dependencies = rewriteInternalToTarballSpecs(
		stagePackageJson.dependencies,
		internalTarballs,
		packageDir,
	);
	// Keep external optionalDependencies as registry version pins so stage install
	// can materialize portable optional parents; platform natives are stripped later.
	stagePackageJson.optionalDependencies = rewriteInternalToTarballSpecs(
		stagePackageJson.optionalDependencies,
		internalTarballs,
		packageDir,
	);
	stagePackageJson.peerDependencies = rewriteInternalToTarballSpecs(
		stagePackageJson.peerDependencies,
		internalTarballs,
		packageDir,
	);

	// Ensure every internal package is a direct dependency so bodies materialize under node_modules.
	stagePackageJson.dependencies = {
		...(stagePackageJson.dependencies ?? {}),
		...Object.fromEntries(
			[...internalTarballs.entries()]
				.filter(([name]) => name !== ENTRY_PACKAGE)
				.map(([name, tarball]) => [name, fileSpecifier(packageDir, tarball.path)]),
		),
	};
	stagePackageJson.overrides = {
		...(stagePackageJson.overrides ?? {}),
		...Object.fromEntries(
			[...internalTarballs.entries()].map(([name, tarball]) => [
				name,
				fileSpecifier(packageDir, tarball.path),
			]),
		),
	};
	delete stagePackageJson.devDependencies;
	writeJson(stagePackageJsonPath, stagePackageJson);

	// Stage install still uses --ignore-scripts for safety, but the final hybrid
	// tree is scanned for install lifecycle scripts and non-allowlisted ones fail.
	run("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: packageDir });

	const nodeModulesDir = join(packageDir, "node_modules");
	const stagedExternalOptional = buildExternalOptionalPolicy(stagePackageJson, internalNames);
	// External optional parents and their complete subtrees must be target-resolved.
	// Bundling the portable parent prevents npm/Bun from fetching its native child.
	const removedExternalOptional = removeExternalOptionalNodeModules(
		nodeModulesDir,
		stagedExternalOptional.allowedNetworkPackages,
	);
	assertExternalOptionalNodeModulesAbsent(
		nodeModulesDir,
		stagedExternalOptional.allowedNetworkPackages,
	);
	// Also reject any unrelated host-selected platform package left elsewhere.
	const removedPlatform = removePlatformSpecificNodeModules(nodeModulesDir);
	assertNoPlatformSpecificNodeModules(nodeModulesDir);

	const lifecycleFindings = collectInstallLifecycleScripts(packageDir);
	const allowedLifecycle = assertInstallLifecycleScriptsAllowed(lifecycleFindings);

	// Rewrite to local bundled paths so Bun never resolves unpublished internal packages.
	const finalPackageJson = readJson(stagePackageJsonPath);
	finalPackageJson.name = ENTRY_PACKAGE;
	finalPackageJson.version = distributionVersion;
	finalPackageJson.piConfig = {
		...(finalPackageJson.piConfig ?? {}),
		changelogVersion: finalPackageJson.piConfig?.changelogVersion ?? baseVersion,
		distribution: DISTRIBUTION,
	};
	finalPackageJson.repository = {
		type: "git",
		url: `git+https://github.com/${REPOSITORY}.git`,
		directory: entry.directory,
	};
	finalPackageJson.bugs = { url: `https://github.com/${REPOSITORY}/issues` };
	finalPackageJson.homepage = `https://github.com/${REPOSITORY}#readme`;
	delete finalPackageJson.publishConfig;

	finalPackageJson.dependencies = rewriteInternalSpecs(finalPackageJson.dependencies, internalNames);
	// Internal optionals become local file: paths; external optionals stay registry pins.
	finalPackageJson.optionalDependencies = rewriteInternalSpecs(
		finalPackageJson.optionalDependencies,
		internalNames,
	);
	finalPackageJson.peerDependencies = rewriteInternalSpecs(finalPackageJson.peerDependencies, internalNames);
	assertExternalOptionalSpecsAreRegistry(finalPackageJson, internalNames);

	const preservedOverrides = { ...(finalPackageJson.overrides ?? {}) };
	for (const name of Object.keys(preservedOverrides)) {
		if (internalNames.has(name)) {
			delete preservedOverrides[name];
		}
	}
	finalPackageJson.overrides = {
		...preservedOverrides,
		...buildInternalOverrides(internalNames),
	};

	const bundled = listTopLevelNodeModulesPackages(nodeModulesDir);
	if (bundled.length === 0) {
		throw new Error("Stage install produced an empty node_modules tree");
	}
	for (const name of internalNames) {
		if (name === ENTRY_PACKAGE) continue;
		if (!bundled.includes(name)) {
			throw new Error(`Internal package ${name} missing from bundled node_modules`);
		}
		if (!existsSync(join(nodeModulesDir, ...name.split("/"), "package.json"))) {
			throw new Error(`Internal package ${name} is missing package.json under node_modules`);
		}
	}
	// Platform packages must never appear in the hybrid bundle list.
	for (const name of bundled) {
		const nestedPath = join(nodeModulesDir, ...name.split("/"), "package.json");
		if (!existsSync(nestedPath)) continue;
		const nestedJson = readJson(nestedPath);
		if (nestedJson.os || nestedJson.cpu || nestedJson.libc) {
			throw new Error(`bundledDependencies would include platform package ${name}`);
		}
	}
	finalPackageJson.bundledDependencies = bundled;
	if (Array.isArray(finalPackageJson.files)) {
		finalPackageJson.files = finalPackageJson.files.filter((file) => file !== "npm-shrinkwrap.json");
	}
	assertNoForbiddenPackageFields(finalPackageJson);
	writeJson(stagePackageJsonPath, finalPackageJson);

	const externalOptional = buildExternalOptionalPolicy(finalPackageJson, internalNames);

	// Drop lockfiles that may embed absolute file: resolved paths from the stage install.
	for (const lockName of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]) {
		rmSync(join(packageDir, lockName), { force: true });
	}

	// Packaging contamination checks only. Runtime self-update is supplied by the
	// separate patch branch; docs/examples/CHANGELOG path strings are not package metadata.
	const rootPackageBlob = readFileSync(stagePackageJsonPath, "utf8");
	if (rootPackageBlob.includes("@xz-dev/") || rootPackageBlob.includes("npm.pkg.github.com")) {
		throw new Error("Root package.json contains forbidden registry/scope markers");
	}
	if (/file:\/[^.]|file:[A-Za-z]:\\/.test(rootPackageBlob)) {
		throw new Error("Root package.json contains absolute file: dependency specs");
	}

	for (const name of internalNames) {
		if (name === ENTRY_PACKAGE) continue;
		const nestedPackageJsonPath = join(nodeModulesDir, ...name.split("/"), "package.json");
		const nested = readFileSync(nestedPackageJsonPath, "utf8");
		if (nested.includes("@xz-dev/") || nested.includes("npm.pkg.github.com")) {
			throw new Error(`Nested package ${name} contains forbidden registry/scope markers`);
		}
		if (/file:\/(?:home|Users|tmp)|file:[A-Za-z]:\\/.test(nested)) {
			throw new Error(`Nested package ${name} contains absolute file: dependency specs`);
		}
	}

	// Avoid `npm pack --json` here: the hybrid tree's file listing exceeds spawn maxBuffer.
	const expectedName = tarballBasename(ENTRY_PACKAGE, distributionVersion);
	const packagePath = join(outDir, expectedName);
	rmSync(packagePath, { force: true });
	run("npm", ["pack", "--pack-destination", outDir], { cwd: packageDir });
	if (!existsSync(packagePath)) {
		throw new Error(`npm pack did not produce ${expectedName}`);
	}
	const packageSha256 = sha256File(packagePath);
	const packageBytes = byteLength(packagePath);
	const packageIntegrity = sha512Integrity(packagePath);

	// Authoritative transaction installer asset (erasable TypeScript).
	const installTsSource = join(SCRIPT_DIR, INSTALL_TS_FILENAME);
	if (!existsSync(installTsSource)) {
		throw new Error(`Missing installer source: ${installTsSource}`);
	}
	const installTsPath = join(outDir, INSTALL_TS_FILENAME);
	copyFileSync(installTsSource, installTsPath);
	const installTsBytes = byteLength(installTsPath);
	const installTsSha256 = sha256File(installTsPath);

	const minimumNodeVersion = minimumNodeVersionFromEngines(finalPackageJson.engines);
	const bootstrapBaseUrl = releaseDownloadBaseUrl(tag, REPOSITORY);

	// Manifest must be frozen before bootstrap generation so install.sh/ps1 can embed its
	// exact sha256. Bootstrap script content hashes therefore live in SHA256SUMS (and the
	// bootstrap.files field lists names only) to avoid a circular digest.
	const manifest = {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		repository: REPOSITORY,
		tag,
		distributionVersion,
		apiVersion: baseVersion,
		commit,
		minimumNodeVersion,
		package: {
			name: ENTRY_PACKAGE,
			file: expectedName,
			bytes: packageBytes,
			sha256: packageSha256,
			integrity: packageIntegrity,
			bundled: true,
			packaging: PACKAGING_HYBRID,
			networkPolicy: NETWORK_POLICY_EXTERNAL_OPTIONAL_ONLY,
			externalOptionalDependencies: externalOptional.packages,
			allowedNetworkPackages: externalOptional.allowedNetworkPackages,
			allowedNetworkPackagePrefixes: externalOptional.allowedNetworkPackagePrefixes,
		},
		installer: {
			file: INSTALL_TS_FILENAME,
			bytes: installTsBytes,
			sha256: installTsSha256,
		},
		attestation: {
			repository: REPOSITORY,
			signerWorkflow: `${REPOSITORY}/${ATTESTATION_SIGNER_WORKFLOW}`,
			signerRef: ATTESTATION_SIGNER_REF,
			denySelfHostedRunners: true,
			subjectsFile: ATTESTATION_SUBJECTS_FILENAME,
		},
		bootstrap: {
			tag,
			baseUrl: bootstrapBaseUrl,
			minimumNodeVersion,
			files: {
				sh: INSTALL_SH_FILENAME,
				ps1: INSTALL_PS1_FILENAME,
			},
		},
	};
	const manifestPath = join(outDir, "release-manifest.json");
	writeJson(manifestPath, manifest);
	const manifestSha256 = sha256File(manifestPath);

	const bootstrap = writeInstallBootstrap(outDir, {
		tag,
		baseUrl: bootstrapBaseUrl,
		manifestSha256,
		installTsSha256,
		installTsBytes,
		minimumNodeVersion,
	});

	const assetEntries = [
		{ file: expectedName, path: packagePath },
		{ file: "release-manifest.json", path: manifestPath },
		{ file: INSTALL_TS_FILENAME, path: installTsPath },
		{ file: INSTALL_SH_FILENAME, path: bootstrap.sh.path },
		{ file: INSTALL_PS1_FILENAME, path: bootstrap.ps1.path },
	].map((entry) => ({
		file: entry.file,
		sha256: sha256File(entry.path),
	}));
	const sha256SumsPath = join(outDir, "SHA256SUMS");
	writeFileSync(sha256SumsPath, formatSha256Sums(assetEntries));
	const attestationSubjects = [
		expectedName,
		"release-manifest.json",
		INSTALL_TS_FILENAME,
		INSTALL_SH_FILENAME,
		INSTALL_PS1_FILENAME,
		"SHA256SUMS",
	];
	const attestationSubjectsPath = join(outDir, ATTESTATION_SUBJECTS_FILENAME);
	writeFileSync(attestationSubjectsPath, `${attestationSubjects.join("\n")}\n`);

	if (manifest.package.sha256 !== sha256File(packagePath)) {
		throw new Error("Manifest package sha256 drifted from final asset");
	}
	if (manifest.installer.sha256 !== sha256File(installTsPath)) {
		throw new Error("Manifest installer sha256 drifted from final install.ts");
	}
	if (manifestSha256 !== sha256File(manifestPath)) {
		throw new Error("release-manifest.json changed after bootstrap pin");
	}

	writeFileSync(join(outDir, "version"), `${distributionVersion}\n`);
	writeFileSync(join(outDir, "tag"), `${tag}\n`);

	console.log(`Prepared GitHub Release ${tag} (${PACKAGING_HYBRID})`);
	console.log(`Removed external optional parents: ${removedExternalOptional.length}`);
	console.log(`Removed platform-specific packages: ${removedPlatform.length}`);
	console.log(`Allowlisted install lifecycle packages: ${allowedLifecycle.join(", ") || "(none)"}`);
	console.log(
		`External optional (target network): ${JSON.stringify(externalOptional.packages)}`,
	);
	console.log(packagePath);
	console.log(manifestPath);
	console.log(installTsPath);
	console.log(bootstrap.sh.path);
	console.log(bootstrap.ps1.path);
	console.log(sha256SumsPath);
	console.log(attestationSubjectsPath);
}

main();
