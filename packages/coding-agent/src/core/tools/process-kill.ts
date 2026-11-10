/** Cancel selected task trees and report native cleanup evidence for each id. */
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { OwnedSession } from "../process-registry.ts";

export type ProcessKillResult =
	| {
			id: number;
			status: "confirmed" | "unconfirmed";
			exitCode: number | null;
			scope: "kernel" | "best-effort" | null;
			unconfirmed: boolean;
	  }
	| { id: number; status: "unknown" | "not-cancellable"; reason: string };

const parameters = Type.Object({
	ids: Type.Array(Type.Integer({ minimum: 0 }), {
		minItems: 1,
		description: "One or more positive task IDs from process_list. Session id 0 cannot be cancelled.",
	}),
});

/** Create per-task cancellation using configured native grace and strict S/X/C/EOF confirmation. */
export function createProcessKillToolDefinition(registry: OwnedSession): ToolDefinition<typeof parameters> {
	return {
		name: "process_kill",
		label: "process_kill",
		description:
			"Cancel one or more owned task trees through their native control endpoints, using the owner's configured grace. Reports each ID independently: confirmed cleanup includes primary exit status and kernel/best-effort scope; missing or invalid cleanup evidence is unconfirmed, never success. Unknown IDs are reported. Session entry 0 cannot be cancelled by this tool. Per-request grace overrides are not supported.",
		parameters,
		async execute(_toolCallId, { ids }) {
			const results = await Promise.all(
				ids.map(async (id): Promise<ProcessKillResult> => {
					if (id === 0 && registry.selfProcwardPid !== undefined)
						return {
							id,
							status: "not-cancellable",
							reason: "This is the current pi session owner, not a cancellable task.",
						};
					const task = registry.get(id);
					if (!task) return { id, status: "unknown", reason: "Unknown task ID" };
					task.status = "reaping";
					try {
						const completion = await task.cancel();
						if (completion.unconfirmed) task.status = "unconfirmed";
						return {
							id,
							status: completion.unconfirmed ? "unconfirmed" : "confirmed",
							exitCode: completion.exitCode ?? null,
							scope: completion.scope ?? null,
							unconfirmed: completion.unconfirmed,
						};
					} catch {
						task.status = "unconfirmed";
						return { id, status: "unconfirmed", exitCode: null, scope: null, unconfirmed: true };
					}
				}),
			);
			return {
				content: [{ type: "text", text: JSON.stringify({ results }) }],
				details: undefined,
				structuredContent: { results },
			};
		},
	};
}
