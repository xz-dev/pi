import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createProcessRegistry, type OwnedSession } from "../src/core/process-registry.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";

// Native ownership tests require an explicit helper and a separate-kernel VM.
// Ordinary host test runs exercise only the direct-spawn case below.
const HELPER = process.env.PI_PROCWARD_VM_HELPER;

test("direct spawn path works without ownership", async () => {
	const chunks: Buffer[] = [];
	const result = await createLocalBashOperations().exec("echo direct-ok", process.cwd(), {
		onData: (chunk) => chunks.push(chunk),
	});
	expect(result.exitCode).toBe(0);
	expect(Buffer.concat(chunks).toString()).toBe("direct-ok\n");
});

describe.skipIf(HELPER === undefined || process.platform !== "linux")("Linux VM owned bash transparency", () => {
	const registries: OwnedSession[] = [];
	const directPids: number[] = [];

	beforeAll(() => {
		const hostBootId = process.env.PROCWARD_VM_HOST_BOOT_ID;
		expect(hostBootId, "native tests require the VM runner's host boot ID").toBeTruthy();
		expect(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()).not.toBe(hostBootId);
	});

	afterEach(() => {
		let rescued = false;
		for (const registry of registries.splice(0)) {
			for (const task of registry.list()) {
				rescued = true;
				task.cancel();
			}
		}
		for (const pid of directPids.splice(0)) {
			if (alive(pid)) {
				rescued = true;
				process.kill(pid, "SIGTERM");
			}
		}
		expect(rescued, "HARNESS RESCUE is not product cleanup").toBe(false);
	});

	function operations(enabled: boolean) {
		const registry = createProcessRegistry();
		registries.push(registry);
		return {
			registry,
			ops: createLocalBashOperations({
				ownership: { procwardBinary: HELPER, registry, enabled, purpose: "bash transparency fixture" },
			}),
		};
	}

	function alive(pid: number): boolean {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
	}

	test.each([false, true])("preserves foreground output and exit status (owned=%s)", async (enabled) => {
		const { ops, registry } = operations(enabled);
		const chunks: Buffer[] = [];
		const result = await ops.exec("printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2; exit 23", process.cwd(), {
			onData: (chunk) => chunks.push(chunk),
		});
		expect(result.exitCode).toBe(23);
		expect(Buffer.concat(chunks).toString().trim().split("\n").sort()).toEqual(["stderr-line", "stdout-line"]);
		await expect.poll(() => registry.list()).toEqual([]);
	});

	test.each([false, true])("returns without ending ordinary background work (owned=%s)", async (enabled) => {
		const { ops, registry } = operations(enabled);
		const chunks: Buffer[] = [];
		const result = await ops.exec("sleep 120 >/dev/null 2>&1 </dev/null & printf '%s\\n' \"$!\"", process.cwd(), {
			onData: (chunk) => chunks.push(chunk),
		});
		const pid = Number(Buffer.concat(chunks).toString().trim());
		expect(pid).toBeGreaterThan(1);
		if (!enabled) directPids.push(pid);
		expect(result.exitCode).toBe(0);
		expect(alive(pid)).toBe(true);
		if (enabled) {
			expect(registry.list()).toMatchObject([{ status: "background", purpose: "bash transparency fixture" }]);
			expect(registry.list()[0]!.procwardPid).toBeGreaterThan(1);
			registry.list()[0]!.cancel();
			await expect.poll(() => registry.list()).toEqual([]);
			await expect.poll(() => existsSync(`/proc/${pid}`)).toBe(false);
		} else {
			expect(registry.list()).toEqual([]);
			process.kill(pid, "SIGTERM");
			await expect.poll(() => alive(pid)).toBe(false);
		}
	});

	test.each([false, true])("keeps draining active output after primary exit (owned=%s)", async (enabled) => {
		const { ops, registry } = operations(enabled);
		const chunks: Buffer[] = [];
		const result = await ops.exec(
			"(for i in 1 2 3 4 5 6; do printf 'part-%s\\n' \"$i\"; sleep 0.04; done) & exit 7",
			process.cwd(),
			{ onData: (chunk) => chunks.push(chunk) },
		);
		expect(result.exitCode).toBe(7);
		expect(Buffer.concat(chunks).toString()).toBe("part-1\npart-2\npart-3\npart-4\npart-5\npart-6\n");
		await expect.poll(() => registry.list()).toEqual([]);
	});

	test.each([false, true])("preserves timeout metadata after shell exit (owned=%s)", async (enabled) => {
		const { ops, registry } = operations(enabled);
		await expect(
			ops.exec("(while :; do printf 'active\\n'; sleep 0.02; done) & exit 5", process.cwd(), {
				onData: () => {},
				timeout: 0.25,
			}),
		).rejects.toMatchObject({ message: "timeout:0.25", shellExit: { exitCode: 5 } });
		await expect.poll(() => registry.list()).toEqual([]);
	});

	test("cancels a running primary through its registry entry", async () => {
		const { ops, registry } = operations(true);
		let output = "";
		const execution = ops.exec("printf 'ready\\n'; sleep 120", process.cwd(), {
			onData: (chunk) => {
				output += chunk.toString();
			},
		});
		await expect.poll(() => output).toBe("ready\n");
		expect(registry.list()).toMatchObject([{ status: "running" }]);
		registry.list()[0]!.cancel();
		expect((await execution).exitCode).not.toBe(0);
		await expect.poll(() => registry.list()).toEqual([]);
	});
});
