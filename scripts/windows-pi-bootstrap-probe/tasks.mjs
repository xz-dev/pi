import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execCommand } from "../../packages/coding-agent/src/core/exec.ts";
import { createProcessRegistry } from "../../packages/coding-agent/src/core/process-registry.ts";
import { createLocalBashOperations } from "../../packages/coding-agent/src/core/tools/bash.ts";
import { prepareOwnedSpawn } from "../../packages/coding-agent/src/core/tools/owned-exec.ts";
import { getProcessOwnership } from "../../packages/coding-agent/src/utils/procward.ts";

const [native, fixture, directory, resultFile] = process.argv.slice(2);
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const receipt = {
	runtime: process.versions.bun ? "bun" : "node",
	version: process.versions.bun ?? process.versions.node,
	arch: process.arch,
	nativeSha256: hash(native),
	fixtureSha256: hash(fixture),
	guard: 0,
	rescue: 0,
	cases: [],
};
const provenance = { toolName: "actual-windows-acceptance", toolCallId: "direct-versus-owned" };
const fixtureCommand = `'${fixture.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
const ownership = (registry) => ({ registry, purpose: "actual Windows task differential", provenance });
async function until(predicate) {
	while (!predicate()) await delay(2);
}

async function run(name, body) {
	const registry = createProcessRegistry(getProcessOwnership().ownerPid);
	const start = performance.now();
	const timer = setTimeout(() => {
		receipt.guard++;
		receipt.failedCase = name;
		receipt.passed = false;
		writeFileSync(resultFile, `${JSON.stringify(receipt, null, 2)}\n`);
		process.exit(125);
	}, 10000);
	try {
		const result = await body(registry);
		receipt.cases.push({ name, milliseconds: performance.now() - start, ...result });
	} finally {
		try {
			await registry.close();
		} finally {
			clearTimeout(timer);
		}
	}
}

async function bash(command, registry) {
	let output = "";
	const operations = createLocalBashOperations(
		registry
			? { ownership: { procwardBinary: native, registry, enabled: true, purpose: "actual Windows bash differential" } }
			: undefined,
	);
	const result = await operations.exec(command, directory, {
		onData: (data) => {
			output += data.toString("utf8");
		},
		provenance,
	});
	return { ...result, output };
}

async function retained(registry, owned, cancel) {
	const dir = path.join(directory, `${owned ? "owned" : "direct"}-${cancel ? "cancel" : "natural"}`);
	mkdirSync(dir);
	// The existing native fixture requires one stdin byte; execCommand
	// intentionally supplies none. Exercise the real bash pipeline unchanged
	// on both sides, rather than treating its direct EOF panic as a Pi bug.
	const target = `'${dir.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
	const result = await bash(`printf x | ${fixtureCommand} retained-task ${target}`, owned ? registry : undefined);
	assert.equal(result.exitCode, 23, JSON.stringify(result));
	assert(existsSync(path.join(dir, "retained-ready")) && !existsSync(path.join(dir, "retained-finished")));
	if (owned)
		assert.deepEqual(
			registry.list().map((task) => task.status),
			["background"],
		);
	// Beyond native's original1500ms cleanup, then ask the actual worker to
	// acknowledge work causally after the primary returned. No PID guessing.
	await delay(1600);
	writeFileSync(path.join(dir, "retained-probe"), "probe");
	await until(() => existsSync(path.join(dir, "retained-probed")));
	if (cancel) {
		const task = registry.list()[0];
		assert(task && task.procwardPid > 0 && task.provenance.toolCallId === provenance.toolCallId);
		const completion = await task.cancel();
		assert.deepEqual(completion, { exitCode: 23, scope: "kernel", unconfirmed: false });
		assert.deepEqual(registry.list(), []);
		assert(!existsSync(path.join(dir, "retained-finished")));
		return { result, causalWorkerAfter1600ms: true, completion };
	}
	writeFileSync(path.join(dir, "retained-release"), "release");
	await until(() => existsSync(path.join(dir, "retained-finished")));
	if (owned) await until(() => registry.list().length === 0);
	return { result, causalWorkerAfter1600ms: true, naturalFinish: true };
}

async function main() {
	assert.equal(process.platform, "win32");
	assert.notEqual(process.env.PI_NO_PROCESS_OWNERSHIP, "1");
	assert.equal(process.env.PI_PROCWARD_BIN, native, "only the existing candidate-helper development override");
	await import("../../packages/coding-agent/src/cli-bootstrap.ts");
	assert(getProcessOwnership().enabled && getProcessOwnership().ownerPid > 0);
	receipt.sessionOwnerPid = getProcessOwnership().ownerPid;
	mkdirSync(directory, { recursive: true });
	process.env.PROCWARD_TEST_VALUE = 'space 雪 "quotes"';
	await run("exec-argv-cwd-env-binary-io", async (registry) => {
		const args = ["probe", "", "a b", 'a"b', "雪"];
		const direct = await execCommand(fixture, args, directory);
		const owned = await execCommand(fixture, args, directory, undefined, ownership(registry));
		assert.deepEqual(owned, direct);
		assert.equal(direct.code, 23);
		assert.equal(direct.stderr.trim(), "fixture-stderr");
		return { direct, owned };
	});
	for (const code of [7, 256, 4275878552, 4294967295])
		await run(`exec-native-u32-${code}`, async (registry) => {
			const args = ["exit", String(code)];
			const direct = await execCommand(fixture, args, directory);
			const owned = await execCommand(fixture, args, directory, undefined, ownership(registry));
			assert.deepEqual(owned, direct);
			const adapter = prepareOwnedSpawn(
				{ procwardBinary: native, registry, purpose: "actual native wire boundary", provenance },
				fixture,
				args,
			);
			const child = spawn(adapter.command, adapter.args, { cwd: directory, stdio: adapter.stdio });
			adapter.finalize(child);
			assert(await adapter.ready);
			assert.equal(await adapter.primaryExit, direct.code);
			const completion = await adapter.completion;
			assert.deepEqual(completion, { exitCode: code, scope: "kernel", unconfirmed: false });
			return { direct, owned, completion };
		});
	for (const command of [
		"printf 'ordinary stdout'; printf 'ordinary stderr' >&2; exit 7",
		...[256, 4275878552].map(
			(code) => `${fixtureCommand} exit ${code}; status=$?; printf 'status:%s' "$status" >&2; exit "$status"`,
		),
	])
		await run(`bash-${receipt.cases.length}`, async (registry) => {
			const direct = await bash(command);
			const owned = await bash(command, registry);
			assert.deepEqual(owned, direct);
			return { command, direct, owned };
		});
	await run("direct-retained-natural", (registry) => retained(registry, false, false));
	await run("owned-retained-natural", (registry) => retained(registry, true, false));
	await run("owned-retained-cancel", (registry) => retained(registry, true, true));
	receipt.passed = true;
}
main()
	.catch((error) => {
		receipt.passed = false;
		receipt.error = String(error.stack ?? error);
		process.exitCode = 1;
	})
	.finally(() => {
		assert.equal(hash(native), receipt.nativeSha256);
		assert.equal(hash(fixture), receipt.fixtureSha256);
		writeFileSync(resultFile, `${JSON.stringify(receipt, null, 2)}\n`);
	});
