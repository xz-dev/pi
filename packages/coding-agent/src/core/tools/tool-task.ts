import {
	type AgentTool,
	createManagedExecutionReplay,
	type ManagedExecutionCancelResult,
	type ManagedExecutionInfo,
	type ManagedExecutionOutcome,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

// Flat object schema: root-level anyOf unions are rejected by strict JSON-schema
// constrained sampling and stripped by OpenAI-compatible gateways, which made
// models emit {} and loop on validation errors.
const toolTaskSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("info"), Type.Literal("wait"), Type.Literal("cancel")]),
	id: Type.Optional(Type.String()),
	timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1800 })),
});

type ToolTaskInput = Static<typeof toolTaskSchema>;

function requireId(input: ToolTaskInput): string {
	if (input.id === undefined) {
		throw new Error(`action "${input.action}" requires argument "id" (task ID string).`);
	}
	return input.id;
}

function requireTimeoutSeconds(input: ToolTaskInput): number {
	if (input.timeoutSeconds === undefined) {
		throw new Error(`action "wait" requires argument "timeoutSeconds" (number > 0 and <= 1800).`);
	}
	return input.timeoutSeconds;
}

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
		description:
			"List, inspect, wait for, or request cancellation of managed background tool executions. Actions: list (no other arguments), info/cancel (also requires id), wait (also requires id and timeoutSeconds).",
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
					const task = managedExecutions.info(requireId(input));
					if (!task) throw new Error(`Unknown managed tool execution: ${input.id}`);
					return { content: [{ type: "text", text: formatTask(task) }], details: { task } };
				}
				case "wait": {
					return createManagedExecutionReplay(
						await managedExecutions.wait(requireId(input), requireTimeoutSeconds(input)),
					);
				}
				case "cancel": {
					const id = requireId(input);
					const cancellation = managedExecutions.cancel(id);
					const cancellationRequested = cancellation.disposition === "requested";
					let text: string;
					switch (cancellation.disposition) {
						case "requested":
							text = `Cancellation requested for managed tool execution ${id}.`;
							break;
						case "already_requested":
							text = `Cancellation was already requested for managed tool execution ${id}.`;
							break;
						case "already_terminal":
							text = `Managed tool execution ${id} is already ${cancellation.status}; no cancellation request was sent.`;
							break;
					}
					return {
						content: [{ type: "text", text }],
						details: { id, ...cancellation, cancellationRequested },
					};
				}
			}
		},
	};
}
