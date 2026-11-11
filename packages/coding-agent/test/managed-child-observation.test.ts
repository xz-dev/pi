import { spawn } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";

const moduleUrl = new URL("../src/utils/managed-child.ts", import.meta.url).href;
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const runtimes = [process.execPath, ...(process.env.PI_OWNERLOSS_BUN ? [process.env.PI_OWNERLOSS_BUN] : [])];
for (const runtime of runtimes) {
	describe.skipIf(process.platform === "win32")(`lifecycle observation (${runtime})`, () => {
		test.each(["valid", "silent", "dribble", "mismatch", "stop", "fifo"])(
			"%s keeps strict READY/first loss/endpoint ownership",
			async (scenario) => {
				const directory = mkdtempSync(new URL("../../../.owner-observation-", import.meta.url).pathname);
				directories.push(directory);
				const script = join(directory, "observe.mjs");
				writeFileSync(
					script,
					`
import { fstatSync } from "node:fs";
import { consumeAndObserveManagedContract } from ${JSON.stringify(moduleUrl)};
const started = (performance.timeOrigin + performance.now());
const launch = "a".repeat(32);
let count = 0;
let observer;
try {
 observer = consumeAndObserveManagedContract({ protocol: "1", ownerPid: String(process.ppid), contractId: launch, lifecycleFd: "3" }, process.pid, process.ppid, (reason, observedAt) => {
  count++;
  setTimeout(() => { console.log(JSON.stringify({ reason, observedAt, current: observer.observedAt, callbackAt: performance.timeOrigin + performance.now(), count })); process.exit(0); }, 100);
 });
 console.log("READY");
 if (${JSON.stringify(scenario)} === "stop") {
  observer.stop();
  const check = setInterval(() => { try { fstatSync(3); } catch { clearInterval(check); console.log("FD-CLOSED"); process.exit(0); } }, 10);
 }
 setInterval(() => {}, 1000);
} catch (error) { console.log(JSON.stringify({ error: error.message, elapsed: (performance.timeOrigin + performance.now()) - started })); process.exit(2); }
`,
				);
				let fd: number | undefined;
				if (scenario === "fifo") {
					const fifo = join(directory, "lifecycle");
					await new Promise<void>((resolve, reject) => {
						const mkfifo = spawn("mkfifo", [fifo]);
						mkfifo.once("error", reject);
						mkfifo.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`mkfifo: ${code}`))));
					});
					fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
				}
				const child = spawn(runtime, [script], { stdio: ["ignore", "pipe", "pipe", fd ?? "pipe"] });
				let output = "";
				let stderr = "";
				let parentGuard = false;
				let lost = false;
				const write = (value: string) => {
					if (fd !== undefined) writeSync(fd, value);
					else {
						const pipe = child.stdio[3];
						if (!(pipe instanceof Duplex)) throw new Error("missing endpoint");
						pipe.write(value);
					}
				};
				child.stdout?.on("data", (chunk: Buffer) => {
					output += chunk.toString();
					if (output.includes("READY\n") && !lost && ["valid", "fifo"].includes(scenario)) {
						lost = true;
						write(`PROCWARD/1 OWNER-LOSS ${"a".repeat(32)}\n`);
						write(`PROCWARD/1 OWNER-LOSS ${"a".repeat(32)}\n`);
					}
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				const pipe = child.stdio[3];
				if (pipe instanceof Duplex) pipe.on("error", () => {});
				if (!["silent", "dribble"].includes(scenario))
					write(
						`PROCWARD/1 READY ${process.pid} ${scenario === "mismatch" ? 1 : child.pid} parent ${"a".repeat(32)}\n`,
					);
				const dribble = scenario === "dribble" ? setInterval(() => write("x"), 100) : undefined;
				const guard = setTimeout(() => {
					parentGuard = true;
					child.kill("SIGKILL");
				}, 4000);
				const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
					(resolve, reject) => {
						child.once("error", reject);
						child.once("close", (code, signal) => resolve({ code, signal }));
					},
				);
				clearTimeout(guard);
				clearInterval(dribble);
				if (fd !== undefined) closeSync(fd);
				console.log(JSON.stringify({ runtime, scenario, ...result, parentGuard, output, stderr }));
				expect(parentGuard, output + stderr).toBe(false);
				if (["valid", "fifo"].includes(scenario)) {
					expect(result.code, stderr).toBe(0);
					const observation = JSON.parse(output.trim().split("\n").at(-1)!) as {
						observedAt: number;
						current: number;
						callbackAt: number;
						count: number;
					};
					expect(observation.current).toBe(observation.observedAt);
					expect(observation.count).toBe(1);
					// Bun's hrtime origin differs per worker; fixed performance origins must agree.
					expect(observation.callbackAt - observation.observedAt).toBeGreaterThanOrEqual(80);
					expect(observation.callbackAt - observation.observedAt).toBeLessThan(250);
				} else if (scenario === "stop") {
					expect(result.code, stderr).toBe(0);
					expect(output).toContain("FD-CLOSED");
				} else {
					expect(result.code, output + stderr).toBe(2);
					const failure = JSON.parse(output) as { elapsed: number; error: string };
					if (scenario === "mismatch") expect(failure.error).toContain("primary pid mismatch");
					else {
						expect(failure.error).toContain("READY startup deadline");
						expect(failure.elapsed).toBeGreaterThanOrEqual(1990);
						expect(failure.elapsed).toBeLessThan(2250);
					}
				}
			},
			6000,
		);
	});
}
