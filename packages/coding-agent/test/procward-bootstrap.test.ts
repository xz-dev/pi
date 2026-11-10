import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { consumeManagedContract } from "../src/utils/managed-child.ts";
import { hasBootstrapNonce, ownCliProcess, ownershipDisabled } from "../src/utils/procward.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const launchId = "a".repeat(32);
const spawnOwner = vi.mocked(spawnSync);
const execOwner = vi.fn<NonNullable<typeof process.execve>>(() => {
	throw new Error("exec fixture");
});
const ownerResult = {
	pid: 123,
	output: [null, Buffer.alloc(0), Buffer.alloc(0)],
	stdout: Buffer.alloc(0),
	stderr: Buffer.alloc(0),
	status: 42,
	signal: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	if (process.execve) vi.spyOn(process, "execve").mockImplementation(execOwner);
	for (const key of [
		"PI_PROCWARD_BOOTSTRAP_NONCE",
		"PI_NO_PROCESS_OWNERSHIP",
		"PI_PROCWARD_BIN",
		"PROCWARD_PROTOCOL",
		"PROCWARD_OWNER_PID",
		"PROCWARD_CONTRACT_ID",
		"PROCWARD_LIFECYCLE_FD",
	]) {
		vi.stubEnv(key, undefined);
	}
	spawnOwner.mockReturnValue(ownerResult);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("ownershipDisabled", () => {
	test("explicit invocation and inherited opt-outs", () => {
		expect(ownershipDisabled(["--no-process-ownership"])).toBe(true);
		vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "1");
		expect(ownershipDisabled([])).toBe(true);
	});

	test.each(["--model", "--name", "--system-prompt"])("%s consumes its value before opt-out scanning", (option) => {
		expect(ownershipDisabled([option, "--no-process-ownership"])).toBe(false);
	});

	test("-- terminates option scanning", () => {
		expect(ownershipDisabled(["--", "--no-process-ownership"])).toBe(false);
		expect(ownershipDisabled(["--model", "example"])).toBe(false);
	});
});

