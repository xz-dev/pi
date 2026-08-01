#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { globSync } from "glob";

const SOURCE_SCOPE = "@earendil-works/";
const INTERNAL_PACKAGE_PREFIX = `${SOURCE_SCOPE}pi-`;
const PUBLISH_SCOPE = "@xz-dev/";
const ENTRY_PACKAGE = "@earendil-works/pi-coding-agent";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	}
	return result.stdout ?? "";
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, undefined, "\t")}\n`);
}

function discoverWorkspacePackages(repoRoot, workspacePatterns) {
	const packageJsonPaths = globSync(
		workspacePatterns.map((pattern) => `${pattern}/package.json`),
		{ absolute: true, cwd: repoRoot, nodir: true },
	).sort();
	const discovered = new Map();
	for (const packageJsonPath of packageJsonPaths) {
		const packageJson = readJson(packageJsonPath);
		if (typeof packageJson.name !== "string") continue;
		if (discovered.has(packageJson.name)) {
			throw new Error(`Duplicate workspace package ${packageJson.name}`);
		}
		discovered.set(packageJson.name, {
			directory: relative(repoRoot, dirname(packageJsonPath)),
			packageJson,
		});
	}
	return discovered;
}

function packageDependencies(packageJson) {
	return [
		...Object.keys(packageJson.dependencies ?? {}),
		...Object.keys(packageJson.peerDependencies ?? {}),
		...Object.keys(packageJson.optionalDependencies ?? {}),
	].sort();
}

function resolvePublishedPackages(repoRoot, workspacePatterns) {
	const discovered = discoverWorkspacePackages(repoRoot, workspacePatterns);
	const resolved = [];
	const resolving = new Set();
	const resolvedNames = new Set();

	const visit = (sourceName) => {
		if (resolvedNames.has(sourceName)) return;
		if (resolving.has(sourceName)) {
			throw new Error(`Circular internal package dependency involving ${sourceName}`);
		}
		const discoveredPackage = discovered.get(sourceName);
		if (!discoveredPackage || discoveredPackage.packageJson.private) {
			throw new Error(`${sourceName} is required but is not a publishable workspace package`);
		}

		resolving.add(sourceName);
		for (const dependencyName of packageDependencies(discoveredPackage.packageJson)) {
			if (discovered.has(dependencyName)) {
				visit(dependencyName);
			} else if (dependencyName.startsWith(INTERNAL_PACKAGE_PREFIX)) {
				throw new Error(`${sourceName} depends on unresolved internal package ${dependencyName}`);
			}
		}
		resolving.delete(sourceName);
		resolvedNames.add(sourceName);
		resolved.push({
			directory: discoveredPackage.directory,
			sourceName,
			publishName: `${PUBLISH_SCOPE}${sourceName.slice(SOURCE_SCOPE.length)}`,
		});
	};

	visit(ENTRY_PACKAGE);
	return resolved;
}

function parseArgs() {
	const args = process.argv.slice(2);
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
		throw new Error("Usage: node scripts/prepare-github-packages.mjs --out <dir>");
	}
	return { outDir: resolve(outDir) };
}

function forkVersion(baseVersion) {
	const runNumber = process.env.GITHUB_RUN_NUMBER ?? "0";
	let sha = process.env.GITHUB_SHA;
	if (!sha) {
		sha = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
	}
	return `${baseVersion}-xz.${runNumber}.1.g${sha.slice(0, 8)}`;
}

function rewriteInternalDependencies(dependencies, version, packageIndex, sourceName, packages, packageIndexes) {
	if (!dependencies) return dependencies;
	const rewritten = { ...dependencies };
	for (const dependencyName of Object.keys(rewritten)) {
		const dependencyIndex = packageIndexes.get(dependencyName);
		if (dependencyIndex === undefined) {
			if (dependencyName.startsWith(INTERNAL_PACKAGE_PREFIX)) {
				throw new Error(`${sourceName} depends on unpublished internal package ${dependencyName}`);
			}
			continue;
		}
		const dependencyPackage = packages[dependencyIndex];
		if (dependencyIndex >= packageIndex) {
			throw new Error(`${dependencyName} must be published before ${sourceName}`);
		}
		rewritten[dependencyName] = `npm:${dependencyPackage.publishName}@${version}`;
	}
	return rewritten;
}

function preparePackage(pkg, packageIndex, version, workDir, packages, packageIndexes) {
	const packageDir = join(workDir, pkg.directory);
	cpSync(pkg.directory, packageDir, {
		recursive: true,
		filter: (source) => !source.includes("node_modules"),
	});

	const packageJsonPath = join(packageDir, "package.json");
	const packageJson = readJson(packageJsonPath);
	if (packageJson.name !== pkg.sourceName) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.sourceName}`);
	}

	packageJson.name = pkg.publishName;
	packageJson.version = version;
	packageJson.piConfig = {
		...packageJson.piConfig,
		changelogVersion: packageJson.piConfig?.changelogVersion ?? baseVersion,
	};
	packageJson.repository = {
		type: "git",
		url: "git+https://github.com/xz-dev/pi.git",
		directory: pkg.directory,
	};
	packageJson.bugs = {
		url: "https://github.com/xz-dev/pi/issues",
	};
	packageJson.homepage = "https://github.com/xz-dev/pi#readme";
	packageJson.publishConfig = {
		registry: "https://npm.pkg.github.com",
	};
	packageJson.dependencies = rewriteInternalDependencies(
		packageJson.dependencies,
		version,
		packageIndex,
		pkg.sourceName,
		packages,
		packageIndexes,
	);
	packageJson.peerDependencies = rewriteInternalDependencies(
		packageJson.peerDependencies,
		version,
		packageIndex,
		pkg.sourceName,
		packages,
		packageIndexes,
	);
	packageJson.optionalDependencies = rewriteInternalDependencies(
		packageJson.optionalDependencies,
		version,
		packageIndex,
		pkg.sourceName,
		packages,
		packageIndexes,
	);

	if (pkg.sourceName === ENTRY_PACKAGE) {
		packageJson.files = packageJson.files?.filter((file) => file !== "npm-shrinkwrap.json");
		rmSync(join(packageDir, "npm-shrinkwrap.json"), { force: true });
	}

	writeJson(packageJsonPath, packageJson);
	return packageDir;
}

