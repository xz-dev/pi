import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { Worker } from "node:worker_threads";
import * as packageConfig from "../config.ts";

const OWNER_PID = "PI_PROCESS_OWNER_PID";
const OWNER_PENDING = "PI_PROCESS_OWNER_PENDING";
const OWNER_BINARY = "PI_PROCESS_OWNER_BINARY";
let cliOwnerPid: number | undefined;
let cliOwnerShutdownRequested = false;

// Embedded module works in source, npm and compiled Bun installs without another asset.
// Kernel CONT (or Darwin's observer) wakes the whole process; this thread needs no main-loop work.
const OWNER_WATCHDOG = `
import { workerData } from "node:worker_threads";
const ready = new Int32Array(workerData.ready);
if (process.pid !== workerData.pid || process.ppid !== workerData.parent) {
    Atomics.store(ready, 0, -1);
} else {
    let lostAt;
    setInterval(() => {
        if (process.ppid === workerData.parent) return;
        lostAt ??= performance.now();
        if (performance.now() - lostAt >= 7000) process.kill(process.pid, "SIGKILL");
    }, 50);
    Atomics.store(ready, 0, 1);
}
Atomics.notify(ready, 0);
`;

/** Only the validated immediate native owner can arm owner-loss shutdown. */
export function hasLostCliProcessOwner(): boolean {
	return cliOwnerPid !== undefined && process.ppid !== cliOwnerPid;
}

/** Notify the still-immediate native owner before a signal hook can block on terminal output. */
export function requestCliProcessOwnerShutdown(): void {
	if (cliOwnerPid === undefined || process.ppid !== cliOwnerPid || cliOwnerShutdownRequested) return;
	cliOwnerShutdownRequested = true;
	try {
		process.kill(cliOwnerPid, "SIGTERM");
	} catch (error) {
		if (!(error instanceof Error) || Reflect.get(error, "code") !== "ESRCH") throw error;
	}
}

function processOwnerBinary(): string {
	const root = packageConfig.getPackageDir();
	let directory = join(root, ...(packageConfig.isBunBinary ? [] : ["dist"]), "native", "process-owner");
	if (packageConfig.isBunBinary) {
		const materialize: unknown = Reflect.get(packageConfig, "materializeResourceTree");
		if (typeof materialize === "function") {
			const physical: unknown = materialize({
				sourceDir: join(root, "process-owner"),
				relativePath: "process-owner",
				fileMode: 0o700,
			});
			if (typeof physical !== "string" || !physical) throw new Error("Process owner materialization failed");
			directory = physical;
		}
	}
	const binary = join(directory, process.platform === "win32" ? "pi-env.exe" : "pi-env");
	try {
		accessSync(binary, constants.X_OK);
	} catch (error) {
		throw new Error(`Process owner helper is unavailable: ${binary}`, { cause: error });
	}
	return binary;
}

/** Give each task its own descendant lifetime inside an owned Pi session. */
export function ownedCommand(
	command: string,
	args: string[],
	controlFd?: number,
): { command: string; args: string[]; nativeOwner: boolean } {
	const binary = process.env[OWNER_BINARY];
	if (binary === undefined) return { command, args, nativeOwner: false };
	if (!binary.trim()) throw new Error("Process owner helper is empty");
	accessSync(binary, constants.X_OK);
	return {
		command: binary,
		args: [
			"supervise",
			...(controlFd === undefined ? [] : ["--control-fd", String(controlFd)]),
			"--",
			command,
			...args,
		],
		nativeOwner: true,
	};
}

