/** Registry of procward tasks whose control transcripts prove cleanup. */
export type OwnedTaskStatus = "running" | "background" | "reaping" | "unconfirmed";

export interface OwnedCompletion {
	readonly exitCode: number | undefined;
	readonly scope: "kernel" | "best-effort" | undefined;
	readonly unconfirmed: boolean;
}

export type OwnedTaskProvenance = {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly messageId?: string;
	readonly messageSummary?: string;
};

export interface OwnedTask {
	readonly id: number;
	readonly command: string;
	readonly purpose: string;
	readonly provenance?: OwnedTaskProvenance;
	readonly procwardPid: number;
	readonly cancel: () => Promise<OwnedCompletion>;
	status: OwnedTaskStatus;
	readonly startedAt: number;
}

export interface OwnedSession {
	/** Only a validated bootstrap handoff supplies the current session owner. */
	readonly selfProcwardPid: number | undefined;
	readonly startedAt: number;
	list(): readonly OwnedTask[];
	get(id: number): OwnedTask | undefined;
	register(task: Omit<OwnedTask, "id" | "status" | "startedAt">): OwnedTask;
	settle(id: number, outcome: { descendantsAlive: boolean; unconfirmed: boolean }): void;
	forget(id: number): void;
	/** Request cleanup of every owned task; unconfirmed entries remain visible. */
	close(): Promise<void>;
}

interface OwnedLifetime {
	readonly completion: Promise<OwnedCompletion>;
	cancel(): Promise<OwnedCompletion>;
}

const pendingSpawns = new WeakMap<OwnedSession, Set<OwnedLifetime>>();
const closedSessions = new WeakSet<OwnedSession>();

/** Reject new session-scoped executions after disposal starts. */
export function assertSessionProcessesOpen(registry: OwnedSession | undefined): void {
	if (registry && closedSessions.has(registry)) throw new Error("Session process ownership is closed");
}

/** Account for every admitted native lifetime before spawn or the first startup await. */
export function trackSessionSpawn(registry: OwnedSession, spawn: OwnedLifetime): void {
	assertSessionProcessesOpen(registry);
	let pending = pendingSpawns.get(registry);
	if (!pending) {
		pending = new Set();
		pendingSpawns.set(registry, pending);
	}
	pending.add(spawn);
	void spawn.completion.then(() => pending.delete(spawn));
}

/** Close admission and cancel even launches that have not yet reported S. */
export function closePendingSessionSpawns(registry: OwnedSession): Promise<void> {
	closedSessions.add(registry);
	const cancellations = [...(pendingSpawns.get(registry) ?? [])].map((spawn) => spawn.cancel());
	return Promise.all(cancellations).then(() => {});
}

/** Create one registry for the lifetime of an AgentSession, including runtime reloads. */
export function createProcessRegistry(selfProcwardPid?: number): OwnedSession {
	let nextId = 1;
	const tasks = new Map<number, OwnedTask>();
	const registry: OwnedSession = {
		selfProcwardPid,
		startedAt: Date.now(),
		list: () => [...tasks.values()].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id),
		get: (id) => tasks.get(id),
		register: (task) => {
			// S can arrive after close for a launch admitted before shutdown.
			const entry: OwnedTask = { ...task, id: nextId++, status: "running", startedAt: Date.now() };
			tasks.set(entry.id, entry);
			return entry;
		},
		settle: (id, outcome) => {
			const task = tasks.get(id);
			if (!task) return;
			if (outcome.unconfirmed) task.status = "unconfirmed";
			else if (outcome.descendantsAlive) task.status = "background";
			else tasks.delete(id);
		},
		forget: (id) => {
			tasks.delete(id);
		},
		close: async () => {
			const pending = closePendingSessionSpawns(registry);
			await Promise.all([
				pending,
				...[...tasks.values()].map(async (task) => {
					try {
						await task.cancel();
					} catch {
						task.status = "unconfirmed";
					}
				}),
			]);
		},
	};
	return registry;
}
