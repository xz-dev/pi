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
 *   fails closed (treated as not ours, so pi wraps again).
 *
 * Opt-outs:
 * - `--no-process-ownership` disables for this invocation.
 * - `PI_NO_PROCESS_OWNERSHIP=1` disables for this and nested invocations.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// One-shot marker for pi's own re-exec handoff. Not a security boundary
// against a hostile parent: procward's contract validation proves
// management; the nonce only prevents pi from re-wrapping itself forever.
const BOOTSTRAP_NONCE = "PI_PROCWARD_BOOTSTRAP_NONCE";

/** CLI options that consume the next argument as their value. */
const VALUE_OPTIONS = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--mode",
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
	"--use-theme",
	"--tui-mode",
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
}

/**
 * Run the procward bootstrap decision for this process. Returns an exit code
 * when the caller must exit immediately (pi re-exec'd under an owner and the
 * owner finished), or undefined when pi should continue starting normally.
 *
 * - Ownership disabled, or the helper is absent: continue (opt-out behavior;
 *   the caller clears its nonce so children never see it).
 * - Pi's own bootstrap nonce present: procward validated the handoff via its
 *   lifecycle contract; consume the nonce and continue without re-wrapping.
 * - Otherwise: exec pi under a fresh procward owner and return its status.
 */
export function ownCliProcess(args: readonly string[], bootstrap: ProcwardBootstrap): number | undefined {
	if (ownershipDisabled(args)) {
		clearBootstrapNonce();
		return undefined;
	}
	if (hasBootstrapNonce()) {
		// Our own handoff: procward's contract (lifecycle pipe + READY with
		// matching launch id and immediate parent) has already validated this
		// exact relationship. One-shot: consume the marker.
		clearBootstrapNonce();
		return undefined;
	}
	const binary = bootstrap.resolveBinary();
	if (binary === undefined) return undefined; // feature absent (PROCWARD=0 build, no helper)

	const nonce = randomBytes(16).toString("hex");
	const childEnv = { ...process.env, [BOOTSTRAP_NONCE]: nonce };
	delete childEnv.PI_PROCWARD_BIN; // the inner pi resolves its own copy

	const result = spawnSync(binary, ["run", "--", process.execPath, ...args], {
		stdio: "inherit",
		env: childEnv,
	});
	return result.status ?? 125;
}
