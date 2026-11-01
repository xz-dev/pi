import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { createHostManager, forkDriver } from "../src/manager.ts";

const binary = process.env.PI_PROCESS_OWNER_TEST_BINARY;
const entry = fileURLToPath(new URL("./fixtures/owned-worker.ts", import.meta.url));
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
};

// This integration gate needs the built native helper; missing input is not release evidence.
describe.skipIf(!binary || process.platform !== "linux")(
	"native-owned Chord forkDriver (Linux helper required)",
	() => {
		for (const mode of ["graceful", "force", "exit137", "disconnect"] as const) {
			it(`preserves IPC, primary PID and status on ${mode}; descendants are gone at return`, async () => {
				const directory = mkdtempSync(join(tmpdir(), "chord-owned-"));
				const marker = join(directory, "descendant");
				const previous = process.env.PI_PROCESS_OWNER_BINARY;
				process.env.PI_PROCESS_OWNER_BINARY = binary;
				const peer = spawn(
					binary!,
					["supervise", "--control-fd", "3", "--", process.execPath, "-e", "setTimeout(() => {}, 12000)"],
					{
						stdio: ["ignore", "ignore", "ignore", "pipe"],
					},
				);
				const peerLease = peer.stdio[3] as Duplex;
				const peerDone = new Promise<void>((resolve) => peer.once("close", () => resolve()));
				const peerReady = new Promise<number>((resolve, reject) => {
					let buffer = "";
					peer.once("error", reject);
					peer.once("close", () => reject(new Error("owned peer closed before readiness")));
					peerLease.on("data", (chunk: Buffer) => {
						buffer += chunk.toString();
						const match = /S\{"pid":(\d+)\}\n/.exec(buffer);
						if (match) resolve(Number(match[1]));
					});
				});
				let observed: { pid?: number; init?: unknown } | undefined;
				const manager = createHostManager({
					driver: forkDriver({
						entry,
						init: { greeting: "hello" },
						env: {
							OWNED_DESCENDANT_FILE: marker,
							OWNED_IGNORE_SHUTDOWN: mode === "force" ? "1" : "0",
							OWNED_EXIT_CODE: mode === "exit137" ? "137" : "0",
							OWNED_DISCONNECT: mode === "disconnect" ? "1" : "0",
						},
						onMessage: (message: unknown) => {
							if (
								message &&
								typeof message === "object" &&
								"pid" in message &&
								typeof message.pid === "number"
							) {
								observed = { pid: message.pid, init: "init" in message ? message.init : undefined };
							}
						},
					}),
					grace: 100,
					readyTimeout: 3000,
				});
				try {
					const peerPid = await peerReady;
					const instance = await manager.start();
					assert.deepEqual(observed?.init, { greeting: "hello" });
					assert.equal(instance.pid, observed?.pid, "Instance.pid must identify the primary, not its owner");
					const descendant = Number(readFileSync(marker, "utf8"));
					assert.ok(alive(descendant));
					for (const pid of [process.pid, instance.pid, descendant, peerPid]) {
						const caps = readFileSync(`/proc/${pid}/status`, "utf8").match(/^Cap(?:Inh|Prm|Eff|Amb):\s*(\w+)/gm);
						assert.equal(caps?.length, 4);
						assert.ok(
							caps?.every((line) => /:\s*0+$/.test(line)),
							`pid ${pid} retained capabilities`,
						);
					}
					const stoppedAt = Date.now();
					if (mode === "disconnect") {
						for (let i = 0; i < 100 && !instance.link.closed; i++) {
							await new Promise((resolve) => setTimeout(resolve, 10));
						}
						assert.ok(instance.link.closed, "child-initiated IPC disconnect did not reach parent");
						assert.ok(alive(instance.pid), "child was already dead when disconnect arrived");
						await instance.exited;
					} else await manager.stop();
					assert.ok(!alive(descendant), "detached descendant survived stop() return");
					assert.ok(!alive(instance.pid), "primary survived stop() return");
					assert.ok(Date.now() - stoppedAt < 3000, "natural fixture expiry must not pass cleanup gate");
					assert.ok(alive(peerPid), "unrelated owned primary did not survive");
					assert.deepEqual(
						await instance.exited,
						mode === "force"
							? { code: null, signal: "SIGKILL" }
							: { code: mode === "exit137" ? 137 : 0, signal: null },
					);
				} finally {
					try {
						await manager.stop();
					} finally {
						if (!peerLease.destroyed && !peerLease.writableEnded) peerLease.end("K");
						await peerDone;
						if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
						else process.env.PI_PROCESS_OWNER_BINARY = previous;
						rmSync(directory, { recursive: true, force: true });
					}
				}
			}, 8000);
		}

		it("rejects a missing owner without launching the host or waiting for ready timeout", async () => {
			const directory = mkdtempSync(join(tmpdir(), "chord-missing-owner-"));
			const previous = process.env.PI_PROCESS_OWNER_BINARY;
			process.env.PI_PROCESS_OWNER_BINARY = join(directory, "missing-owner");
			const manager = createHostManager({ driver: forkDriver({ entry }), readyTimeout: 2500 });
			const started = Date.now();
			try {
				await assert.rejects(manager.start(), /ENOENT/);
				assert.ok(Date.now() - started < 1500, "missing-helper spawn error stalled");
			} finally {
				await manager.stop();
				if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
				else process.env.PI_PROCESS_OWNER_BINARY = previous;
				rmSync(directory, { recursive: true, force: true });
			}
		}, 5000);
	},
);
