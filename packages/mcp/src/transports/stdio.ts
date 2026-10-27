import { type ChildProcess, spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import process from "node:process";
import type { Duplex } from "node:stream";
import crossSpawn from "cross-spawn";
import { type JsonRpcMessage, McpConnectionClosedError, parseJsonRpcMessage } from "../protocol/jsonrpc.ts";
import { DEFAULT_MAX_MESSAGE_BYTES, type McpTransport, TransportEvents } from "./transport.ts";

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/** How long a server gets to exit on its own after stdin closes, before it is sent SIGTERM. */
const STDIN_CLOSE_GRACE_MS = 500;
const USE_PROCESS_GROUPS = process.platform !== "win32";

/** Owned shutdown requests, retired when each child exits. */
const liveProcesses = new Set<() => void>();
let exitHookInstalled = false;

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (process.platform === "win32" && pid !== undefined) {
		if (child.exitCode !== null) return;
		// Windows has no graceful signals, and cross-spawn runs `.cmd` shims through cmd.exe; killing only
		// that would leave the server running.
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
			"error",
			() => {},
		);
		return;
	}
	if (USE_PROCESS_GROUPS && pid !== undefined) {
		try {
			// Negative pid: the whole group, so wrappers like `npx` or `uvx` do not leave the server behind.
			process.kill(-pid, signal);
			return;
		} catch {
			// The group is gone or was never created; fall back to the direct child.
		}
	}
	try {
		child.kill(signal);
	} catch {}
}

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const stop of liveProcesses) stop();
	});
}

export interface StdioTransportOptions {
	command: string;
	args?: readonly string[];
	cwd?: string;
	env?: Record<string, string>;
	inheritEnv?: boolean;
	stderr?: "pipe" | "inherit";
	onStderr?: (chunk: string) => void;
	maxMessageBytes?: number;
	maxStderrBytes?: number;
	/** Time to wait for the server to exit after SIGTERM before sending SIGKILL. Default: 2000. */
	closeTimeoutMs?: number;
}

export class StdioTransport extends TransportEvents implements McpTransport {
	readonly options: Readonly<StdioTransportOptions>;
	private child: ChildProcess | undefined;
	private stdoutBuffer = Buffer.alloc(0);
	private stderrBuffer = Buffer.alloc(0);
	private started = false;
	private closed = false;
	private primaryPid: number | undefined;
	private cleanup: Promise<void> | undefined;
	private requestStop: ((force: boolean) => void) | undefined;
	private timers: ReturnType<typeof setTimeout>[] = [];

