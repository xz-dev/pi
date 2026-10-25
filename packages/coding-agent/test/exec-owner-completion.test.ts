import type * as ChildProcessModule from "node:child_process";
import { ChildProcess, spawn as spawnChild } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { createLocalShellOperations } from "../src/core/tools/bash.ts";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof ChildProcessModule>();
	spawn.mockImplementation(actual.spawn);
	return { ...actual, spawn };
});
vi.mock("child_process", async (original) => {
	const actual = await original<typeof ChildProcessModule>();
	spawn.mockImplementation(actual.spawn);
	return { ...actual, spawn };
});

const previous = process.env.PI_PROCESS_OWNER_BINARY;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
	Object.defineProperty(process, "platform", originalPlatform);
	if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
	else process.env.PI_PROCESS_OWNER_BINARY = previous;
	spawn.mockClear();
});

const S = 'S{"pid":42}\n';
const X = (code: number) => `X{"code":${code},"signal":null}\n`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeChild(emitSpawn = true) {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const control = new PassThrough();
	const child = Object.assign(new ChildProcess(), {
		pid: 2147483647,
		stdin: null,
		stdout,
		stderr,
		stdio: [null, stdout, stderr, control],
	});
	vi.spyOn(child, "kill").mockReturnValue(true);
	let atSpawn: () => void = () => {};
	const spawned = new Promise<void>((resolve) => {
		atSpawn = resolve;
	});
	spawn.mockImplementationOnce(() => {
		atSpawn();
		if (emitSpawn) queueMicrotask(() => child.emit("spawn"));
		return child;
	});
	return {
		child,
		stdout,
		stderr,
		control,
		spawned,
		exit(code: number) {
			Object.defineProperty(child, "exitCode", { value: code });
			child.emit("exit", code, null);
			stdout.end();
			stderr.end();
		},
	};
}

for (const caller of ["exec", "bash"] as const) {
	describe(`${caller} native completion protocol (unit ordering, not containment evidence)`, () => {
		function run(options?: { signal?: AbortSignal; timeout?: number; onData?: (data: Buffer) => void }) {
			process.env.PI_PROCESS_OWNER_BINARY = process.execPath;
			if (caller === "exec") return execCommand("program", ["arg"], process.cwd(), options);
			return createLocalShellOperations("sh", () => ({ shell: "program", args: [] })).exec("arg", process.cwd(), {
				onData: () => {},
				...options,
			});
		}
		async function outcome(pending: ReturnType<typeof run>) {
			try {
				const result = await pending;
				return "code" in result ? result.code : result.exitCode;
			} catch (error) {
				expect(error).toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
				return 1;
			}
		}

		for (const code of [0, 125]) {
			for (const complete of [false, true]) {
				it(`${complete ? "requires" : "rejects absence of"} C for primary/helper ${code}/${code}`, async () => {
					const f = fakeChild();
					const pending = outcome(run());
					await f.spawned;
					f.control.end(S + X(code) + (complete ? "C\n" : ""));
					f.exit(code);
					f.child.emit("close", code, null);
					expect(await pending).toBe(complete ? code : 1);
				});
			}
		}

		for (const closeFirst of [true, false]) {
			it(`C plus primary exit waits for ${closeFirst ? "control drain" : "actual helper close"}; late output survives`, async () => {
				const f = fakeChild();
				let settled = false;
				let output = "";
				const pending = run({
					onData: (data) => {
						output += data.toString();
					},
				}).finally(() => {
					settled = true;
				});
				await f.spawned;
				f.control.write(`${S}${X(0)}C\n`);
				f.child.emit("exit", 0, null);
				await new Promise((resolve) => setTimeout(resolve, 150));
				expect(settled).toBe(false);
				f.stdout.write("late λ");
				f.stdout.end();
				f.stderr.end();
				if (closeFirst) f.child.emit("close", 0, null);
				else f.control.end();
				await tick();
				expect(settled).toBe(false);
				if (closeFirst) f.control.end();
				else f.child.emit("close", 0, null);
				const result = await pending;
				expect("code" in result ? result.code : result.exitCode).toBe(0);
				expect("stdout" in result ? result.stdout : output).toBe("late λ");
			});
		}

		for (const report of [
			"C\n",
			`${S}C\n`,
			`${S}${S}${X(0)}C\n`,
			`${S}${X(0)}C\nC\n`,
			`${S}${X(0)}C`,
			`${S}${X(0)}C\nX{}\n`,
			`${S}X{"code":null,"signal":null}\nC\n`,
		]) {
			it(`fails closed on malformed records ${JSON.stringify(report)}`, async () => {
				const f = fakeChild();
				const pending = outcome(run());
				await f.spawned;
				if (report.endsWith("\n")) {
					f.control.write(report);
					expect(f.control.writableEnded).toBe(true);
				} else f.control.end(report);
				f.exit(0);
				f.child.emit("close", 0, null);
				expect(await pending).toBe(1);
			});
		}

		it("preserves original helper launch error before any owned scope", async () => {
			const f = fakeChild(false);
			const error = Object.assign(new Error("spawn /broken-owner ENOENT"), {
				code: "ENOENT",
				path: "/broken-owner",
				syscall: "spawn /broken-owner",
			});
			const pending = run();
			const checked =
				caller === "bash"
					? expect(pending).rejects.toBe(error)
					: expect(pending).resolves.toMatchObject({ code: 1, stderr: `${error.message}\n` });
			await f.spawned;
			f.child.emit("error", error);
			f.control.end();
			f.stdout.end();
			f.stderr.end();
			f.child.emit("close", -2, null);
			await checked;
		});

		for (const report of ["E2 No such file or directory\n", "E2 No such file or directory\nC"]) {
			it(`does not let E hide missing/truncated C: ${JSON.stringify(report)}`, async () => {
				const f = fakeChild();
				const pending = outcome(run());
				await f.spawned;
				f.control.end(report);
				f.exit(125);
				f.child.emit("close", 125, null);
				expect(await pending).toBe(1);
			});
		}

		it("cleanup failure outranks ordinary timeout settlement", async () => {
			const f = fakeChild();
			const pending = outcome(run({ timeout: caller === "exec" ? 1 : 0.001 }));
			await f.spawned;
			await new Promise((resolve) => setTimeout(resolve, 10));
			f.control.end(S + X(0));
			f.exit(0);
			f.child.emit("close", 0, null);
			expect(await pending).toBe(1);
		});

		it("cleanup failure outranks normal abort settlement", async () => {
			const f = fakeChild();
			const controller = new AbortController();
			const pending = outcome(run({ signal: controller.signal }));
			await f.spawned;
			controller.abort();
			f.control.end(S + X(0));
			f.exit(0);
			f.child.emit("close", 0, null);
			expect(await pending).toBe(1);
		});
	});
}

