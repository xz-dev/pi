import { closeSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { consumeManagedContract, readLifecycleRecord } from "../src/utils/managed-child.ts";

const openFds: number[] = [];
afterEach(() => {
	while (openFds.length > 0) closeSync(openFds.pop()!);
});

function readyRecord(ownerPid: number, primaryPid: number, launchId: string): string {
	return `PROCWARD/1 READY ${ownerPid} ${primaryPid} parent ${launchId}`;
}

const LAUNCH = "a".repeat(32);

describe("consumeManagedContract", () => {
	test("no protocol env means unmanaged", () => {
		expect(consumeManagedContract({}, 100, 200)).toBeUndefined();
	});

	test("valid READY accepts the contract", () => {
		const contract = consumeManagedContract(
			{ protocol: "1", ownerPid: "200", contractId: LAUNCH, lifecycleFd: "7" },
			100,
			200,
			() => readyRecord(200, 100, LAUNCH),
		);
		expect(contract).toEqual({ ownerPid: 200, launchId: LAUNCH, lifecycleFd: 7 });
	});

	test("unknown protocol fails closed", () => {
		expect(() =>
			consumeManagedContract({ protocol: "2", ownerPid: "200", contractId: LAUNCH, lifecycleFd: "7" }, 100, 200),
		).toThrow(/unknown contract protocol/);
	});

	test("stale handoff: launch id mismatch fails closed", () => {
		const other = "b".repeat(32);
		expect(() =>
			consumeManagedContract(
				{ protocol: "1", ownerPid: "200", contractId: LAUNCH, lifecycleFd: "7" },
				100,
				200,
				() => readyRecord(200, 100, other),
			),
		).toThrow(/launch id mismatch/);
	});

	test("owner pid env mismatch fails closed", () => {
		expect(() =>
			consumeManagedContract(
				{ protocol: "1", ownerPid: "300", contractId: LAUNCH, lifecycleFd: "7" },
				100,
				300,
				() => readyRecord(200, 100, LAUNCH),
			),
		).toThrow(/owner pid mismatch/);
	});

	test("primary pid mismatch fails closed", () => {
		expect(() =>
			consumeManagedContract(
				{ protocol: "1", ownerPid: "200", contractId: LAUNCH, lifecycleFd: "7" },
				999,
				200,
				() => readyRecord(200, 100, LAUNCH),
			),
		).toThrow(/primary pid mismatch/);
	});

	test("owner is not the immediate parent fails closed", () => {
		expect(() =>
			consumeManagedContract(
				{ protocol: "1", ownerPid: "200", contractId: LAUNCH, lifecycleFd: "7" },
				100,
				400,
				() => readyRecord(200, 100, LAUNCH),
			),
		).toThrow(/not the immediate parent/);
	});

	test("EOF before READY fails closed", () => {
		expect(() =>
			consumeManagedContract(
				{ protocol: "1", ownerPid: "200", contractId: LAUNCH, lifecycleFd: "7" },
				100,
				200,
				() => undefined,
			),
		).toThrow(/lifecycle closed before READY/);
	});

	test("malformed record fails closed", () => {
		expect(() =>
			consumeManagedContract(
				{ protocol: "1", ownerPid: "200", contractId: LAUNCH, lifecycleFd: "7" },
				100,
				200,
				() => "PROCWARD/1 GARBAGE",
			),
		).toThrow(/expected READY/);
	});
});

describe("readLifecycleRecord (real fd framing)", () => {
	test("reads one LF-terminated record from a real fd", () => {
		const fd = writeTempThenReopen(`${readyRecord(200, 100, LAUNCH)}\n`);
		expect(readLifecycleRecord(fd)).toBe(readyRecord(200, 100, LAUNCH));
	});

	test("EOF with no data yields undefined", () => {
		const fd = writeTempThenReopen("");
		expect(readLifecycleRecord(fd)).toBeUndefined();
	});

	test("partial record without LF at EOF is invalid", () => {
		const fd = writeTempThenReopen("PROCWARD/1 READY partial");
		expect(readLifecycleRecord(fd)).toBeNull();
	});

	test("oversized record without LF is invalid", () => {
		const fd = writeTempThenReopen("x".repeat(300));
		expect(readLifecycleRecord(fd)).toBeNull();
	});
});

function writeTempThenReopen(content: string): number {
	const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-"));
	const path = join(dir, "pipe");
	writeFileSync(path, content);
	const fd = openSync(path, "r");
	openFds.push(fd);
	return fd;
}