	constructor(options: StdioTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, args: options.args ? [...options.args] : undefined });
	}

	get pid(): number | undefined {
		return this.primaryPid;
	}

	get stderr(): string {
		return this.stderrBuffer.toString("utf8");
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP stdio transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
		// Ownership comes from the host, never from the server's environment options.
		const owner = process.env.PI_PROCESS_OWNER_BINARY;
		if (owner !== undefined && !owner.trim()) throw new Error("Invalid MCP process owner binary");
		const owned = owner !== undefined;
		const env = this.options.inheritEnv === false ? { ...this.options.env } : { ...process.env, ...this.options.env };
		const args = [...(this.options.args ?? [])];
		const child = crossSpawn(
			owned ? owner : this.options.command,
			owned ? ["supervise", "--control-fd", "3", "--", this.options.command, ...args] : args,
			{
				cwd: this.options.cwd,
				env,
				stdio: [
					"pipe",
					"pipe",
					this.options.stderr === "inherit" ? "inherit" : "pipe",
					...(owned ? ["pipe" as const] : []),
				],
				windowsHide: true,
				detached:
					USE_PROCESS_GROUPS && !(owned && (process.platform === "linux" || process.platform === "freebsd")),
			},
		);
		this.child = child;
		const lease = owned ? (child.stdio[3] as Duplex) : undefined;
		let exited = false;
		let cancelled = false;
		let ready = false;
		let failure: Error | undefined;
		let helperError: Error | undefined;
		let helperSpawned = false;
		let cleanupError: Error | undefined;
		let primaryStatus: { code: number | null; signal: number | null } | undefined;
		let phase: "startup" | "running" | "exited" | "spawn-error" | "complete" | "failed" = "startup";
		let report = "";
		// Keep startup bytes in the paused stream, including across ChildProcess exit flushing.
		const holdStderr = () => {};
		const startStderr = () => {
			child.stderr?.removeListener("readable", holdStderr);
			child.stderr?.on("data", (chunk: Buffer | string) => this.handleStderr(chunk));
		};
		if (owned) child.stderr?.on("readable", holdStderr);
		else startStderr();
		let resolveStart: () => void;
		const startup = new Promise<void>((resolve) => {
			resolveStart = resolve;
		});
		const serverError = (errno: number): Error => {
			const code = Object.entries(osConstants.errno).find(([, value]) => value === errno)?.[0] ?? "UNKNOWN";
			return Object.assign(new Error(`spawn ${this.options.command} ${code}`), {
				code,
				errno: -errno,
				syscall: `spawn ${this.options.command}`,
				path: this.options.command,
				spawnargs: args,
			});
		};
		const stop = (force: boolean) => {
			if (owned && (force || process.platform === "win32")) {
				if (lease?.writable && !lease.destroyed) {
					if (process.platform === "win32") {
						if (!cancelled) {
							cancelled = true;
							lease.write("K");
						}
					} else lease.end();
				}
				return;
			}
			if (exited) return;
			if (owned) child.kill("SIGTERM");
			else killProcessTree(child, force ? "SIGKILL" : "SIGTERM");
		};
		this.requestStop = stop;
		const exitStop = () => stop(owned);
		installExitHook();
		liveProcesses.add(exitStop);
		const retire = () => {
			exited = true;
			liveProcesses.delete(exitStop);
			for (const timer of this.timers) clearTimeout(timer);
			this.timers = [];
		};
		child.once("exit", retire);
		const ownerDrained = lease
			? new Promise<void>((resolve) => {
					lease.once("end", resolve);
					lease.once("close", resolve);
				})
			: Promise.resolve();
		const childClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
			child.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal })),
		);
		this.cleanup = Promise.all([childClosed, ownerDrained]).then(([helperStatus]) => {
			if (process.platform === "win32") lease?.destroy();
			retire();
			// Legacy standalone group cleanup; native owners must only use their lease.
			if (!owned && this.closed) killProcessTree(child, "SIGTERM");
			this.child = undefined;
			this.primaryPid = undefined;
			this.requestStop = undefined;
			this.closed = true;
			if (helperError) cleanupError = undefined;
			const expectedCode = primaryStatus ? (primaryStatus.code ?? 128 + (primaryStatus.signal ?? 0)) : 125;
			const expectedHelper =
				process.platform === "win32" && process.versions.bun ? expectedCode % 256 : expectedCode;
			if (
				owned &&
				!helperError &&
				(phase !== "complete" ||
					report ||
					!lease?.readableEnded ||
					helperStatus.code !== expectedHelper ||
					helperStatus.signal !== null)
			) {
				cleanupError ??= Object.assign(new Error("MCP process owner cleanup unconfirmed"), {
					code: "ERR_PROCESS_OWNER_CLEANUP",
				});
			}
			if (!ready && !failure) failure = new Error("Process owner did not report MCP server startup");
			resolveStart();
			if (cleanupError) this.emitError(cleanupError);
			if (this.stdoutBuffer.toString("utf8").trim()) {
				this.emitError(new Error("MCP stdio server closed with an incomplete JSON-RPC message"));
			}
			this.stdoutBuffer = Buffer.alloc(0);
			this.emitClose();
			if (cleanupError) throw cleanupError;
		});
		// Keep the stored rejection observable to close/start without an unhandled background rejection.
		void this.cleanup.catch(() => {});
		const fail = (error: Error) => {
			failure ??= error;
			if (!ready) {
				child.stderr?.removeListener("readable", holdStderr);
				child.stderr?.resume();
			}
			// E already means spawn failed; let the owner finish cleanup without writing into its closing socket.
			if (phase !== "spawn-error") stop(true);
		};
		const invalidReport = () => {
			phase = "failed";
			cleanupError ??= Object.assign(new Error("Invalid MCP process owner report; cleanup unconfirmed"), {
				code: "ERR_PROCESS_OWNER_CLEANUP",
			});
			fail(cleanupError);
		};
		lease?.on("data", (chunk: Buffer) => {
			report += chunk.toString("utf8");
			if (report.length > 4096) {
				invalidReport();
				return;
			}
			while (true) {
				const newline = report.indexOf("\n");
				if (newline < 0) break;
				const line = report.slice(0, newline);
				report = report.slice(newline + 1);
				try {
					if (phase === "startup" && line.startsWith("S")) {
						const status: unknown = JSON.parse(line.slice(1));
						if (
							!status ||
							typeof status !== "object" ||
							!("pid" in status) ||
							typeof status.pid !== "number" ||
							!Number.isSafeInteger(status.pid) ||
							status.pid <= 0
						)
							throw new Error("Invalid startup");
						phase = "running";
						this.primaryPid = status.pid;
						ready = true;
						startStderr();
						resolveStart();
					} else if (phase === "startup" && /^E[1-9]\d* .+$/.test(line)) {
						const errno = Number(line.slice(1, line.indexOf(" ")));
						if (!Number.isSafeInteger(errno)) throw new Error("Invalid errno");
						phase = "spawn-error";
						fail(serverError(errno));
					} else if (phase === "running" && line.startsWith("X")) {
						const status: unknown = JSON.parse(line.slice(1));
						if (!status || typeof status !== "object" || !("code" in status) || !("signal" in status))
							throw new Error("Invalid exit");
						const { code, signal } = status;
						if (
							typeof code === "number" &&
							Number.isInteger(code) &&
							code >= 0 &&
							code <= (process.platform === "win32" ? 0xffff_ffff : 255) &&
							signal === null
						) {
							primaryStatus = { code, signal };
						} else if (
							code === null &&
							typeof signal === "number" &&
							Number.isInteger(signal) &&
							signal > 0 &&
							signal <= 127
						) {
							primaryStatus = { code, signal };
						} else throw new Error("Invalid exit");
						phase = "exited";
					} else if ((phase === "exited" || phase === "spawn-error") && line === "C") {
						phase = "complete";
					} else invalidReport();
				} catch {
					invalidReport();
				}
			}
		});
		lease?.on("error", invalidReport);
		const ownerEnded = () => {
			if (!helperError && (phase !== "complete" || report)) invalidReport();
		};
		lease?.once("end", ownerEnded);
		lease?.once("close", () => {
			if (!lease.readableEnded && !helperError) invalidReport();
			ownerEnded();
		});
		child.once("spawn", () => {
			helperSpawned = true;
			if (!owned) {
				this.primaryPid = child.pid;
				ready = true;
				resolveStart();
			}
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			// This is the spawned helper's error; only an E record identifies a server spawn failure.
			if (!ready) {
				if (!helperSpawned) {
					helperError = error;
					failure = error;
				}
				fail(error);
			} else if (!this.closed) this.emitError(error);
		});
		child.stdout?.on("data", (chunk: Buffer | string) => this.handleStdout(chunk));
		child.stdout?.on("error", (error) => this.emitError(error));
		child.stdin?.on("error", (error) => {
			if (!this.closed) this.emitError(error);
		});
		child.stderr?.on("error", (error) => this.emitError(error));
		await startup;
		if (failure) {
			await this.cleanup;
			throw failure;
		}
	}

	async send(message: JsonRpcMessage): Promise<void> {
		const stdin = this.child?.stdin;
		if (!this.started || this.closed || !stdin?.writable) throw new McpConnectionClosedError();
		const payload = `${JSON.stringify(message)}\n`;
		await new Promise<void>((resolve, reject) => {
			stdin.write(payload, (error) => (error ? reject(error) : resolve()));
		});
	}

	async close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			const child = this.child;
			if (child && child.exitCode === null && child.signalCode === null) {
				// EOF grace, graceful TERM to owner, then private cancellation; never SIGKILL the owner.
				const timeout = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
				const grace = Math.min(STDIN_CLOSE_GRACE_MS, timeout);
				this.timers.push(setTimeout(() => this.requestStop?.(false), grace));
				this.timers.push(setTimeout(() => this.requestStop?.(true), grace + timeout));
				child.stdin?.end();
			} else if (!child) this.emitClose();
		}
		await this.cleanup;
	}

	private handleStdout(chunk: Buffer | string): void {
		this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		const maxMessageBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		while (true) {
			const newline = this.stdoutBuffer.indexOf(0x0a);
			if (newline < 0) {
				if (this.stdoutBuffer.length > maxMessageBytes) {
					this.stdoutBuffer = Buffer.alloc(0);
					this.emitError(new Error(`MCP stdio message exceeds ${maxMessageBytes} bytes`));
				}
				return;
			}
			const line = this.stdoutBuffer.subarray(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
			if (line.length > maxMessageBytes) {
				this.emitError(new Error(`MCP stdio message exceeds ${maxMessageBytes} bytes`));
				continue;
			}
			const text = line.toString("utf8").replace(/\r$/, "");
			if (!text.trim()) continue;
			try {
				this.emitMessage(parseJsonRpcMessage(JSON.parse(text)));
			} catch (error) {
				this.emitError(error);
			}
		}
	}

	private handleStderr(chunk: Buffer | string): void {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const maxStderrBytes = this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		this.stderrBuffer = Buffer.concat([this.stderrBuffer, buffer]);
		if (this.stderrBuffer.length > maxStderrBytes) this.stderrBuffer = this.stderrBuffer.subarray(-maxStderrBytes);
		this.options.onStderr?.(buffer.toString("utf8"));
	}
}
