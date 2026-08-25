#!/usr/bin/env node

import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Authoritative xz-dev binary Release target and acceptance matrix. */
export const BUN_VERSION = "1.4.0";
export const BUN_BUILD_FLAGS = Object.freeze(["--minify", "--bytecode", "--format=esm"]);
export const RELEASE_BUILD = Object.freeze({
	nodeEnv: "production",
	minify: true,
	bytecode: true,
	bytecodeReason: "Pi's Bun entrypoint uses ESM bytecode to move parsing work from runtime to Release build time",
	bytecodeRequiresNativeBuild: true,
	bytecodeCrossCompileReason: "Cross-compiled --bytecode executables still segfault on the target OS (oven-sh/bun#18416), so Release builds use a matching native OS and architecture while ad-hoc cross-builds omit bytecode",
	sourcemap: false,
	debug: false,
	profile: false,
});

function currentBuildHost() {
	return {
		os: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : process.platform,
		arch: process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch,
	};
}

/** Bytecode is safe only when compilation runs on the target OS and architecture. */
export function bunBuildFlags(id, buildHost = currentBuildHost()) {
	const target = bunTarget(id);
	if (target.os !== buildHost.os || target.arch !== buildHost.arch) return BUN_BUILD_FLAGS.filter((flag) => flag !== "--bytecode");
	return BUN_BUILD_FLAGS;
}
export const SMOKE_LIMITS = Object.freeze({
	archiveBytes: 100 * 1024 * 1024,
	extractedBytes: 250 * 1024 * 1024,
	coldVersionMs: 5000,
	versionMs: 2500,
	helpMs: 3000,
	listModelsMs: 5000,
	interactiveMs: 7000,
});

const GITHUB_RUNNER_PLATFORMS = Object.freeze({
	"macos-15-intel": { os: "darwin", arch: "x64" },
	"macos-15": { os: "darwin", arch: "arm64" },
	"ubuntu-24.04": { os: "linux", arch: "x64" },
	"ubuntu-24.04-arm": { os: "linux", arch: "arm64" },
	"windows-2022": { os: "windows", arch: "x64" },
	"windows-2025": { os: "windows", arch: "x64" },
	"windows-11-arm": { os: "windows", arch: "arm64" },
});
export const GITHUB_HOSTED_RUNNERS = Object.freeze(Object.keys(GITHUB_RUNNER_PLATFORMS));

const MUSL_IMAGES = Object.freeze({
	x64: "docker.io/oven/bun@sha256:8aac45197595035f697ea6b11cd73ce2401d82503fcb2540b5fac606973b242b",
	arm64: "docker.io/oven/bun@sha256:b707d91190be7e8d5dee8dd7dbe9e7dfecfd26a632266b69335d7a9082814f8b",
});

function target({ id, bunTarget, os, arch, libc, cpu, runner, buildRunner = runner, clipboardNativePackage, clipboardNativeFile, nativeHelperDir, nativeHelperFile }) {
	if (!GITHUB_HOSTED_RUNNERS.includes(runner)) throw new Error(`Unsupported GitHub-hosted runner label: ${runner}`);
	if (!GITHUB_HOSTED_RUNNERS.includes(buildRunner)) throw new Error(`Unsupported GitHub-hosted build runner label: ${buildRunner}`);
	const buildPlatform = GITHUB_RUNNER_PLATFORMS[buildRunner];
	if (buildPlatform.os !== os || buildPlatform.arch !== arch) throw new Error(`Build runner ${buildRunner} does not natively match ${id}`);
	const executor = libc === "musl" ? "pinned-musl-container" : "native";
	return Object.freeze({
		id,
		bunTarget,
		os,
		arch,
		libc,
		cpu,
		runner,
		buildRunner,
		buildRunnerOs: buildPlatform.os === "darwin" ? "macOS" : buildPlatform.os === "windows" ? "Windows" : "Linux",
		buildRunnerArch: buildPlatform.arch === "arm64" ? "ARM64" : "X64",
		runnerOs: os === "darwin" ? "macOS" : os === "windows" ? "Windows" : "Linux",
		runnerArch: arch === "arm64" ? "ARM64" : "X64",
		executor,
		...(executor === "pinned-musl-container" ? { containerImage: MUSL_IMAGES[arch] } : {}),
		requiredCpuFeatures: arch === "x64" ? ["sse4_2"] : [],
		requiredCommands: ["extract", "measure-extracted-size", "cold-version", "bytecode", "version", "help", "list-models", "clipboard", ...(libc === "musl" ? ["musl-provenance"] : []), os === "windows" ? "tui-pseudoconsole" : "tui-pseudoterminal"],
		executable: os === "windows" ? "pi-native.exe" : "pi-native",
		wrapper: os === "windows" ? "pi.exe" : "pi",
		archive: "zip",
		clipboardNativePackage,
		clipboardNativeFile,
		...(nativeHelperDir ? { nativeHelperDir, nativeHelperFile } : {}),
	});
}

