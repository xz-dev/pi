/**
 * Registry of processes owned through procward.
 *
 * Every tool call spawned under `procward run --control-fd` registers here;
 * `process_list`/`process_kill` read it. Entries outlive the tool call that
 * created them while their procward still tracks background descendants
 * (`status: "background"`), and record `unconfirmed` when cleanup evidence
 * was incomplete (X without a valid C+EOF, per the procward contract).
 */

export type OwnedTaskStatus = "running" | "background" | "reaping" | "unconfirmed";

export interface OwnedTask {
	readonly id: number;
	/** The command line as invoked (for display). */
	readonly command: string;
	/** Why this task exists: which tool call / message triggered it. */
	readonly purpose: string;
	/** PID of the procward owner wrapping this task's tree. */
	readonly procwardPid: number;
	/** Cancel this task's tree through its control endpoint. */
	readonly cancel: () => void;
	status: OwnedTaskStatus;
	readonly startedAt: number;
}

export interface OwnedSession {
	/** pi's own self-ownership entry (the outer procward), when managed. */
	readonly selfProcwardPid: number | undefined;
	list(): readonly OwnedTask[];
	get(id: number): OwnedTask | undefined;
	register(task: Omit<OwnedTask, "id" | "status" | "startedAt">): OwnedTask;
	/** Mark a finished task: kept when descendants remain, else removed. */
	settle(id: number, outcome: { descendantsAlive: boolean; unconfirmed: boolean }): void;
	/** Drop a task from the registry (tree fully cleaned). */
	forget(id: number): void;
}

export function createProcessRegistry(selfProcwardPid?: number): OwnedSession {
	let nextId = 1;
	const tasks = new Map<number, OwnedTask>();
	return {
		selfProcwardPid,
		list: () =>
			[...tasks.values()].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id),
		get: (id) => tasks.get(id),
		register: (task) => {
			const entry: OwnedTask = { ...task, id: nextId++, status: "running", startedAt: Date.now() };
			tasks.set(entry.id, entry);
			return entry;
		},
		settle: (id, outcome) => {
			const task = tasks.get(id);
			if (!task) return;
			if (outcome.unconfirmed) {
				task.status = "unconfirmed";
				return; // keep the entry: an operator may want to inspect it
			}
			if (outcome.descendantsAlive) {
				task.status = "background";
				return;
			}
			tasks.delete(id);
		},
		forget: (id) => {
			tasks.delete(id);
		},
	};
}
