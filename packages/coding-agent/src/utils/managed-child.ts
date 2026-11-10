/**
 * Procward managed-child contract, consumer side.
 *
 * When pi runs as a procward primary, procward grants a lifecycle pipe
 * (PROCWARD_LIFECYCLE_FD on Unix, PROCWARD_LIFECYCLE_HANDLE on Windows) whose
 * first record proves the managed relationship:
 *
 *   PROCWARD/1 READY <owner_pid> <primary_pid> <owner_identity> <launch_id>
 *
 * Acceptance (vendor/procward/docs/contract.md): owner PID and launch ID must
 * match PROCWARD_OWNER_PID / PROCWARD_CONTRACT_ID in the environment, the
 * primary PID must equal our own live PID, owner_identity is "parent" on Unix
 * and getppid() must equal the announced owner. An invalid, malformed, or
 * absent READY fails closed: pi is not managed by this handoff.
 *
 * After READY, the pipe carries OWNER-LOSS when the owner goes away; pipe EOF
 * is owner loss too. Managed pi bridges that into a bounded shutdown
 * (see owner-loss handling in the interactive/rpc modes).
 */

import { closeSync, fstatSync, readSync } from "node:fs";
import { Worker } from "node:worker_threads";

const MAX_RECORD_BYTES = 256;

export interface ManagedContract {
	readonly ownerPid: number;
	readonly launchId: string;
	readonly lifecycleFd: number;
}

export interface ContractEnvironment {
	readonly protocol?: string;
	readonly ownerPid?: string;
	readonly contractId?: string;
	readonly lifecycleFd?: string;
}

/** Which env vars the contract consumes (also stripped from tool children). */
export const CONTRACT_ENV_KEYS = [
	"PROCWARD_PROTOCOL",
	"PROCWARD_OWNER_PID",
	"PROCWARD_CONTRACT_ID",
	"PROCWARD_LIFECYCLE_FD",
	"PROCWARD_LIFECYCLE_HANDLE",
] as const;

function isPositiveDecimalPid(value: string): boolean {
	return /^[1-9][0-9]*$/.test(value);
}

function isLaunchId(value: string): boolean {
	return /^[0-9a-f]{32}$/.test(value);
}

/**
 * Read one LF-terminated record (at most MAX_RECORD_BYTES) from the lifecycle
 * pipe. Returns the line without LF, or undefined at EOF with no data.
 * Oversized or partial records are contract violations (null).
 */
export function readLifecycleRecord(fd: number): string | null | undefined {
	// Reading exactly through LF preserves a coalesced following record for
	// the owner-loss observer. The protocol includes LF in its 256-byte cap.
	const record = Buffer.alloc(MAX_RECORD_BYTES);
	for (let offset = 0; offset < record.length; offset++) {
		let count: number;
		try {
			count = readSync(fd, record, offset, 1, null);
		} catch {
			return null;
		}
		if (count === 0) return offset === 0 ? undefined : null;
		if (record[offset] === 10) return record.subarray(0, offset).toString("ascii");
		if (record[offset] < 32 || record[offset] > 126) return null;
	}
	return null;
}

/**
 * Validate the managed-child contract for this process. Returns the contract
 * when every check passes, or undefined when the environment does not claim
 * management. Throws when the environment claims management but the contract
 * is invalid (fail closed: callers must not treat this as unmanaged).
 *
 * `readRecord` supplies framing; bootstrap uses its deadline-bounded worker reader.
 */
export function consumeManagedContract(
	env: ContractEnvironment,
	selfPid: number,
	parentPid: number,
	readRecord: (fd: number) => string | null | undefined = readLifecycleRecord,
): ManagedContract | undefined {
	if (env.protocol === undefined) return undefined;
	if (env.protocol !== "1") throw new Error("procward: unknown contract protocol");
	if (
		env.lifecycleFd === undefined ||
		!/^[1-9][0-9]*$/.test(env.lifecycleFd) ||
		!Number.isSafeInteger(Number(env.lifecycleFd)) ||
		Number(env.lifecycleFd) <= 2
	) {
		throw new Error("procward: invalid lifecycle fd");
	}
	if (env.ownerPid === undefined || !isPositiveDecimalPid(env.ownerPid)) {
		throw new Error("procward: missing owner pid");
	}
	if (env.contractId === undefined || !isLaunchId(env.contractId)) {
		throw new Error("procward: missing contract id");
	}

	const record = readRecord(Number(env.lifecycleFd));
	if (record === undefined) throw new Error("procward: lifecycle closed before READY");
	if (record === null) throw new Error("procward: invalid lifecycle record");

	const parts = record.split(" ");
	if (parts.length !== 6 || parts[0] !== "PROCWARD/1" || parts[1] !== "READY") {
		throw new Error("procward: expected READY record");
	}
	const [, , ownerPid, primaryPid, ownerIdentity, launchId] = parts;
	if (ownerPid !== env.ownerPid) throw new Error("procward: READY owner pid mismatch");
	if (launchId !== env.contractId) throw new Error("procward: READY launch id mismatch");
	if (!isPositiveDecimalPid(primaryPid) || Number(primaryPid) !== selfPid) {
		throw new Error("procward: READY primary pid mismatch");
	}
	if (ownerIdentity !== "parent") throw new Error("procward: unsupported owner identity");
	if (Number(ownerPid) !== parentPid) throw new Error("procward: owner is not the immediate parent");

	return { ownerPid: Number(ownerPid), launchId, lifecycleFd: Number(env.lifecycleFd) };
}

