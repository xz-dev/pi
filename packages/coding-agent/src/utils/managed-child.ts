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

import { readSync } from "node:fs";

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
	const chunks: Buffer[] = [];
	let total = 0;
	const scratch = Buffer.alloc(64);
	for (;;) {
		let bytesRead: number;
		try {
			bytesRead = readSync(fd, scratch, 0, scratch.length, null);
		} catch {
			return null; // transport error: treat as invalid contract
		}
		if (bytesRead === 0) {
			// EOF: a complete line already read is fine; a partial one is not.
			return total === 0 ? undefined : null;
		}
		const lf = scratch.subarray(0, bytesRead).indexOf(10);
		if (lf >= 0) {
			// Copy: `scratch` is reused by the next readSync call.
			chunks.push(Buffer.from(scratch.subarray(0, lf)));
			total += lf;
			if (total > MAX_RECORD_BYTES) return null;
			return Buffer.concat(chunks).toString("utf8");
		}
		chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
		total += bytesRead;
		if (total > MAX_RECORD_BYTES) return null;
	}
}

/**
 * Validate the managed-child contract for this process. Returns the contract
 * when every check passes, or undefined when the environment does not claim
 * management. Throws when the environment claims management but the contract
 * is invalid (fail closed: callers must not treat this as unmanaged).
 *
 * `readRecord` is injectable for tests; production reads the lifecycle fd.
 */
export function consumeManagedContract(
	env: ContractEnvironment,
	selfPid: number,
	parentPid: number,
	readRecord: (fd: number) => string | null | undefined = readLifecycleRecord,
): ManagedContract | undefined {
	if (env.protocol === undefined) return undefined;
	if (env.protocol !== "1") throw new Error("procward: unknown contract protocol");
	if (env.lifecycleFd === undefined || !/^[1-9][0-9]*$/.test(env.lifecycleFd)) {
		throw new Error("procward: missing lifecycle fd");
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
