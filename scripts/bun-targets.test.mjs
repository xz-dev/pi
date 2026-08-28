import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { BUN_BUILD_FLAGS, BUN_TARGET_IDS, BUN_TARGETS, BUN_VERSION, GITHUB_HOSTED_RUNNERS, RELEASE_BUILD, SMOKE_LIMITS, binaryArchiveName, bunBuildFlags, githubBuildMatrix, githubSmokeMatrix, isMainModulePath } from "./lib/bun-targets.mjs";

const EXPECTED = [
	"darwin-x64-baseline", "darwin-x64-modern", "darwin-arm64",
	"linux-x64-gnu-baseline", "linux-x64-gnu-modern", "linux-arm64-gnu",
	"linux-x64-musl-baseline", "linux-x64-musl-modern", "linux-arm64-musl",
	"windows-x64-baseline", "windows-x64-modern", "windows-arm64",
];

test("target descriptor CLI recognizes native Windows paths", () => {
	assert.equal(isMainModulePath("D:\\a\\pi\\pi\\scripts\\lib\\bun-targets.mjs", "D:\\a\\pi\\pi\\scripts\\lib\\bun-targets.mjs", path.win32), true);
	assert.equal(isMainModulePath("D:\\A\\PI\\scripts\\lib\\bun-targets.mjs", "d:\\a\\pi\\scripts\\lib\\bun-targets.mjs", path.win32), true);
	assert.equal(isMainModulePath("D:\\a\\pi\\scripts\\lib\\bun-targets.mjs", "D:\\a\\pi\\scripts\\other.mjs", path.win32), false);
});

test("authoritative Bun target descriptors contain the exact supported matrix", () => {
	assert.deepEqual(BUN_TARGET_IDS, EXPECTED);
	assert.equal(new Set(BUN_TARGET_IDS).size, 12);
	const matrix = githubBuildMatrix();
	assert.deepEqual(matrix.include.map(({ id }) => id), EXPECTED);
	assert.ok(matrix.include.every(({ id, runner, arch, runnerOs, runnerArch }) => id && runner && arch && runnerOs && runnerArch));
	assert.deepEqual(
		matrix.include.filter(({ id }) => id.startsWith("windows-")).map(({ id, runner }) => [id, runner]),
		[["windows-x64-baseline", "windows-2022"], ["windows-x64-modern", "windows-2022"], ["windows-arm64", "windows-11-arm"]],
	);
	assert.equal(BUN_TARGETS.find(({ id }) => id === "darwin-x64-baseline").runner, "macos-15-intel");
	assert.deepEqual(new Set(BUN_TARGETS.filter(({ os, arch }) => os === "darwin" && arch === "x64").map(({ runner }) => runner)), new Set(["macos-15-intel"]));
	assert.ok(BUN_TARGETS.every(({ runner }) => GITHUB_HOSTED_RUNNERS.includes(runner)));
	assert.ok(BUN_TARGETS.every(({ runner }) => !["macos-10.15", "macos-11", "macos-12", "macos-13"].includes(runner)));
	const bunTargetFor = (os, arch, libc = "") => {
		const libcSuffix = libc === "musl" ? "-musl" : "";
		return `bun-${os}-${arch}${libcSuffix}`;
	};
	for (const target of BUN_TARGETS) {
		const os = target.os;
		const base = os === "darwin" ? "darwin" : os === "windows" ? "windows" : "linux";
		assert.equal(target.bunTarget, bunTargetFor(base, target.arch, target.libc ?? ""));
		assert.equal(binaryArchiveName(target.id), `pi-${target.id}.${target.archive}`);
		assert.match(target.clipboardNativePackage, target.libc ? new RegExp(`${target.libc}$`) : /clipboard-/);
		if (target.os === "windows") {
			assert.equal(target.filesystemHelperDir, `native/win32/prebuilds/win32-${target.arch}`);
			assert.equal(target.filesystemHelperFile, "pi-filesystem-snapshot.node");
			for (const command of [
				"win32-filesystem-snapshot-lazy-missing",
				"win32-filesystem-snapshot-lazy-corrupt",
				"win32-filesystem-snapshot",
				"win32-filesystem-snapshot-loader",
			]) assert.ok(target.requiredCommands.includes(command), `${target.id} missing ${command}`);
		} else {
			assert.equal(target.filesystemHelperDir, undefined);
			assert.equal(target.filesystemHelperFile, undefined);
			assert.equal(target.requiredCommands.some((command) => command.startsWith("win32-filesystem-snapshot")), false);
		}
	}
	for (const group of [
		BUN_TARGETS.filter((target) => target.os === "darwin" && target.arch === "x64"),
		BUN_TARGETS.filter((target) => target.os === "linux" && target.arch === "x64" && target.libc === "gnu"),
		BUN_TARGETS.filter((target) => target.os === "linux" && target.arch === "x64" && target.libc === "musl"),
		BUN_TARGETS.filter((target) => target.os === "windows" && target.arch === "x64"),
	]) {
		assert.equal(group.length, 2);
		assert.equal(new Set(group.map((target) => target.bunTarget)).size, 1);
		assert.ok(group.every((target) => target.requiredCpuFeatures.includes("sse4_2")));
	}
});