describe("bash ownership snapshot absence (unit)", () => {
	it("does not adopt an owner installed while filesystem access awaits", async () => {
		const f = fakeChild();
		delete process.env.PI_PROCESS_OWNER_BINARY;
		const pending = createLocalShellOperations("sh", () => ({ shell: "program", args: [] })).exec(
			"arg",
			process.cwd(),
			{ onData: () => {} },
		);
		process.env.PI_PROCESS_OWNER_BINARY = "/owner-installed-too-late";
		await f.spawned;
		expect(spawn.mock.calls.at(-1)?.slice(0, 2)).toEqual(["program", ["arg"]]);
		f.exit(0);
		f.child.emit("close", 0, null);
		expect(await pending).toEqual({ exitCode: 0 });
		f.control.destroy();
	});
});

describe("bash task group wiring (unit; subprocess coverage in owner-task-groups)", () => {
	for (const platform of ["linux", "freebsd", "darwin", "win32"]) {
		for (const owned of [false, true]) {
			it(`${platform} owned=${owned} preserves caller-specific detached policy`, async () => {
				Object.defineProperty(process, "platform", { value: platform, configurable: true });
				if (owned) process.env.PI_PROCESS_OWNER_BINARY = process.execPath;
				else delete process.env.PI_PROCESS_OWNER_BINARY;
				const f = fakeChild();
				const pending = createLocalShellOperations("sh", () => ({ shell: "program", args: [] })).exec(
					"arg",
					process.cwd(),
					{ onData: () => {} },
				);
				await f.spawned;
				expect(spawn.mock.calls.at(-1)?.[2].detached).toBe(
					platform !== "win32" && (!owned || platform === "darwin"),
				);
				if (owned) f.control.end(`${S}${X(0)}C\n`);
				f.exit(0);
				f.child.emit("close", 0, null);
				expect(await pending).toEqual({ exitCode: 0 });
				f.control.destroy();
			});
		}
	}
});

