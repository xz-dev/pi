import type { ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import * as packageConfig from "../config.ts";

const OWNER_PID = "PI_PROCESS_OWNER_PID";
const OWNER_PENDING = "PI_PROCESS_OWNER_PENDING";
const OWNER_BINARY = "PI_PROCESS_OWNER_BINARY";

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
	const binary = join(directory, "pi-env");
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
	const cancel = () => {
		if (lease.writable && !lease.destroyed && !lease.writableEnded) lease.end("K");
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
					if (signal === null && Number.isSafeInteger(code) && Number(code) >= 0 && Number(code) <= 255) {
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
			if (helperError && !helperSpawned && !started) {
				reject(helperError);
				return;
			}
			if (pending || state !== "complete") fail("missing or truncated completion record");
			if (helperError) fail(helperError.message);
			if (helperCode !== (errno === undefined ? primaryCode : 125))
				fail("helper status does not match primary status");
			if (failure) reject(failure);
			else resolve({ code: helperCode, errno });
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

/** Enter the shipped native owner before any CLI task or extension runs. */
export function ownCliProcesses(): void {
	const owner = process.env[OWNER_PID];
	const pending = process.env[OWNER_PENDING];
	delete process.env[OWNER_PID];
	delete process.env[OWNER_PENDING];
	delete process.env[OWNER_BINARY];
	if (pending) throw new Error("Process owner did not complete its startup handoff");
	// Version-only startup cannot load extensions or run tasks.
	const cliArgs = process.argv.slice(2);
	if (cliArgs.length === 1 && (cliArgs[0] === "--version" || cliArgs[0] === "-v")) return;
	// The guardian grants this one-shot handoff only to its immediate child.
	if (process.ppid > 0 && owner === String(process.ppid)) {
		process.env[OWNER_BINARY] = processOwnerBinary();
		return;
	}
	if (process.platform !== "linux" && process.platform !== "freebsd" && process.platform !== "darwin") return;

	const binary = processOwnerBinary();
	if (!process.execve) throw new Error("Process ownership requires execve support in this runtime");

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env[OWNER_PENDING] = "1";
	const args = packageConfig.isBunBinary ? process.argv.slice(2) : [...process.execArgv, ...process.argv.slice(1)];
	process.execve(binary, [binary, "supervise", "--", process.execPath, ...args], env);
}
