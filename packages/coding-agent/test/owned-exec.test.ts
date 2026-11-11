import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createProcessRegistry } from "../src/core/process-registry.ts";
import { prepareOwnedSpawn } from "../src/core/tools/owned-exec.ts";
import { waitForChildProcess } from "../src/utils/child-process.ts";

// Node-only protocol peers: no native procward execution or tree killing on
// the host. Native task lifecycle checks run in procward's disposable VMs.
const children: ChildProcess[] = [];
afterEach(() => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
});

function fixture(transcript: string, waitForCancel = false, primaryBeforeCancel?: number) {
	const registry = createProcessRegistry();
	const owned = prepareOwnedSpawn(
		{ procwardBinary: "/unused-native-helper", registry, purpose: "protocol fixture" },
		"command",
		["argument"],
	);
	if (!owned) throw new Error("expected an ownership control channel");
	const script = `
const { Socket } = require("node:net");
const channel = new Socket({ fd: 3 });
channel.on("error", () => process.exit(1));
const payload = ${JSON.stringify(transcript)}.replaceAll("{pid}", String(process.pid));
if (${waitForCancel}) {
 channel.write("PROCWARD/1 S " + process.pid + " kernel\\n" + ${JSON.stringify(primaryBeforeCancel === undefined ? "" : `PROCWARD/1 X ${primaryBeforeCancel}\n`)});
 let request = "";
 channel.on("data", bytes => {
  request += bytes.toString();
  if (request.includes("\\n")) {
   channel.end(request === "PROCWARD/1 CANCEL\\n" ? payload : "PROCWARD/1 E 125\\n");
  }
 });
} else {
 channel.end(payload);
}
`;
	const child = spawn(process.execPath, ["-e", script], { stdio: owned.stdio });
	children.push(child);
	owned.finalize(child);
	return { owned, registry, child };
}

describe.skipIf(process.platform === "win32")("procward task control adapter", () => {
	test("confirms exactly S, X, C and transport EOF", async () => {
		const { owned, registry } = fixture("PROCWARD/1 S {pid} kernel\nPROCWARD/1 X 7\nPROCWARD/1 C kernel\n");
		expect(await owned.ready).toMatchObject({ purpose: "protocol fixture" });
		expect(await owned.primaryExit).toBe(7);
		expect(await owned.completion).toEqual({ exitCode: 7, scope: "kernel", unconfirmed: false });
		expect(registry.list()).toEqual([]);
	});

	test("returns the primary result while background ownership remains live", async () => {
		const { owned, registry, child } = fixture("PROCWARD/1 C kernel\n", true, 7);
		expect(owned.args).toEqual(["run", "--retain-descendants", "--control-fd", "3", "--", "command", "argument"]);
		const result = await waitForChildProcess(child, owned.primaryExit);
		expect(result).toBe(7);
		expect(child.exitCode).toBeNull();
		expect(registry.list()).toMatchObject([{ status: "background" }]);
		expect(await owned.cancel()).toEqual({ exitCode: 7, scope: "kernel", unconfirmed: false });
		expect(registry.list()).toEqual([]);
	});

	test("cancel sends the bounded request and is idempotent", async () => {
		const { owned } = fixture("PROCWARD/1 X 143\nPROCWARD/1 C kernel\n", true);
		expect(await owned.ready).toMatchObject({ status: "running" });
		const first = owned.cancel();
		expect(owned.cancel()).toBe(first);
		expect(await first).toEqual({ exitCode: 143, scope: "kernel", unconfirmed: false });
	});

	test("registry cancellation uses the same control request", async () => {
		const { owned } = fixture("PROCWARD/1 X 143\nPROCWARD/1 C kernel\n", true);
		const task = await owned.ready;
		if (!task) throw new Error("task did not register");
		task.cancel();
		expect(await owned.completion).toEqual({ exitCode: 143, scope: "kernel", unconfirmed: false });
	});

	test.each([
		["missing start", "PROCWARD/1 X 0\nPROCWARD/1 C kernel\n"],
		["missing cleanup", "PROCWARD/1 S {pid} kernel\nPROCWARD/1 X 0\n"],
		["wrong scope", "PROCWARD/1 S {pid} kernel\nPROCWARD/1 X 0\nPROCWARD/1 C best-effort\n"],
		["duplicate primary", "PROCWARD/1 S {pid} kernel\nPROCWARD/1 X 0\nPROCWARD/1 X 0\nPROCWARD/1 C kernel\n"],
		["wrong order", "PROCWARD/1 S {pid} kernel\nPROCWARD/1 C kernel\nPROCWARD/1 X 0\n"],
		["truncated record", "PROCWARD/1 S {pid} kernel\nPROCWARD/1 X 0\nPROCWARD/1 C kernel"],
		["native failure", "PROCWARD/1 S {pid} kernel\nPROCWARD/1 X 0\nPROCWARD/1 E 125\n"],
		["oversized record", `${"x".repeat(256)}\n`],
		["result outside u32", "PROCWARD/1 S {pid} kernel\nPROCWARD/1 X 4294967296\nPROCWARD/1 C kernel\n"],
		["data after cleanup", "PROCWARD/1 S {pid} kernel\nPROCWARD/1 X 0\nPROCWARD/1 C kernel\nextra\n"],
	])("reports %s as unconfirmed cleanup", async (_name, transcript) => {
		const { owned } = fixture(transcript);
		expect((await owned.completion).unconfirmed).toBe(true);
	});

	test("a missing primary result fails instead of treating wrapper exit as success", async () => {
		const { owned, child } = fixture("PROCWARD/1 S {pid} kernel\nPROCWARD/1 E 125\n");
		await expect(waitForChildProcess(child, owned.primaryExit)).rejects.toThrow("without a primary result");
		expect((await owned.completion).unconfirmed).toBe(true);
	});

	test("keeps an unconfirmed task for inspection", async () => {
		const { owned, registry } = fixture("PROCWARD/1 S {pid} kernel\nPROCWARD/1 X 0\n");
		expect((await owned.completion).unconfirmed).toBe(true);
		expect(registry.list()).toMatchObject([{ status: "unconfirmed" }]);
	});
});