/** Observe only the private native protocol; success also requires actual helper close and control drain. */
export function observeOwnedProcess(child: ChildProcess, onStartup?: () => void) {
	// Bun can omit extra stdio when CreateProcess itself fails. Preserve that error,
	// without allowing missing control transport to count as owned completion.
	if (process.platform === "win32" && !child.stdio[3]) {
		const completion = new Promise<{ code: number | null; errno: number | undefined }>((_resolve, reject) => {
			child.once("error", reject);
			child.once("close", () =>
				reject(
					Object.assign(new Error("Process owner cleanup unconfirmed: missing control pipe"), {
						code: "ERR_PROCESS_OWNER_CLEANUP",
					}),
				),
			);
		});
		return {
			completion,
			cancel: () => {},
			get started() {
				return false;
			},
		};
	}
	const lease = child.stdio[3] as Duplex;
	let state: "initial" | "started" | "exited" | "error" | "complete" = "initial";
	let started = false;
	let pending = "";
	let errno: number | undefined;
	let primaryCode: number | undefined;
	let failure: Error | undefined;
	let helperError: Error | undefined;
	let helperSpawned = false;
	let closed = false;
	let drained = false;
	let helperCode: number | null = null;
	let finish: () => void = () => {};
	let cancelled = false;
	const cancel = () => {
		if (lease.writable && !lease.destroyed && !lease.writableEnded) {
			if (process.platform === "win32") {
				if (!cancelled) {
					cancelled = true;
					lease.write("K");
				}
			} else if (!cancelled) {
				cancelled = true;
				// ChildProcess retains the unreaped controller; never signal a cached PID/group.
				if (child.pid && child.exitCode === null && child.signalCode === null) {
					try {
						if (!child.kill("SIGCONT")) fail("controller resume failed");
					} catch (error) {
						fail(error instanceof Error ? error.message : "controller resume failed");
					}
				}
				lease.end();
			}
		}
	};
	const fail = (detail: string) => {
		failure ??= Object.assign(new Error(`Process owner cleanup unconfirmed: ${detail}`), {
			code: "ERR_PROCESS_OWNER_CLEANUP",
		});
		cancel();
	};
	lease.setEncoding("utf8");
	lease.on("data", (data: string) => {
		if (failure) return;
		pending += data;
		if (pending.length > 4096) {
			fail("oversized control record");
			return;
		}
		while (pending.includes("\n")) {
			const newline = pending.indexOf("\n");
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			try {
				if (state === "initial" && line.startsWith("S")) {
					const record: unknown = JSON.parse(line.slice(1));
					if (
						!record ||
						typeof record !== "object" ||
						!("pid" in record) ||
						!Number.isSafeInteger(record.pid) ||
						Number(record.pid) <= 0 ||
						Object.keys(record).length !== 1
					) {
						throw new Error("invalid startup record");
					}
					state = "started";
					started = true;
					onStartup?.();
				} else if (state === "started" && line.startsWith("X")) {
					const record: unknown = JSON.parse(line.slice(1));
					if (
						!record ||
						typeof record !== "object" ||
						!("code" in record) ||
						!("signal" in record) ||
						Object.keys(record).length !== 2
					)
						throw new Error("invalid exit record");
					const { code, signal } = record;
					if (
						signal === null &&
						Number.isSafeInteger(code) &&
						Number(code) >= 0 &&
						Number(code) <= (process.platform === "win32" ? 0xffff_ffff : 255)
					) {
						primaryCode = Number(code);
					} else if (code === null && Number.isSafeInteger(signal) && Number(signal) > 0 && Number(signal) < 128) {
						primaryCode = 128 + Number(signal);
					} else throw new Error("invalid exit status");
					state = "exited";
				} else if (state === "initial" && /^E[1-9]\d* [^\n]+$/.test(line)) {
					errno = Number(line.slice(1, line.indexOf(" ")));
					if (!Number.isSafeInteger(errno)) throw new Error("invalid spawn errno");
					state = "error";
				} else if ((state === "exited" || state === "error") && line === "C") {
					state = "complete";
				} else throw new Error("invalid control record ordering");
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
				return;
			}
		}
		if (state === "complete" && pending) fail("bytes after completion record");
	});
	lease.on("error", (error: Error) => fail(error.message));
	lease.once("end", () => {
		drained = true;
		if (pending || state !== "complete") fail("missing or truncated completion record");
		finish();
	});
	lease.once("close", () => {
		if (!drained) fail("control closed before EOF");
		drained = true;
		finish();
	});
	child.once("spawn", () => {
		helperSpawned = true;
	});
	child.once("error", (error: Error) => {
		helperError = error;
		cancel();
	});
	child.once("close", (code) => {
		closed = true;
		helperCode = code;
		finish();
	});
	const completion = new Promise<{ code: number | null; errno: number | undefined }>((resolve, reject) => {
		finish = () => {
			if (!closed || !drained) return;
			if (process.platform === "win32") lease.destroy();
			if (helperError && !helperSpawned && !started) {
				reject(helperError);
				return;
			}
			if (pending || state !== "complete") fail("missing or truncated completion record");
			if (helperError) fail(helperError.message);
			const expected = errno === undefined ? primaryCode : 125;
			// Pinned Bun truncates Windows child status to u8; X retains native u32.
			const expectedHelper =
				process.platform === "win32" && process.versions.bun && expected !== undefined ? expected % 256 : expected;
			if (helperCode !== expectedHelper) fail("helper status does not match primary status");
			if (failure) reject(failure);
			else resolve({ code: errno === undefined ? (primaryCode ?? null) : helperCode, errno });
		};
	});
	return {
		completion,
		cancel,
		get started() {
			return started;
		},
	};
}

