import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { err, FileError, getOrThrow } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";

// Explicit local artifacts only. Native containment evidence requires Linux and finite C fixture.
const OWNER = process.env.PI_PROCESS_OWNER_TEST_BINARY;
const FIXTURE = process.env.PI_PROCESS_OWNER_TEST_FIXTURE;
const owned = process.platform === "linux" && OWNER ? it : it.skip;
const containment = process.platform === "linux" && OWNER && FIXTURE ? it : it.skip;
const tempDirs: string[] = [];
const previousOwner = process.env.PI_PROCESS_OWNER_BINARY;

function createTempDir(): string {
	const dir = join(tmpdir(), `pi-durable-owned-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	if (previousOwner === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
	else process.env.PI_PROCESS_OWNER_BINARY = previousOwner;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Fixture startup exceeded 2000ms");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function collect(
	env: NodeExecutionEnv,
	command: string | readonly string[],
	options?: Parameters<NodeExecutionEnv["exec"]>[1],
) {
	const output = { stdout: "", stderr: "" };
	const result = await env.exec(
		command,
		{
			...options,
			onOutput: (text, _context, info) => {
				output[info.stream] += text;
			},
		},
		BACKGROUND_CONTEXT,
	);
	return { result, output };
}

function expectGone(pid: number, work: string): void {
	expect(pid).toBeGreaterThan(0);
	// Signal 0 must fail ESRCH now, including zombies. No post-return polling or expiry credit.
	expect(alive(pid)).toBe(false);
	expect(existsSync(join(work, "daemon.expired"))).toBe(false);
	const identity = JSON.parse(readFileSync(join(work, "daemon.ready"), "utf8")) as {
		pid: number;
		uid: number;
		euid: number;
		gid: number;
		egid: number;
		caps: string[];
	};
	process.stderr.write(`Native fixture identity: ${JSON.stringify(identity)}\n`);
	expect(identity.pid).toBe(pid);
	for (const value of [identity.uid, identity.euid, identity.gid, identity.egid]) expect(value).toBeGreaterThan(0);
	expect(identity.caps.map((value) => BigInt(`0x${value}`))).toEqual([0n, 0n, 0n, 0n]);
}

describe("NodeExecutionEnv native process owner", () => {
	containment("measures unprivileged test host (UID/EUID/GID/EGID > 0, capabilities zero)", () => {
		expect(process.getuid!()).toBeGreaterThan(0);
		expect(process.geteuid!()).toBeGreaterThan(0);
		expect(process.getgid!()).toBeGreaterThan(0);
		expect(process.getegid!()).toBeGreaterThan(0);
		const status = readFileSync("/proc/self/status", "utf8");
		process.stderr.write(
			`Native test host identity: ${JSON.stringify({ uid: process.getuid!(), euid: process.geteuid!(), gid: process.getgid!(), egid: process.getegid!(), capabilities: status.split("\n").filter((line) => /^Cap(Inh|Prm|Eff|Amb):/.test(line)) })}\n`,
		);
		for (const name of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {
			expect(BigInt(`0x${status.match(new RegExp(`^${name}:\\s*([0-9a-f]+)$`, "m"))![1]}`)).toBe(0n);
		}
	});

	for (const mode of ["primary exit", "abort", "timeout", "cleanup", "host mutation", "callback error"] as const) {
		containment(
			`${mode}: double-fork setsid descendant ESRCH at return; finite independent peer survives`,
			async () => {
				process.env.PI_PROCESS_OWNER_BINARY = OWNER!;
				const work = createTempDir();
				const env = new NodeExecutionEnv({
					cwd: work,
					shellEnv: { PI_PROCESS_OWNER_BINARY: "/wrong-shell-owner" },
				});
				const controller = new AbortController();
				let daemon = 0;
				const peer = spawn(FIXTURE!, ["--peer"], { stdio: "ignore" });
				const peerClosed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
				try {
					const running = env.exec(
						[FIXTURE!, work, "8", ...(mode === "primary exit" || mode === "host mutation" ? [] : ["linger"])],
						{
							timeout: mode === "timeout" ? 0.3 : 3,
							env: { PI_PROCESS_OWNER_BINARY: "/wrong-option-owner" },
							inheritEnv: false,
							onOutput: (text) => {
								daemon = Number(text.trim());
								if (mode === "callback error") throw new Error("caller exploded");
							},
						},
						withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
					);
					if (mode === "host mutation") delete process.env.PI_PROCESS_OWNER_BINARY;
					if (mode === "abort" || mode === "cleanup") {
						await waitFor(() => daemon > 0 && existsSync(join(work, "daemon.ready")));
						if (mode === "abort") controller.abort();
						else {
							await Promise.all([env.cleanup(BACKGROUND_CONTEXT), env.cleanup(BACKGROUND_CONTEXT)]);
							expectGone(daemon, work);
							expect(alive(peer.pid!)).toBe(true);
						}
					}
					const result = await running;
					expectGone(daemon, work);
					expect(alive(peer.pid!)).toBe(true);
					if (mode === "abort" || mode === "timeout" || mode === "callback error") {
						expect(result.ok).toBe(false);
						if (!result.ok)
							expect(result.error.code).toBe(
								mode === "callback error" ? "callback_error" : mode === "abort" ? "aborted" : "timeout",
							);
					} else expect(getOrThrow(result).exitCode).toBe(mode === "cleanup" ? 137 : 0);
					await env.cleanup(BACKGROUND_CONTEXT);
				} finally {
					await env.cleanup(BACKGROUND_CONTEXT);
					peer.kill("SIGKILL");
					await peerClosed;
				}
			},
		);
	}

	owned("cleanup joins spawn-phase work, concurrent and repeated calls", async () => {
		process.env.PI_PROCESS_OWNER_BINARY = OWNER!;
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const running = env.exec(["/bin/sleep", "8"], { timeout: 3 }, BACKGROUND_CONTEXT);
		await Promise.all([env.cleanup(BACKGROUND_CONTEXT), env.cleanup(BACKGROUND_CONTEXT)]);
		expect(getOrThrow(await running).exitCode).toBe(137);
		await env.cleanup(BACKGROUND_CONTEXT);
	});

	owned(
		"preserves argv, cwd, environment, early stderr, UTF-8, exact status; no cross-stream ordering claim",
		async () => {
			process.env.PI_PROCESS_OWNER_BINARY = OWNER!;
			const root = createTempDir();
			const env = new NodeExecutionEnv({ cwd: root });
			const { result, output } = await collect(
				env,
				[
					process.execPath,
					"-e",
					"process.stderr.write('early λ\\n');process.stdout.write(process.cwd()+'\\n'+process.argv[1]+'\\n'+process.env.MARKER);process.exitCode=3",
					"space ' quote",
				],
				{ env: { MARKER: "kept" }, timeout: 3 },
			);
			expect(getOrThrow(result).exitCode).toBe(3);
			expect(output.stdout).toBe(`${root}\nspace ' quote\nkept`);
			expect(output.stderr).toBe("early λ\n");
		},
	);

	owned("shell command captures host owner before shell discovery awaits", async () => {
		process.env.PI_PROCESS_OWNER_BINARY = OWNER!;
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const pending = collect(env, "printf shell", { timeout: 3 });
		process.env.PI_PROCESS_OWNER_BINARY = "/wrong-later-owner";
		const { result, output } = await pending;
		expect(getOrThrow(result).exitCode).toBe(0);
		expect(output.stdout).toBe("shell");
	});

	for (const code of [0, 125]) {
		owned(`C-confirmed native primary exit ${code} preserves matching helper status`, async () => {
			process.env.PI_PROCESS_OWNER_BINARY = OWNER!;
			const result = await new NodeExecutionEnv({ cwd: createTempDir() }).exec(
				["/bin/sh", "-c", `exit ${code}`],
				{ timeout: 3 },
				BACKGROUND_CONTEXT,
			);
			expect(getOrThrow(result).exitCode).toBe(code);
		});
	}

	owned("helper ENOENT retains infrastructure identity; explicit empty helper fails", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		process.env.PI_PROCESS_OWNER_BINARY = "/nonexistent/pi-env";
		const result = await env.exec(["/bin/true"], { timeout: 3 }, BACKGROUND_CONTEXT);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("spawn_error");
			expect((result.error.cause as NodeJS.ErrnoException)?.code).toBe("ENOENT");
			expect((result.error.cause as NodeJS.ErrnoException)?.path).toBe("/nonexistent/pi-env");
		}
		process.env.PI_PROCESS_OWNER_BINARY = "";
		expect((await env.exec(["/bin/true"], undefined, BACKGROUND_CONTEXT)).ok).toBe(false);
	});

	for (const denied of [false, true]) {
		owned(
			`program ${denied ? "EACCES" : "ENOENT"} reconstructs only E-record error; diagnostics suppressed`,
			async () => {
				process.env.PI_PROCESS_OWNER_BINARY = OWNER!;
				const root = createTempDir();
				const program = join(root, denied ? "denied" : "missing");
				if (denied) writeFileSync(program, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
				const { result, output } = await collect(new NodeExecutionEnv({ cwd: root }), [program, "arg1"], {
					timeout: 3,
				});
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.code).toBe("spawn_error");
					const cause = result.error.cause as NodeJS.ErrnoException;
					expect(cause.code).toBe(denied ? "EACCES" : "ENOENT");
					expect(cause.path).toBe(program);
					expect(cause.syscall).toBe(`spawn ${program}`);
					expect(cause).toMatchObject({ spawnargs: ["arg1"] });
				}
				expect(output).toEqual({ stdout: "", stderr: "" });
			},
		);
	}

	owned("backpressured spill and callbacks retain every stdout/stderr byte", async () => {
		process.env.PI_PROCESS_OWNER_BINARY = OWNER!;
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const bytes = 3 * 1024 * 1024;
		const { result, output } = await collect(
			env,
			[
				process.execPath,
				"-e",
				`process.stdout.write('a'.repeat(${bytes}));process.stderr.write('λ'.repeat(${bytes / 2}));`,
			],
			{ timeout: 3, spill: { afterBytes: 16, afterLines: 4 } },
		);
		const value = getOrThrow(result);
		expect(value.exitCode).toBe(0);
		expect(output.stdout).toBe("a".repeat(bytes));
		expect(output.stderr).toBe("λ".repeat(bytes / 2));
		const spilled = readFileSync(value.spillPath!);
		expect(spilled.length).toBe(bytes * 2);
		expect(spilled.filter((byte) => byte === 97).length).toBe(bytes);
		rmSync(join(value.spillPath!, ".."), { recursive: true, force: true });
	});

	for (const priority of ["spill", "callback", "timeout"] as const) {
		owned(`${priority} error priority survives paused output and native join`, async () => {
			process.env.PI_PROCESS_OWNER_BINARY = OWNER!;
			const env = new NodeExecutionEnv({ cwd: createTempDir() });
			env.createTempFile = async () => {
				if (priority === "timeout") await new Promise((resolve) => setTimeout(resolve, 500));
				return err(new FileError("permission_denied", "fixture spill failure"));
			};
			const result = await env.exec(
				[process.execPath, "-e", "process.stdout.write('x'.repeat(100000));setTimeout(()=>{},8000)"],
				{
					timeout: priority === "timeout" ? 0.3 : 3,
					spill: { afterBytes: 1, afterLines: 1 },
					onOutput: () => {
						if (priority === "callback") throw new Error("caller failed");
					},
				},
				BACKGROUND_CONTEXT,
			);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.error.code).toBe(
					priority === "spill" ? "unknown" : priority === "callback" ? "callback_error" : "timeout",
				);
		});
	}

	// Synthetic helpers start no primary. Protocol tests are not containment evidence.
	for (const report of [
		"",
		'S{"pid":123}\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC\nC\n',
		'S{"pid":123}\nC\nX{"code":0,"signal":null}\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nC\nE2 late\n',
		'S{"pid":123}\nX{"code":0,"signal":null}',
		'X{"code":0,"signal":null}\n',
		'S{"pid":123}\nX{"code":0,"signal":9}\n',
		'S{"pid":123}\nX{"code":-1,"signal":null}\n',
		'S{"pid":123}\nX{"code":null,"signal":0}\n',
		'S{"pid":123}\nX{"code":0,"signal":null}\nX{"code":0,"signal":null}\n',
		"E9007199254740992 bad\n",
		'S{"pid":0}\n',
	]) {
		it(`UNIT fails closed on missing/malformed/out-of-order/truncated report ${JSON.stringify(report)}`, async () => {
			const root = createTempDir();
			const helper = join(root, "bad-owner");
			writeFileSync(helper, `#!/bin/sh\nprintf '%s' '${report}' >&3\nexit 0\n`, { mode: 0o700 });
			process.env.PI_PROCESS_OWNER_BINARY = helper;
			const result = await new NodeExecutionEnv({ cwd: root }).exec(
				["/bin/true"],
				{ timeout: 2 },
				BACKGROUND_CONTEXT,
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe("unknown");
				expect(result.error.cause).toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
			}
		});
	}
});
