import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const quote = (value) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
async function challenge(directory) {
	const nonce = randomBytes(16).toString("hex");
	writeFileSync(join(directory, "probe"), nonce);
	const deadline = performance.now() + 10000;
	while (!existsSync(join(directory, "ack")) || readFileSync(join(directory, "ack"), "utf8") !== nonce) {
		assert(performance.now() < deadline, "owned background worker did not causally acknowledge work");
		await delay(2);
	}
	return nonce;
}

/** Runs actual registered tools from an installed extension tool context; no copied transport. */
export async function runInstalledOwnerContract(context, { runtime, fixtures, directory, toolCallId }) {
	mkdirSync(directory, { recursive: true });
	const directories = [join(directory, "first"), join(directory, "survivor")];
	for (const dir of directories) mkdirSync(dir);
	const foreground = [];
	for (const dir of directories) {
		const command = `${quote(runtime)} ${quote(join(fixtures, "descendant.mjs"))} retained-primary ${quote(dir)}`;
		const outcome = await context.executeTool("bash", { command });
		const result = outcome.result.structuredContent;
		assert.equal(result?.exit_code, 23, JSON.stringify(outcome));
		assert(existsSync(join(dir, "ready")) && !existsSync(join(dir, "finished")));
		foreground.push(result.exit_code);
	}
	const listed = await context.executeTool("process_list", {});
	assert.equal(listed.isError, false, JSON.stringify(listed));
	const processes = listed.result.structuredContent.processes;
	const self = processes.find((entry) => entry.id === 0);
	assert(
		self?.kind === "session" && Number.isSafeInteger(self.procwardPid) && self.procwardPid > 0,
		"default-on installed session owner missing",
	);
	const tasks = directories.map((dir) =>
		processes.find((entry) => entry.kind === "task" && entry.command.includes(dir.replaceAll("\\", "/"))),
	);
	for (const task of tasks) {
		assert(
			task && task.id > 0 && task.status === "background" && task.procwardPid > 0,
			"returned command lost its owned background scope",
		);
		assert.equal(task.provenance?.toolName, "bash");
		assert(
			task.provenance.toolCallId.startsWith(`${toolCallId}/`),
			"nested bash provenance does not identify the actual triggering call",
		);
	}
	assert.notEqual(tasks[0].id, tasks[1].id);
	await delay(1600);
	const acknowledged = await Promise.all(directories.map(challenge));
	const killed = await context.executeTool("process_kill", { ids: [0, tasks[0].id] });
	assert.equal(killed.isError, false, JSON.stringify(killed));
	const results = killed.result.structuredContent.results;
	assert.equal(results[0].status, "not-cancellable");
	assert.deepEqual(results[1], {
		id: tasks[0].id,
		status: "confirmed",
		exitCode: 23,
		scope: "kernel",
		unconfirmed: false,
	});
	const after = await context.executeTool("process_list", {});
	assert.equal(after.isError, false);
	assert(!after.result.structuredContent.processes.some((entry) => entry.id === tasks[0].id));
	assert(
		after.result.structuredContent.processes.some((entry) => entry.id === tasks[1].id && entry.status === "background"),
	);
	const survivorAfterCancellation = await challenge(directories[1]);
	assert.notEqual(survivorAfterCancellation, acknowledged[1]);
	assert(!existsSync(join(directories[0], "finished")), "cancelled worker exited through its natural-release gate");
	return {
		foreground,
		selfOwnerPid: self.procwardPid,
		taskIds: tasks.map((task) => task.id),
		taskOwnerPids: tasks.map((task) => task.procwardPid),
		actualProvenance: tasks.map((task) => task.provenance),
		causalAfter1600ms: acknowledged,
		cancellation: results,
		survivorAfterCancellation,
		survivorPid: Number(readFileSync(join(directories[1], "leaf.pid"), "utf8")),
	};
}
