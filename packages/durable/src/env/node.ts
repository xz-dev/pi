import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream, type Dir, type Stats, type WriteStream } from "node:fs";
import {
	access,
	appendFile,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	opendir,
	open as openFile,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, constants as osConstants, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { StreamDecoder } from "./decode.ts";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	type FileChange,
	FileError,
	type FileInfo,
	type FileKind,
	type FileWatcher,
	type LineScan,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellOutputInfo,
	type TextLine,
	type TextLineReader,
	toError,
	type WatchTarget,
} from "./index.ts";
import { LineScanner } from "./line-scan.ts";
import { NodeFileWatcher, type NodeWatchOptions } from "./node-watch.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const EXIT_STDIO_GRACE_MS = 100;
const OWNER_REPORT_MAX_BYTES = 4096;

const SPILL_HIGH_WATER_MARK = 1024 * 1024;
/** Largest single read of a `BinaryReader`, so a huge `length` allocates only as much as the file yields. */
const BINARY_READ_CHUNK = 1024 * 1024;

type SpillChunk = string | Uint8Array;

function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

function resolvePath(cwd: string, path: string): string {
	let normalized = path;
	if (normalized === "~") {
		normalized = homedir();
	} else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// Keep malformed URLs as ordinary paths so filesystem methods preserve their non-throwing contract.
		}
	}
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function fileKindFromStats(stats: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): FileKind | undefined {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

function fileInfoFromStats(
	path: string,
	stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number },
): Result<FileInfo, FileError> {
	const kind = fileKindFromStats(stats);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: basename(path),
		path,
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function toFileError(error: unknown, fallbackPath?: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	const nodeError = isNodeError(error) ? error : undefined;
	const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
	if (nodeError) {
		const message = nodeError.message;
		switch (nodeError.code) {
			case "ABORT_ERR":
				return new FileError("aborted", message, path, cause);
			case "ENOENT":
				return new FileError("not_found", message, path, cause);
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", message, path, cause);
			case "ENOTDIR":
				return new FileError("not_directory", message, path, cause);
			case "EISDIR":
				return new FileError("is_directory", message, path, cause);
			case "EINVAL":
				return new FileError("invalid", message, path, cause);
		}
	}
	return new FileError("unknown", cause.message, path, cause);
}

function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

interface OwnerExit {
	code: number | null;
	signal: number | null;
}

/** The private fd-3 stream reports S,X,C or E,C; C confirms completed cleanup. */
type OwnerRecord =
	| { kind: "startup" }
	| { kind: "exit"; report: OwnerExit }
	| { kind: "spawnError"; errno: number }
	| { kind: "cleanup" };

function parseOwnerLine(line: string): OwnerRecord {
	if (line === "C") return { kind: "cleanup" };
	const spawnFailure = /^E(\d+) [\s\S]*$/.exec(line);
	if (spawnFailure) {
		const errno = Number(spawnFailure[1]);
		if (!Number.isSafeInteger(errno) || errno <= 0 || errno > 2_147_483_647)
			throw new Error("Invalid process owner errno");
		return { kind: "spawnError", errno };
	}
	if (line.startsWith("S") || line.startsWith("X")) {
		const parsed: unknown = JSON.parse(line.slice(1));
		if (!parsed || typeof parsed !== "object") throw new Error("Invalid process owner report");
		if (line.startsWith("S")) {
			if (
				!("pid" in parsed) ||
				typeof parsed.pid !== "number" ||
				!Number.isSafeInteger(parsed.pid) ||
				parsed.pid <= 0
			)
				throw new Error("Invalid process owner startup record");
			return { kind: "startup" };
		}
		const code = "code" in parsed ? parsed.code : undefined;
		const signal = "signal" in parsed ? parsed.signal : undefined;
		if (
			typeof code === "number" &&
			Number.isInteger(code) &&
			code >= 0 &&
			code <= (process.platform === "win32" ? 0xffff_ffff : 255) &&
			signal === null
		)
			return { kind: "exit", report: { code, signal } };
		if (code === null && typeof signal === "number" && Number.isInteger(signal) && signal > 0 && signal <= 127)
			return { kind: "exit", report: { code, signal } };
		throw new Error("Invalid process owner exit record");
	}
	throw new Error("Invalid process owner report");
}

/** One native child and lease; completion requires C, helper close AND control EOF. */
type Duplex = import("node:stream").Duplex;

class OwnedProcess {
	readonly child: ChildProcess;
	private readonly lease: Duplex | undefined;
	private report = "";
	private started = false;
	private primaryExit: OwnerExit | undefined;
	private spawnErrno: number | undefined;
	private cleanupConfirmed = false;
	private cancelled = false;
	private protocolError: Error | undefined;
	private launchError: Error | undefined;
	private stderrListener: ((chunk: Buffer) => void) | undefined;
	// A readable listener keeps startup stderr paused, even during ChildProcess exit flushing.
	private readonly holdStderr = () => {};
	readonly completed: Promise<OwnerExit>;

	constructor(child: ChildProcess, program: string, args: readonly string[]) {
		this.child = child;
		child.stderr?.on("readable", this.holdStderr);
		// Bun can leave fd 3 null when the helper itself failed to spawn.
		this.lease = (child.stdio[3] as Duplex | null) ?? undefined;
		const controlFinished = this.lease
			? new Promise<void>((resolve) => {
					let readableEOF = false;
					this.lease?.once("end", () => {
						readableEOF = true;
						if (this.report !== "" || !this.cleanupConfirmed)
							this.fail(new Error("Incomplete process owner cleanup report"));
						resolve();
					});
					this.lease?.once("close", () => {
						if (!readableEOF) this.fail(new Error("Process owner control closed before EOF"));
						resolve();
					});
				})
			: Promise.resolve();
		const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
			child.once("close", (code, signal) => resolve({ code, signal })),
		);
		child.on("error", (error) => {
			this.launchError ??= error;
			this.discardStderr();
			this.kill();
		});
		this.lease?.on("data", (chunk: Buffer) => this.readControl(chunk));
		this.lease?.on("error", (error) => this.fail(error));
		this.completed = Promise.all([closed, controlFinished]).then(([helper]) => {
			this.lease?.destroy();
			if (this.launchError) throw this.launchError;
			if (this.protocolError) throw this.protocolError;
			const expectedCode = this.primaryExit ? (this.primaryExit.code ?? 128 + (this.primaryExit.signal ?? 0)) : 125;
			const expectedHelper =
				process.platform === "win32" && process.versions.bun ? expectedCode % 256 : expectedCode;
			if (helper.signal !== null || helper.code !== expectedHelper) {
				const failure = new Error(
					`Process owner failed: expected exit ${expectedCode}, received ${helper.signal ?? helper.code}`,
				);
				this.fail(failure);
				throw failure;
			}
			if (this.spawnErrno !== undefined) throw ownerSpawnError(program, args, this.spawnErrno);
			if (!this.primaryExit) {
				const failure = new Error("Incomplete process owner report");
				this.fail(failure);
				throw failure;
			}
			return this.primaryExit;
		});
	}

	onStderr(listener: (chunk: Buffer) => void): void {
		this.stderrListener = listener;
		if (this.started) this.startStderr();
	}

	private startStderr(): void {
		if (!this.stderrListener) return;
		this.child.stderr?.removeListener("readable", this.holdStderr);
		this.child.stderr?.on("data", this.stderrListener);
	}

	private discardStderr(): void {
		if (this.started) return;
		this.child.stderr?.removeListener("readable", this.holdStderr);
		this.child.stderr?.resume();
	}

	private fail(error: Error): void {
		this.protocolError ??= Object.assign(error, { code: "ERR_PROCESS_OWNER_CLEANUP" });
		this.discardStderr();
		this.kill();
	}

	private readControl(chunk: Buffer): void {
		if (this.protocolError) return;
		this.report += chunk.toString("utf8");
		if (Buffer.byteLength(this.report) > OWNER_REPORT_MAX_BYTES) {
			this.fail(new Error("Invalid process owner report"));
			return;
		}
		while (true) {
			const newline = this.report.indexOf("\n");
			if (newline < 0) return;
			const line = this.report.slice(0, newline);
			this.report = this.report.slice(newline + 1);
			try {
				const record = parseOwnerLine(line);
				if (this.cleanupConfirmed) throw new Error("Invalid process owner record after cleanup");
				if (record.kind === "cleanup") {
					if (!this.primaryExit && this.spawnErrno === undefined)
						throw new Error("Invalid process owner cleanup order");
					this.cleanupConfirmed = true;
					continue;
				}
				if (this.primaryExit || this.spawnErrno !== undefined)
					throw new Error("Invalid process owner record order");
				if (record.kind === "startup") {
					if (this.started) throw new Error("Invalid process owner record order");
					this.started = true;
					this.startStderr();
				} else if (record.kind === "spawnError") {
					if (this.started) throw new Error("Invalid process owner record order");
					this.spawnErrno = record.errno;
					this.discardStderr();
				} else {
					if (!this.started) throw new Error("Invalid process owner record order");
					this.primaryExit = record.report;
				}
			} catch (error) {
				this.fail(toError(error));
				return;
			}
		}
	}

	/** K or lease EOF requests subtree cleanup; never signal the helper's process group. */
	kill(): void {
		if (this.lease?.writable && !this.lease.destroyed && !this.lease.writableEnded) {
			if (process.platform === "win32") {
				if (!this.cancelled) {
					this.cancelled = true;
					this.lease.write("K");
				}
			} else this.lease.end();
		}
	}
}

