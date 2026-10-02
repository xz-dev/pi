#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bunTarget, isMainModulePath } from "./bun-targets.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function hashFileTree(root) {
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) files.push(path);
		}
	};
	visit(root);
	const entries = files.map((path) => ({ path, name: relative(root, path).replaceAll("\\", "/") }));
	entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
	const closure = createHash("sha256");
	for (const { path, name } of entries) closure.update(`${name}\0${sha256(path)}\n`);
	return closure.digest("hex");
}

// This is provenance for copied upstream prebuilds, not a claim that the old
// vendored Rust source or an unrecorded downstream toolchain built these bytes.
export function muslClipboardProvenance(targetId) {
	const target = bunTarget(targetId);
	if (target.libc !== "musl") throw new Error(`not a musl target: ${targetId}`);
	const commit = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("native provenance requires a full source commit");
	const file = `${target.nativeHelperDir}/${target.nativeHelperFile}`;
	return {
		schemaVersion: 4,
		component: "@earendil-works/pi-tui",
		method: "upstream-prebuilt",
		architecture: target.arch,
		source: {
			repository: "https://github.com/xz-dev/pi",
			commit,
			path: `packages/tui/${file}`,
			linuxSourceSha256: hashFileTree(join(repoRoot, "packages/tui/native/linux/src")),
			buildScriptSha256: sha256(join(repoRoot, "packages/tui/native/linux/build.sh")),
			clipboardHeaderSha256: sha256(join(repoRoot, "packages/tui/native/clipboard.h")),
			napiHeaderSha256: sha256(join(repoRoot, "packages/tui/native/napi.h")),
			license: "MIT",
			licenseFile: "native/LICENSE",
			licenseSha256: sha256(join(repoRoot, "LICENSE")),
		},
		helper: { file, sha256: sha256(join(repoRoot, "packages/tui", file)) },
	};
}

if (process.argv[1] && isMainModulePath(fileURLToPath(import.meta.url), process.argv[1])) {
	const [output, arch] = process.argv.slice(2);
	if (!output || !["x64", "arm64"].includes(arch)) throw new Error("Usage: musl-provenance.mjs <output-dir> <x64|arm64>");
	const provenance = muslClipboardProvenance(arch === "x64" ? "linux-x64-musl-modern" : "linux-arm64-musl");
	const helper = join(resolve(output), provenance.helper.file);
	mkdirSync(dirname(helper), { recursive: true });
	copyFileSync(join(repoRoot, provenance.source.path), helper);
	copyFileSync(join(repoRoot, "LICENSE"), join(resolve(output), "native/LICENSE"));
	writeFileSync(join(resolve(output), "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
}