test("release compiler settings and smoke descriptors cover every target", () => {
	assert.equal(BUN_VERSION, "1.4.0");
	assert.deepEqual(BUN_BUILD_FLAGS, ["--minify", "--bytecode", "--format=esm"]);
	assert.equal(RELEASE_BUILD.bytecode, true);
	assert.match(RELEASE_BUILD.bytecodeReason, /ESM bytecode/);
	assert.match(RELEASE_BUILD.bytecodeReason, /Release build time/);
	assert.equal(RELEASE_BUILD.bytecodeRequiresNativeBuild, true);
	assert.match(RELEASE_BUILD.bytecodeCrossCompileReason, /oven-sh\/bun#18416/);
	assert.match(RELEASE_BUILD.bytecodeCrossCompileReason, /matching native OS and architecture/);
	for (const target of BUN_TARGETS) {
		assert.deepEqual(bunBuildFlags(target.id, { os: target.os, arch: target.arch }), BUN_BUILD_FLAGS);
		const otherOs = target.os === "windows" ? "linux" : "windows";
		assert.deepEqual(bunBuildFlags(target.id, { os: otherOs, arch: target.arch }), ["--minify", "--format=esm"]);
		const otherArch = target.arch === "x64" ? "arm64" : "x64";
		assert.deepEqual(bunBuildFlags(target.id, { os: target.os, arch: otherArch }), ["--minify", "--format=esm"]);
	}
	assert.equal(SMOKE_LIMITS.coldVersionMs, 5000);
	assert.equal(SMOKE_LIMITS.versionMs, 2500);
	assert.ok(BUN_TARGETS.every(({ requiredCommands }) => requiredCommands.includes("bytecode") && requiredCommands.includes("cold-version") && requiredCommands.includes("version")));
	const smoke = githubSmokeMatrix().include;
	assert.deepEqual(smoke.map(({ target }) => target), EXPECTED);
	assert.ok(smoke.every(({ runner, executor }) => runner && ["native", "pinned-musl-container"].includes(executor)));
	assert.deepEqual(
		smoke.filter(({ target }) => target.startsWith("windows-")).map(({ target, runner }) => [target, runner]),
		[["windows-x64-baseline", "windows-2022"], ["windows-x64-modern", "windows-2025"], ["windows-arm64", "windows-11-arm"]],
	);
	for (const target of BUN_TARGETS) {
		assert.ok(target.runnerOs && target.runnerArch && target.requiredCommands.length > 0);
		assert.deepEqual(target.executor, target.libc === "musl" ? "pinned-musl-container" : "native");
	}
	assert.deepEqual(smoke.filter(({ executor }) => executor === "pinned-musl-container").map(({ target }) => target), [
		"linux-x64-musl-baseline", "linux-x64-musl-modern", "linux-arm64-musl",
	]);
});

test("Linux descriptors include GNU and musl native clipboard packages for both architectures", () => {
	const packages = BUN_TARGETS.filter((target) => target.os === "linux").map((target) => target.clipboardNativePackage);
	for (const name of [
		"clipboard-linux-x64-gnu", "clipboard-linux-arm64-gnu",
		"clipboard-linux-x64-musl", "clipboard-linux-arm64-musl",
	]) assert.ok(packages.includes(name), name);
});
