import { afterEach, describe, expect, test, vi } from "vitest";
import { hasBootstrapNonce, ownershipDisabled, ownCliProcess } from "../src/utils/procward.ts";

const ORIGINAL_NONCE = process.env.PI_PROCWARD_BOOTSTRAP_NONCE;
const ORIGINAL_DISABLE = process.env.PI_NO_PROCESS_OWNERSHIP;

afterEach(() => {
	for (const key of ["PI_PROCWARD_BOOTSTRAP_NONCE", "PI_NO_PROCESS_OWNERSHIP"]) {
		if (process.env[key] === undefined) delete process.env[key];
	}
	if (ORIGINAL_NONCE === undefined) delete process.env.PI_PROCWARD_BOOTSTRAP_NONCE;
	else process.env.PI_PROCWARD_BOOTSTRAP_NONCE = ORIGINAL_NONCE;
	if (ORIGINAL_DISABLE === undefined) delete process.env.PI_NO_PROCESS_OWNERSHIP;
	else process.env.PI_NO_PROCESS_OWNERSHIP = ORIGINAL_DISABLE;
});

describe("ownershipDisabled", () => {
	test("flag disables for this invocation", () => {
		expect(ownershipDisabled(["--no-process-ownership"])).toBe(true);
	});

	test("environment variable disables inherited invocations", () => {
		process.env.PI_NO_PROCESS_OWNERSHIP = "1";
		expect(ownershipDisabled(["--model", "x"])).toBe(true);
	});

	test("flag as another option's value does not disable", () => {
		expect(ownershipDisabled(["--system-prompt", "--no-process-ownership"])).toBe(false);
		expect(ownershipDisabled(["--name", "--no-process-ownership"])).toBe(false);
		expect(ownershipDisabled(["--use-theme", "--no-process-ownership"])).toBe(false);
	});

	test("flag after -- is a positional value, not a switch", () => {
		expect(ownershipDisabled(["--", "--no-process-ownership"])).toBe(false);
	});

	test("value options skip their argument", () => {
		expect(ownershipDisabled(["--model", "--no-process-ownership"])).toBe(false);
	});

	test("plain invocation keeps ownership", () => {
		expect(ownershipDisabled(["--model", "gpt"])).toBe(false);
	});
});

describe("ownCliProcess", () => {
	test("disabled invocation continues immediately and clears a stale nonce", () => {
		process.env.PI_PROCWARD_BOOTSTRAP_NONCE = "stale";
		expect(ownCliProcess(["--no-process-ownership"], { resolveBinary: () => "/bin/true" })).toBeUndefined();
		expect(hasBootstrapNonce()).toBe(false);
	});

	test("own bootstrap nonce without contract env is stale, not accepted", () => {
		process.env.PI_PROCWARD_BOOTSTRAP_NONCE = "mine";
		// No PROCWARD_* env: consumeManagedContract reports unmanaged, so the
		// nonce alone must NOT skip wrapping (fail closed on stale markers).
		const status = ownCliProcess(["chat"], { resolveBinary: () => "/nonexistent-procward" });
		expect(status).toBeGreaterThan(0);
		expect(hasBootstrapNonce()).toBe(false);
	});

	test("missing helper continues without ownership", () => {
		expect(ownCliProcess(["chat"], { resolveBinary: () => undefined })).toBeUndefined();
	});

	test("unmanaged invocation re-execs under the owner and returns its status", () => {
		// The real vendored helper: procward run -- sh -c 'exit 42' must surface
		// the primary's status through the ownership lifecycle.
		const helper = new URL("../native/procward/host/procward", import.meta.url).pathname;
		const resolveBinary = vi.fn(() => helper);
		const status = ownCliProcess(["-c", "exit 42"], { resolveBinary });
		expect(resolveBinary).toHaveBeenCalled();
		// process.execPath (node) runs with args; node -c is invalid, so the
		// owner reports a nonzero status — assert a defined code, not 0.
		expect(status).toBeDefined();
		expect(status).toBeGreaterThan(0);
		expect(hasBootstrapNonce()).toBe(false);
	});

	test("re-exec passes a clean environment decision to the child", () => {
		const helper = new URL("../native/procward/host/procward", import.meta.url).pathname;
		// The child (node, bad argv) exits fast; we only assert the parent did
		// not crash while building the environment.
		const status = ownCliProcess(["--version"], { resolveBinary: () => helper });
		expect(status).toBeDefined();
	});
});

describe("ownCliProcess handoff validation", () => {
	test("nonce with a valid contract consumes and continues", () => {
		process.env.PI_PROCWARD_BOOTSTRAP_NONCE = "mine";
		const status = ownCliProcess(["chat"], {
			resolveBinary: () => "/bin/false",
			consumeContract: (env) => {
				void env;
				return { ownerPid: 9, launchId: "f".repeat(32), lifecycleFd: 7 };
			},
		});
		expect(status).toBeUndefined();
		expect(hasBootstrapNonce()).toBe(false);
	});

	test("nonce without contract env is stale: wraps again", () => {
		process.env.PI_PROCWARD_BOOTSTRAP_NONCE = "stale";
		// consumeContract reports "unmanaged" (undefined): must re-wrap,
		// which with a broken binary surfaces a nonzero status.
		const status = ownCliProcess(["chat"], {
			resolveBinary: () => "/nonexistent-procward",
			consumeContract: () => undefined,
		});
		expect(status).toBeGreaterThan(0);
		expect(hasBootstrapNonce()).toBe(false);
	});

	test("nonce with a mismatched contract fails closed with a diagnostic", () => {
		process.env.PI_PROCWARD_BOOTSTRAP_NONCE = "spoofed";
		expect(() =>
			ownCliProcess(["chat"], {
				resolveBinary: () => "/bin/false",
				consumeContract: () => {
					throw new Error("procward: READY launch id mismatch");
				},
			}),
		).toThrow(/launch id mismatch/);
	});
});
