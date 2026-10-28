import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import { getPackagedProcward, isBunBinary } from "../config.ts";
import { consumeProcwardContract, discardProcwardContract } from "./managed-child.ts";
import { enableTaskProcessOwnership } from "./process-owner.ts";

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
// One-shot loop prevention for our bootstrap, not a security boundary against a parent.
const BOOTSTRAP_NONCE = "PI_PROCWARD_BOOTSTRAP_NONCE";
let bootstrapped = false;

export function ownershipDisabled(args: string[]): boolean {
	if (process.env.PI_NO_PROCESS_OWNERSHIP === "1") return true;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--") break;
		if (args[i] === "--no-process-ownership") return true;
		if (VALUE_OPTIONS.has(args[i])) i++;
	}
	return false;
}

/** Bootstrap before importing settings, providers or extensions. No network/install side effects. */
export function ownCliProcesses(): undefined | false {
	if (bootstrapped) return;
	for (const key of Object.keys(process.env)) if (key.startsWith("PI_PROCESS_OWNER_")) delete process.env[key];
	const nonce = process.env[BOOTSTRAP_NONCE];
	delete process.env[BOOTSTRAP_NONCE];
	delete process.env.PI_PROCWARD_BOOTSTRAP_PENDING;
	const args = process.argv.slice(2);
	if (ownershipDisabled(args)) {
		discardProcwardContract();
		bootstrapped = true;
		return;
	}
	if (nonce !== undefined) {
		try {
			if (!/^[0-9a-f]{32}$/.test(nonce) || !consumeProcwardContract()) throw new Error("Missing bootstrap READY");
		} catch {
			try {
				discardProcwardContract();
			} catch {
				/* Startup exits without loading the CLI. */
			}
			const error = new Error(
				`${BOOTSTRAP_NONCE} has no matching valid procward READY; unset ${BOOTSTRAP_NONCE}, or use --no-process-ownership / PI_NO_PROCESS_OWNERSHIP=1`,
			);
			// CLI entry reports one actionable line, not a stack for stale private metadata.
			error.stack = undefined;
			throw error;
		}
		enableTaskProcessOwnership();
		bootstrapped = true;
		return;
	}
	// An external owner is not our handoff: discard its endpoint and create our own layer.
	discardProcwardContract();
	if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
		bootstrapped = true;
		return;
	}
	let binary = getPackagedProcward();
	if (!binary && !isBunBinary) {
		const filename = process.platform === "win32" ? "procward.exe" : "procward";
		binary = (process.env.PATH ?? "")
			.split(delimiter)
			.map((directory) => resolve(directory, filename))
			.find((candidate) => {
				try {
					accessSync(candidate, constants.X_OK);
					return true;
				} catch {
					return false;
				}
			});
		if (binary) {
			const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 2000, maxBuffer: 1024 });
			if (version.error || version.status !== 0 || !/^procward \d+\.\d+\.\d+\r?\n$/.test(version.stdout))
				throw new Error("Incompatible procward on PATH; install https://github.com/xz-dev/procward");
		}
	}
	if (!binary) {
		console.error(
			"Process ownership disabled: install procward on PATH (https://github.com/xz-dev/procward; source/npm run)",
		);
		bootstrapped = true;
		return;
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	env[BOOTSTRAP_NONCE] = randomBytes(16).toString("hex");
	const commandArgs = isBunBinary ? args : [...process.execArgv, ...process.argv.slice(1)];
	const ownerArgs = [
		"run",
		"--grace",
		"6s",
		"--fatal-grace",
		"3s",
		"--cleanup-deadline",
		"7500ms",
		"--",
		process.execPath,
		...commandArgs,
	];
	if (process.platform === "win32") {
		// Windows cannot exec. This lightweight wrapper never enters the CLI graph.
		const child = spawn(binary, ownerArgs, { env, stdio: "inherit" });
		process.on("SIGINT", () => {});
		process.on("SIGBREAK", () => {});
		process.on("SIGTERM", () => {
			child.kill("SIGTERM");
		});
		child.once("error", (error) => {
			console.error(error.message);
			process.exit(125);
		});
		child.once("close", (code) => process.exit(code ?? 125));
		return false;
	}
	if (!process.execve) throw new Error("Process ownership requires execve support in this runtime");
	process.execve(binary, [binary, ...ownerArgs], env);
}
