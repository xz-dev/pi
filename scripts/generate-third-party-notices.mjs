#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [rootArg, outputArg, lockArg] = process.argv.slice(2);
if (!rootArg || !outputArg) throw new Error("Usage: generate-third-party-notices.mjs <bundle-root> <output> [package-lock.json]");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(rootArg);
const output = resolve(outputArg);
const lockPath = resolve(lockArg ?? join(repoRoot, "package-lock.json"));
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if (lock.lockfileVersion !== 3 || !lock.packages?.["packages/coding-agent"]) throw new Error("Unsupported package lock");
const workspaceByName = new Map(Object.entries(lock.packages).filter(([path, value]) => path && !path.startsWith("node_modules/") && value.name).map(([path, value]) => [value.name, path]));
// npm node resolution: resolve <name> against the nearest node_modules/<name> walking up from the requiring package,
// following workspace link markers to their real lockfile path. Never flatten to a top-level version.
const resolveDependency = (parentPath, name) => {
	let current = parentPath;
	while (true) {
		const candidate = current ? `${current}/node_modules/${name}` : `node_modules/${name}`;
		const metadata = lock.packages[candidate];
		if (metadata && !metadata.extraneous) {
			if (metadata.link) return metadata.resolved ?? workspaceByName.get(name);
			return candidate;
		}
		if (!current) break;
		const slash = current.lastIndexOf("/");
		current = slash === -1 ? "" : current.slice(0, slash);
	}
	return workspaceByName.get(name);
};
const closure = new Set();
const pending = [["packages/coding-agent", ""]];
while (pending.length > 0) {
	const [path, requiredBy] = pending.shift();
	if (closure.has(path)) continue;
	closure.add(path);
	const metadata = lock.packages[path];
	if (!metadata) throw new Error(`Runtime dependency missing from exact lockfile: ${path} (required by ${requiredBy || "packages/coding-agent"})`);
	for (const name of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies })) {
		const resolved = resolveDependency(path, name);
		if (!resolved) throw new Error(`Runtime dependency ${name} (required by ${path}) missing from exact lockfile`);
		pending.push([resolved, path]);
	}
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packageName = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
const packages = [...closure].filter((path) => path.startsWith("node_modules/")).map((path) => {
	const metadata = lock.packages[path];
	if (!metadata.version || typeof metadata.license !== "string") throw new Error(`Incomplete locked license metadata: ${path}`);
	return { path, name: packageName(path), version: metadata.version, license: metadata.license, sourceDirectory: join(repoRoot, path) };
}).sort((a, b) => `${a.path}@${a.version}`.localeCompare(`${b.path}@${b.version}`));
if (packages.length === 0) throw new Error("No locked runtime dependencies found");
const nativeRoot = join(root, "node_modules", "@mariozechner");
const nativePackages = ["@mariozechner/clipboard", ...(existsSync(nativeRoot) ? readdirSync(nativeRoot).filter((name) => name.startsWith("clipboard-") && existsSync(join(nativeRoot, name, "package.json"))).map((name) => `@mariozechner/${name}`) : [])].sort();
for (const name of nativePackages) if (!packages.some((entry) => entry.name === name)) {
	const metadata = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
	if (!metadata.version || !metadata.license) throw new Error(`Incomplete packaged native metadata: ${name}`);
	packages.push({ path: `node_modules/${name}`, name, version: metadata.version, license: metadata.license, packagedNative: true, sourceDirectory: join(root, "node_modules", name) });
}
packages.sort((a, b) => `${a.path}@${a.version}`.localeCompare(`${b.path}@${b.version}`));
const legalFilePattern = /^(?:licen[cs]e|copying|notice)(?:$|[-_.].*)/iu;
function legalFiles(entry) {
	const files = existsSync(entry.sourceDirectory)
		? readdirSync(entry.sourceDirectory, { withFileTypes: true })
			.filter((item) => item.isFile() && legalFilePattern.test(item.name))
			.map((item) => item.name)
			.sort((a, b) => a.localeCompare(b))
		: [];
	if (files.length === 0) {
		const body = Buffer.from(`SPDX-License-Identifier: ${entry.license}\n`, "utf8");
		return [{ name: "SPDX-License-Identifier", bytes: body }];
	}
	return files.map((name) => ({ name, bytes: readFileSync(join(entry.sourceDirectory, name)) }));
}
const inventory = packages.map((entry) => {
	const files = legalFiles(entry);
	const sections = files.map(({ name, bytes }) => [
		`### ${name}`,
		`SHA-256: ${sha256(bytes)}`,
		"",
		"```text",
		bytes.toString("utf8").trimEnd(),
		"```",
	].join("\n"));
	return [`## ${entry.path}@${entry.version}`, `License: ${entry.license}${entry.packagedNative ? " (packaged native)" : ""}`, "", ...sections].join("\n");
}).join("\n\n");
writeFileSync(output, `# Third-Party Notices\n\nGenerated deterministically from package-lock.json's complete production dependency closure rooted at @earendil-works/pi-coding-agent, plus packaged native modules.\n\n## Dependency inventory and included license texts\n\n${inventory}\n`);
console.log(`${packages.length} dependency notices (${nativePackages.length} packaged natives): ${sha256(readFileSync(output))}`);
