import type { ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import * as packageConfig from "../config.ts";

const OWNER_BINARY = "PI_PROCESS_OWNER_BINARY";

export { hasLostCliProcessOwner } from "./managed-child.ts";
export { ownCliProcesses } from "./procward.ts";

/** Retain pi-env's existing per-task ownership inside the procward-managed primary. */
export function enableTaskProcessOwnership(): void {
	const root = packageConfig.getPackageDir();
	let directory = join(root, ...(packageConfig.isBunBinary ? [] : ["dist"]), "native", "process-owner");
	if (packageConfig.isBunBinary) {
		directory = packageConfig.materializeResourceTree({
			sourceDir: join(root, "process-owner"),
			relativePath: "process-owner",
			fileMode: 0o700,
		});
	}
	const binary = join(directory, process.platform === "win32" ? "pi-env.exe" : "pi-env");
	try {
		accessSync(binary, constants.X_OK);
	} catch (error) {
		throw new Error(`Process owner helper is unavailable: ${binary}`, { cause: error });
	}
	process.env[OWNER_BINARY] = binary;
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
				lease.end("K");
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