/**
 * Observe the lifecycle pipe for owner loss after a validated contract.
 *
 * A dedicated worker observes the inherited pipe asynchronously, so it can
 * shut down without a blocked read retaining the process. On loss, it arms
 * its own fatal timer before notifying the main thread; a blocked main loop
 * cannot prevent that deadline from firing. This observer exclusively owns
 * the endpoint until its worker exits; callers must not close or reuse it.
 */
export function observeOwnerLoss(contract: ManagedContract, onLoss: (reason: string) => void): () => void {
	return startLifecycleObserver(contract, onLoss);
}

/** Validate READY within two seconds, then observe owner loss on the same endpoint. */
export function consumeAndObserveManagedContract(
	env: ContractEnvironment,
	selfPid: number,
	parentPid: number,
	onLoss: (reason: string) => void,
): void {
	let stop: (() => void) | undefined;
	try {
		const contract = consumeManagedContract(env, selfPid, parentPid, (fd) => {
			const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT + MAX_RECORD_BYTES);
			const state = new Int32Array(shared, 0, 1);
			// consumeManagedContract validates environment fields before invoking the reader.
			stop = startLifecycleObserver(
				{ ownerPid: Number(env.ownerPid), launchId: env.contractId!, lifecycleFd: fd },
				onLoss,
				shared,
			);
			if (Atomics.wait(state, 0, 0, 2000) === "timed-out") {
				throw new Error("procward: READY startup deadline exceeded");
			}
			const length = Atomics.load(state, 0);
			return length < 0 ? null : Buffer.from(shared, Int32Array.BYTES_PER_ELEMENT, length).toString("ascii");
		});
		if (!contract) throw new Error("procward: missing bootstrap contract");
		// Reading READY may outlive the parent; recheck the kernel relationship at acceptance.
		if (contract.ownerPid !== process.ppid) throw new Error("procward: owner is not the immediate parent");
	} catch (error) {
		stop?.();
		throw error;
	}
}

function startLifecycleObserver(
	contract: ManagedContract,
	onLoss: (reason: string) => void,
	ready?: SharedArrayBuffer,
): () => void {
	// The inherited OS descriptor is a trust boundary; reject invalid Bun fds before taking ownership.
	if (process.versions.bun) fstatSync(contract.lifecycleFd);
	const workerSource = `
import { parentPort, workerData } from "node:worker_threads";
import { Socket } from "node:net";
import { Readable } from "node:stream";
let lost = false;
let record = "";
let pendingReady = workerData.ready !== undefined;
function readiness(length) {
 const state = new Int32Array(workerData.ready, 0, 1);
 if (length >= 0) new Uint8Array(workerData.ready, 4).set(Buffer.from(record, "ascii"));
 Atomics.store(state, 0, length);
 Atomics.notify(state, 0);
 pendingReady = false;
 record = "";
}
function loss(reason) {
 if (pendingReady) { readiness(-1); pipe.destroy(); return; }
 if (lost) return;
 lost = true;
 // This timer remains independent of a blocked main loop.
 setTimeout(() => process.kill(workerData.pid, "SIGKILL"), 7000);
 parentPort.postMessage(reason);
}
const pipe = process.versions.bun
 ? Readable.fromWeb(Bun.file(workerData.fd).stream())
 : new Socket({ fd: workerData.fd, readable: true, writable: false });
pipe.on("data", chunk => {
 for (const byte of chunk) {
  if (lost) return;
  if (byte === 10) {
   if (pendingReady) { readiness(record.length); continue; }
   loss(record === "PROCWARD/1 OWNER-LOSS " + workerData.launchId ? "owner-loss" : "invalid-record");
   return;
  }
  if (byte < 32 || byte > 126 || record.length >= 255) { loss("invalid-record"); return; }
  record += String.fromCharCode(byte);
 }
});
pipe.once("end", () => loss(record.length === 0 ? "eof" : "invalid-record"));
pipe.once("error", () => loss("read-error"));
`;
	const worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`), {
		workerData: { fd: contract.lifecycleFd, launchId: contract.launchId, pid: process.pid, ready },
		resourceLimits: { maxOldGenerationSizeMb: 32 },
	});
	// Bun's stream owns a duplicate; release the inherited endpoint only after the worker exits.
	if (process.versions.bun) worker.once("exit", () => closeSync(contract.lifecycleFd));
	worker.once("message", (reason: string) => onLoss(reason));
	worker.once("error", () => onLoss("worker-error"));
	worker.unref();
	return () => {
		void worker.terminate();
	};
}