/** Spawn `program` through the host's process owner, adding the private fd-3 control stream. */
function spawnOwned(owner: string, program: string, args: readonly string[], options: SpawnOptions): OwnedProcess {
	const child = spawn(owner, ["supervise", "--control-fd", "3", "--", program, ...args], {
		cwd: options.cwd,
		env: options.env,
		windowsHide: options.windowsHide,
		stdio: [options.stdin, "pipe", "pipe", "pipe"],
	});
	return new OwnedProcess(child, program, args);
}

interface SpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdin: "ignore" | "pipe";
	windowsHide: boolean;
}

/** The `E<errno>` record, translated to the same fields a direct spawn error would carry. */
function ownerSpawnError(program: string, args: readonly string[], errno: number): NodeJS.ErrnoException {
	const code = Object.entries(osConstants.errno).find(([, value]) => value === errno)?.[0] ?? "UNKNOWN";
	return Object.assign(new Error(`spawn ${program} ${code}`), {
		code,
		errno: -errno,
		syscall: `spawn ${program}`,
		path: program,
		spawnargs: [...args],
	});
}

interface ExecEntry {
	stopping: boolean;
	killTarget: (() => void) | undefined;
	kill(): void;
	done: Promise<void>;
}

async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
	owner: string | undefined,
	entry: ExecEntry,
): Promise<{ stdout: string; status: number | null }> {
	let stdout = "";
	const owned =
		owner === undefined
			? undefined
			: spawnOwned(owner, command, args, {
					cwd: process.cwd(),
					env: process.env,
					stdin: "ignore",
					windowsHide: true,
				});
	const child =
		owned?.child ??
		spawn(command, args, {
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
	owned?.onStderr(() => {});
	const completion =
		owned?.completed ??
		new Promise<OwnerExit>((resolve) => {
			child.once("error", () => resolve({ code: null, signal: null }));
			child.once("close", (code) => resolve({ code, signal: null }));
		});
	entry.killTarget = () => {
		if (owned) owned.kill();
		else if (child.pid) killProcessTree(child.pid);
	};
	if (entry.stopping) entry.kill();
	const timeout = setTimeout(() => entry.killTarget?.(), timeoutMs);
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	try {
		const result = await completion;
		return { stdout, status: result.code };
	} finally {
		clearTimeout(timeout);
		entry.killTarget = undefined;
	}
}

async function findBashOnPath(owner: string | undefined, entry: ExecEntry): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runCommand("where", ["bash.exe"], 5000, owner, entry)
			: await runCommand("which", ["bash"], 5000, owner, entry);
	if (result.status !== 0 || !result.stdout) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

// Keep in sync with packages/coding-agent/src/utils/shell.ts.
function isLegacyWslBashPath(path: string): boolean {
	const normalized = win32.normalize(path).toLowerCase();
	const systemRoot = process.env.SystemRoot;
	if (systemRoot) {
		if (!/^[a-z]:[\\/]/i.test(systemRoot)) return false;
		return ["System32", "Sysnative"].some(
			(directory) => normalized === win32.join(systemRoot, directory, "bash.exe").toLowerCase(),
		);
	}
	// Fall back to conventional launcher paths only when the Windows directory is unknown.
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

async function getShellConfig(
	customShellPath: string | undefined,
	owner: string | undefined,
	entry: ExecEntry,
): Promise<Result<ShellConfig, ExecutionError>> {
	if (customShellPath) {
		if (await pathExists(customShellPath)) {
			return ok(getBashShellConfig(customShellPath));
		}
		return err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`));
	}
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) {
				return ok(getBashShellConfig(candidate));
			}
		}
		const bashOnPath = await findBashOnPath(owner, entry);
		if (bashOnPath) {
			return ok(getBashShellConfig(bashOnPath));
		}
		return err(
			new ExecutionError(
				"shell_unavailable",
				`No bash shell found. Options:\n` +
					`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
					`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
					"  3. Configure an explicit shellPath\n\n" +
					`Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
			),
		);
	}

	if (await pathExists("/bin/bash")) {
		return ok(getBashShellConfig("/bin/bash"));
	}
	const bashOnPath = await findBashOnPath(owner, entry);
	if (bashOnPath) {
		return ok(getBashShellConfig(bashOnPath));
	}
	return ok({ shell: "sh", args: ["-c"] });
}

function getShellEnv(
	baseEnv?: NodeJS.ProcessEnv,
	extraEnv?: Record<string, string>,
	inheritEnv = true,
): NodeJS.ProcessEnv {
	if (!inheritEnv) return { ...extraEnv };
	return {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			const child = spawn(
				join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			child.once("error", () => {});
		} catch {
			// Ignore errors.
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead.
		}
	}
}

function waitForChildProcess(
	child: ChildProcess,
	spillIsDraining: () => boolean,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finalize = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolvePromise({ code: exitCode, signal: exitSignal });
		};
		const maybeFinalizeAfterExit = (): void => {
			if (exited && stdoutEnded && stderrEnded) finalize();
		};
		const armIdleTimer = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => {
				if (spillIsDraining()) armIdleTimer();
				else finalize();
			}, EXIT_STDIO_GRACE_MS);
		};
		const onData = (): void => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
			exitCode = code;
			exitSignal = signal;
			finalize();
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

