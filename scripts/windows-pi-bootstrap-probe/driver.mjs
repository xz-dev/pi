import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [native, out, runtime, arch] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.equal(process.arch, arch);
assert.equal(process.versions.bun ? "bun" : "node", runtime);
assert.equal(process.versions.bun ?? process.versions.node, runtime === "bun" ? "1.4.4" : "22.22.2");
const primary = path.join(path.dirname(fileURLToPath(import.meta.url)), "primary.mjs");
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const receipt = {
	runtime,
	arch,
	platform: process.platform,
	nativeSha256: hash(native),
	primarySha256: hash(primary),
	driverSha256: hash(fileURLToPath(import.meta.url)),
	runtimeSha256: hash(process.execPath),
	cases: [],
};

async function run(mode, seeded) {
	const env = { ...process.env };
	for (const key of Object.keys(env))
		if (
			key.startsWith("PROCWARD_") ||
			key === "PI_PROCWARD_BIN" ||
			key === "PI_PROCWARD_BOOTSTRAP_NONCE" ||
			key === "PI_PACKAGE_DIR" ||
			key === "PI_NO_PROCESS_OWNERSHIP"
		)
			delete env[key];
	if (mode === "off") env.PI_NO_PROCESS_OWNERSHIP = "1";
	if (seeded) env.PI_PROCWARD_BOOTSTRAP_NONCE = randomBytes(16).toString("hex");
	const executable = seeded ? native : process.execPath;
	const args = seeded ? ["run", "--quiet", "--", process.execPath, primary, mode] : [primary, mode];
	const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"] });
	const state = { mode, seeded, childPid: child.pid, stdout: "", stderr: "", guard: false, rescue: false, records: [] };
	let error;
	child.once("error", (value) => {
		error = value;
	});
	child.stdout.on("data", (bytes) => {
		state.stdout += bytes.toString("utf8");
	});
	child.stderr.on("data", (bytes) => {
		state.stderr += bytes.toString("utf8");
	});
	child.once("close", (code, signal) => {
		state.closed = { code, signal };
	});
	const timer = setTimeout(() => {
		state.guard = true;
		state.rescue = true;
		child.kill("SIGKILL");
		error = new Error("Pi bootstrap fixture guard expired");
	}, 10000);
	async function until(predicate) {
		while (!predicate()) {
			if (error) throw error;
			await delay(2);
		}
		if (error) throw error;
	}
	try {
		if (mode === "hold") {
			await until(() => state.stdout.includes("\n"));
			const ready = JSON.parse(state.stdout.split("\n")[0]);
			assert.equal(ready.phase, "ready");
			assert.equal(ready.ownerPid, child.pid);
			assert.equal(ready.ownerPid, ready.nativeParentPid);
			state.requestedNativeOwnerLoss = true;
			child.kill("SIGKILL");
		}
		await until(() => state.closed !== undefined);
		state.records = state.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		assert(!state.guard && !state.rescue);
		if (mode === "wrong-owner") {
			assert.notEqual(state.closed.code, 0);
			assert.equal(state.records.length, 0);
			assert.match(state.stderr, /READY owner pid mismatch/);
		} else if (mode === "hold") {
			assert(state.requestedNativeOwnerLoss && state.records[0].phase === "ready");
			assert.notEqual(state.closed.code, 0);
			state.actualOwnerAndPrimaryPipeClose = true;
		} else {
			assert.equal(state.closed.code, 23);
			assert.equal(state.closed.signal, null);
			assert.equal(state.stderr, "");
			const first = state.records[0];
			if (mode === "off") assert.equal(first.phase, "off");
			else if (mode === "identity-mismatch") {
				assert.equal(first.phase, "identity-rejected");
				assert.notEqual(first.realCreation, first.rejectedCreation);
				assert(BigInt(`0x${first.realCreation}`) > BigInt(Number.MAX_SAFE_INTEGER));
			} else {
				assert.equal(first.phase, "ready");
				assert(first.scrubbed && first.privateReaderAccepted && first.ownerPid === first.nativeParentPid);
				assert(/^[0-9a-f]{16}$/.test(first.creationTime));
				assert(BigInt(`0x${first.creationTime}`) > BigInt(Number.MAX_SAFE_INTEGER));
				if (seeded) assert.equal(first.ownerPid, child.pid);
				if (mode === "healthy") assert.equal(state.records[1].phase, "healthy-after-seven-seconds");
				else assert.equal(state.records.length, 1, "outer bootstrap must not restart the application twice");
			}
		}
		return state;
	} catch (failure) {
		failure.bootstrapCase = state;
		throw failure;
	} finally {
		clearTimeout(timer);
		if (!state.closed) {
			state.rescue = true;
			child.kill("SIGKILL");
		}
	}
}

try {
	for (const [mode, seeded] of [
		["outer", false],
		["healthy", true],
		["wrong-owner", true],
		["identity-mismatch", true],
		["hold", true],
		["off", false],
	])
		receipt.cases.push(await run(mode, seeded));
	receipt.passed = true;
} catch (error) {
	receipt.passed = false;
	receipt.error = String(error.stack ?? error);
	receipt.failedCase = error.bootstrapCase;
	process.exitCode = 1;
} finally {
	assert.equal(hash(native), receipt.nativeSha256);
	writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
}
