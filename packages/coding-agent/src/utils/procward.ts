/**
 * Procward process-tree ownership bootstrap.
 *
 * Pi wraps itself in a procward owner (`procward run -- pi ...`) so the whole
 * process tree — including tool-spawned commands and their background
 * children — is cleaned up when pi exits. This module runs before the full
 * CLI dependency graph loads; keep it dependency-free (node: builtins only).
 *
 * Nesting rules (procward contract, vendor/procward/docs/contract.md):
 * - Already managed by any procward (external or another pi): pi still adds
 *   its own layer, unless ownership is disabled.
 * - Only pi's own one-shot bootstrap handoff (validated by procward's
 *   lifecycle contract) skips re-wrapping. Anything stale or mismatched
 *   fails closed before the application loads.
 *
 * Opt-outs:
 * - `--no-process-ownership` disables for this invocation.
 * - `PI_NO_PROCESS_OWNERSHIP=1` disables for this and nested invocations.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import {
	CONTRACT_ENV_KEYS,
	consumeAndObserveManagedContract,
	type consumeManagedContract,
	observeOwnerLoss,
} from "./managed-child.ts";

// One-shot marker for pi's own re-exec handoff. Not a security boundary
// against a hostile parent: procward's contract validation proves
// management; the nonce only prevents pi from re-wrapping itself forever.
const BOOTSTRAP_NONCE = "PI_PROCWARD_BOOTSTRAP_NONCE";

let bootstrapOwnership: { enabled: boolean; ownerPid?: number } | undefined;

/** Read invocation-local ownership state; embedded SDKs never claim an unvalidated parent. */
export function getProcessOwnership(): Readonly<{ enabled: boolean; ownerPid?: number }> {
	return bootstrapOwnership ?? { enabled: process.env.PI_NO_PROCESS_OWNERSHIP !== "1" };
}

/** CLI options that consume even a flag-looking next argument (see cli/args.ts). */
const VALUE_OPTIONS = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--session",
	"--session-id",
	"--fork",
	"--session-dir",
	"--name",
	"-n",
	"--models",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--thinking",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--export",
]);

/** True when this invocation must not add any procward ownership layer. */
export function ownershipDisabled(args: readonly string[]): boolean {
	if (process.env.PI_NO_PROCESS_OWNERSHIP === "1") return true;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg === "--no-process-ownership") return true;
		if (VALUE_OPTIONS.has(arg)) i++;
	}
	return false;
}

/** True when the environment carries pi's own one-shot bootstrap nonce. */
export function hasBootstrapNonce(): boolean {
	return process.env[BOOTSTRAP_NONCE] !== undefined;
}

/** Remove the bootstrap nonce so spawned children cannot inherit it. */
export function clearBootstrapNonce(): void {
	delete process.env[BOOTSTRAP_NONCE];
}

export interface ProcwardBootstrap {
	/** Resolve the vendored procward helper, or undefined when absent. */
	readonly resolveBinary: () => string | undefined;
	/** Validate the managed-child contract for this process (test seam). */
	readonly consumeContract?: typeof consumeManagedContract;
	/** This process's PID and parent PID (test seam). */
	readonly selfPid?: number;
	readonly parentPid?: number;
	/** Standalone executables have no Node script entry in argv[1]. */
	readonly standalone?: boolean;
	/** Bridge validated owner loss into pi's shutdown path (test seam). */
	readonly onOwnerLoss?: (reason: string) => void;
	/** Observe the lifecycle pipe for owner loss (test seam). */
	readonly observeLoss?: typeof observeOwnerLoss;
}

/**
 * Run the procward bootstrap decision for this process. Returns an exit code
 * when the caller must exit immediately (pi re-exec'd under an owner and the
 * owner finished), or undefined when pi should continue starting normally.
 *
 * - Ownership disabled: clear the one-shot marker and continue.
 * - Helper absent: fail visibly with an explicit opt-out diagnostic.
 * - Pi's own bootstrap nonce present: procward validated the handoff via its
 *   lifecycle contract; consume the nonce and continue without re-wrapping.
 * - Otherwise: run pi under a fresh procward owner and return its status.
 */
