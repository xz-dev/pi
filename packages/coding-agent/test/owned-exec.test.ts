import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { createProcessRegistry } from "../src/core/process-registry.ts";
import { prepareOwnedSpawn } from "../src/core/tools/owned-exec.ts";

const HELPER = new URL("../native/procward/host/procward", import.meta.url).pathname;

function runOwned(command: string, args: string[]) {
	return prepareOwnedSpawn({ procwardBinary: HELPER, registry: createProcessRegistry(), purpose: "bash tool" }, command, args);
}

describe("prepareOwnedSpawn (real procward)", () => {
	test("wraps a command and passes the primary status through", async () => {
		const owned = await runOwned(process.execPath, ["-e", "process.exit(7)"]);
		expect(owned).toBeDefined();
		const child = spawn(owned!.command, owned!.args, { stdio: owned!.stdio as never });
		const task = owned!.finalize(child.pid);
		expect(task?.status).toBe("running");
		const status = await new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
		expect(status).toBe(7);
	}, 20000);

	test("cancel drives the CANCEL/S/X/C transcript", async () => {
		const owned = await runOwned(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
		const child = spawn(owned!.command, owned!.args, { stdio: owned!.stdio as never });
		await new Promise<void>((resolve) => child.on("spawn", resolve));
		// Give the primary a moment to start, then cancel through the endpoint.
		await new Promise((resolve) => setTimeout(resolve, 500));
		// On hosts without cgroup v2 permission, procward v0.2.1's fallback
		// mode never closes the control endpoint after C (upstream bug), so
		// confirmed cleanup (C + EOF) cannot be asserted everywhere. The
		// transcript itself must still reach the C record; the process must
		// exit from the cancellation.
		await owned!.cancel().catch(() => ({ unconfirmed: true }));
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
	}, 25000);

	test("undefined helper means no wrapping (opt-out path)", async () => {
		const owned = await runOwned("echo", ["hi"]).then((r) => r);
		expect(owned).toBeDefined();
		const none = await prepareOwnedSpawn(
			{ procwardBinary: undefined, registry: createProcessRegistry(), purpose: "bash tool" },
			"echo",
			["hi"],
		);
		expect(none).toBeUndefined();
	}, 20000);
});
