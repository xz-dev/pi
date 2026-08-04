/**
 * Pure continuation planner for manual /retry.
 *
 * Classifies a session branch into a protocol-safe continuation boundary and
 * returns only plan data. Does not touch SessionManager, providers, or tools.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "./session-manager.ts";

/** Exact neutral text for unresolved tool calls. */
export const SYNTHETIC_TOOL_RESULT_TEXT =
	"No usable result was recorded for this tool call. Whether it executed or produced side effects is unknown. Do not assume it is safe to repeat.";

export type ContinuationPlanKind = "terminal_assistant" | "user_anchor" | "tool_batch";

export type ContinuationRejectionCode =
	| "nothing_to_continue"
	| "orphan_tool_result"
	| "duplicate_tool_call"
	| "duplicate_tool_result"
	| "tool_name_mismatch"
	| "interleaved_tool_batch"
	| "malformed_tool_call"
	| "malformed_tool_result"
	| "missing_anchor"
	| "empty_branch"
	| "invalid_anchor";

export class ContinuationPlanError extends Error {
	readonly code: ContinuationRejectionCode;

	constructor(code: ContinuationRejectionCode, message: string) {
		super(message);
		this.name = "ContinuationPlanError";
		this.code = code;
	}
}

export interface ContinuationPlan {
	kind: ContinuationPlanKind;
	/** Parent entry for the next assistant turn (and first synthetic recovery message). */
	anchorEntryId: string;
	/** Current branch leaf that must still match when the plan is applied. */
	expectedLeafId: string;
	/** Retained branch messages through the continuation boundary (no synthetics). */
	contextMessages: AgentMessage[];
	/** Protocol-valid synthetic tool results for missing calls, in original call order. */
	recoveryMessages: ToolResultMessage[];
}

export interface PlanContinuationInput {
	/** Ordered root→leaf branch entries. */
	branchEntries: readonly SessionEntry[];
	/** Optional focus entry on the branch; defaults to the branch leaf. */
	selectedEntryId?: string;
}

function reject(code: ContinuationRejectionCode, message: string): never {
	throw new ContinuationPlanError(code, message);
}

function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
	return message.role === "toolResult";
}

function toolCallsOf(assistant: AssistantMessage): ToolCall[] {
	return assistant.content.filter((part): part is ToolCall => part.type === "toolCall");
}

function createSyntheticToolResult(toolCallId: string, toolName: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: SYNTHETIC_TOOL_RESULT_TEXT }],
		isError: true,
		timestamp,
	};
}

function contextThrough(entries: readonly SessionEntry[], endEntryId: string): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (isMessageEntry(entry)) {
			messages.push(entry.message);
		}
		if (entry.id === endEntryId) {
			return messages;
		}
	}
	reject("invalid_anchor", `Continuation boundary ${endEntryId} is not on the provided branch.`);
}

function findEntryIndex(entries: readonly SessionEntry[], entryId: string): number {
	const index = entries.findIndex((entry) => entry.id === entryId);
	if (index < 0) {
		reject("invalid_anchor", `Selected entry ${entryId} is not on the provided branch.`);
	}
	return index;
}

function findOwningToolAssistantIndex(entries: readonly SessionEntry[], fromIndex: number): number {
	for (let i = fromIndex; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || !isMessageEntry(entry)) {
			continue;
		}
		if (isAssistantMessage(entry.message) && toolCallsOf(entry.message).length > 0) {
			return i;
		}
		if (entry.message.role === "user") {
			break;
		}
	}
	reject("orphan_tool_result", "Tool result has no matching assistant tool-call batch on the branch.");
}

interface ValidatedToolBatch {
	anchorEntryId: string;
	contextEndEntryId: string;
	recoveryMessages: ToolResultMessage[];
}

