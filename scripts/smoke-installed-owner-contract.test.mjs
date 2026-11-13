import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInstalledOwnerContract } from "./fixtures/owner/installed-contract.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/owner", import.meta.url));
async function waitFor(predicate) {
	const limit = performance.now() + 5000;
	while (!predicate()) {
		assert(performance.now() < limit, "controlled workload deadline");
		await delay(2);
	}
}

// Mock only the public tool boundary. These tests do not attest native cleanup;
// the installed CLI must supply the real process_list/process_kill implementations.
async function exitedPid() {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await once(child, "close");
	return child.pid;
}

async function contract({ unconfirmed = false, self = true, timeoutLeafSurvives = false } = {}) {
	const timeoutLeaf = timeoutLeafSurvives ? process.pid : await exitedPid();
	const directory = mkdtempSync(join(tmpdir(), "pi-installed-contract-"));
	const tasks = new Map();
	const calls = [];
	let counter = 0;
	const timer = setInterval(() => {
		for (const name of ["first", "survivor"]) {
			const dir = join(directory, name);
			if (existsSync(join(dir, "probe"))) writeFileSync(join(dir, "ack"), readFileSync(join(dir, "probe")));
		}
	}, 2);
	try {
		const context = {
			async executeTool(name, args) {
				calls.push({ name, args });
				if (name === "bash" && args.timeout !== undefined) {
					assert.equal(args.timeout, 3);
					writeFileSync(join(directory, "timeout", "leaf.pid"), String(timeoutLeaf));
					return { isError: true, result: { content: [{ type: "text", text: "Command timed out after 3 seconds" }] } };
				}
				if (name === "bash") {
					const id = ++counter;
					const dir = join(directory, id === 1 ? "first" : "survivor");
					writeFileSync(join(dir, "ready"), "ready");
					// The survivor must be a live process: timeout cleanup may not kill unrelated owned work.
					writeFileSync(join(dir, "leaf.pid"), String(id === 1 ? 101 : process.pid));
					tasks.set(id, {
						id,
						kind: "task",
						command: args.command,
						status: "background",
						procwardPid: 200 + id,
						provenance: { toolName: "bash", toolCallId: `installed-owner/${id}` },
					});
					return { isError: true, result: { structuredContent: { exit_code: 23 } } };
				}
				if (name === "process_list")
					return {
						isError: false,
						result: {
							structuredContent: {
								processes: [...(self ? [{ id: 0, kind: "session", procwardPid: 200 }] : []), ...tasks.values()],
							},
						},
					};
				assert.equal(name, "process_kill");
				assert.deepEqual(args.ids, [0, 1]);
				tasks.delete(1);
				return {
					isError: false,
					result: {
						structuredContent: {
							results: [
								{ id: 0, status: "not-cancellable" },
								{
									id: 1,
									status: unconfirmed ? "unconfirmed" : "confirmed",
									exitCode: 23,
									scope: "kernel",
									unconfirmed,
								},
							],
						},
					},
				};
			},
		};
		const result = await runInstalledOwnerContract(context, {
			runtime: process.execPath,
			fixtures,
			directory,
			toolCallId: "installed-owner",
		});
		assert.deepEqual(result.foreground, [23, 23]);
		assert.equal(result.survivorPid, process.pid);
		assert.deepEqual(result.timeout, { leafPid: timeoutLeaf, cleaned: true });
		assert.notEqual(result.causalAfter1600ms[1], result.survivorAfterCancellation);
		assert.deepEqual(
			calls.map((call) => call.name),
			["bash", "bash", "process_list", "process_kill", "process_list", "bash", "process_list"],
		);
		return result;
	} finally {
		clearInterval(timer);
		rmSync(directory, { recursive: true, force: true });
	}
}

test("installed contract exercises real public-tool shape, read-only self and causal survivor checks", () =>
	contract());
test("installed contract never credits unconfirmed cleanup", async () => {
	await assert.rejects(contract({ unconfirmed: true }));
});
test("installed contract rejects missing default-on session ownership before claiming success", async () => {
	await assert.rejects(contract({ self: false }), /session owner missing/);
});

test("installed contract rejects a bash timeout whose detached descendant survives", { timeout: 20000 }, async () => {
	await assert.rejects(contract({ timeoutLeafSurvives: true }), /timed-out owned scope kept/);
});

test("timeout workload keeps its primary running with a live detached leaf until killed", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-installed-timeout-"));
	const child = spawn(process.execPath, [join(fixtures, "descendant.mjs"), "timeout-primary", directory], {
		stdio: "ignore",
	});
	try {
		await waitFor(() => existsSync(join(directory, "leaf.pid")));
		assert.equal(child.exitCode, null);
		process.kill(Number(readFileSync(join(directory, "leaf.pid"), "utf8")), 0);
	} finally {
		child.kill("SIGKILL");
		writeFileSync(join(directory, "release"), "release");
		await waitFor(() => existsSync(join(directory, "finished")));
		rmSync(directory, { recursive: true, force: true });
	}
});

test("retained Node workload returns23 before its detached worker completes and accepts causal work", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-installed-workload-"));
	const child = spawn(process.execPath, [join(fixtures, "descendant.mjs"), "retained-primary", directory], {
		stdio: "ignore",
	});
	try {
		const [code] = await once(child, "close");
		assert.equal(code, 23);
		assert(existsSync(join(directory, "ready")) && !existsSync(join(directory, "finished")));
		writeFileSync(join(directory, "probe"), "causal-after-primary-return");
		await waitFor(() => existsSync(join(directory, "ack")));
		assert.equal(readFileSync(join(directory, "ack"), "utf8"), "causal-after-primary-return");
	} finally {
		writeFileSync(join(directory, "release"), "release");
		await waitFor(() => existsSync(join(directory, "finished")));
		rmSync(directory, { recursive: true, force: true });
	}
});
