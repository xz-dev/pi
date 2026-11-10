/** Associates a session's shared process registry with its extension context. */

import { resolveProcwardBinary } from "../config.ts";
import { CONTRACT_ENV_KEYS } from "../utils/managed-child.ts";
import type { OwnedSession, OwnedTaskProvenance } from "./process-registry.ts";
import { type OwnedSpawn, prepareOwnedSpawn } from "./tools/owned-exec.ts";

// Session managers and extension runtimes share one registry, including after runtime reload.
export type SessionSpawnProvenance = OwnedTaskProvenance & {
	readonly extensionPath?: string;
	readonly serverName?: string;
	readonly configSource?: string;
};

export const sessionProcessRegistries = new WeakMap<object, OwnedSession>();
const pendingSpawns = new WeakMap<OwnedSession, Set<OwnedSpawn>>();
const closedSessions = new WeakSet<OwnedSession>();

/** Reject new session-scoped executions after disposal starts. */
export function assertSessionProcessesOpen(registry: OwnedSession | undefined): void {
	if (registry && closedSessions.has(registry)) throw new Error("Session process ownership is closed");
}

/** Cancel pending launches before waiting for their first ownership record. */
export function closePendingSessionSpawns(registry: OwnedSession): Promise<void> {
	closedSessions.add(registry);
	const cancellations = [...(pendingSpawns.get(registry) ?? [])].map((spawn) => spawn.cancel());
	return Promise.all(cancellations).then(() => {});
}

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
	const owned = prepareOwnedSpawn({ procwardBinary: binary, registry, purpose, provenance }, command, args)!;
	// The resolved binary above guarantees a prepared spawn; retain it until cleanup is settled.
	let pending = pendingSpawns.get(registry);
	if (!pending) {
		pending = new Set();
		pendingSpawns.set(registry, pending);
	}
	pending.add(owned);
	void owned.completion.then(() => pending.delete(owned));
	return owned;
}

/** Remove the parent's one-use ownership handoff from the child's environment. */
export function ownedChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const childEnv = { ...env };
	for (const key of CONTRACT_ENV_KEYS) delete childEnv[key];
	delete childEnv.PI_PROCWARD_BOOTSTRAP_NONCE;
	return childEnv;
}
