import { describe, expect, test } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { createProcessRegistry } from "../src/core/process-registry.ts";

const HELPER = new URL("../native/procward/host/procward", import.meta.url).pathname;

describe("owned bash operations", () => {
	test("direct spawn path still works without ownership", async () => {
		const ops = createLocalBashOperations();
		const result = await ops.exec("echo direct-ok", process.cwd(), { onData: () => {} });
		expect(result.exitCode).toBe(0);
	}, 20000);

	test("owned exec wraps the shell and returns its status", async () => {
		const registry = createProcessRegistry();
		const ops = createLocalBashOperations({
			ownership: { procwardBinary: HELPER, registry, enabled: true, purpose: "bash tool" },
		});
		const chunks: Buffer[] = [];
		const result = await ops.exec("echo owned-ok", process.cwd(), { onData: (d) => chunks.push(d) });
		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString()).toContain("owned-ok");
		// Clean tree: the task settles out of the registry.
		expect(registry.list()).toHaveLength(0);
	}, 20000);

	test("background command is owned and cleaned by the wrapper contract", async () => {
		const registry = createProcessRegistry();
		const ops = createLocalBashOperations({
			ownership: { procwardBinary: HELPER, registry, enabled: true, purpose: "bash tool" },
		});
		const result = await ops.exec("sleep 30 & disown; echo started", process.cwd(), { onData: () => {} });
		expect(result.exitCode).toBe(0);
		// procward's contract cleans the whole tree once the primary (the
		// shell) exits: the orphaned sleep does not outlive the tool call, so
		// the registry settles empty and nothing leaks past the wrapper.
		expect(registry.list()).toHaveLength(0);
	}, 25000);

	test("running command is listed and cancellable through the registry", async () => {
		const registry = createProcessRegistry();
		const ops = createLocalBashOperations({
			ownership: { procwardBinary: HELPER, registry, enabled: true, purpose: "bash tool" },
		});
		const execPromise = ops.exec("sleep 30", process.cwd(), { onData: () => {} });
		// While the primary runs, the task is listed.
		await new Promise((resolve) => setTimeout(resolve, 800));
		const tasks = registry.list();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.status).toBe("running");
		tasks[0]!.cancel();
		const result = await execPromise;
		// Cancelled tree: nonzero (signal-terminated) status.
		expect(result.exitCode).not.toBe(0);
	}, 25000);
});