const darwinHelper = (arch) => ({ nativeHelperDir: `native/darwin/prebuilds/darwin-${arch}`, nativeHelperFile: "darwin-modifiers.node" });
const windowsHelper = (arch) => ({ nativeHelperDir: `native/win32/prebuilds/win32-${arch}`, nativeHelperFile: "win32-console-mode.node" });
export const BUN_TARGETS = Object.freeze([
	target({ id: "darwin-x64-baseline", bunTarget: "bun-darwin-x64", os: "darwin", arch: "x64", cpu: "baseline", runner: "macos-15-intel", clipboardNativePackage: "clipboard-darwin-x64", clipboardNativeFile: "clipboard.darwin-x64.node", ...darwinHelper("x64") }),
	target({ id: "darwin-x64-modern", bunTarget: "bun-darwin-x64", os: "darwin", arch: "x64", cpu: "modern", runner: "macos-15-intel", clipboardNativePackage: "clipboard-darwin-x64", clipboardNativeFile: "clipboard.darwin-x64.node", ...darwinHelper("x64") }),
	target({ id: "darwin-arm64", bunTarget: "bun-darwin-arm64", os: "darwin", arch: "arm64", cpu: "arm64", runner: "macos-15", clipboardNativePackage: "clipboard-darwin-arm64", clipboardNativeFile: "clipboard.darwin-arm64.node", ...darwinHelper("arm64") }),
	target({ id: "linux-x64-gnu-baseline", bunTarget: "bun-linux-x64", os: "linux", arch: "x64", libc: "gnu", cpu: "baseline", runner: "ubuntu-24.04", clipboardNativePackage: "clipboard-linux-x64-gnu", clipboardNativeFile: "clipboard.linux-x64-gnu.node" }),
	target({ id: "linux-x64-gnu-modern", bunTarget: "bun-linux-x64", os: "linux", arch: "x64", libc: "gnu", cpu: "modern", runner: "ubuntu-24.04", clipboardNativePackage: "clipboard-linux-x64-gnu", clipboardNativeFile: "clipboard.linux-x64-gnu.node" }),
	target({ id: "linux-arm64-gnu", bunTarget: "bun-linux-arm64", os: "linux", arch: "arm64", libc: "gnu", cpu: "arm64", runner: "ubuntu-24.04-arm", clipboardNativePackage: "clipboard-linux-arm64-gnu", clipboardNativeFile: "clipboard.linux-arm64-gnu.node" }),
	target({ id: "linux-x64-musl-baseline", bunTarget: "bun-linux-x64-musl", os: "linux", arch: "x64", libc: "musl", cpu: "baseline", runner: "ubuntu-24.04", clipboardNativePackage: "clipboard-linux-x64-musl", clipboardNativeFile: "clipboard.linux-x64-musl.node" }),
	target({ id: "linux-x64-musl-modern", bunTarget: "bun-linux-x64-musl", os: "linux", arch: "x64", libc: "musl", cpu: "modern", runner: "ubuntu-24.04", clipboardNativePackage: "clipboard-linux-x64-musl", clipboardNativeFile: "clipboard.linux-x64-musl.node" }),
	target({ id: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl", os: "linux", arch: "arm64", libc: "musl", cpu: "arm64", runner: "ubuntu-24.04-arm", clipboardNativePackage: "clipboard-linux-arm64-musl", clipboardNativeFile: "clipboard.linux-arm64-musl.node" }),
	target({ id: "windows-x64-baseline", bunTarget: "bun-windows-x64", os: "windows", arch: "x64", cpu: "baseline", runner: "windows-2022", buildRunner: "windows-2022", clipboardNativePackage: "clipboard-win32-x64-msvc", clipboardNativeFile: "clipboard.win32-x64-msvc.node", ...windowsHelper("x64") }),
	target({ id: "windows-x64-modern", bunTarget: "bun-windows-x64", os: "windows", arch: "x64", cpu: "modern", runner: "windows-2025", buildRunner: "windows-2022", clipboardNativePackage: "clipboard-win32-x64-msvc", clipboardNativeFile: "clipboard.win32-x64-msvc.node", ...windowsHelper("x64") }),
	target({ id: "windows-arm64", bunTarget: "bun-windows-arm64", os: "windows", arch: "arm64", cpu: "arm64", runner: "windows-11-arm", buildRunner: "windows-11-arm", clipboardNativePackage: "clipboard-win32-arm64-msvc", clipboardNativeFile: "clipboard.win32-arm64-msvc.node", ...windowsHelper("arm64") }),
]);
export const BUN_TARGET_IDS = Object.freeze(BUN_TARGETS.map(({ id }) => id));
export function bunTarget(id) { const found = BUN_TARGETS.find((entry) => entry.id === id); if (!found) throw new Error(`Unknown Bun Release target: ${id}`); return found; }
export function binaryArchiveName(id) { const entry = bunTarget(id); return `pi-${id}.${entry.archive}`; }
export function githubBuildMatrix() { return { include: BUN_TARGETS.map(({ id, buildRunner, arch, buildRunnerOs, buildRunnerArch }) => ({ id, runner: buildRunner, arch, runnerOs: buildRunnerOs, runnerArch: buildRunnerArch })) }; }
export function githubSmokeMatrix() {
	return { include: BUN_TARGETS.map(({ id: target, runner, executor, containerImage }) => ({ target, runner, executor, ...(containerImage ? { containerImage } : {}) })) };
}

export function isMainModulePath(modulePath, argvPath, pathApi = path) {
	const resolvedModule = pathApi.resolve(modulePath);
	const resolvedArgv = pathApi.resolve(argvPath);
	return pathApi.sep === "\\" ? resolvedModule.toLowerCase() === resolvedArgv.toLowerCase() : resolvedModule === resolvedArgv;
}

if (process.argv[1] && isMainModulePath(fileURLToPath(import.meta.url), process.argv[1])) {
	const [command, id, field] = process.argv.slice(2);
	if (command === "--ids") process.stdout.write(`${BUN_TARGET_IDS.join("\n")}\n`);
	else if (command === "--matrix") process.stdout.write(JSON.stringify(githubBuildMatrix()));
	else if (command === "--smoke-matrix") process.stdout.write(JSON.stringify(githubSmokeMatrix()));
	else if (command === "--build-flags") process.stdout.write(`${bunBuildFlags(id).join("\n")}\n`);
	else if (command === "--get" && id && field) { const value = bunTarget(id)[field]; if (value === undefined) process.exitCode = 2; else process.stdout.write(String(value)); }
	else throw new Error("Usage: bun-targets.mjs --ids | --matrix | --smoke-matrix | --build-flags [target] | --get <target> <field>");
}