test.skipIf(process.platform === "win32")(
	"controlled Windows adapter uses the native CRT stdio slot, not a HANDLE",
	async () => {
		vi.stubGlobal("process", { ...process, platform: "win32" });
		try {
			// This is a controlled Unix Node peer; actual Windows CRT execution is
			// a separate platform gate, not something this dispatch test proves.
			const { owned, child } = fixture("PROCWARD/1 S {pid} kernel\nPROCWARD/1 X 7\nPROCWARD/1 C kernel\n");
			expect(owned.args).toEqual(["run", "--retain-descendants", "--control-fd", "3", "--", "command", "argument"]);
			expect(owned.stdio).toEqual(["ignore", "pipe", "pipe", "pipe"]);
			expect(await waitForChildProcess(child, owned.primaryExit)).toBe(7);
			expect(await owned.completion).toEqual({ exitCode: 7, scope: "kernel", unconfirmed: false });
		} finally {
			vi.unstubAllGlobals();
		}
	},
);

test.skipIf(process.platform === "win32").each([
	{ runtime: "node", wire: 4275878552, direct: 4275878552 },
	{ runtime: "bun", wire: 4275878552, direct: 152 },
	{ runtime: "bun", wire: 256, direct: 0 },
	{ runtime: "bun", wire: 7, direct: 7 },
])(
	"controlled $runtime Windows primary result matches direct launch without narrowing native X=$wire",
	async ({ runtime, wire, direct }) => {
		vi.stubGlobal("process", {
			...process,
			platform: "win32",
			versions: { ...process.versions, bun: runtime === "bun" ? "1.4.4" : undefined },
		});
		try {
			const { owned } = fixture(`PROCWARD/1 S {pid} kernel\nPROCWARD/1 X ${wire}\nPROCWARD/1 C kernel\n`);
			expect(await owned.primaryExit).toBe(direct);
			expect(await owned.completion).toEqual({ exitCode: wire, scope: "kernel", unconfirmed: false });
		} finally {
			vi.unstubAllGlobals();
		}
	},
);

test("an absent helper does not allocate a control channel", () => {
	expect(
		prepareOwnedSpawn(
			{ procwardBinary: undefined, registry: createProcessRegistry(), purpose: "disabled" },
			"command",
			[],
		),
	).toBeUndefined();
});

test("registry close bounds a prepared launch that never reports S and rejects later preparation", async () => {
	vi.useFakeTimers();
	try {
		const registry = createProcessRegistry();
		const options = { procwardBinary: "/unused-native-helper", registry, purpose: "never-S" };
		const owned = prepareOwnedSpawn(options, "not executed", [])!;
		let closed = false;
		const closing = registry.close().then(() => {
			closed = true;
		});
		expect(() => prepareOwnedSpawn(options, "late", [])).toThrow("closed");
		await vi.advanceTimersByTimeAsync(14_999);
		expect(closed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await closing;
		expect(await owned.completion).toMatchObject({ unconfirmed: true, scope: undefined });
		expect(await owned.ready).toBeUndefined();
	} finally {
		vi.useRealTimers();
	}
});