describe("ownCliProcess", () => {
	test.each(["0", "1", "2", "9007199254740992"])("rejects invalid lifecycle fd %s before reading", (lifecycleFd) => {
		const readRecord = vi.fn();
		expect(() => consumeManagedContract({ protocol: "1", lifecycleFd }, 100, 200, readRecord)).toThrow(
			"lifecycle fd",
		);
		expect(readRecord).not.toHaveBeenCalled();
	});
	test.each(["--mode", "--use-theme", "--tui-mode"])("%s does not consume a flag-looking value", (option) => {
		expect(ownershipDisabled([option, "--no-process-ownership"])).toBe(true);
	});

	test("print accepts a documented flag-looking prompt without hiding later opt-out", () => {
		expect(ownershipDisabled(["-p", "---no-process-ownership"])).toBe(false);
		expect(ownershipDisabled(["-p", "---prompt", "--no-process-ownership"])).toBe(true);
	});

	test("missing helper fails closed for source and npm invocations too", () => {
		expect(() => ownCliProcess([], { resolveBinary: () => undefined })).toThrow("--no-process-ownership");
	});

	test("stale and malformed own markers fail closed rather than rewrap", () => {
		for (const nonce of ["stale", "a".repeat(32)]) {
			vi.stubEnv("PI_PROCWARD_BOOTSTRAP_NONCE", nonce);
			expect(() => ownCliProcess([], { resolveBinary: () => "/unused" })).toThrow(/handoff|nonce/i);
			expect(hasBootstrapNonce()).toBe(false);
		}
		expect(spawnOwner).not.toHaveBeenCalled();
	});

	test("external metadata alone is not consumed as our handoff", () => {
		vi.stubEnv("PROCWARD_PROTOCOL", "1");
		const consumeContract = vi.fn();
		expect(ownCliProcess([], { resolveBinary: () => "/helper", consumeContract, standalone: true })).toBe(42);
		expect(consumeContract).not.toHaveBeenCalled();
	});

	test("opt-out never resolves or launches a helper", () => {
		vi.stubEnv("PI_PROCWARD_BOOTSTRAP_NONCE", "stale");
		const resolveBinary = vi.fn(() => "/unused");
		expect(ownCliProcess(["--no-process-ownership"], { resolveBinary })).toBeUndefined();
		expect(resolveBinary).not.toHaveBeenCalled();
		expect(spawnOwner).not.toHaveBeenCalled();
		expect(hasBootstrapNonce()).toBe(false);
	});

	test.skipIf(process.platform === "win32" || !!process.versions.bun)(
		"Node exec preserves runtime arguments, the CLI entry, and user arguments",
		() => {
			vi.stubEnv("PI_PROCWARD_BIN", "/explicit/helper");
			expect(() =>
				ownCliProcess(["--model", "example", "hello world"], { resolveBinary: () => "/explicit/helper" }),
			).toThrow("--no-process-ownership");
			expect(execOwner).toHaveBeenCalledWith(
				"/explicit/helper",
				[
					"/explicit/helper",
					"run",
					"--quiet",
					"--",
					process.execPath,
					...process.execArgv,
					process.argv[1],
					"--model",
					"example",
					"hello world",
				],
				expect.objectContaining({
					PI_PROCWARD_BIN: "/explicit/helper",
					PI_PROCWARD_BOOTSTRAP_NONCE: expect.stringMatching(/^[a-f0-9]{32}$/),
				}),
			);
			expect(spawnOwner).not.toHaveBeenCalled();
		},
	);

	test.skipIf(process.platform === "win32" || !!process.versions.bun)(
		"unavailable Node exec fails closed instead of waiting in a wrapper",
		() => {
			process.execve = undefined;
			expect(() => ownCliProcess([], { resolveBinary: () => "/helper" })).toThrow("--no-process-ownership");
			expect(spawnOwner).not.toHaveBeenCalled();
		},
	);

	test("standalone relaunch does not add a Node script entry", () => {
		ownCliProcess(["--help"], { resolveBinary: () => "/helper", standalone: true });
		expect(spawnOwner).toHaveBeenCalledWith(
			"/helper",
			["run", "--quiet", "--", process.execPath, "--help"],
			expect.any(Object),
		);
	});

	test("maps real PROCWARD environment variables into the READY validator", () => {
		vi.stubEnv("PI_PROCWARD_BOOTSTRAP_NONCE", "b".repeat(32));
		vi.stubEnv("PROCWARD_PROTOCOL", "1");
		vi.stubEnv("PROCWARD_OWNER_PID", "200");
		vi.stubEnv("PROCWARD_CONTRACT_ID", launchId);
		vi.stubEnv("PROCWARD_LIFECYCLE_FD", "7");
		const observeLoss = vi.fn(() => () => {});
		const resolveBinary = vi.fn(() => "/unused");
		expect(
			ownCliProcess([], {
				resolveBinary,
				selfPid: 100,
				parentPid: 200,
				consumeContract: (env, self, parent) =>
					consumeManagedContract(env, self, parent, () => `PROCWARD/1 READY 200 100 parent ${launchId}`),
				observeLoss,
			}),
		).toBeUndefined();
		expect(observeLoss).toHaveBeenCalledWith({ ownerPid: 200, launchId, lifecycleFd: 7 }, expect.any(Function));
		expect(hasBootstrapNonce()).toBe(false);
		expect(resolveBinary).not.toHaveBeenCalled();
		expect(spawnOwner).not.toHaveBeenCalled();
	});

	test("invalid READY fails before relaunch", () => {
		vi.stubEnv("PROCWARD_PROTOCOL", "1");
		vi.stubEnv("PI_PROCWARD_BOOTSTRAP_NONCE", "b".repeat(32));
		expect(() =>
			ownCliProcess([], {
				resolveBinary: () => "/unused",
				consumeContract: () => {
					throw new Error("invalid READY");
				},
			}),
		).toThrow("invalid READY");
		expect(spawnOwner).not.toHaveBeenCalled();
	});

	test("spawn failure points at the explicit opt-out", () => {
		spawnOwner.mockReturnValue({ ...ownerResult, status: null, error: new Error("ENOENT") });
		expect(() => ownCliProcess([], { resolveBinary: () => "/missing", standalone: true })).toThrow(
			"--no-process-ownership",
		);
	});

	test("preserves signal-derived status", () => {
		spawnOwner.mockReturnValue({ ...ownerResult, status: null, signal: "SIGTERM" });
		expect(ownCliProcess([], { resolveBinary: () => "/helper", standalone: true })).toBe(143);
	});

	test("missing helper is not silently ignored", () => {
		expect(() => ownCliProcess([], { resolveBinary: () => undefined })).toThrow("--no-process-ownership");
	});
});