/** Strict LF reader; Node readline does not report whether its final line was newline-terminated. */
class NodeTextLineReader implements TextLineReader {
	private readonly file: Awaited<ReturnType<typeof openFile>>;
	private readonly path: string;
	private readonly decoder = new StreamDecoder();
	private readonly chunk = new Uint8Array(64 * 1024);
	private byteOffset = 0;
	private buffered = "";
	private ended = false;
	private closed = false;

	constructor(file: Awaited<ReturnType<typeof openFile>>, path: string) {
		this.file = file;
		this.path = path;
	}

	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		const aborted = abortResult<TextLine | undefined>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return err(new FileError("invalid", "Text line reader is closed", this.path));

		try {
			while (true) {
				const newline = this.buffered.indexOf("\n");
				if (newline !== -1) {
					const text = this.buffered.slice(0, newline);
					this.buffered = this.buffered.slice(newline + 1);
					return ok({ text, terminated: true });
				}
				if (this.ended) {
					if (this.buffered.length === 0) return ok(undefined);
					const text = this.buffered;
					this.buffered = "";
					return ok({ text, terminated: false });
				}

				// Explicit positions allow an aborted read to be retried without skipping bytes.
				const { bytesRead } = await this.file.read(this.chunk, 0, this.chunk.length, this.byteOffset);
				const afterReadAbort = abortResult<TextLine | undefined>(context.abortSignal, this.path);
				if (afterReadAbort) return afterReadAbort;
				this.byteOffset += bytesRead;
				if (bytesRead === 0) {
					this.buffered += this.decoder.decode();
					this.ended = true;
				} else {
					this.buffered += this.decoder.decode(this.chunk.subarray(0, bytesRead));
				}
			}
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.buffered = "";
		try {
			await this.file.close();
		} catch {
			// Closing is best-effort, including after cancellation or an earlier I/O failure.
		}
	}
}