const owner = process.env.PI_PROCESS_OWNER_TEST_BINARY;
const fixture = process.env.PI_PROCESS_OWNER_TEST_FIXTURE;
describe.skipIf(!owner || !fixture || process.platform !== "linux")("exec/bash native finite containment", () => {
	it("measures unprivileged native test host with all capability sets zero", () => {
		const ids = [process.getuid!(), process.geteuid!(), process.getgid!(), process.getegid!()];
		const status = readFileSync("/proc/self/status", "utf8");
		const caps = status.split("\n").filter((line) => /^Cap(Inh|Prm|Eff|Amb):/.test(line));
		process.stderr.write(`native test host ids=${JSON.stringify(ids)} caps=${JSON.stringify(caps)}\n`);
		expect(ids.every((id) => id > 0)).toBe(true);
		expect(caps).toHaveLength(4);
		for (const cap of caps) expect(BigInt(`0x${cap.split(":")[1].trim()}`)).toBe(0n);
	});
	for (const caller of ["exec", "bash"] as const) {
		it(`${caller}: native drain preserves backpressured stdout/stderr beyond one MiB`, async () => {
			process.env.PI_PROCESS_OWNER_BINARY = owner;
			const bytes = 2 * 1024 * 1024;
			const script = `process.stdout.write('x'.repeat(${bytes}));process.stderr.write('y'.repeat(${bytes}));`;
			const chunks: Buffer[] = [];
			const result =
				caller === "exec"
					? await execCommand(process.execPath, ["-e", script], process.cwd())
					: await createLocalShellOperations("node", () => ({ shell: process.execPath, args: ["-e"] })).exec(
							script,
							process.cwd(),
							{ onData: (data) => chunks.push(data) },
						);
			expect("code" in result ? result.code : result.exitCode).toBe(0);
			if ("stdout" in result) {
				expect(result.stdout).toBe("x".repeat(bytes));
				expect(result.stderr).toBe("y".repeat(bytes));
			} else {
				const output = Buffer.concat(chunks);
				expect(output.length).toBe(bytes * 2);
				const decoded = output.toString("utf8");
				expect(decoded.replaceAll("x", "")).toBe("y".repeat(bytes));
				expect(decoded.replaceAll("y", "")).toBe("x".repeat(bytes));
			}
		});
		for (const status of [3, 125, "signal"] as const) {
			it(`${caller}: native C preserves primary ${status}, argv and UTF-8 stderr`, async () => {
				process.env.PI_PROCESS_OWNER_BINARY = owner;
				const script = `process.stderr.write('early λ\\n');process.stdout.write(process.argv[1]);${status === "signal" ? "process.kill(process.pid, 'SIGTERM')" : `process.exitCode=${status}`}`;
				let output = "";
				const arg = "space ' quote";
				const result =
					caller === "exec"
						? await execCommand(process.execPath, ["-e", script, arg], process.cwd())
						: await createLocalShellOperations("node", () => ({
								shell: process.execPath,
								args: ["-e", script],
							})).exec(arg, process.cwd(), {
								onData: (data) => {
									output += data.toString();
								},
							});
				expect("code" in result ? result.code : result.exitCode).toBe(status === "signal" ? 143 : status);
				if ("stdout" in result) {
					expect(result.stdout).toBe(arg);
					expect(result.stderr).toBe("early λ\n");
				} else {
					expect(output).toContain(arg);
					expect(output).toContain("early λ\n");
				}
			});
		}
		it(`${caller}: captures host owner before await; descendant ESRCH now; unrelated finite owned peer lives`, async () => {
			process.env.PI_PROCESS_OWNER_BINARY = owner;
			const directory = mkdtempSync(join(tmpdir(), "completion-caller-"));
			const peer = spawnChild(owner!, ["supervise", "--", fixture!, "--peer"], { stdio: "ignore" });
			const peerClosed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
			try {
				let output = "";
				const pending =
					caller === "exec"
						? execCommand(fixture!, [directory, "8"], directory)
						: createLocalShellOperations("fixture", () => ({ shell: fixture!, args: [directory] })).exec(
								"8",
								directory,
								{
									env: { ...process.env, PI_PROCESS_OWNER_BINARY: "/wrong-option-owner" },
									onData: (data) => {
										output += data.toString();
									},
								},
							);
				delete process.env.PI_PROCESS_OWNER_BINARY;
				const result = await pending;
				if ("stdout" in result) output = result.stdout;
				expect("code" in result ? result.code : result.exitCode).toBe(0);
				const pid = Number(output.trim());
				expect(pid).toBeGreaterThan(0);
				expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
				expect(existsSync(join(directory, "daemon.expired"))).toBe(false);
				const identity = JSON.parse(readFileSync(join(directory, "daemon.ready"), "utf8")) as {
					caps: string[];
					uid: number;
					euid: number;
					gid: number;
					egid: number;
				};
				process.stderr.write(`native fixture identity=${JSON.stringify(identity)}\n`);
				expect([identity.uid, identity.euid, identity.gid, identity.egid].every((id) => id > 0)).toBe(true);
				expect(identity.caps.map((cap) => BigInt(`0x${cap}`))).toEqual([0n, 0n, 0n, 0n]);
				expect(() => process.kill(peer.pid!, 0)).not.toThrow();
			} finally {
				peer.kill("SIGTERM");
				await peerClosed;
				rmSync(directory, { recursive: true, force: true });
			}
		}, 7000);
	}
});
