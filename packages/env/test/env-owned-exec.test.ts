import { execFileSync, spawn } from "node:child_process";
import {
	closeSync,
	constants,
	existsSync,
	type FSWatcher,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	watch,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow, type ShellExecOptions } from "@earendil-works/pi-durable/env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, nodePlatform, RemoteError } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { daemon, expectedDaemonPlatform } from "./daemon.ts";

const context = BACKGROUND_CONTEXT;
const python = "/usr/bin/python3";
const fixture = join(import.meta.dirname, "fixtures/env-owned-exec.py");
const wire = join(import.meta.dirname, "fixtures/env-owned-wire.ts");
const trace = join(import.meta.dirname, "fixtures/env-owned-trace.py");
const connections: Connection[] = [];
const envs: RemoteExecutionEnv[] = [];
const dirs: string[] = [];
const controllers: AbortController[] = [];
const pending: Promise<unknown>[] = [];
const peers: ReturnType<typeof peer>[] = [];
const watchers: FSWatcher[] = [];
const gateFds: number[] = [];
const seamReleases: (() => void)[] = [];
const qualification = new Connection({ command: [daemon] });
const selectedHello = process.platform === "linux" ? await qualification.info() : undefined;
const qualified = selectedHello?.features?.includes("ownedExec1") === true;
const runtimeReport = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
const glibc = runtimeReport.header?.glibcVersionRuntime ?? "non-GNU/unknown";
afterAll(() => qualification.close());

type Identity = {
	pid: number;
	sid: number;
	pgrp: number;
	uid: number;
	euid: number;
	gid: number;
	egid: number;
	caps: Record<string, string>;
	fds: Record<string, string>;
};
type Tree = { primary: Identity; leaf: Identity };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
function jsonFile<T>(path: string): Promise<T> {
	const ready = deferred<T>();
	const read = () => {
		if (existsSync(path)) ready.resolve(JSON.parse(readFileSync(path, "utf8")) as T);
	};
	const watcher = watch(dirname(path), (_event, name) => {
		if (String(name) === path.slice(dirname(path).length + 1)) read();
	});
	watchers.push(watcher);
	read();
	return ready.promise;
}
function controller() {
	const abort = new AbortController();
	controllers.push(abort);
	return abort;
}
function environment(command: ConstructorParameters<typeof Connection>[0]["command"] = [daemon]) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-env-owned-"));
	dirs.push(cwd);
	const connection = new Connection({ command, onLog: (text) => console.error(text) });
	connections.push(connection);
	const env = new RemoteExecutionEnv({ connection, id: "owned-acceptance", cwd });
	envs.push(env);
	return { env, connection, cwd };
}
async function traced(mode: string, lookup = false) {
	let path = "";
	let prefix: string[] = [];
	let starts = 0;
	const fixtureEnv = environment(async () => {
		starts++;
		if (starts > 1) return [daemon];
		const native = [...prefix, python, trace, daemon, path, mode === "observe-eof" ? "observe" : mode];
		return mode === "observe-eof" ? [process.execPath, wire, "transport-eof", `${path}.eof`, ...native] : native;
	});
	path = join(fixtureEnv.cwd, "os-seam");
	execFileSync("/usr/bin/mkfifo", ["-m", "600", `${path}.arm`], { timeout: 1000 });
	const commandFd = openSync(`${path}.arm`, constants.O_RDWR | constants.O_NONBLOCK);
	gateFds.push(commandFd);
	let lookupGate: number | undefined;
	let lookupReady: Promise<Tree> | undefined;
	if (lookup) {
		writeFileSync(join(fixtureEnv.cwd, "which"), `#!${python}\n${readFileSync(fixture, "utf8")}`, { mode: 0o700 });
		execFileSync("/usr/bin/mkfifo", ["-m", "600", `${path}.lookup-gate`], { timeout: 1000 });
		lookupGate = openSync(`${path}.lookup-gate`, constants.O_RDWR | constants.O_NONBLOCK);
		gateFds.push(lookupGate);
		lookupReady = jsonFile<Tree>(`${path}.lookup`);
		vi.stubEnv("PATH", fixtureEnv.cwd);
		vi.stubEnv("PI_ENV_C_LOOKUP_REPORT", `${path}.lookup`);
		vi.stubEnv("PI_ENV_C_LOOKUP_GATE", `${path}.lookup-gate`);
		const pythonElf = execFileSync(python, ["-c", "import os,sys;print(os.path.realpath(sys.executable))"], {
			encoding: "utf8",
			timeout: 1000,
		}).trim();
		prefix = [
			"/usr/bin/bwrap",
			"--ro-bind",
			"/",
			"/",
			"--bind",
			fixtureEnv.cwd,
			fixtureEnv.cwd,
			"--unshare-user",
			"--uid",
			String(process.getuid?.()),
			"--gid",
			String(process.getgid?.()),
			"--dev",
			"/dev",
			"--tmpfs",
			"/usr/bin",
			"--ro-bind",
			"/usr/bin/bash",
			"/usr/bin/sh",
			"--ro-bind",
			pythonElf,
			python,
		];
	}
	const armed = jsonFile(`${path}.armed`);
	const hello = await fixtureEnv.connection.info();
	expect(hello.features).toContain("ownedExec1");
	writeSync(commandFd, "A");
	seamReleases.push(() => {
		writeSync(commandFd, "R");
		if (lookupGate !== undefined) writeSync(lookupGate, "G");
	});
	await armed;
	return {
		...fixtureEnv,
		path,
		commandFd,
		hello,
		lookupGate,
		lookupReady,
		starts: () => starts,
		trace: () =>
			JSON.parse(readFileSync(`${path}.trace`, "utf8")) as {
				events: { event: string; fromDaemon?: boolean; original?: string }[];
			},
	};
}
function unprivileged(identity: Pick<Identity, "uid" | "euid" | "gid" | "egid" | "caps">) {
	expect([identity.uid, identity.euid, identity.gid, identity.egid]).toEqual([
		process.getuid?.(),
		process.geteuid?.(),
		process.getgid?.(),
		process.getegid?.(),
	]);
	expect(identity.uid).toBeGreaterThan(0);
	expect(Object.keys(identity.caps).sort()).toEqual(["CapAmb", "CapEff", "CapInh", "CapPrm"]);
	for (const value of Object.values(identity.caps)) expect(BigInt(`0x${value}`)).toBe(0n);
}
function probe(pid: number): string {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code ?? "unknown";
	}
}
function sessionIdentity(pid: number) {
	const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
	return { pgrp: Number(fields[2]), sid: Number(fields[3]) };
}
function daemonIdentity(pid: number) {
	const status = readFileSync(`/proc/${pid}/status`, "utf8");
	const uid = status.match(/^Uid:\s+(\d+)\s+(\d+)/m)!;
	const gid = status.match(/^Gid:\s+(\d+)\s+(\d+)/m)!;
	return {
		pid,
		...sessionIdentity(pid),
		uid: Number(uid[1]),
		euid: Number(uid[2]),
		gid: Number(gid[1]),
		egid: Number(gid[2]),
		caps: Object.fromEntries(
			[...status.matchAll(/^(Cap(?:Inh|Prm|Eff|Amb)):\s+([0-9a-f]+)$/gm)].map((match) => [match[1]!, match[2]!]),
		),
	};
}
function peer() {
	const child = spawn(python, [fixture, "peer"], { stdio: ["pipe", "pipe", "pipe"] });
	const ready = deferred<Identity>();
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
		if (output.includes("\n")) ready.resolve(JSON.parse(output.trim()));
	});
	const closed = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`peer exited ${code}`))));
	});
	closed.catch(() => {});
	return { child, ready: ready.promise, closed };
}
function launch(
	env: RemoteExecutionEnv,
	command: string | readonly string[],
	options: ShellExecOptions = {},
	abort = controller(),
	onReady?: (tree: Tree) => void,
) {
	const ready = deferred<Tree>();
	let record: Tree | undefined;
	let output = "";
	const result = env.exec(
		command,
		{
			...options,
			onOutput: (text) => {
				output += text;
				if (record === undefined && output.includes("\n")) {
					record = JSON.parse(output.slice(0, output.indexOf("\n"))) as Tree;
					ready.resolve(record);
					onReady?.(record);
				}
			},
		},
		withAbortSignal(abort.signal, context),
	);
	pending.push(result);
	return {
		result,
		abort,
		get record() {
			return record;
		},
		ready: () =>
			Promise.race([
				ready.promise,
				result.then((value) => {
					if (record) return record;
					throw new Error(`No fixture readiness: ${JSON.stringify(value)}`);
				}),
			]),
	};
}
function command(form: string, action: string) {
	const argv = [python, fixture, "contain", action];
	return form === "argv" ? argv : `exec ${argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")}`;
}

