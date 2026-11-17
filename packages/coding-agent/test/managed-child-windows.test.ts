import { describe, expect, it, vi } from "vitest";
import { consumeWindowsManagedContract } from "../src/utils/managed-child.ts";

const launch = "0123456789abcdef0123456789abcdef";
const time = "01dffffffffffff0";
const handle = "9007199254740993";
const env = { protocol: "1", ownerPid: "72", contractId: launch, lifecycleHandle: handle };
const ready = `PROCWARD/1 READY 72 91 ${time} ${launch}`;

function parent(pid = 72, creationTime = time) {
	return { ownershipParentIdentity: vi.fn(() => ({ pid, creationTime })) };
}

describe("Windows native managed-child acceptance", () => {
	it("accepts the live native parent identity and preserves the HANDLE string without Number rounding", () => {
		const read = vi.fn(() => ready);
		const native = parent();
		expect(consumeWindowsManagedContract(env, 91, read, native)).toEqual({
			ownerPid: 72,
			launchId: launch,
			lifecycleHandle: handle,
		});
		expect(read).toHaveBeenCalledWith(handle);
		expect(native.ownershipParentIdentity).toHaveBeenCalledTimes(1);
	});

	it("does not infer native ownership from an announced or JavaScript parent PID", () => {
		expect(() => consumeWindowsManagedContract(env, 91, () => ready, parent(73))).toThrow(/native parent/);
	});

	it("rejects a one-bit creation FILETIME mismatch beyond Number precision", () => {
		expect(Number(BigInt(`0x${time}`))).toBe(Number(BigInt("0x01dffffffffffff1")));
		expect(() => consumeWindowsManagedContract(env, 91, () => ready, parent(72, "01dffffffffffff1"))).toThrow(
			/creation/,
		);
	});

	it("propagates a dead or inaccessible native owner query instead of accepting its stale PID", () => {
		const native = {
			ownershipParentIdentity: () => {
				throw new Error("native parent is not live");
			},
		};
		expect(() => consumeWindowsManagedContract(env, 91, () => ready, native)).toThrow(/not live/);
	});

	it("rejects wrong primary, owner, launch, identity kind and incomplete readiness", () => {
		for (const record of [
			undefined,
			null,
			ready.replace("72 91", "73 91"),
			ready.replace("72 91", "72 92"),
			ready.replace(time, "parent"),
			ready.replace(launch, "f".repeat(32)),
		]) {
			expect(() => consumeWindowsManagedContract(env, 91, () => record, parent())).toThrow();
		}
	});

	it("rejects malformed or wrong-platform claims before touching a pipe or querying a process", () => {
		for (const fields of [
			{ protocol: "2" },
			{ lifecycleFd: "3" },
			{ lifecycleHandle: "0" },
			{ lifecycleHandle: "01" },
			{ lifecycleHandle: "18446744073709551616" },
			{ ownerPid: "0" },
			{ contractId: "wrong" },
		]) {
			const read = vi.fn(() => ready);
			const native = parent();
			expect(() => consumeWindowsManagedContract({ ...env, ...fields }, 91, read, native)).toThrow();
			expect(read).not.toHaveBeenCalled();
			expect(native.ownershipParentIdentity).not.toHaveBeenCalled();
		}
	});
});
