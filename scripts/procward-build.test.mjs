import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertProcwardBuild, assertProcwardBundleBuild, buildProcward, requestedProcwardIncluded } from "../packages/coding-agent/scripts/build-procward.mjs";
import { buildHostBinary } from "../packages/coding-agent/scripts/build-host-binary.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { execNpmSync } from "./npm-command.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function put(path, contents) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}
function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-procward-build-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const bin = join(directory, "bin");
	put(join(bin, "package.json"), '{"type":"commonjs"}');
	const log = join(directory, "calls.jsonl");
	put(join(directory, "vendor/procward/LICENSE"), "BSD-3-Clause test notice\n");
	put(join(directory, "vendor/procward/Cargo.toml"), "vendored manifest fixture\n");
	put(join(bin, "cargo"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({command:"cargo",args,cwd:process.cwd(),home:process.env.CARGO_HOME,offline:process.env.CARGO_NET_OFFLINE})+"\\n");
if (process.env.FAIL_CARGO) process.exit(9);
if (args[0] !== "build") process.exit(10);
const target = args.includes("--target") ? args[args.indexOf("--target")+1] : "";
const output = path.join(args[args.indexOf("--target-dir")+1],target,"release", target.includes("windows") ? "procward.exe" : "procward");
fs.mkdirSync(path.dirname(output), {recursive:true});
fs.writeFileSync(output, "HELPER SENTINEL: MUST NOT EXECUTE");
`);
	put(join(bin, "bun"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const asset = args.find(x => x.startsWith("--asset=") && x.endsWith("/process-owner"));
const owner = asset && asset.slice(8);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({command:"bun",args,license:owner && fs.readFileSync(owner+"/LICENSE","utf8"),helper:owner && fs.readFileSync(owner+"/procward","utf8")})+"\\n");
if (process.env.BUN_SIGNAL) process.kill(process.pid, process.env.BUN_SIGNAL);
process.exit(Number(process.env.BUN_STATUS || 0));
`);
	for (const command of ["cargo", "bun"]) chmodSync(join(bin, command), 0o755);
	const env = { ...process.env, PATH: bin, CALL_LOG: log, PROCWARD: "1", CARGO_HOME: join(directory, "cargo-home"), CARGO_NET_OFFLINE: "true" };
	delete env.CARGO_BUILD_TARGET;
	delete env.CARGO_TARGET_DIR;
	return { directory, env, log, options: { root: directory, directory, env } };
}
function stampBundle(directory) {
	mkdirSync(join(directory, "dist/bundle"), { recursive: true });
	copyFileSync(join(directory, "dist/utils/procward-build.js"), join(directory, "dist/bundle/procward-build.js"));
}
function calls(log) {
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

test("PROCWARD input is an explicit build-only boolean", () => {
	assert.equal(requestedProcwardIncluded({}), true);
	assert.equal(requestedProcwardIncluded({ PROCWARD: "0" }), false);
	assert.throws(() => requestedProcwardIncluded({ PROCWARD: "false" }), /must be 0 or 1/);
	const pkg = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json")));
	assert.ok(pkg.files.includes("native/procward"));
	assert.match(pkg.scripts["build:unbundled"], /tsc .* && node scripts\/build-procward.mjs/);
	assert.match(pkg.scripts["build:binary"], /node scripts\/build-host-binary.mjs && npm run copy-binary-assets/);
});

test("off emits a durable SDK flag without any Cargo, rustup, version probe or native assets", t => {
	const f = fixture(t);
	buildProcward({ ...f.options, env: { ...f.env, PROCWARD: "0" } });
	assert.equal(calls(f.log).length, 0);
	assert.equal(existsSync(join(f.directory, "native/procward")), false);
	assert.match(readFileSync(join(f.directory, "dist/utils/procward-build.js"), "utf8"), /procwardIncluded = false;/);
	assert.equal(assertProcwardBuild(f.directory, { PROCWARD: "0" }), false);
	assert.throws(() => assertProcwardBuild(f.directory, { PROCWARD: "1" }), /preceding matching package build/);
});

test("enabled source build stages the canonical target, executable mode and exact BSD notice", { skip: process.platform === "win32" }, t => {
	const f = fixture(t);
	const target = "x86_64-unknown-linux-gnu";
	f.env.CARGO_TARGET_DIR = "cargo-cache";
	buildProcward({ ...f.options, target, offline: true });
	const [call] = calls(f.log);
	assert.deepEqual(call.args, ["build", "--manifest-path", join(f.directory, "vendor/procward/Cargo.toml"), "--release", "--locked", "--target-dir", join(f.directory, "cargo-cache"), "--target", target, "--offline"]);
	assert.equal(call.cwd, join(f.directory, "vendor/procward"), "Cargo must load the native project's .cargo/config.toml (including Windows static CRT)");
	assert.equal(call.home, f.env.CARGO_HOME);
	assert.equal(call.offline, "true");
	const staged = join(f.directory, "native/procward", target);
	assert.equal(statSync(join(staged, "procward")).mode & 0o777, 0o755);
	assert.equal(readFileSync(join(staged, "LICENSE"), "utf8"), "BSD-3-Clause test notice\n");
	assert.equal(assertProcwardBuild(f.directory, f.env), true);
});

test("on to off to on removes only owned staging and keeps vendor/Cargo cache", { skip: process.platform === "win32" }, t => {
	const f = fixture(t);
	buildProcward(f.options);
	stampBundle(f.directory);
	put(join(f.directory, "native/unrelated/keep"), "keep");
	const off = { ...f.env, PROCWARD: "0" };
	buildProcward({ ...f.options, env: off });
	assert.equal(existsSync(join(f.directory, "native/procward")), false);
	assert.equal(existsSync(join(f.directory, "native/unrelated/keep")), true);
	assert.equal(existsSync(join(f.directory, "vendor/procward/target/release/procward")), true);
	assert.equal(existsSync(join(f.directory, "dist/bundle/procward-build.js")), false);
	assert.throws(() => assertProcwardBundleBuild(f.directory, off), /bundle capability mismatch/);
	stampBundle(f.directory);
	assert.equal(assertProcwardBundleBuild(f.directory, off), false);
	buildProcward({ ...f.options, target: "aarch64-pc-windows-msvc" });
	assert.equal(existsSync(join(f.directory, "native/procward/host")), false);
	assert.equal(existsSync(join(f.directory, "native/procward/aarch64-pc-windows-msvc/procward.exe")), true);
	assert.equal(calls(f.log).length, 2);
});

test("enabled missing or failed Cargo is strict and invalidates old build flags", { skip: process.platform === "win32" }, t => {
	const f = fixture(t);
	buildProcward(f.options);
	stampBundle(f.directory);
	assert.throws(() => buildProcward({ ...f.options, env: { ...f.env, FAIL_CARGO: "1" } }), /Cargo.*required/);
	assert.throws(() => assertProcwardBuild(f.directory, f.env), /preceding matching/);
	assert.throws(() => buildProcward({ ...f.options, env: { ...f.env, PATH: join(f.directory, "missing") } }), /use PROCWARD=0/);
	assert.equal(calls(f.log).length, 2);
});

test("release staging uses source Cargo for its target without replacing npm host assets/flags", { skip: process.platform === "win32" }, t => {
	const f = fixture(t);
	buildProcward(f.options);
	stampBundle(f.directory);
	const out = join(f.directory, "release/process-owner");
	buildProcward({ ...f.options, stageOnly: true, target: "aarch64-unknown-linux-gnu", out });
	assert.equal(existsSync(join(out, "procward")), true);
	assert.equal(existsSync(join(out, "LICENSE")), true);
	assert.equal(existsSync(join(f.directory, "native/procward/host/procward")), true);
	assert.equal(assertProcwardBundleBuild(f.directory, f.env), true);
});

test("direct Bun wrapper embeds process-owner only for enabled builds and propagates failures", { skip: process.platform === "win32" }, t => {
	const f = fixture(t);
	buildProcward(f.options);
	stampBundle(f.directory);
	assert.equal(buildHostBinary(f.directory, f.env), 0);
	let bun = calls(f.log).at(-1);
	assert.equal(bun.command, "bun");
	assert.ok(bun.args.includes("--define=PI_PROCWARD_INCLUDED=true"));
	assert.match(bun.args.find(x => x.startsWith("--asset=") && x.endsWith("/process-owner")), /\/process-owner$/);
	assert.ok(bun.args.includes("--asset=.pi/skills"));
	assert.deepEqual(bun.args, [
		"build", "--compile", "--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv",
		"--compile-autoload-package-json", "--define=PI_PROCWARD_INCLUDED=true", "--asset=.pi/skills",
		bun.args.find(x => x.startsWith("--asset=") && x.endsWith("/process-owner")),
		"./dist/bun/cli-portable.js", "./src/utils/image-resize-worker.ts", "./src/extensions/codemode/worker.ts",
		"--outfile", "dist/pi",
	]);
	assert.match(bun.helper, /MUST NOT EXECUTE/);
	assert.equal(bun.license, "BSD-3-Clause test notice\n");
	const off = { ...f.env, PROCWARD: "0", BUN_STATUS: "23" };
	buildProcward({ ...f.options, env: off });
	stampBundle(f.directory);
	assert.equal(buildHostBinary(f.directory, off), 23);
	assert.equal(buildHostBinary(f.directory, { ...off, BUN_SIGNAL: "SIGTERM" }), 143);
	bun = calls(f.log).at(-1);
	assert.ok(bun.args.includes("--define=PI_PROCWARD_INCLUDED=false"));
	assert.deepEqual(bun.args.filter(x => x.startsWith("--asset=")), ["--asset=.pi/skills"]);
	assert.equal(calls(f.log).filter(x => x.command === "cargo").length, 1);
	assert.throws(() => buildHostBinary(f.directory, f.env), /preceding matching/);
	assert.throws(() => buildHostBinary(f.directory, { ...off, PATH: "/nonexistent" }), /ENOENT/);
});

test("npm skip-build rejects mismatched capability before packing", t => {
	const f = fixture(t);
	const directory = join(f.directory, "packages/coding-agent");
	put(join(f.directory, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
	put(join(directory, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0" }));
	buildProcward({ root: f.directory, directory, env: { ...f.env, PROCWARD: "0" } });
	stampBundle(directory);
	assert.throws(() => produceArtifactSet({ repoRoot: f.directory, outDir: join(f.directory, ".artifacts/off"), build: false, source: { commit: "fixture", dirty: false } }), /preceding matching package build/);
});

test("npm allowlist publishes enabled target helper and LICENSE, then neither after off", { skip: process.platform === "win32" }, t => {
	const f = fixture(t);
	const pkg = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8"));
	put(join(f.directory, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, files: pkg.files, type: "module" }));
	buildProcward(f.options);
	const packedFiles = () => {
		const output = JSON.parse(execNpmSync(["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: f.directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
		const packed = Array.isArray(output) ? output[0] : output[pkg.name];
		return packed.files.map(file => file.path);
	};
	assert.ok(packedFiles().includes("native/procward/host/procward"));
	assert.ok(packedFiles().includes("native/procward/host/LICENSE"));
	buildProcward({ ...f.options, env: { ...f.env, PROCWARD: "0" } });
	assert.equal(packedFiles().some(path => path.startsWith("native/procward/")), false);
	assert.ok(packedFiles().includes("dist/utils/procward-build.js"));
});

test("thin shell forwarder off path uses the single Node authority", t => {
	const result = spawnSync("bash", [join(root, "scripts/build-procward.sh"), "--unknown-option"], { env: { ...process.env, PROCWARD: "0" }, encoding: "utf8" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unknown option/);
});