function closedResult<TValue>(what: string, path: string): Result<TValue, FileError> {
	return err(new FileError("invalid", `${what} is closed`, path));
}

class NodeBinaryReader implements BinaryReader {
	private readonly file: FileHandle;
	private readonly path: string;
	private closed = false;

	constructor(file: FileHandle, path: string) {
		this.file = file;
		this.path = path;
	}

	async info(context: Context): Promise<Result<FileInfo, FileError>> {
		const aborted = abortResult<FileInfo>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Binary reader", this.path);
		try {
			return fileInfoFromStats(this.path, await this.file.stat());
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const aborted = abortResult<Uint8Array>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Binary reader", this.path);
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.path));
		}
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (total < length) {
				const chunk = new Uint8Array(Math.min(length - total, BINARY_READ_CHUNK));
				const { bytesRead } = await this.file.read(chunk, 0, chunk.length, offset + total);
				const afterReadAbort = abortResult<Uint8Array>(context.abortSignal, this.path);
				if (afterReadAbort) return afterReadAbort;
				if (bytesRead === 0) break;
				chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
				total += bytesRead;
			}
		} catch (error) {
			return err(toFileError(error, this.path));
		}
		if (chunks.length === 1) return ok(chunks[0]!);
		const bytes = new Uint8Array(total);
		let position = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, position);
			position += chunk.length;
		}
		return ok(bytes);
	}

	async scanLines(
		options: { startLine: number; endLine?: number },
		context: Context,
	): Promise<Result<LineScan, FileError>> {
		const aborted = abortResult<LineScan>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Binary reader", this.path);
		let scanner: LineScanner;
		try {
			scanner = new LineScanner(options.startLine, options.endLine);
		} catch {
			return err(new FileError("invalid", "Invalid line range", this.path));
		}
		const chunk = new Uint8Array(64 * 1024);
		try {
			for (let position = 0; ; ) {
				const { bytesRead } = await this.file.read(chunk, 0, chunk.length, position);
				const afterReadAbort = abortResult<LineScan>(context.abortSignal, this.path);
				if (afterReadAbort) return afterReadAbort;
				if (bytesRead === 0) return ok(scanner.finish());
				scanner.push(chunk.subarray(0, bytesRead));
				position += bytesRead;
			}
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.file.close().catch(() => undefined);
	}
}