// Bootstrap precedes the full parser (which loads settings); skip its value-taking options.
const VALUE_OPTIONS = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--name",
	"-n",
	"--session",
	"--session-id",
	"--fork",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--thinking",
	"--export",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
]);

function ownershipDisabled(args: string[]): boolean {
	if (process.env.PI_NO_PROCESS_OWNERSHIP === "1") return true;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--") break;
		if (args[i] === "--no-process-ownership") return true;
		if (VALUE_OPTIONS.has(args[i])) i++;
	}
	return false;
}

/** Enter the shipped native owner before any CLI task or extension runs. */
export function ownCliProcesses(): undefined | false {
	cliOwnerPid = undefined;
	cliOwnerShutdownRequested = false;
	const owner = process.env[OWNER_PID];
	const pending = process.env[OWNER_PENDING];
	delete process.env[OWNER_PID];
	delete process.env[OWNER_PENDING];
	delete process.env[OWNER_BINARY];
	const cliArgs = process.argv.slice(2);
	if (ownershipDisabled(cliArgs)) {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("PI_PROCESS_OWNER_")) delete process.env[key];
		}
		return;
	}
	if (pending) throw new Error("Process owner did not complete its startup handoff");
	const parent = process.ppid;
	if (owner !== undefined && (parent <= 0 || owner !== String(parent))) {
		throw new Error("Process owner exited before its startup handoff completed");
	}
	// Version-only startup cannot load extensions or run tasks.
	if (cliArgs.length === 1 && (cliArgs[0] === "--version" || cliArgs[0] === "-v")) return;
	// The guardian grants this one-shot handoff only to its immediate child.
	if (owner !== undefined) {
		process.env[OWNER_BINARY] = processOwnerBinary();
		if (process.platform !== "win32") {
			cliOwnerPid = parent;
			const ready = new Int32Array(new SharedArrayBuffer(4));
			let watchdog: Worker;
			try {
				watchdog = new Worker(new URL(`data:text/javascript,${encodeURIComponent(OWNER_WATCHDOG)}`), {
					execArgv: [],
					workerData: { parent, pid: process.pid, ready: ready.buffer },
				});
			} catch (error) {
				throw new Error("Process owner watchdog unavailable; use --no-process-ownership to opt out", {
					cause: error,
				});
			}
			let exiting = false;
			process.once("exit", () => {
				exiting = true;
			});
			const failWatchdog = () => {
				if (!exiting) process.exit(125);
			};
			watchdog.once("error", failWatchdog);
			watchdog.once("exit", failWatchdog);
			watchdog.unref();
			Atomics.wait(ready, 0, 0, 5_000);
			if (Atomics.load(ready, 0) !== 1 || process.ppid !== parent) {
				void watchdog.terminate();
				throw new Error("Process owner watchdog unavailable during startup; use --no-process-ownership to opt out");
			}
			let requested = false;
			const requestOwnerShutdown = () => {
				if (requested || !hasLostCliProcessOwner()) return;
				requested = true;
				clearInterval(ownerWatch);
				process.kill(process.pid, "SIGTERM");
			};
			const ownerWatch = setInterval(requestOwnerShutdown, 1_000);
			process.on("SIGCONT", requestOwnerShutdown);
			ownerWatch.unref();
		}
		return;
	}
	if (
		process.platform !== "linux" &&
		process.platform !== "freebsd" &&
		process.platform !== "darwin" &&
		process.platform !== "win32"
	)
		return;

	const binary = processOwnerBinary();
	if (process.platform !== "win32" && !process.execve)
		throw new Error("Process ownership requires execve support in this runtime");

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env[OWNER_PENDING] = "1";
	const args = packageConfig.isBunBinary ? process.argv.slice(2) : [...process.execArgv, ...process.argv.slice(1)];
	if (process.platform === "win32") {
		// Windows has no execve. This wrapper never enters main or loads extensions.
		const child = spawn(binary, ["supervise", "--control-fd", "3", "--", process.execPath, ...args], {
			env,
			stdio: ["inherit", "inherit", "inherit", "pipe"],
		});
		const owner = observeOwnedProcess(child);
		// Console already delivers Ctrl-C to payload. Keep wrapper/lease alive for cleanup.
		process.on("SIGINT", () => {});
		process.on("SIGBREAK", () => {});
		process.on("SIGTERM", owner.cancel);
		void owner.completion.then(
			({ code, errno }) => process.exit(errno === undefined ? (code ?? 125) : 125),
			(error: unknown) => {
				console.error(error instanceof Error ? error.message : String(error));
				process.exit(125);
			},
		);
		return false;
	}
	process.execve!(binary, [binary, "supervise", "--", process.execPath, ...args], env);
}
