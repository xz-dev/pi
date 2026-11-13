/** List the session owner and task trees recorded by native control transcripts. */
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { OwnedSession, OwnedTaskProvenance, OwnedTaskStatus } from "../process-registry.ts";

export type ProcessListEntry = {
	id: number;
	kind: "session" | "task";
	command: string;
	purpose: string;
	provenance?: OwnedTaskProvenance;
	procwardPid: number;
	status: OwnedTaskStatus;
	startedAt: number;
	ageSeconds: number;
};

const parameters = Type.Object({});

/** Create a read-only snapshot tool; session id 0 is not a cancellable task. */
export function createProcessListToolDefinition(registry: OwnedSession): ToolDefinition<typeof parameters> {
	return {
		name: "process_list",
		label: "process_list",
		description:
			"List owned process trees, including background work after its tool returns. Shows command, tool call/message provenance, procward PID, status and age. Session entry 0 identifies the current owner and cannot be cancelled; use process_kill for positive task IDs. Unconfirmed entries have not proved tree cleanup.",
		parameters,
		async execute() {
			const now = Date.now();
			const processes: ProcessListEntry[] = registry.list().map((task) => ({
				id: task.id,
				kind: "task",
				command: task.command,
				purpose: task.purpose,
				...(task.provenance ? { provenance: task.provenance } : {}),
				procwardPid: task.procwardPid,
				status: task.status,
				startedAt: task.startedAt,
				ageSeconds: Math.max(0, now - task.startedAt) / 1000,
			}));
			if (registry.selfProcwardPid !== undefined) {
				processes.unshift({
					id: 0,
					kind: "session",
					command: process.argv.join(" "),
					purpose: "Current pi session owner",
					procwardPid: registry.selfProcwardPid,
					status: "running",
					startedAt: registry.startedAt,
					ageSeconds: Math.max(0, now - registry.startedAt) / 1000,
				});
			}
			return {
				content: [{ type: "text", text: JSON.stringify({ processes }) }],
				details: undefined,
				structuredContent: { processes },
			};
		},
	};
}