function validateToolBatch(
	entries: readonly SessionEntry[],
	assistantIndex: number,
	timestamp: number,
): ValidatedToolBatch {
	const assistantEntry = entries[assistantIndex];
	if (!assistantEntry || !isMessageEntry(assistantEntry) || !isAssistantMessage(assistantEntry.message)) {
		reject("malformed_tool_call", "Tool batch assistant entry does not contain an assistant message.");
	}

	const assistant = assistantEntry.message;
	const toolCalls = toolCallsOf(assistant);
	if (toolCalls.length === 0) {
		reject("malformed_tool_call", "Assistant tool batch contains no tool calls.");
	}

	const seenCallIds = new Set<string>();
	for (const call of toolCalls) {
		if (typeof call.id !== "string" || call.id.length === 0) {
			reject("malformed_tool_call", "Assistant tool batch contains a tool call with an empty id.");
		}
		if (typeof call.name !== "string" || call.name.length === 0) {
			reject("malformed_tool_call", `Tool call ${call.id} has an empty name.`);
		}
		if (seenCallIds.has(call.id)) {
			reject("duplicate_tool_call", `Assistant tool batch has duplicate tool call id ${call.id}.`);
		}
		seenCallIds.add(call.id);
	}

	const callById = new Map(toolCalls.map((call) => [call.id, call] as const));
	const existingResults: SessionMessageEntry[] = [];
	const resultByCallId = new Map<string, SessionMessageEntry>();

	// Consume the whole batch as a contiguous toolResult run. Missing calls are
	// synthesized after the run. Non-results before completion are interleaved.
	// Extra results after completion for the same batch are duplicate/orphan.
	for (let i = assistantIndex + 1; i < entries.length; i++) {
		const entry = entries[i]!;
		const batchComplete = resultByCallId.size === toolCalls.length;

		if (!isMessageEntry(entry)) {
			if (batchComplete) {
				break;
			}
			reject(
				"interleaved_tool_batch",
				"Tool batch is interleaved with non-message entries before the batch completes.",
			);
		}

		const message = entry.message;
		if (!isToolResultMessage(message)) {
			if (batchComplete) {
				break;
			}
			reject(
				"interleaved_tool_batch",
				"Tool batch is interleaved with a non-toolResult message before all calls are resolved.",
			);
		}

		if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) {
			reject("malformed_tool_result", "Tool result is missing a toolCallId.");
		}
		if (typeof message.toolName !== "string" || message.toolName.length === 0) {
			reject("malformed_tool_result", `Tool result ${message.toolCallId} is missing a toolName.`);
		}

		const call = callById.get(message.toolCallId);
		if (!call) {
			reject(
				"orphan_tool_result",
				`Tool result ${message.toolCallId} does not match any tool call in the assistant batch.`,
			);
		}
		if (resultByCallId.has(message.toolCallId)) {
			reject("duplicate_tool_result", `Tool call ${message.toolCallId} has duplicate tool results.`);
		}
		if (message.toolName !== call.name) {
			reject(
				"tool_name_mismatch",
				`Tool result ${message.toolCallId} name ${message.toolName} does not match call name ${call.name}.`,
			);
		}

		resultByCallId.set(message.toolCallId, entry);
		existingResults.push(entry);
	}

	const recoveryMessages: ToolResultMessage[] = [];
	for (const call of toolCalls) {
		if (!resultByCallId.has(call.id)) {
			recoveryMessages.push(createSyntheticToolResult(call.id, call.name, timestamp));
		}
	}

	const lastExisting = existingResults[existingResults.length - 1];
	return {
		anchorEntryId: lastExisting?.id ?? assistantEntry.id,
		contextEndEntryId: lastExisting?.id ?? assistantEntry.id,
		recoveryMessages,
	};
}

function planTerminalAssistant(
	entries: readonly SessionEntry[],
	failedEntry: SessionMessageEntry,
	expectedLeafId: string,
): ContinuationPlan {
	const failedIndex = findEntryIndex(entries, failedEntry.id);
	if (failedIndex === 0) {
		reject("missing_anchor", "Terminal assistant has no parent entry to continue from.");
	}

	let anchorId: string | undefined;
	let contextEndId: string | undefined;
	for (let i = failedIndex - 1; i >= 0; i--) {
		const candidate = entries[i]!;
		if (anchorId === undefined) {
			anchorId = candidate.id;
		}
		if (isMessageEntry(candidate)) {
			contextEndId = candidate.id;
			break;
		}
	}
	if (!anchorId) {
		reject("missing_anchor", "Terminal assistant has no parent entry to continue from.");
	}

	return {
		kind: "terminal_assistant",
		anchorEntryId: anchorId,
		expectedLeafId,
		contextMessages: contextEndId ? contextThrough(entries, contextEndId) : [],
		recoveryMessages: [],
	};
}

function planToolBatch(
	entries: readonly SessionEntry[],
	assistantIndex: number,
	expectedLeafId: string,
	timestamp: number,
): ContinuationPlan {
	const batch = validateToolBatch(entries, assistantIndex, timestamp);
	return {
		kind: "tool_batch",
		anchorEntryId: batch.anchorEntryId,
		expectedLeafId,
		contextMessages: contextThrough(entries, batch.contextEndEntryId),
		recoveryMessages: batch.recoveryMessages,
	};
}

/**
 * Plan a pure continuation from a session branch.
 *
 * @throws {ContinuationPlanError} when the branch has nothing to continue or is malformed.
 */
export function planContinuation(input: PlanContinuationInput): ContinuationPlan {
	const { branchEntries } = input;
	if (branchEntries.length === 0) {
		reject("empty_branch", "Cannot plan continuation on an empty branch.");
	}

	const expectedLeafId = branchEntries[branchEntries.length - 1]!.id;
	const focusId = input.selectedEntryId ?? expectedLeafId;
	const focusIndex = findEntryIndex(branchEntries, focusId);
	const focusEntry = branchEntries[focusIndex]!;

	if (!isMessageEntry(focusEntry)) {
		reject(
			"nothing_to_continue",
			"Nothing to continue: selected entry is not a user, assistant, or toolResult message.",
		);
	}

	const focusMessage = focusEntry.message;
	const now = Date.now();

	if (focusMessage.role === "user") {
		return {
			kind: "user_anchor",
			anchorEntryId: focusEntry.id,
			expectedLeafId,
			contextMessages: contextThrough(branchEntries, focusEntry.id),
			recoveryMessages: [],
		};
	}

	if (isAssistantMessage(focusMessage)) {
		if (focusMessage.stopReason === "error" || focusMessage.stopReason === "aborted") {
			return planTerminalAssistant(branchEntries, focusEntry, expectedLeafId);
		}

		if (toolCallsOf(focusMessage).length > 0) {
			return planToolBatch(branchEntries, focusIndex, expectedLeafId, now);
		}

		reject("nothing_to_continue", "Nothing to continue: assistant response already completed.");
	}

	if (isToolResultMessage(focusMessage)) {
		if (typeof focusMessage.toolCallId !== "string" || focusMessage.toolCallId.length === 0) {
			reject("malformed_tool_result", "Tool result is missing a toolCallId.");
		}
		const assistantIndex = findOwningToolAssistantIndex(branchEntries, focusIndex);
		return planToolBatch(branchEntries, assistantIndex, expectedLeafId, now);
	}

	reject("nothing_to_continue", "Nothing to continue from the selected message role.");
}
