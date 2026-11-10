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

/** Create one registry for the lifetime of an AgentSession, including runtime reloads. */
export function createProcessRegistry(selfProcwardPid?: number): OwnedSession {
	let nextId = 1;
	const tasks = new Map<number, OwnedTask>();
	return {
		selfProcwardPid,
		startedAt: Date.now(),
		list: () => [...tasks.values()].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id),
		get: (id) => tasks.get(id),
		register: (task) => {
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
			await Promise.all(
				[...tasks.values()].map(async (task) => {
					try {
						await task.cancel();
					} catch {
						task.status = "unconfirmed";
					}
				}),
			);
		},
	};
}