beforeEach(() => vi.stubEnv("PI_PROCESS_OWNER_BINARY", ""));
afterEach(async () => {
	for (const abort of controllers.splice(0)) abort.abort();
	// Release OS-seam holds on failed assertions too, so teardown joins without fixture-expiry credit.
	for (const release of seamReleases.splice(0)) release();
	await Promise.allSettled(envs.splice(0).map((env) => env.cleanup(context)));
	await Promise.allSettled(pending.splice(0));
	for (const connection of connections.splice(0)) connection.close();
	for (const owned of peers.splice(0)) {
		owned.child.stdin.end();
		await owned.closed;
	}
	for (const watcher of watchers.splice(0)) watcher.close();
	for (const fd of gateFds.splice(0)) closeSync(fd);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe.skipIf(process.platform !== "linux")("real owned exec acceptance", () => {
	it("hello without ownedExec1 refuses owned dispatch but preserves unmarked legacy exec", async () => {
		const { env, connection, cwd } = environment(
			qualified ? [process.execPath, wire, "featureless", daemon] : [daemon],
		);
		expect((await connection.info()).features).not.toContain("ownedExec1");
		const sentinel = join(cwd, "must-not-start");
		expect(await env.exec([python, fixture, "touch", sentinel], undefined, context)).toMatchObject({
			ok: false,
			error: { code: "unknown", cause: { code: "ERR_PROCESS_OWNER_CLEANUP" } },
		});
		expect(existsSync(sentinel)).toBe(false);
		await env.cleanup(context);
		delete process.env.PI_PROCESS_OWNER_BINARY;
		expect(
			getOrThrow(
				await env.exec(["/bin/sh", "-c", "exit 125"], { env: { PI_PROCESS_OWNER_BINARY: "target-only" } }, context),
			).exitCode,
		).toBe(125);
		await env.cleanup(context);
	});

	if (!qualified) {
		it(`owned rows not applicable: ownedExec1 withheld; runtime glibc ${glibc}`, () => {
			expect(selectedHello?.features).not.toContain("ownedExec1");
			console.info(`Owned rows not applicable: real daemon withheld ownedExec1; runtime glibc ${glibc}`);
		});
		return;
	}

	beforeAll(() => {
		for (const tool of [python, "/usr/bin/bwrap", "/usr/bin/mkfifo"]) {
			try {
				execFileSync(tool, ["--version"], { timeout: 1000, stdio: "pipe" });
			} catch (cause) {
				throw new Error(`Daemon advertises ownedExec1, but required fixture tool is missing or unusable: ${tool}`, {
					cause,
				});
			}
		}
		try {
			execFileSync(
				python,
				[
					"-c",
					"import ctypes,glob,json,os,select,signal,subprocess,time; assert hasattr(os, 'fork') and hasattr(os, 'setsid')",
				],
				{ timeout: 1000, stdio: "pipe" },
			);
		} catch (cause) {
			throw new Error("Daemon advertises ownedExec1, but Python fixture dependencies are missing or unusable", {
				cause,
			});
		}
	});

	it.each([
		["argv", "7"],
		["shell", "7"],
		["argv", "125"],
		["shell", "125"],
		["argv", "abort"],
		["shell", "abort"],
		["argv", "timeout"],
		["shell", "timeout"],
		["argv", "cleanup"],
		["shell", "cleanup"],
	])(
		"%s %s fences double-fork/setsid descendants without harming peers",
		async (form, action) => {
			let readyPath = "";
			const { env, connection, cwd } = environment(async () =>
				action === "timeout" ? [python, trace, daemon, readyPath, "timeout"] : [daemon],
			);
			readyPath = join(cwd, "timeout-ready");
			let armFd: number | undefined;
			let armed: Promise<unknown> | undefined;
			if (action === "timeout") {
				execFileSync("/usr/bin/mkfifo", ["-m", "600", `${readyPath}.arm`], { timeout: 1000 });
				armFd = openSync(`${readyPath}.arm`, constants.O_RDWR | constants.O_NONBLOCK);
				gateFds.push(armFd);
				armed = jsonFile(`${readyPath}.armed`);
			}
			const hello = await connection.info();
			if (armFd !== undefined) {
				writeSync(armFd, "A");
				const fd = armFd;
				seamReleases.push(() => writeSync(fd, "R"));
				await armed;
			}
			expect(nodePlatform(hello)).toEqual(expectedDaemonPlatform);
			expect(hello.features).toContain("ownedExec1");
			const daemonSession = sessionIdentity(hello.pid);
			const daemonObserved = daemonIdentity(hello.pid);
			unprivileged(daemonObserved);
			const independent = peer();
			peers.push(independent);
			const independentIdentity = await independent.ready;
			unprivileged(independentIdentity);
			const siblingEnv = new RemoteExecutionEnv({ connection, id: "sibling", cwd });
			envs.push(siblingEnv);
			const sibling = launch(siblingEnv, [python, fixture, "wait"]);
			const siblingIdentity = (await sibling.ready()) as unknown as Identity;
			const abort = controller();
			const started = performance.now();
			let stopping: Promise<void> | undefined;
			const running = launch(
				env,
				command(form, ["abort", "timeout", "cleanup"].includes(action) ? "wait" : action),
				action === "timeout" ? { timeout: 0.1, env: { PI_ENV_C_READY_FILE: readyPath } } : {},
				abort,
				() => {
					if (action === "abort") abort.abort();
					if (action === "cleanup") stopping = env.cleanup(context);
				},
			);
			const result = await running.result;
			// One immediate signal0 per leaf; ESRCH excludes zombies. Never poll or wait for fixture expiry.
			const leafState = running.record ? probe(running.record.leaf.pid) : "not-ready";
			const siblingState = probe(siblingIdentity.pid);
			const peerState = probe(independentIdentity.pid);
			expect(leafState).toBe("ESRCH");
			if (action === "timeout") {
				const gate = JSON.parse(readFileSync(`${readyPath}.trace`, "utf8"));
				expect(gate.releasedAfterReady).toBe(true);
				expect(gate.events.at(-1).leaf).toBe(running.record!.leaf.pid);
				console.error(JSON.stringify({ row: "timeout-readiness-gate", ...gate }));
			}
			expect(performance.now() - started).toBeLessThan(3000);
			expect(siblingState).toBe("alive");
			expect(peerState).toBe("alive");
			const tree = running.record!;
			unprivileged(tree.primary);
			unprivileged(tree.leaf);
			unprivileged(siblingIdentity);
			expect([tree.primary.pid, tree.primary.pid]).toEqual([tree.primary.sid, tree.primary.pgrp]);
			expect(tree.leaf.sid).not.toBe(tree.primary.sid);
			expect(tree.leaf.pid).not.toBe(tree.leaf.sid);
			expect(Object.keys(tree.primary.fds).sort()).toEqual(["0", "1", "2"]);
			if (action === "abort" || action === "timeout") {
				expect(result).toMatchObject({ ok: false, error: { code: action === "abort" ? "aborted" : "timeout" } });
				if (!result.ok)
					expect(result.error.cause).toMatchObject({ fields: { owner: { v: 1, state: "complete" } } });
			} else expect(getOrThrow(result).exitCode).toBe(action === "cleanup" ? 137 : Number(action));
			await stopping;
			await env.cleanup(context);
			await env.cleanup(context);
			expect(getOrThrow(await env.exec(["/bin/sh", "-c", "exit 7"], undefined, context)).exitCode).toBe(7);
			expect((await connection.info()).pid).toBe(hello.pid);
			expect(sessionIdentity(hello.pid)).toEqual(daemonSession);
			sibling.abort.abort();
			expect(await sibling.result).toMatchObject({ ok: false, error: { code: "aborted" } });
			console.error(
				JSON.stringify({
					row: `${form}-${action}`,
					daemon: daemonObserved,
					...tree,
					sibling: siblingIdentity,
					peer: independentIdentity,
					leafState,
					siblingState,
					peerState,
				}),
			);
		},
		5000,
	);

	it("kill returns actual primary137 with complete ownership", async () => {
		const { connection, cwd } = environment();
		let id = 0;
		let session = 0;
		let output = "";
		let tree: Tree | undefined;
		const abort = controller();
		const response = connection.request(
			"exec",
			{ argv: [python, fixture, "contain", "wait"], cwd, owner: { v: 1 } },
			{
				signal: abort.signal,
				onStart: (request, current) => {
					id = request;
					session = current;
				},
				onEvent: (event, payload) => {
					if (event.kind !== "output") return;
					output += Buffer.from(payload).toString("utf8");
					if (!tree && output.includes("\n")) {
						tree = JSON.parse(output.trim()) as Tree;
						connection.kill(id, session);
					}
				},
			},
		);
		pending.push(response);
		const reply = await response;
		const leafState = tree ? probe(tree.leaf.pid) : "not-ready";
		expect(leafState).toBe("ESRCH");
		expect(reply.json).toMatchObject({ exitCode: 137, owner: { v: 1, state: "complete" } });
		console.error(JSON.stringify({ row: "kill", terminal: reply.json, tree, leafState }));
	});

	it("concurrent cleanup joins every snapshot entry; repeated cleanup remains safe", async () => {
		const { env } = environment();
		const first = launch(env, command("argv", "wait"));
		const second = launch(env, command("shell", "wait"));
		await Promise.all([first.ready(), second.ready()]);
		await Promise.all([env.cleanup(context), env.cleanup(context)]);
		const states = [probe(first.record!.leaf.pid), probe(second.record!.leaf.pid)];
		expect(states).toEqual(["ESRCH", "ESRCH"]);
		expect((await Promise.all([first.result, second.result])).map((result) => getOrThrow(result).exitCode)).toEqual([
			137, 137,
		]);
		await env.cleanup(context);
		console.error(JSON.stringify({ row: "cleanup-two", states }));
	});

	it.each(["cwd", "hello"])(
		"cleanup registers before blocked %s; no fabricated137 or later dispatch",
		async (phase) => {
			const gate = deferred<void>();
			const { env, cwd } = environment(async () => {
				await gate.promise;
				return [daemon];
			});
			const sentinel = join(cwd, "must-not-start");
			const running = env.exec(
				[python, fixture, "touch", sentinel],
				phase === "cwd" ? { cwd: "." } : undefined,
				context,
			);
			pending.push(running);
			let settled = false;
			const cleanup = Promise.all([env.cleanup(context), env.cleanup(context)]).then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			gate.resolve();
			expect(await running).toMatchObject({ ok: false, error: { code: "aborted" } });
			await cleanup;
			expect(existsSync(sentinel)).toBe(false);
			await env.cleanup(context);
		},
	);

	it("pre-aborted owned Connection request is local not-started and never calls onStart", async () => {
		const { connection, cwd } = environment();
		const abort = controller();
		abort.abort();
		let starts = 0;
		await expect(
			connection.request(
				"exec",
				{ argv: [python, fixture, "touch", join(cwd, "must-not-start")], cwd, owner: { v: 1 } },
				{ signal: abort.signal, onStart: () => starts++ },
			),
		).rejects.toMatchObject({ code: "aborted", fields: { owner: { v: 1, state: "not-started" } } });
		expect(starts).toBe(0);
		expect(existsSync(join(cwd, "must-not-start"))).toBe(false);
	});

	it("captured host ownership survives marker deletion; target marker is literal data", async () => {
		const gate = deferred<void>();
		const { env, cwd } = environment(async () => {
			await gate.promise;
			return [daemon];
		});
		let output = "";
		const running = env.exec(
			[python, fixture, "context", "space arg", ""],
			{
				cwd: ".",
				inheritEnv: false,
				env: { PI_PROCESS_OWNER_BINARY: "target-literal", X: "value", PYTHONCOERCECLOCALE: "0", PYTHONUTF8: "1" },
				onOutput: (text) => {
					output += text;
				},
			},
			context,
		);
		delete process.env.PI_PROCESS_OWNER_BINARY;
		gate.resolve();
		expect(getOrThrow(await running).exitCode).toBe(0);
		const observed = JSON.parse(output);
		expect(observed.argv).toEqual(["space arg", ""]);
		expect(observed.cwd).toBe(cwd);
		expect(observed.env).toEqual({
			PI_PROCESS_OWNER_BINARY: "target-literal",
			X: "value",
			PYTHONCOERCECLOCALE: "0",
			PYTHONUTF8: "1",
		});
		expect(observed.primary.pid).toBe(observed.primary.sid);
		unprivileged(observed.primary);
	});

	it("false terminal ownership fails closed and cleanup retains uncertainty", async () => {
		const { env, cwd } = environment([process.execPath, wire, "missing-owner", daemon]);
		const sentinel = join(cwd, "once");
		expect(await env.exec([python, fixture, "touch", sentinel], undefined, context)).toMatchObject({
			ok: false,
			error: { code: "unknown", cause: { code: "ERR_PROCESS_OWNER_CLEANUP" } },
		});
		expect(readFileSync(sentinel, "utf8")).toBe("started");
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(env.cleanup(context)).rejects.toMatchObject({
				code: "unknown",
				cause: { code: "ERR_PROCESS_OWNER_CLEANUP" },
			});
		}
	});

	it.each(["normal", "bad-cwd", "abort", "kill"])(
		"real discovery + main history: %s",
		async (action) => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-env-owned-discovery-"));
			dirs.push(cwd);
			const report = join(cwd, "lookup.json");
			const gate = join(cwd, "lookup-gate");
			const sentinel = join(cwd, "must-not-start");
			writeFileSync(join(cwd, "which"), `#!${python}\n${readFileSync(fixture, "utf8")}`, { mode: 0o700 });
			execFileSync("/usr/bin/mkfifo", ["-m", "600", gate], { timeout: 1000 });
			const gateFd = openSync(gate, constants.O_RDWR | constants.O_NONBLOCK);
			gateFds.push(gateFd);
			// Gentoo's /usr/bin/python3 can be python-exec, whose next executable is hidden by the namespace.
			const pythonElf = execFileSync(python, ["-c", "import os,sys;print(os.path.realpath(sys.executable))"], {
				encoding: "utf8",
				timeout: 1000,
			}).trim();
			vi.stubEnv("PATH", cwd);
			vi.stubEnv("PI_ENV_C_LOOKUP_REPORT", report);
			vi.stubEnv("PI_ENV_C_LOOKUP_GATE", gate);
			vi.stubEnv("DAEMON_ONLY", "literal");
			// Same unprivileged namespace calibration used by A1; hide /bin/bash without changing host files.
			const namespace = new Connection({
				command: [
					"/usr/bin/bwrap",
					"--ro-bind",
					"/",
					"/",
					"--bind",
					cwd,
					cwd,
					"--unshare-user",
					"--uid",
					String(process.getuid?.()),
					"--gid",
					String(process.getgid?.()),
					"--dev",
					"/dev",
					"--tmpfs",
					"/usr/bin",
					"--ro-bind",
					"/usr/bin/bash",
					"/usr/bin/sh",
					"--ro-bind",
					pythonElf,
					python,
					daemon,
				],
			});
			connections.push(namespace);
			const native = new RemoteExecutionEnv({ connection: namespace, id: "two-scope", cwd });
			envs.push(native);
			const hello = await namespace.info();
			expect(hello.features).toContain("ownedExec1");
			const daemonSession = sessionIdentity(hello.pid);
			const daemonObserved = daemonIdentity(hello.pid);
			unprivileged(daemonObserved);
			const ready = deferred<Tree & { env: Record<string, string> }>();
			const watcher = watch(cwd, (_event, name) => {
				if (String(name) === "lookup.json" && existsSync(report))
					ready.resolve(JSON.parse(readFileSync(report, "utf8")));
			});
			watchers.push(watcher);
			const abort = controller();
			let id = 0;
			let session = 0;
			let main: Tree | undefined;
			let output = "";
			// Raw Connection retains terminal history state; same native instance also serves RemoteEnv recovery below.
			const running = namespace.request(
				"exec",
				{
					owner: { v: 1 },
					command: action === "normal" ? command("shell", "7") : `exec ${python} '${fixture}' touch '${sentinel}'`,
					cwd: action === "bad-cwd" ? join(cwd, "missing") : cwd,
					inheritEnv: false,
					env: { MAIN_ONLY: "overlay" },
				},
				{
					signal: abort.signal,
					onStart: (request, current) => {
						id = request;
						session = current;
					},
					onEvent: (event, payload) => {
						if (event.kind === "output") {
							output += Buffer.from(payload).toString("utf8");
							if (!main && output.includes("\n")) main = JSON.parse(output.trim()) as Tree;
						}
					},
				},
			);
			const outcome = running.then(
				(reply) => ({ reply, error: undefined }),
				(error: unknown) => ({ reply: undefined, error }),
			);
			pending.push(outcome);
			const lookup = await Promise.race([
				ready.promise,
				outcome.then((value) => {
					throw new Error(`No lookup readiness: ${JSON.stringify(value)}`);
				}),
			]);
			if (action === "abort") abort.abort();
			else if (action === "kill") namespace.kill(id, session);
			else writeSync(gateFd, "G");
			const result = await outcome;
			const lookupLeafState = probe(lookup.leaf.pid);
			const mainLeafState = main ? probe(main.leaf.pid) : "not-started";
			expect(lookupLeafState).toBe("ESRCH");
			unprivileged(lookup.primary);
			unprivileged(lookup.leaf);
			expect({ sid: lookup.primary.sid, pgrp: lookup.primary.pgrp }).toEqual(daemonSession);
			expect(lookup.env.DAEMON_ONLY).toBe("literal");
			expect(lookup.env).not.toHaveProperty("MAIN_ONLY");
			expect(Object.keys(lookup.primary.fds).sort()).toEqual(["0", "1", "2"]);
			if (action === "normal") {
				expect(result.reply?.json).toMatchObject({ exitCode: 7, owner: { v: 1, state: "complete" } });
				expect(mainLeafState).toBe("ESRCH");
			} else {
				expect(result.error).toBeInstanceOf(RemoteError);
				expect(result.error).toMatchObject({
					code: action === "bad-cwd" ? "spawn_error" : "aborted",
					fields: { owner: { v: 1, state: "complete" } },
				});
				expect(main).toBeUndefined();
				expect(existsSync(sentinel)).toBe(false);
			}
			// Explicit-shell RemoteEnv request avoids reopening gated lookup and proves same daemon remains usable.
			const recovery = new RemoteExecutionEnv({ connection: namespace, id: "recovery", cwd, shellPath: "/bin/sh" });
			envs.push(recovery);
			expect(getOrThrow(await recovery.exec("exit 7", undefined, context)).exitCode).toBe(7);
			expect((await namespace.info()).pid).toBe(hello.pid);
			await native.cleanup(context);
			console.error(
				JSON.stringify({
					row: `two-scope-${action}`,
					daemon: daemonObserved,
					lookup,
					main,
					lookupLeafState,
					mainLeafState,
					terminal: result.reply?.json ?? (result.error as RemoteError).fields,
				}),
			);
		},
		5000,
	);

	it.each([false, true])(
		"split UTF8, >100ms pause, >4MiB output and spill join before return; window=%s",
		async (windowed) => {
			const { env } = environment();
			let output = "";
			let skipped = 0;
			let settled = false;
			let late = 0;
			const result = getOrThrow(
				await env.exec(
					[python, fixture, "output"],
					{
						spill: { afterBytes: 1024, afterLines: 100 },
						...(windowed
							? { window: { maxBytes: 1000, maxLines: 20, minIntervalMs: 20, bytesPerSecond: 1_000_000 } }
							: {}),
						onOutput: (text, _context, info) => {
							if (settled) late++;
							output += text;
							skipped += info.skipped?.bytes ?? 0;
						},
					},
					context,
				),
			);
			settled = true;
			const expected = Buffer.concat([Buffer.from("€"), Buffer.alloc(80 * 65536, "x"), Buffer.from("\nEND\n")]);
			expect(result.exitCode).toBe(0);
			expect(Buffer.byteLength(output) + skipped).toBe(expected.length);
			expect(output.endsWith("\nEND\n")).toBe(true);
			if (windowed) expect(skipped).toBeGreaterThan(0);
			else expect(Buffer.compare(Buffer.from(output), expected)).toBe(0);
			expect(result.spillPath).toBeDefined();
			expect(Buffer.compare(readFileSync(result.spillPath!), expected)).toBe(0);
			rmSync(result.spillPath!);
			expect(getOrThrow(await env.exec(["/bin/sh", "-c", "exit 7"], undefined, context)).exitCode).toBe(7);
			expect(late).toBe(0);
			console.error(
				JSON.stringify({
					row: `output-window-${windowed}`,
					delivered: Buffer.byteLength(output),
					skipped,
					total: expected.length,
					late,
				}),
			);
		},
	);

	it.each([false, true])(
		"callback failure precedence against real terminal; missing-owner=%s",
		async (missingOwner) => {
			const { env } = environment(missingOwner ? [process.execPath, wire, "missing-owner", daemon] : [daemon]);
			const callback = new Error("acceptance callback failed");
			const running = launch(env, command("argv", "wait"), {}, controller(), () => {
				throw callback;
			});
			const result = await running.result;
			const leafState = running.record ? probe(running.record.leaf.pid) : "not-ready";
			expect(leafState).toBe("ESRCH");
			if (missingOwner) {
				expect(result).toMatchObject({
					ok: false,
					error: { code: "unknown", cause: { code: "ERR_PROCESS_OWNER_CLEANUP" } },
				});
				await expect(env.cleanup(context)).rejects.toMatchObject({ cause: { code: "ERR_PROCESS_OWNER_CLEANUP" } });
			} else {
				expect(result).toMatchObject({ ok: false, error: { code: "callback_error", cause: callback } });
				await env.cleanup(context);
			}
		},
	);

	it.each([
		"valid",
		"missing-c",
		"missing-c-125",
		"c-only",
		"malformed",
		"order",
		"oversize",
		"partial",
		"status-mismatch",
	])(
		"native control matrix: %s (not RPC terminal stripping)",
		async (fault) => {
			const native = await traced(`control-${fault}`);
			const primaryExit = fault === "missing-c-125" ? 125 : 7;
			const running = launch(native.env, command("argv", String(primaryExit)));
			const result = await running.result;
			const leafState = running.record ? probe(running.record.leaf.pid) : "not-ready";
			expect(leafState).toBe("ESRCH");
			const proof = native.trace();
			const substitution = proof.events.find((event) => event.event === "native-control-read-substitution")!;
			expect(substitution).toBeDefined();
			const records = substitution.original!.trim().split("\n");
			expect(JSON.parse(records[0]!.slice(1)).pid).toBe(running.record!.primary.pid);
			expect(JSON.parse(records[1]!.slice(1))).toEqual({ code: primaryExit, signal: null });
			expect(records[2]).toBe("C");
			if (fault === "valid") {
				expect(getOrThrow(result).exitCode).toBe(7);
				await native.env.cleanup(context);
			} else {
				expect(result).toMatchObject({
					ok: false,
					error: { code: "unknown", cause: { code: "ERR_PROCESS_OWNER_CLEANUP" } },
				});
				if (fault === "status-mismatch" && !result.ok) {
					expect(result.error.cause).toMatchObject({
						message: expect.stringContaining("helper wait disagrees with control status"),
					});
				}
				await expect(native.env.cleanup(context)).rejects.toMatchObject({
					cause: { code: "ERR_PROCESS_OWNER_CLEANUP" },
				});
			}
			console.error(JSON.stringify({ row: `native-control-${fault}`, leafState, ...proof }));
		},
		5000,
	);

	it.each([
		["setup", "abort"],
		["publication", "kill"],
		["replace", "abort"],
	])(
		"stop at native %s boundary: %s",
		async (boundary, stop) => {
			const native = await traced(`stop-${boundary}`, boundary !== "setup");
			const held = jsonFile<{ point: string; scope: number }>(`${native.path}.held`);
			const abort = controller();
			const sentinel = join(native.cwd, "main-must-not-start");
			let id = 0;
			let session = 0;
			const request = native.connection.request(
				"exec",
				{
					owner: { v: 1 },
					cwd: native.cwd,
					...(boundary === "setup"
						? { argv: [python, fixture, "touch", sentinel] }
						: { command: `exec ${python} '${fixture}' touch '${sentinel}'` }),
				},
				{
					signal: abort.signal,
					onStart: (requestId, current) => {
						id = requestId;
						session = current;
					},
				},
			);
			const outcome = request.then(
				(reply) => ({ reply, error: undefined }),
				(error: unknown) => ({ reply: undefined, error }),
			);
			pending.push(outcome);
			let lookup: Tree | undefined;
			if (boundary === "replace") {
				lookup = await Promise.race([
					native.lookupReady!,
					outcome.then((value) => {
						throw new Error(`Lookup ended before readiness: ${JSON.stringify(value)}`);
					}),
				]);
				writeSync(native.lookupGate!, "G");
			}
			const point = await Promise.race([
				held,
				outcome.then((value) => {
					throw new Error(`Stop gate absent: ${JSON.stringify(value)}`);
				}),
			]);
			expect(point.point).toBe(boundary === "publication" ? "spawn-stdio" : "memfd");
			expect(point.scope).toBe(boundary === "replace" ? 2 : 1);
			if (stop === "kill") native.connection.kill(id, session);
			else abort.abort();
			// Hello is a FIFO barrier after CANCEL, not a timing sleep.
			await native.connection.request("hello", { protocol: 1 });
			writeSync(native.commandFd, "R");
			const result = await outcome;
			const leafState = lookup ? probe(lookup.leaf.pid) : "no-ready-target-required";
			if (boundary === "replace") expect(leafState).toBe("ESRCH");
			expect(result.error).toMatchObject({
				code: "aborted",
				fields: { owner: { v: 1, state: boundary === "setup" ? "not-started" : "complete" } },
			});
			expect(existsSync(sentinel)).toBe(false);
			const proof = native.trace();
			expect(proof.events.filter((event) => event.event === "process-fork" && event.fromDaemon)).toHaveLength(
				boundary === "setup" ? 0 : 1,
			);
			const recovery = new RemoteExecutionEnv({
				connection: native.connection,
				cwd: native.cwd,
				id: "stop-recovery",
				shellPath: "/bin/sh",
			});
			envs.push(recovery);
			expect(getOrThrow(await recovery.exec("exit 7", undefined, context)).exitCode).toBe(7);
			expect((await native.connection.info()).pid).toBe(native.hello.pid);
			console.error(JSON.stringify({ row: `stop-${boundary}`, point, leafState, ...proof }));
		},
		5000,
	);

	it.each(["observe", "observe-eof"])(
		"native abrupt death/transport EOF with containment and session replacement: %s",
		async (mode) => {
			const native = await traced(mode);
			const oldSession = await native.connection.session();
			const independent = peer();
			peers.push(independent);
			const independentIdentity = await independent.ready;
			const running = launch(native.env, command("argv", "wait"));
			await running.ready();
			if (mode === "observe") writeSync(native.commandFd, "K");
			else writeFileSync(`${native.path}.eof`, "EOF");
			const result = await running.result;
			// Fixture transport closes only after exact traced exits, not Connection.close acknowledgement.
			const leafState = probe(running.record!.leaf.pid);
			const peerState = probe(independentIdentity.pid);
			expect(leafState).toBe("ESRCH");
			expect(peerState).toBe("alive");
			expect(result).toMatchObject({
				ok: false,
				error: { code: "unknown", cause: { code: "ERR_PROCESS_OWNER_CLEANUP" } },
			});
			const joined = JSON.parse(readFileSync(`${native.path}.done`, "utf8"));
			expect(joined.joined).toBe(true);
			expect(joined.daemonStatus).toBe(mode === "observe" ? -9 : 0);
			await expect(native.env.cleanup(context)).rejects.toMatchObject({
				cause: { code: "ERR_PROCESS_OWNER_CLEANUP" },
			});
			const replacement = await native.connection.info();
			expect(replacement.pid).not.toBe(native.hello.pid);
			expect(await native.connection.session()).not.toBe(oldSession);
			await expect(
				native.connection.request(
					"exec",
					{ owner: { v: 1 }, argv: ["/bin/sh", "-c", "exit 0"], cwd: native.cwd },
					{ session: oldSession },
				),
			).rejects.toMatchObject({ fields: { lost: true } });
			const recovery = new RemoteExecutionEnv({ connection: native.connection, cwd: native.cwd, id: "replacement" });
			envs.push(recovery);
			expect(getOrThrow(await recovery.exec(["/bin/sh", "-c", "exit 7"], undefined, context)).exitCode).toBe(7);
			expect(native.starts()).toBe(2);
			console.error(
				JSON.stringify({ row: mode, oldSession, replacement: replacement.pid, leafState, peerState, joined }),
			);
		},
		5000,
	);

	it("native spill EFBIG followed by native control EIO preserves spill and uncertainty precedence", async () => {
		const native = await traced("spill-control");
		const running = launch(native.env, command("argv", "wait"), { spill: { afterBytes: 0, afterLines: 0 } });
		const result = await running.result;
		const leafState = running.record ? probe(running.record.leaf.pid) : "not-ready";
		expect(leafState).toBe("ESRCH");
		expect(result).toMatchObject({
			ok: false,
			error: { code: "unknown", cause: { code: "ERR_PROCESS_OWNER_CLEANUP" } },
		});
		if (result.ok) throw new Error("uncertainty cannot become success");
		expect(result.error.cause).toMatchObject({ message: expect.stringContaining("control read failed") });
		expect(result.error.spillPath).toBeDefined();
		expect(readFileSync(result.error.spillPath!).length).toBe(0);
		rmSync(result.error.spillPath!);
		const proof = native.trace();
		const spill = proof.events.findIndex((event) => event.event === "native-spill-write-EFBIG");
		const uncertainty = proof.events.findIndex((event) => event.event === "native-control-read-EIO");
		expect(spill).toBeGreaterThanOrEqual(0);
		expect(uncertainty).toBeGreaterThan(spill);
		await expect(native.env.cleanup(context)).rejects.toMatchObject({ cause: { code: "ERR_PROCESS_OWNER_CLEANUP" } });
		console.error(JSON.stringify({ row: "native-spill-control", leafState, ...proof }));
	}, 5000);

	it("abort racing committed write settles aborted, never fabricated137", async () => {
		const { connection, cwd } = environment();
		const abort = controller();
		let starts = 0;
		const error = await connection
			.request(
				"exec",
				{
					owner: { v: 1 },
					argv: [python, fixture, "wait"],
					cwd,
				},
				{
					signal: abort.signal,
					onStart: () => {
						starts++;
						abort.abort();
					},
				},
			)
			.catch((failure: unknown) => failure);
		expect(starts).toBe(1);
		expect(error).toBeInstanceOf(RemoteError);
		expect(error).toMatchObject({ code: "aborted", fields: { owner: { v: 1 } } });
		expect(["not-started", "complete"]).toContain(
			(error as RemoteError).fields.owner && ((error as RemoteError).fields.owner as { state: string }).state,
		);
	});

	it.each([
		["ENOENT", 2],
		["EACCES", 13],
		["E2BIG", 7],
	])("genuine target %s is distinct from primary125", async (name, errno) => {
		const { connection, cwd } = environment();
		const denied = join(cwd, "not-executable");
		writeFileSync(denied, "not executable", { mode: 0o600 });
		const argv =
			name === "ENOENT"
				? [join(cwd, "missing")]
				: name === "EACCES"
					? [denied]
					: ["/bin/sh", "-c", "x".repeat(131072)];
		await expect(connection.request("exec", { owner: { v: 1 }, argv, cwd })).rejects.toMatchObject({
			code: "spawn_error",
			fields: { owner: { v: 1, state: "complete" }, spawn: { stage: "target", errno } },
		});
	});
});
