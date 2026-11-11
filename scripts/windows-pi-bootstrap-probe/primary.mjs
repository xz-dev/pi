import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { resolveWindowsOwnershipHelper } from "../../packages/coding-agent/src/config.ts";
import { consumeWindowsManagedContract } from "../../packages/coding-agent/src/utils/managed-child.ts";
import { getProcessOwnership, processShutdownPending } from "../../packages/coding-agent/src/utils/procward.ts";
import { loadWindowsOwnershipHelper } from "../../packages/coding-agent/src/utils/windows-process-ownership.ts";

const mode = process.argv[2];
const env = {
	protocol: process.env.PROCWARD_PROTOCOL,
	ownerPid: process.env.PROCWARD_OWNER_PID,
	contractId: process.env.PROCWARD_CONTRACT_ID,
	lifecycleHandle: process.env.PROCWARD_LIFECYCLE_HANDLE,
};

async function main() {
	if (mode === "identity-mismatch") {
		const helper = loadWindowsOwnershipHelper(resolveWindowsOwnershipHelper());
		helper.prepareOwnershipPipe(env.lifecycleHandle);
		const limit = performance.now() + 2000;
		let record = "";
		while (!record.includes("\n")) {
			const bytes = helper.readOwnershipPipe(env.lifecycleHandle);
			assert(bytes !== null, "native lifecycle ended before READY");
			if (bytes) record += Buffer.from(bytes).toString("ascii");
			assert(record.length <= 256 && performance.now() < limit, "original READY bound");
			if (!bytes) await delay(2);
		}
		const parts = record.trimEnd().split(" ");
		assert.equal(parts.length, 6);
		const real = parts[4];
		parts[4] = `${real.slice(0, -1)}${(Number.parseInt(real.at(-1), 16) ^ 1).toString(16)}`;
		assert.throws(() => consumeWindowsManagedContract(env, process.pid, () => parts.join(" "), helper), /creation/);
		helper.closeOwnershipPipe(env.lifecycleHandle);
		console.log(
			JSON.stringify({ phase: "identity-rejected", pid: process.pid, realCreation: real, rejectedCreation: parts[4] }),
		);
		process.exitCode = 23;
		return;
	}
	if (mode === "wrong-owner") process.env.PROCWARD_OWNER_PID = "1";
	// This is the actual production entry bootstrap, not a copied consumer.
	await import("../../packages/coding-agent/src/cli-bootstrap.ts");
	const ownership = getProcessOwnership();
	if (mode === "off") {
		assert.equal(ownership.enabled, false);
		console.log(JSON.stringify({ phase: "off", pid: process.pid }));
		process.exitCode = 23;
		return;
	}
	const helper = loadWindowsOwnershipHelper(resolveWindowsOwnershipHelper());
	const native = helper.ownershipParentIdentity();
	assert(ownership.enabled && ownership.ownerPid === native.pid);
	assert(/^[0-9a-f]{16}$/.test(native.creationTime));
	for (const key of [
		"PROCWARD_PROTOCOL",
		"PROCWARD_OWNER_PID",
		"PROCWARD_CONTRACT_ID",
		"PROCWARD_LIFECYCLE_FD",
		"PROCWARD_LIFECYCLE_HANDLE",
		"PI_PROCWARD_BOOTSTRAP_NONCE",
	])
		assert.equal(process.env[key], undefined);
	assert.equal(processShutdownPending(), false);
	console.log(
		JSON.stringify({
			phase: "ready",
			pid: process.pid,
			ownerPid: ownership.ownerPid,
			nativeParentPid: native.pid,
			creationTime: native.creationTime,
			scrubbed: true,
			privateReaderAccepted: true,
		}),
	);
	if (mode === "hold") {
		setInterval(() => {}, 1000);
		return;
	}
	if (mode === "healthy") {
		await delay(7100);
		assert.equal(processShutdownPending(), false);
		console.log(JSON.stringify({ phase: "healthy-after-seven-seconds", pid: process.pid }));
	}
	process.exitCode = 23;
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
