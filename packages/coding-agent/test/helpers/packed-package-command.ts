import { spawnProcess } from "../../src/utils/child-process.ts";

const OUTPUT_LIMIT_BYTES = 20 * 1024 * 1024;
const TERMINATION_GRACE_MS = 500;
const BLOCKED_NPM_CONFIG = new Set([
	"allow_scripts",
	"global",
	"global_prefix",
	"include_workspace_root",
	"local_prefix",
	"location",
	"prefix",
	"workspace",
	"workspaces",
]);

function createPackedPackageEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const entries = Object.entries(process.env).filter(([key]) => {
		if (/^npm_(?:package|lifecycle)_/i.test(key) || key === "INIT_CWD") return false;
		const npmConfig = key.match(/^npm_config_(.+)$/i)?.[1]?.toLowerCase();
		return !npmConfig || !BLOCKED_NPM_CONFIG.has(npmConfig);
	});
	return {
		...Object.fromEntries(entries),
		NO_COLOR: "1",
		npm_config_loglevel: "error",
		PI_OFFLINE: "1",
		...overrides,
	};
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		// The process group may already have exited between the timeout and signal.
	}
}

export async function runPackedPackageCommand(
	command: string,
	args: string[],
	cwd: string,
	timeout: number,
	readyOutput?: string,
	env?: NodeJS.ProcessEnv,
): Promise<string> {
	if (process.platform === "win32") {
		throw new Error("Packed package process tests require POSIX process-group signals");
	}
	return await new Promise<string>((resolve, reject) => {
		const child = spawnProcess(command, args, {
			cwd,
			detached: true,
			env: createPackedPackageEnvironment(env),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let timedOut = false;
		let outputExceeded = false;
		let settled = false;
		let terminationSignal: NodeJS.Signals | undefined;
		let timeoutHandle: NodeJS.Timeout | undefined;
		let escalationHandle: NodeJS.Timeout | undefined;
		let ready = readyOutput === undefined;
		let forceTerminationRequested = false;

		const forceTerminate = (): void => {
			if (forceTerminationRequested || settled) return;
			forceTerminationRequested = true;
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = undefined;
			}
			if (escalationHandle) {
				clearTimeout(escalationHandle);
				escalationHandle = undefined;
			}
			terminationSignal = "SIGKILL";
			signalProcessGroup(child.pid, "SIGKILL");
		};
		const armTimeout = (): void => {
			if (timedOut || outputExceeded || forceTerminationRequested || settled) return;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			timeoutHandle = setTimeout(() => {
				timeoutHandle = undefined;
				if (outputExceeded || forceTerminationRequested || settled) return;
				timedOut = true;
				terminationSignal = "SIGTERM";
				signalProcessGroup(child.pid, "SIGTERM");
				escalationHandle = setTimeout(forceTerminate, TERMINATION_GRACE_MS);
			}, timeout);
		};
		armTimeout();

		const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer): void => {
			outputBytes += chunk.length;
			if (outputBytes > OUTPUT_LIMIT_BYTES) {
				if (!outputExceeded) {
					outputExceeded = true;
					forceTerminate();
				}
				return;
			}
			if (stream === "stdout") {
				stdout += chunk.toString("utf8");
				if (!ready && readyOutput && stdout.includes(readyOutput)) {
					ready = true;
					armTimeout();
				}
			} else {
				stderr += chunk.toString("utf8");
			}
		};
		child.stdout.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));

		const finish = (status: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (escalationHandle) clearTimeout(escalationHandle);
			if (!error && !timedOut && !outputExceeded && status === 0) {
				resolve(stdout);
				return;
			}
			reject(
				new Error(
					[
						`Command failed: ${command} ${args.join(" ")}`,
						timedOut ? `Timed out after ${timeout}ms` : undefined,
						outputExceeded ? `Output exceeded ${OUTPUT_LIMIT_BYTES} bytes` : undefined,
						error?.message,
						`Exit status: ${status ?? "none"}`,
						terminationSignal ? `Termination: ${terminationSignal}` : undefined,
						signal ? `Signal: ${signal}` : undefined,
						stdout ? `stdout:\n${stdout}` : undefined,
						stderr ? `stderr:\n${stderr}` : undefined,
					]
						.filter(Boolean)
						.join("\n"),
				),
			);
		};
		child.once("error", (error) => finish(null, null, error));
		child.once("close", (status, signal) => finish(status, signal));
	});
}
