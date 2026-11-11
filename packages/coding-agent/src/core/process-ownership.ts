/** Associates a session's shared process registry with its extension context. */

import { resolveProcwardBinary } from "../config.ts";
import { CONTRACT_ENV_KEYS } from "../utils/managed-child.ts";
import { assertSessionProcessesOpen, type OwnedSession, type OwnedTaskProvenance } from "./process-registry.ts";
import { prepareOwnedSpawn } from "./tools/owned-exec.ts";

// Session managers and extension runtimes share one registry, including after runtime reload.
export type SessionSpawnProvenance = OwnedTaskProvenance & {
	readonly extensionPath?: string;
	readonly serverName?: string;
	readonly configSource?: string;
};

export const sessionProcessRegistries = new WeakMap<object, OwnedSession>();
export { assertSessionProcessesOpen, closePendingSessionSpawns } from "./process-registry.ts";

/** Prepare the same owned task protocol used by the built-in shell tools. */
export function prepareSessionSpawn(
	registry: OwnedSession | undefined,
	command: string,
	args: string[],
	purpose: string,
	provenance: SessionSpawnProvenance,
) {
	if (!registry) return undefined;
	assertSessionProcessesOpen(registry);
	const binary = resolveProcwardBinary();
	if (!binary)
		throw new Error(
			"pi: process-ownership helper is missing; use --no-process-ownership or PI_NO_PROCESS_OWNERSHIP=1 to opt out",
		);
	return prepareOwnedSpawn({ procwardBinary: binary, registry, purpose, provenance }, command, args)!;
}

/** Remove the parent's one-use ownership handoff from the child's environment. */
export function ownedChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const childEnv = { ...env };
	for (const key of CONTRACT_ENV_KEYS) delete childEnv[key];
	delete childEnv.PI_PROCWARD_BOOTSTRAP_NONCE;
	return childEnv;
}
