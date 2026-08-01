#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	}
}

function readManifest(path) {
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	if (!manifest.version || !Array.isArray(manifest.packages)) {
		throw new Error("Invalid GitHub Packages release manifest");
	}
	const entries = manifest.packages.filter((pkg) => pkg.entry);
	if (entries.length !== 1) {
		throw new Error("Release manifest must contain exactly one entry package");
	}
	return { ...manifest, entry: entries[0] };
}

const [mode, manifestPath] = process.argv.slice(2);
if (!manifestPath || !["local", "support-registry", "registry"].includes(mode)) {
	throw new Error(
		"Usage: node scripts/verify-github-packages.mjs <local|support-registry|registry> <release-manifest.json>",
	);
}

const manifest = readManifest(manifestPath);
const installDirectory = mkdtempSync(join(tmpdir(), "pi-github-packages-install-"));
try {
	let packageJson;
	if (mode === "local") {
		const overrides = Object.fromEntries(
			manifest.packages.map((pkg) => [pkg.sourceName, pathToFileURL(pkg.tarball).href]),
		);
		packageJson = {
			private: true,
			dependencies: { [manifest.entry.publishName]: pathToFileURL(manifest.entry.tarball).href },
			overrides,
		};
	} else if (mode === "support-registry") {
		packageJson = {
			private: true,
			dependencies: { [manifest.entry.publishName]: pathToFileURL(manifest.entry.tarball).href },
		};
	} else {
		packageJson = {
			private: true,
			dependencies: { [manifest.entry.publishName]: manifest.version },
		};
	}
	writeFileSync(join(installDirectory, "package.json"), `${JSON.stringify(packageJson, undefined, "\t")}\n`);
	run("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: installDirectory });
	const executable = process.platform === "win32" ? "pi.cmd" : "pi";
	run(join(installDirectory, "node_modules", ".bin", executable), ["--version"], { cwd: installDirectory });
} finally {
	rmSync(installDirectory, { force: true, recursive: true });
}
