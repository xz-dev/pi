import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function selectExecutable(messages) {
	const artifacts = messages.filter(
		(message) => message.reason === "compiler-artifact" && message.target?.name === "pi-env"
			&& Array.isArray(message.target.kind) && message.target.kind.includes("bin") && typeof message.executable === "string",
	);
	assert.equal(artifacts.length, 1, "Cargo must report exactly one pi-env executable");
	assert.ok(artifacts[0].executable.length > 0, "Cargo executable path must not be empty");
	return artifacts[0].executable;
}

/** CI runners only carry stable Rust: install the toolchain pinned by rust-toolchain.toml (and the cross target) there. Local builds never install. */
function ensurePinnedToolchain(daemonDirectory) {
	if (process.env.CI !== "true") return;
	const channel = /channel\s*=\s*"([^"]+)"/.exec(readFileSync(join(daemonDirectory, "rust-toolchain.toml"), "utf8"))?.[1];
	assert.ok(channel, "rust-toolchain.toml must pin a channel");
	const install = ["toolchain", "install", channel, "--profile", "minimal"];
	if (process.env.CARGO_BUILD_TARGET) install.push("--target", process.env.CARGO_BUILD_TARGET);
	const result = spawnSync("rustup", install, { stdio: "inherit" });
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `rustup could not install pinned toolchain ${channel}`);
}

export function buildProcessOwner(destinationDirectory) {
	const manifest = fileURLToPath(new URL("../../env/daemon/Cargo.toml", import.meta.url));
	ensurePinnedToolchain(dirname(manifest));
	const result = spawnSync("cargo", [
		"build", "--manifest-path", manifest, "--locked", "--release", "--message-format=json-render-diagnostics",
	], {
		cwd: dirname(manifest),
		env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	const messages = result.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
	for (const message of messages) {
		if (message.reason === "compiler-message" && message.message?.rendered) process.stderr.write(message.message.rendered);
	}
	assert.equal(result.status, 0, "Cargo process-owner build failed");
	const executable = selectExecutable(messages);
	const directory = destinationDirectory ?? fileURLToPath(new URL("../dist/native/process-owner", import.meta.url));
	mkdirSync(directory, { recursive: true });
	const staging = mkdtempSync(join(directory, ".stage-"));
	const destination = join(directory, basename(executable));
	try {
		const temporary = join(staging, basename(executable));
		copyFileSync(executable, temporary);
		chmodSync(temporary, 0o755);
		renameSync(temporary, destination);
	} finally {
		rmSync(staging, { recursive: true });
	}
	return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	console.log(`Staged process owner: ${buildProcessOwner(process.argv[2])}`);
}
