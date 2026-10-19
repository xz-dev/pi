/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { waitForChildProcess } from "../utils/child-process.ts";
import { observeOwnedProcess, ownedCommand } from "../utils/process-owner.ts";

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
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const invocation = ownedCommand(command, args, 3);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe", ...(invocation.nativeOwner ? ["pipe" as const] : [])],
		});
		let stdout = "";
		let stderr = "";
		const setupStderr: string[] = [];
		const owner = invocation.nativeOwner
			? observeOwnedProcess(proc, () => {
					stderr += setupStderr.splice(0).join("");
				})
			: undefined;
		let killed = false;
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillId: NodeJS.Timeout | undefined;
		// proc.killed only means a signal was sent; track actual exit so the
		// escalation below reaches children that ignore SIGTERM (#7864).
		let exited = false;
		let exitSignal: NodeJS.Signals | null = null;

		proc.once("exit", (_code, signal) => {
			exited = true;
			exitSignal = signal;
			if (forceKillId) {
				clearTimeout(forceKillId);
				forceKillId = undefined;
			}
		});

		const killProcess = () => {
			if (!killed && !exited && !settled) {
				killed = true;
				proc.kill("SIGTERM");
				// Native owners escalate and acknowledge exit only after descendant cleanup.
				if (!invocation.nativeOwner) {
					forceKillId = setTimeout(() => {
						forceKillId = undefined;
						if (!exited && !settled) {
							proc.kill("SIGKILL");
						}
					}, 5000);
				}
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data: string) => {
			if (!owner || owner.started) stderr += data;
			else setupStderr.push(data);
		});

		const cleanup = () => {
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			if (forceKillId) {
				clearTimeout(forceKillId);
				forceKillId = undefined;
			}
			options?.signal?.removeEventListener("abort", killProcess);
		};

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		const completion = owner
			? owner.completion.then(({ code, errno }) => (errno === undefined ? code : 1))
			: waitForChildProcess(proc);
		completion
			.then((code) => {
				cleanup();
				// A null code means signal termination; report the conventional
				// 128+signo instead of a false-success 0 (#7864).
				const signalCode = exitSignal ? 128 + (constants.signals[exitSignal] ?? 0) : null;
				resolve({ stdout, stderr, code: code ?? signalCode ?? 1, killed });
			})
			.catch((error: unknown) => {
				cleanup();
				if (owner) {
					const message = error instanceof Error ? error.message : String(error);
					stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${message}\n`;
				}
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}
