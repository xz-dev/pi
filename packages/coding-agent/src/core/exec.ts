/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { constants as bufferConstants } from "node:buffer";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { getSystemErrorName } from "node:util";
import { waitForChildProcess } from "../utils/child-process.ts";
import { observeOwnedProcess, ownedCommand } from "../utils/process-owner.ts";

const DEFAULT_EXEC_MAX_BUFFER = Math.min(256 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH);
const FORCE_KILL_DELAY_MS = 5000;

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/**
	 * Combined stdout/stderr byte limit; exceeding it terminates the command with `truncated: true`.
	 * Nonnegative integer up to the runtime string limit. Default: 256 MiB, capped by that limit.
	 */
	maxBuffer?: number;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	/** The command was terminated by pi: timeout, abort, or output over `maxBuffer`. */
	killed: boolean;
	/** Output exceeded `maxBuffer`; stdout and stderr are incomplete and `code` is nonzero. */
	truncated: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout, abort signal, and an output cap (`maxBuffer`).
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	const maxBuffer = options?.maxBuffer ?? DEFAULT_EXEC_MAX_BUFFER;
	if (!Number.isInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > bufferConstants.MAX_STRING_LENGTH) {
		throw new RangeError(`maxBuffer must be an integer between 0 and ${bufferConstants.MAX_STRING_LENGTH} bytes`);
	}

	const invocation = ownedCommand(command, args, 3);
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe", ...(invocation.nativeOwner ? ["pipe" as const] : [])],
	});

	let stdout = "";
	let stderr = "";
	// Decode across chunks: a multi-byte UTF-8 character can be split between two chunks,
	// and decoding each chunk separately would corrupt it (earendil-works/pi#11312).
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	const setupStderr: string[] = [];
	const owner = invocation.nativeOwner
		? observeOwnedProcess(proc, () => {
				stderr += setupStderr.splice(0).join("");
			})
		: undefined;
	let outputBytes = 0;
	let truncated = false;
	let killed = false;
	let settled = false;
	let timeoutId: NodeJS.Timeout | undefined;
	let forceKillId: NodeJS.Timeout | undefined;
	// The child may exit while inherited output still drains; never cancel it after exit (#7864).
	let exited = false;
	proc.once("exit", () => {
		exited = true;
		clearTimeout(forceKillId);
	});

	const killProcess = () => {
		if (killed || settled || exited) return;
		killed = true;
		if (process.platform === "win32" && owner) owner.cancel();
		else proc.kill("SIGTERM");
		// Native owners escalate and acknowledge exit only after descendant cleanup.
		if (invocation.nativeOwner) return;
		forceKillId = setTimeout(() => {
			// `proc.killed` only says a signal was sent, so check whether the child actually exited.
			if (proc.exitCode === null && proc.signalCode === null) {
				proc.kill("SIGKILL");
			}
		}, FORCE_KILL_DELAY_MS);
	};

	if (options?.signal) {
		if (options.signal.aborted) {
			killProcess();
		} else {
			options.signal.addEventListener("abort", killProcess, { once: true });
		}
	}

	if (options?.timeout && options.timeout > 0) {
		timeoutId = setTimeout(killProcess, options.timeout);
	}

	// Keep only bytes within the combined cap (#11360). Close both pipes on overflow so writing
	// descendants cannot keep waitForChildProcess busy after the child exits. Pausing is not
	// enough: Node resumes the child's stdio on exit.
	const takeWithinCap = (data: Buffer): Buffer | undefined => {
		if (truncated) return undefined;
		const remaining = maxBuffer - outputBytes;
		if (data.length <= remaining) {
			outputBytes += data.length;
			return data;
		}
		truncated = true;
		proc.stdout?.destroy();
		proc.stderr?.destroy();
		killProcess();
		return remaining > 0 ? data.subarray(0, remaining) : undefined;
	};

	proc.stdout?.on("data", (data: Buffer) => {
		const chunk = takeWithinCap(data);
		if (chunk) stdout += stdoutDecoder.write(chunk);
	});

	proc.stderr?.on("data", (data: Buffer) => {
		const chunk = takeWithinCap(data);
		if (!chunk) return;
		const text = stderrDecoder.write(chunk);
		if (!owner || owner.started) stderr += text;
		else setupStderr.push(text);
	});

	let code: number | null;
	try {
		// Do not hang on inherited stdio handles held open by detached descendants.
		const completion = owner
			? owner.completion.then(({ code, errno }) => {
					if (errno !== undefined && !stderr) stderr = `spawn ${command} ${getSystemErrorName(-errno)}`;
					return errno === undefined ? code : 1;
				})
			: waitForChildProcess(proc);
		code = await completion;
	} catch (error) {
		if (!owner && !(error instanceof Error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		// Child-process errors (e.g. ENOENT) are failed executions, not host failures.
		code = 1;
		if (owner) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${message}\n`;
		else if (!stderr) stderr = message;
	} finally {
		settled = true;
		clearTimeout(timeoutId);
		clearTimeout(forceKillId);
		options?.signal?.removeEventListener("abort", killProcess);
	}

	// On truncation, discard any incomplete UTF-8 suffix buffered by either decoder.
	// Flushing it would append a replacement character that was not in the accepted output.
	if (!truncated) {
		stdout += stdoutDecoder.end();
		const tail = stderrDecoder.end();
		if (!owner || owner.started) stderr += tail;
	}

	// A null code means signal termination; report the conventional 128+signo
	// instead of a false-success 0 (#7864).
	const signalCode = proc.signalCode ? 128 + (constants.signals[proc.signalCode] ?? 0) : null;
	const exitCode = code ?? signalCode ?? 1;
	return {
		stdout,
		stderr,
		// A truncated result must never read as success.
		code: truncated && exitCode === 0 ? 1 : exitCode,
		killed,
		truncated,
	};
}