export function ownCliProcess(args: readonly string[], bootstrap: ProcwardBootstrap): number | undefined {
	if (ownershipDisabled(args)) {
		bootstrapOwnership = { enabled: false };
		clearBootstrapNonce();
		return undefined;
	}
	if (hasBootstrapNonce()) {
		const nonce = process.env[BOOTSTRAP_NONCE];
		clearBootstrapNonce();
		if (!nonce || !/^[0-9a-f]{32}$/.test(nonce)) throw new Error("pi: invalid bootstrap nonce");
		validateOwnHandoff(bootstrap);
		bootstrapOwnership = { enabled: true, ownerPid: Number(process.env.PROCWARD_OWNER_PID) };
		for (const key of CONTRACT_ENV_KEYS) delete process.env[key];
		return undefined;
	}
	const binary = bootstrap.resolveBinary();
	if (binary === undefined) {
		throw new Error(
			"pi: the process-ownership helper is missing; rebuild or reinstall pi, " +
				"or disable ownership with --no-process-ownership / PI_NO_PROCESS_OWNERSHIP=1",
		);
	}

	const nonce = randomBytes(16).toString("hex");
	const childEnv = { ...process.env, [BOOTSTRAP_NONCE]: nonce };
	const launchArgs = bootstrap.standalone ? [...args] : [...process.execArgv, process.argv[1], ...args];

	// Replacing the outer process keeps signals addressed to its PID inside
	// the native owner; a waiting Unix wrapper could die and orphan that owner.
	if (process.platform !== "win32") {
		try {
			if (!process.execve) throw new Error("process.execve is unavailable");
			process.execve(binary, [binary, "run", "--quiet", "--", process.execPath, ...launchArgs], childEnv);
		} catch (cause) {
			throw new Error(
				"pi: cannot exec the process owner; use --no-process-ownership or PI_NO_PROCESS_OWNERSHIP=1 to opt out",
				{ cause },
			);
		}
	}

	const result = spawnSync(binary, ["run", "--quiet", "--", process.execPath, ...launchArgs], {
		stdio: "inherit",
		env: childEnv,
	});
	if (result.error) {
		throw new Error(
			"pi: cannot start the process owner; use --no-process-ownership or PI_NO_PROCESS_OWNERSHIP=1 to opt out",
			{ cause: result.error },
		);
	}
	return result.status ?? (result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : 125);
}

/** Validate and consume our own handoff before any application startup. */
function validateOwnHandoff(bootstrap: ProcwardBootstrap): void {
	const env = {
		protocol: process.env.PROCWARD_PROTOCOL,
		ownerPid: process.env.PROCWARD_OWNER_PID,
		contractId: process.env.PROCWARD_CONTRACT_ID,
		lifecycleFd: process.env.PROCWARD_LIFECYCLE_FD,
	};
	if (env.protocol === undefined) throw new Error("pi: bootstrap handoff is missing its contract");
	if (process.env.PROCWARD_LIFECYCLE_HANDLE !== undefined) {
		throw new Error("pi: Windows process-ownership handoff is not supported by this adapter");
	}
	const selfPid = bootstrap.selfPid ?? process.pid;
	const parentPid = bootstrap.parentPid ?? process.ppid;
	const onLoss = bootstrap.onOwnerLoss ?? defaultOwnerLoss;
	if (bootstrap.consumeContract) {
		const contract = bootstrap.consumeContract(env, selfPid, parentPid);
		if (!contract) throw new Error("pi: invalid bootstrap handoff");
		(bootstrap.observeLoss ?? observeOwnerLoss)(contract, onLoss);
	} else {
		consumeAndObserveManagedContract(env, selfPid, parentPid, onLoss);
	}
}

/**
 * Default owner-loss bridge: re-enter pi through its SIGTERM shutdown path
 * (the same one external terminators use), which runs graceful hooks. The
 * 7-second watchdog armed by observeOwnerLoss bounds the exit even when a
 * hook never yields.
 */
function defaultOwnerLoss(reason: string): void {
	process.stderr.write(`pi: process owner gone (${reason}); shutting down\n`);
	process.kill(process.pid, "SIGTERM");
}
