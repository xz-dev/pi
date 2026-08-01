#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REGISTRY = "https://npm.pkg.github.com";

function runNpm(args, options = {}) {
	return spawnSync("npm", args, {
		encoding: "utf8",
		stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
	});
}

function readManifest(path) {
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	if (!manifest.version || !Array.isArray(manifest.packages) || manifest.packages.length === 0) {
		throw new Error("Invalid GitHub Packages release manifest");
	}
	return manifest;
}

function verifyTarball(pkg) {
	const data = readFileSync(pkg.tarball);
	const integrity = `sha512-${createHash("sha512").update(data).digest("base64")}`;
	if (integrity !== pkg.integrity) {
		throw new Error(`Tarball integrity mismatch for ${pkg.publishName}@${pkg.version}`);
	}
}

function readPublishedIntegrity(pkg) {
	const result = runNpm([
		"view",
		`${pkg.publishName}@${pkg.version}`,
		"dist.integrity",
		"--json",
		`--registry=${REGISTRY}`,
	]);
	if (result.status === 0) {
		return JSON.parse(result.stdout.trim());
	}
	const failure = `${result.stdout}\n${result.stderr}`;
	if (/E404|No match found|Not Found/.test(failure)) return undefined;
	throw new Error(`Could not inspect ${pkg.publishName}@${pkg.version}: ${failure.trim()}`);
}

function verifyPublishedPackage(pkg) {
	const publishedIntegrity = readPublishedIntegrity(pkg);
	if (publishedIntegrity === undefined) return false;
	if (publishedIntegrity !== pkg.integrity) {
		throw new Error(`Published integrity mismatch for ${pkg.publishName}@${pkg.version}`);
	}
	return true;
}

function waitForPublishedPackage(pkg) {
	for (let attempt = 1; attempt <= 10; attempt += 1) {
		if (verifyPublishedPackage(pkg)) return;
		if (attempt < 10) spawnSync("sleep", ["3"], { stdio: "inherit" });
	}
	throw new Error(`${pkg.publishName}@${pkg.version} did not become readable from ${REGISTRY}`);
}

const [mode, manifestPath] = process.argv.slice(2);
if (!manifestPath || !["support", "entry"].includes(mode)) {
	throw new Error("Usage: node scripts/publish-github-packages.mjs <support|entry> <release-manifest.json>");
}

const manifest = readManifest(manifestPath);
for (const pkg of manifest.packages) verifyTarball(pkg);
for (const pkg of manifest.packages) verifyPublishedPackage(pkg);

const selected = manifest.packages.filter((pkg) => (mode === "entry" ? pkg.entry : !pkg.entry));
if (mode === "entry" && selected.length !== 1) {
	throw new Error("Release manifest must contain exactly one entry package");
}
for (const pkg of selected) {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		if (verifyPublishedPackage(pkg)) break;
		const result = runNpm(["publish", pkg.tarball, `--registry=${REGISTRY}`, "--access", "public"], {
			inherit: true,
		});
		if (result.status === 0 || verifyPublishedPackage(pkg)) break;
		if (attempt === 3) {
			throw new Error(`Could not publish ${pkg.publishName}@${pkg.version}`);
		}
		spawnSync("sleep", ["3"], { stdio: "inherit" });
	}
	waitForPublishedPackage(pkg);
}
