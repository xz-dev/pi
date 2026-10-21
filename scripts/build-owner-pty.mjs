#!/usr/bin/env node
// CI fixture only: no manifest, dependency, toolchain or product asset changes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bunTarget, isMainModulePath } from "./lib/bun-targets.mjs";

export function buildOwnerPty(targetId, output, { run = spawnSync, env = process.env } = {}) {
	const target = bunTarget(targetId);
	assert.notEqual(target.os, "windows", "Unix PTY fixture only");
	const daemon = fileURLToPath(new URL("../packages/env/daemon/", import.meta.url));
	const channel = /channel\s*=\s*"([^"]+)"/.exec(readFileSync(join(daemon, "rust-toolchain.toml"), "utf8"))?.[1];
	assert.ok(channel, "daemon toolchain must be pinned");
	if (env.CI === "true" && !env.PI_XZ_UNPINNED_RUST) {
		const install = run("rustup", ["toolchain", "install", channel, "--profile", "minimal", "--target", target.cargoTarget], { stdio: "inherit" });
		assert.equal(install.status, 0, "could not install existing pinned Rust toolchain");
	}
	assert.ok(env.CARGO_TARGET_DIR, "CI PTY build requires a dedicated CARGO_TARGET_DIR outside source");
	const result = run("cargo", ["build", "--manifest-path", join(daemon, "Cargo.toml"), "--locked", "--release", "--example", "owner-pty", "--target", target.cargoTarget, "--message-format=json-render-diagnostics"], {
		cwd: daemon, env: { ...env, RUSTUP_AUTO_INSTALL: "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, "CI owner PTY build failed");
	const artifacts = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((message) => message.reason === "compiler-artifact" && message.target?.name === "owner-pty" && message.target.kind?.includes("example") && typeof message.executable === "string");
	assert.equal(artifacts.length, 1, "Cargo must report exactly one owner-pty example");
	mkdirSync(dirname(output), { recursive: true });
	copyFileSync(artifacts[0].executable, output);
	chmodSync(output, 0o755);
	return output;
}

if (process.argv[1] && isMainModulePath(fileURLToPath(import.meta.url), process.argv[1])) {
	const [target, output] = process.argv.slice(2);
	if (!target || !output) throw new Error("Usage: build-owner-pty.mjs <target> <CI-only-output>");
	buildOwnerPty(target, resolve(output));
}