const { outDir } = parseArgs();
const repoRoot = process.cwd();
const rootPackageJson = readJson(join(repoRoot, "package.json"));
if (rootPackageJson.name !== "pi-monorepo") {
	throw new Error("Run this script from the repository root");
}
if (!Array.isArray(rootPackageJson.workspaces)) {
	throw new Error("Root package.json must declare workspaces");
}

const packages = resolvePublishedPackages(repoRoot, rootPackageJson.workspaces);
const packageIndexes = new Map(packages.map((pkg, index) => [pkg.sourceName, index]));
const baseVersion = readJson(join(repoRoot, "packages/coding-agent/package.json")).version;
const version = forkVersion(baseVersion);
const workDir = join(outDir, "work");
const tarballDir = join(outDir, "tarballs");
rmSync(outDir, { force: true, recursive: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(tarballDir, { recursive: true });

const releasePackages = [];
for (const [packageIndex, pkg] of packages.entries()) {
	const packageDir = preparePackage(pkg, packageIndex, version, workDir, packages, packageIndexes);
	const output = run("npm", ["pack", "--json", "--pack-destination", tarballDir], { capture: true, cwd: packageDir });
	const packResult = JSON.parse(output);
	const packed = Array.isArray(packResult) ? packResult[0] : packResult[pkg.publishName];
	if (!packed?.filename || !packed.integrity) {
		throw new Error(`npm pack returned incomplete metadata for ${pkg.publishName}`);
	}
	releasePackages.push({
		sourceName: pkg.sourceName,
		publishName: pkg.publishName,
		version,
		tarball: join(tarballDir, packed.filename),
		integrity: packed.integrity,
		entry: pkg.sourceName === ENTRY_PACKAGE,
	});
}

const entryPackage = releasePackages.find((pkg) => pkg.entry);
if (!entryPackage || releasePackages.at(-1) !== entryPackage) {
	throw new Error("Coding-agent must be the final release package");
}
writeFileSync(join(outDir, "version"), `${version}\n`);
writeFileSync(join(outDir, "publish-order.txt"), `${releasePackages.map((pkg) => pkg.tarball).join("\n")}\n`);
writeFileSync(join(outDir, "entry-tarball"), `${entryPackage.tarball}\n`);
writeJson(join(outDir, "release-manifest.json"), { version, packages: releasePackages });
console.log(`Prepared GitHub Packages version ${version}`);
for (const pkg of releasePackages) {
	console.log(pkg.tarball);
}
