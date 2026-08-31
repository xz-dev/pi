import {
	type AgentTool,
	createManagedExecutionReplay,
	type ManagedExecutionCancelResult,
	type ManagedExecutionInfo,
	type ManagedExecutionOutcome,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

const toolTaskSchema = Type.Union([
	Type.Object({ action: Type.Literal("list") }),
	Type.Object({ action: Type.Literal("info"), id: Type.String() }),
	Type.Object({
		action: Type.Literal("wait"),
		id: Type.String(),
		timeoutSeconds: Type.Number({ exclusiveMinimum: 0, maximum: 1800 }),
	}),
	Type.Object({ action: Type.Literal("cancel"), id: Type.String() }),
]);

function formatTask(task: ManagedExecutionInfo): string {
	return `${task.id} ${task.status} ${task.toolName} (tool call ${task.toolCallId})`;
}

export function createToolTaskTool(managedExecutions: {
	list(): ManagedExecutionInfo[];
	info(id: string): ManagedExecutionInfo | undefined;
	wait(id: string, timeoutSeconds: number): Promise<ManagedExecutionOutcome>;
	cancel(id: string): ManagedExecutionCancelResult;
}): AgentTool<typeof toolTaskSchema> {
	return {
		name: "tool_task",
		label: "tool_task",
		description: "List, inspect, wait for, or request cancellation of managed background tool executions.",
		parameters: toolTaskSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input: Static<typeof toolTaskSchema>) {
			switch (input.action) {
				case "list": {
					const tasks = managedExecutions.list();
					return {
						content: [
							{
								type: "text",
								text: tasks.length > 0 ? tasks.map(formatTask).join("\n") : "No managed tool executions.",
							},
						],
						details: { tasks },
					};
				}
				case "info": {
					const task = managedExecutions.info(input.id);
					if (!task) throw new Error(`Unknown managed tool execution: ${input.id}`);
					return { content: [{ type: "text", text: formatTask(task) }], details: { task } };
				}
				case "wait": {
					return createManagedExecutionReplay(await managedExecutions.wait(input.id, input.timeoutSeconds));
				}
				case "cancel": {
					const cancellation = managedExecutions.cancel(input.id);
					const cancellationRequested = cancellation.disposition === "requested";
					let text: string;
					switch (cancellation.disposition) {
						case "requested":
							text = `Cancellation requested for managed tool execution ${input.id}.`;
							break;
						case "already_requested":
							text = `Cancellation was already requested for managed tool execution ${input.id}.`;
							break;
						case "already_terminal":
							text = `Managed tool execution ${input.id} is already ${cancellation.status}; no cancellation request was sent.`;
							break;
					}
					return {
						content: [{ type: "text", text }],
						details: { id: input.id, ...cancellation, cancellationRequested },
					};
				}
			}
		},
	};
}
