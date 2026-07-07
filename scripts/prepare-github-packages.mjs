#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packages = [
	{ directory: "packages/ai", sourceName: "@earendil-works/pi-ai", publishName: "@xz-dev/pi-ai" },
	{ directory: "packages/tui", sourceName: "@earendil-works/pi-tui", publishName: "@xz-dev/pi-tui" },
	{ directory: "packages/agent", sourceName: "@earendil-works/pi-agent-core", publishName: "@xz-dev/pi-agent-core" },
	{ directory: "packages/coding-agent", sourceName: "@earendil-works/pi-coding-agent", publishName: "@xz-dev/pi-coding-agent" },
];

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
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
	let sha = process.env.GITHUB_SHA;
	if (!sha) {
		sha = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
	}
	return `${baseVersion}-xz.${runNumber}.${runAttempt}.g${sha.slice(0, 8)}`;
}

function rewriteInternalDependencies(dependencies, version) {
	if (!dependencies) return dependencies;
	const rewritten = { ...dependencies };
	for (const pkg of packages) {
		if (rewritten[pkg.sourceName]) {
			rewritten[pkg.sourceName] = `npm:${pkg.publishName}@${version}`;
		}
	}
	return rewritten;
}

function preparePackage(pkg, version, workDir) {
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
	packageJson.dependencies = rewriteInternalDependencies(packageJson.dependencies, version);
	packageJson.peerDependencies = rewriteInternalDependencies(packageJson.peerDependencies, version);
	packageJson.optionalDependencies = rewriteInternalDependencies(packageJson.optionalDependencies, version);

	if (pkg.sourceName === "@earendil-works/pi-coding-agent") {
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

const baseVersion = readJson(join(repoRoot, "packages/coding-agent/package.json")).version;
const version = forkVersion(baseVersion);
const workDir = join(outDir, "work");
const tarballDir = join(outDir, "tarballs");
rmSync(outDir, { force: true, recursive: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(tarballDir, { recursive: true });

const tarballs = [];
for (const pkg of packages) {
	const packageDir = preparePackage(pkg, version, workDir);
	const output = run("npm", ["pack", "--json", "--pack-destination", tarballDir], { capture: true, cwd: packageDir });
	const packed = JSON.parse(output)[0];
	tarballs.push(join(tarballDir, packed.filename));
}

writeFileSync(join(outDir, "version"), `${version}\n`);
writeFileSync(join(outDir, "publish-order.txt"), `${tarballs.join("\n")}\n`);
console.log(`Prepared GitHub Packages version ${version}`);
for (const tarball of tarballs) {
	console.log(tarball);
}