class NodeDirReader implements DirReader {
	private readonly dir: Dir;
	private readonly path: string;
	private done = false;
	private closed = false;

	constructor(dir: Dir, path: string) {
		this.dir = dir;
		this.path = path;
	}

	async next(
		maxEntries: number,
		context: Context,
	): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		const aborted = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Directory reader", this.path);
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
			return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.path));
		}
		const entries: FileInfo[] = [];
		try {
			while (!this.done && entries.length < maxEntries) {
				const entry = await this.dir.read();
				if (entry === null) {
					this.done = true;
					break;
				}
				const loopAbort = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, this.path);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(this.path, entry.name);
				let stats: Stats;
				try {
					stats = await lstat(entryPath);
				} catch (error) {
					// Removed between enumeration and lstat: not part of the listing any more.
					if (isNodeError(error) && error.code === "ENOENT") continue;
					return err(toFileError(error, entryPath));
				}
				const info = fileInfoFromStats(entryPath, stats);
				if (info.ok) entries.push(info.value);
			}
			return ok({ entries, done: this.done });
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.dir.close().catch(() => undefined);
	}
}

function symlinkRefused(path: string, cause?: Error): FileError {
	return new FileError("invalid", "Refusing to follow a symbolic link", path, cause);
}

export class NodeExecutionEnv implements ExecutionEnv {
	/** Every local environment sees the same files. */
	readonly id: string = "node:local";
	cwd: string;
	private shellPath?: string;
	private shellEnv?: NodeJS.ProcessEnv;
	private watchOptions: NodeWatchOptions;
	/** Includes shell discovery and spawn-phase work, before any await. */
	private activeExecs = new Set<ExecEntry>();

	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv; watch?: NodeWatchOptions }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
		this.watchOptions = options.watch ?? {};
	}

	async watch(
		targets: readonly WatchTarget[],
		onChange: (change: FileChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		const aborted = abortResult<FileWatcher>(context.abortSignal);
		if (aborted) return aborted;
		try {
			const watcher = await NodeFileWatcher.open(
				targets,
				(path) => resolvePath(this.cwd, path),
				onChange,
				this.watchOptions,
			);
			const afterOpenAbort = abortResult<FileWatcher>(context.abortSignal);
			if (afterOpenAbort) {
				await watcher.close(context);
				return afterOpenAbort;
			}
			return ok(watcher);
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(resolvePath(this.cwd, path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		// Ownership is a host decision, captured before shell discovery or cwd checks await.
		const owner = process.env.PI_PROCESS_OWNER_BINARY;
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;

		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		// Registered before the first await so a concurrent cleanup() always joins this exec.
		// `killTarget` is installed at spawn; a kill arriving earlier sets `stopping` so the
		// freshly spawned child is killed immediately instead of outliving the cleanup.
		let execDone: () => void = () => {};
		const execEntry = {
			stopping: false,
			killTarget: undefined as (() => void) | undefined,
			kill() {
				this.stopping = true;
				this.killTarget?.();
			},
			done: new Promise<void>((resolve) => {
				execDone = resolve;
			}),
		};
		this.activeExecs.add(execEntry);
		// A string runs through the shell; an argv array runs its program directly, without shell parsing.
		let program: string;
		let args: readonly string[];
		let stdinCommand: string | undefined;
		const unregisterEarly = (result: Result<never, ExecutionError>) => {
			this.activeExecs.delete(execEntry);
			execDone();
			return result;
		};
		if (typeof command === "string") {
			let shellConfig: Result<ShellConfig, ExecutionError>;
			try {
				shellConfig = await getShellConfig(this.shellPath, owner, execEntry);
			} catch (error) {
				const cause = toError(error);
				return unregisterEarly(
					err(
						new ExecutionError(
							isNodeError(cause) && cause.code === "ERR_PROCESS_OWNER_CLEANUP" ? "unknown" : "spawn_error",
							cause.message,
							cause,
						),
					),
				);
			}
			if (!shellConfig.ok) return unregisterEarly(shellConfig);
			const commandFromStdin = shellConfig.value.commandTransport === "stdin";
			program = shellConfig.value.shell;
			args = commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command];
			stdinCommand = commandFromStdin ? command : undefined;
		} else {
			const [first, ...rest] = command;
			if (first === undefined) {
				return unregisterEarly(err(new ExecutionError("spawn_error", "Empty argv: no program to run")));
			}
			program = first;
			args = rest;
		}
		try {
			await access(cwd, constants.F_OK);
		} catch (error) {
			const cause = toError(error);
			return unregisterEarly(
				err(
					new ExecutionError(
						"spawn_error",
						`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
						cause,
					),
				),
			);
		}

		return await new Promise((resolvePromise) => {
			let settled = false;
			let timedOut = false;
			let callbackError: ExecutionError | undefined;
			let spillError: ExecutionError | undefined;
			let child: ReturnType<typeof spawn> | undefined;
			let owned: OwnedProcess | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const spillPrefix: SpillChunk[] = [];
			let spillPath: string | undefined;
			const spillQueue: SpillChunk[] = [];
			let spillStart: Promise<void> | undefined;
			let spillStream: WriteStream | undefined;
			let spillBackpressured = false;

			const onAbort = () => {
				execEntry.kill();
			};
			const failCallback = (error: unknown) => {
				if (callbackError !== undefined) return;
				const cause = toError(error);
				callbackError = new ExecutionError("callback_error", cause.message, cause);
				onAbort();
			};
			// One decoder per stream, so a character split across chunks of one stream survives interleaving.
			const stdoutDecoder = new StreamDecoder();
			const stderrDecoder = new StreamDecoder();
			// No output reaches the caller after exec() settled, for example from a descendant holding stdio open.
			const emit = (text: string, stream: ShellOutputInfo["stream"]): void => {
				if (settled || text === "" || options?.onOutput === undefined || callbackError !== undefined) return;
				try {
					options.onOutput(text, context, { stream });
				} catch (error) {
					failCallback(error);
				}
			};
			// Output seen before the spill starts: counted against the thresholds and kept for the spill's prefix.
			let seenBytes = 0;
			let seenNewlines = 0;

			const settle = (result: Result<ShellExecResult, ExecutionError>) => {
				if (settled) return;
				settled = true;
				if (timeoutId) clearTimeout(timeoutId);
				if (signal) signal.removeEventListener("abort", onAbort);
				this.activeExecs.delete(execEntry);
				resolvePromise(result);
				// cleanup() joins on execEntry.done; resolve only after the result reached the caller.
				execDone();
			};
			const pauseOutput = () => {
				child?.stdout?.pause();
				child?.stderr?.pause();
			};
			const resumeOutput = () => {
				if (spillBackpressured || (spillStart !== undefined && spillStream === undefined && !spillError)) return;
				child?.stdout?.resume();
				child?.stderr?.resume();
			};
			const failSpill = (error: unknown) => {
				if (spillError !== undefined) return;
				const cause = toError(error);
				spillError = new ExecutionError(
					"unknown",
					`Failed to preserve complete shell output: ${cause.message}`,
					cause,
				);
				spillBackpressured = false;
				onAbort();
				resumeOutput();
			};
			const writeSpill = (chunk: SpillChunk): void => {
				if (spillStream === undefined || chunk.length === 0) return;
				if (spillStream.write(chunk) || spillBackpressured) return;
				spillBackpressured = true;
				pauseOutput();
				spillStream.once("drain", () => {
					spillBackpressured = false;
					resumeOutput();
				});
			};
			const startSpill = (chunk: SpillChunk): void => {
				if (spillStream !== undefined) {
					writeSpill(chunk);
					return;
				}
				spillQueue.push(chunk);
				if (spillStart !== undefined) return;
				pauseOutput();
				spillStart = (async () => {
					const created = await this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, context);
					if (!created.ok) throw created.error;
					spillPath = created.value;
					spillStream = createWriteStream(spillPath, { flags: "a", highWaterMark: SPILL_HIGH_WATER_MARK });
					spillStream.on("error", failSpill);
					for (const queued of spillQueue) writeSpill(queued);
					spillQueue.length = 0;
				})()
					.catch(failSpill)
					.finally(resumeOutput);
			};
			const finishSpill = async (): Promise<void> => {
				await spillStart;
				const stream = spillStream;
				if (stream === undefined || spillError !== undefined || stream.destroyed) return;
				await new Promise<void>((resolveFinish) => {
					stream.once("error", () => resolveFinish());
					stream.once("finish", resolveFinish);
					stream.end();
				});
			};

			try {
				if (owner !== undefined) {
					owned = spawnOwned(owner, program, args, {
						cwd,
						env: getShellEnv(this.shellEnv, options?.env, options?.inheritEnv),
						stdin: stdinCommand === undefined ? "ignore" : "pipe",
						windowsHide: true,
					});
					child = owned.child;
					execEntry.killTarget = () => owned?.kill();
					if (stdinCommand !== undefined) {
						child.stdin?.on("error", () => {});
						child.stdin?.end(stdinCommand);
					}
				} else {
					child = spawn(program, args, {
						cwd,
						detached: process.platform !== "win32",
						env: getShellEnv(this.shellEnv, options?.env, options?.inheritEnv),
						stdio: [stdinCommand === undefined ? "ignore" : "pipe", "pipe", "pipe"],
						windowsHide: true,
					});
					execEntry.killTarget = () => {
						if (child?.pid) killProcessTree(child.pid);
					};
					if (stdinCommand !== undefined) {
						child.stdin?.on("error", () => {});
						child.stdin?.end(stdinCommand);
					}
				}
				// A cleanup() issued while shell config or cwd resolved lands here.
				if (execEntry.stopping) execEntry.kill();
			} catch (error) {
				const cause = toError(error);
				settle(err(new ExecutionError("spawn_error", cause.message, cause)));
				return;
			}

			timeoutId =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							onAbort();
						}, timeoutMs);

			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			const feed = (source: ShellOutputInfo["stream"], decoder: StreamDecoder) => (chunk: Uint8Array) => {
				emit(decoder.decode(chunk), source);
				const spill = options?.spill;
				if (spill === undefined || spillError !== undefined || chunk.length === 0) return;
				if (spillStart !== undefined) {
					startSpill(chunk);
					return;
				}
				seenBytes += chunk.length;
				for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) seenNewlines++;
				const lines = seenNewlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
				if (seenBytes <= spill.afterBytes && lines <= spill.afterLines) {
					spillPrefix.push(chunk);
					return;
				}
				for (const prefix of spillPrefix) startSpill(prefix);
				spillPrefix.length = 0;
				startSpill(chunk);
			};
			child.stdout?.on("data", feed("stdout", stdoutDecoder));
			if (owned) owned.onStderr(feed("stderr", stderrDecoder));
			else child.stderr?.on("data", feed("stderr", stderrDecoder));

			const completion =
				owned?.completed ??
				waitForChildProcess(
					child,
					() =>
						spillError === undefined &&
						spillStart !== undefined &&
						(spillStream === undefined || spillBackpressured),
				).then(({ code, signal: exitSignal }) => ({
					code,
					signal: exitSignal ? (osConstants.signals[exitSignal] ?? 0) : null,
				}));
			void (async () => {
				let primary: OwnerExit | undefined;
				let failure: Error | undefined;
				try {
					primary = await completion;
				} catch (error) {
					failure = toError(error);
				}
				await finishSpill();
				emit(stdoutDecoder.decode(), "stdout");
				emit(stderrDecoder.decode(), "stderr");
				// Cleanup may follow primary side effects; never classify it as a retryable spawn failure.
				if (isNodeError(failure) && failure.code === "ERR_PROCESS_OWNER_CLEANUP") {
					settle(err(new ExecutionError("unknown", failure.message, failure)));
					return;
				}
				if (callbackError) {
					settle(err(callbackError));
					return;
				}
				const interrupted = timedOut
					? new ExecutionError("timeout", `timeout:${options?.timeout}`)
					: signal?.aborted
						? new ExecutionError("aborted", "aborted")
						: undefined;
				if (interrupted) {
					if (spillPath !== undefined) interrupted.spillPath = spillPath;
					settle(err(interrupted));
				} else if (spillError) settle(err(spillError));
				else if (failure) settle(err(new ExecutionError("spawn_error", failure.message, failure)));
				else {
					const exitCode = primary?.code ?? (primary?.signal ? 128 + primary.signal : 1);
					settle(ok({ exitCode, ...(spillPath === undefined ? {} : { spillPath }) }));
				}
			})();
		});
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<TextLineReader>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const file = await openFile(resolved, "r");
			const afterOpenAbort = abortResult<TextLineReader>(context.abortSignal, resolved);
			if (afterOpenAbort) {
				await file.close().catch(() => undefined);
				return afterOpenAbort;
			}
			return ok(new NodeTextLineReader(file, resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<string>(signal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { encoding: "utf8", signal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close(context);
		}
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<Uint8Array>(signal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { signal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<BinaryReader>(context.abortSignal, resolved);
		if (aborted) return aborted;
		const noFollow = options?.noFollow === true;
		let file: FileHandle | undefined;
		try {
			let flags = constants.O_RDONLY;
			if (process.platform === "win32") {
				// Windows has no O_NOFOLLOW; check the final component before opening (not race-free).
				if (noFollow && (await lstat(resolved)).isSymbolicLink()) return err(symlinkRefused(resolved));
			} else {
				// Nonblocking, so opening a FIFO does not wait for a writer.
				flags |= constants.O_NONBLOCK;
				if (noFollow) flags |= constants.O_NOFOLLOW;
			}
			file = await openFile(resolved, flags);
			const stats = await file.stat();
			if (!stats.isFile()) {
				await file.close().catch(() => undefined);
				return err(
					stats.isDirectory()
						? new FileError("is_directory", "EISDIR: illegal operation on a directory, read", resolved)
						: new FileError("invalid", "Not a regular file", resolved),
				);
			}
			const afterOpenAbort = abortResult<BinaryReader>(context.abortSignal, resolved);
			if (afterOpenAbort) {
				await file.close().catch(() => undefined);
				return afterOpenAbort;
			}
			return ok(new NodeBinaryReader(file, resolved));
		} catch (error) {
			await file?.close().catch(() => undefined);
			// O_NOFOLLOW reports a final-component symlink as ELOOP (EMLINK on some BSDs).
			if (noFollow && isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
				return err(symlinkRefused(resolved, toError(error)));
			}
			return err(toFileError(error, resolved));
		}
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(signal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await writeFile(resolved, content, { signal });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(signal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await appendFile(resolved, content);
			const afterAppendAbort = abortResult<void>(signal, resolved);
			return afterAppendAbort ?? ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		if (!Number.isSafeInteger(size) || size < 0) {
			return err(new FileError("invalid", "File size must be a non-negative safe integer", resolved));
		}
		let file: Awaited<ReturnType<typeof openFile>> | undefined;
		try {
			file = await openFile(resolved, "r+");
			await file.truncate(size);
			const afterTruncateAbort = abortResult<void>(signal, resolved);
			return afterTruncateAbort ?? ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			await file?.close().catch(() => undefined);
		}
	}

	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		let file: Awaited<ReturnType<typeof openFile>> | undefined;
		try {
			file = await openFile(resolved, "r+");
			// POSIX refuses to open a directory for writing; Windows opens it, so check explicitly.
			if ((await file.stat()).isDirectory()) return err(new FileError("is_directory", "Is a directory", resolved));
			await file.sync();
			const afterSyncAbort = abortResult<void>(signal, resolved);
			return afterSyncAbort ?? ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			await file?.close().catch(() => undefined);
		}
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = resolvePath(this.cwd, sourcePath);
		const destination = resolvePath(this.cwd, destinationPath);
		const aborted = abortResult<void>(context.abortSignal, destination);
		if (aborted) return aborted;
		try {
			await rename(source, destination);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<FileInfo>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return fileInfoFromStats(resolved, await lstat(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<FileInfo[]>(signal, resolved);
		if (aborted) return aborted;
		try {
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const loopAbort = abortResult<FileInfo[]>(signal, resolved);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(resolved, entry.name);
				try {
					const info = fileInfoFromStats(entryPath, await lstat(entryPath));
					if (info.ok) infos.push(info.value);
				} catch (error) {
					return err(toFileError(error, entryPath));
				}
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<DirReader>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const dir = await opendir(resolved);
			const afterOpenAbort = abortResult<DirReader>(context.abortSignal, resolved);
			if (afterOpenAbort) {
				await dir.close().catch(() => undefined);
				return afterOpenAbort;
			}
			return ok(new NodeDirReader(dir, resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await realpath(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolved, { recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const aborted = abortResult<string>(context.abortSignal);
		if (aborted) return aborted;
		try {
			prefix ??= "tmp-";
			return ok(await mkdtemp(join(tmpdir(), prefix)));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-", context);
		if (!dir.ok) return dir;
		const filePath = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFile(filePath, "");
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	async cleanup(_context: Context): Promise<void> {
		// Kill execs still in their spawn phase, then wait for every in-flight exec to settle:
		// C confirms cleanup, helper close and fd-3 EOF fence process and control bytes.
		for (const exec of this.activeExecs) exec.kill();
		await Promise.all([...this.activeExecs].map((exec) => exec.done));
	}
}
export type { NodeWatchOptions } from "./node-watch.ts";
