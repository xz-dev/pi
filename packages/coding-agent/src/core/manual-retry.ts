/**
 * Pure continuation planner for manual /retry.
 *
 * Classifies a session branch into a protocol-safe continuation boundary and
 * returns only plan data. Does not touch SessionManager, providers, or tools.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	buildContextEntries,
	type SessionEntry,
	type SessionMessageEntry,
	sessionEntryToContextMessages,
} from "./session-manager.ts";

/** Exact neutral text for unresolved tool calls. */
export const SYNTHETIC_TOOL_RESULT_TEXT =
	"No usable result was recorded for this tool call. Whether it executed or produced side effects is unknown. Do not assume it is safe to repeat.";

export type ContinuationPlanKind = "interrupted_assistant" | "user_anchor" | "tool_batch";

export type ContinuationRejectionCode =
	| "nothing_to_continue"
	| "unsupported_tail"
	| "assistant_eof"
	| "assistant_length_eof"
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
	/** Protocol-valid synthetic tool results that are safe to persist after an existing tool-call assistant. */
	recoveryMessages: ToolResultMessage[];
	/** Provider-only synthetic results for a normalized interrupted tool-call assistant. */
	providerRecoveryMessages?: ToolResultMessage[];
	/** A protocol-normalized copy of an interrupted assistant tool batch, when needed. */
	recoveryAssistant?: AssistantMessage;
	/** Safe interrupted assistant text preserved for the provider-only recovery request. */
	partialAssistantText?: string;
}

export interface PlanContinuationInput {
	/** Ordered root→leaf branch entries. */
	branchEntries: readonly SessionEntry[];
	/** Optional focus entry on the branch; defaults to the branch leaf. */
	selectedEntryId?: string;
	/** Timestamp applied to synthetic recovery messages. */
	recoveryTimestamp: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonblankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function findLatestConversationEntryIndex(entries: readonly SessionEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "custom" || entry.type === "custom_message") continue;
		if (isMessageEntry(entry)) {
			if (entry.message.role === "custom") continue;
			if (
				entry.message.role === "user" ||
				entry.message.role === "assistant" ||
				entry.message.role === "toolResult"
			) {
				return i;
			}
			reject(
				"unsupported_tail",
				`Cannot retry: the latest session message type ${entry.message.role} is not recoverable.`,
			);
		}
		reject("unsupported_tail", `Cannot retry: the latest session entry type ${entry.type} is not recoverable.`);
	}
	reject("nothing_to_continue", "Nothing to continue: session contains no user, assistant, or toolResult message.");
}

function safePartialAssistantText(message: AssistantMessage): string | undefined {
	if (!Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				isRecord(block) && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
	return isNonblankString(text) ? text : undefined;
}

function hasUsableUserContent(message: AgentMessage): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return isNonblankString(message.content);
	if (!Array.isArray(message.content) || message.content.length === 0) return false;
	return message.content.some(
		(part) =>
			(part.type === "text" && isNonblankString(part.text)) ||
			(part.type === "image" && isNonblankString(part.data) && isNonblankString(part.mimeType)),
	);
}

function toolCallsOf(assistant: AssistantMessage): ToolCall[] {
	if (!Array.isArray(assistant.content)) {
		reject("malformed_tool_call", "Assistant content must be an array.");
	}
	const calls: ToolCall[] = [];
	for (const part of assistant.content as unknown[]) {
		if (!isRecord(part) || typeof part.type !== "string") {
			reject("malformed_tool_call", "Assistant content contains a malformed block.");
		}
		if (part.type === "toolCall") {
			if (
				typeof part.id !== "string" ||
				part.id.trim().length === 0 ||
				typeof part.name !== "string" ||
				part.name.trim().length === 0 ||
				!isRecord(part.arguments)
			) {
				reject("malformed_tool_call", "Assistant content contains a malformed tool call.");
			}
			calls.push(part as unknown as ToolCall);
			continue;
		}
		if (part.type === "text" && typeof part.text === "string") continue;
		if (part.type === "thinking" && typeof part.thinking === "string") continue;
		reject("malformed_tool_call", `Assistant content contains an unsupported ${part.type} block.`);
	}
	if (calls.length > 0 && assistant.stopReason !== "toolUse") {
		reject("malformed_tool_call", "Assistant tool calls require stopReason toolUse.");
	}
	return calls;
}

function inspectInterruptedAssistant(message: AssistantMessage): {
	calls: ToolCall[];
	malformed: boolean;
} {
	if (!Array.isArray(message.content)) return { calls: [], malformed: true };
	const calls: ToolCall[] = [];
	const seenCallIds = new Set<string>();
	let malformed = false;
	for (const part of message.content as unknown[]) {
		if (!isRecord(part) || typeof part.type !== "string") {
			malformed = true;
			continue;
		}
		if (part.type === "text" && typeof part.text === "string") continue;
		if (part.type === "thinking" && typeof part.thinking === "string") continue;
		if (
			part.type === "toolCall" &&
			typeof part.id === "string" &&
			part.id.trim().length > 0 &&
			typeof part.name === "string" &&
			part.name.trim().length > 0 &&
			isRecord(part.arguments)
		) {
			if (seenCallIds.has(part.id)) {
				malformed = true;
				continue;
			}
			seenCallIds.add(part.id);
			calls.push(part as unknown as ToolCall);
			continue;
		}
		malformed = true;
	}
	return { calls, malformed };
}

function normalizedInterruptedAssistant(message: AssistantMessage, calls: ToolCall[]): AssistantMessage | undefined {
	if (calls.length === 0) return undefined;
	return { ...message, stopReason: "toolUse", errorMessage: undefined };
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
	const endIndex = entries.findIndex((entry) => entry.id === endEntryId);
	if (endIndex < 0) {
		reject("invalid_anchor", `Continuation boundary ${endEntryId} is not on the provided branch.`);
	}
	const boundedEntries = entries.slice(0, endIndex + 1);
	return buildContextEntries([...boundedEntries], endEntryId).flatMap(sessionEntryToContextMessages);
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
	endIndex: number,
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
	for (let i = assistantIndex + 1; i <= endIndex; i++) {
		const entry = entries[i]!;
		if (!isMessageEntry(entry)) {
			if (sessionEntryToContextMessages(entry).length === 0) {
				continue;
			}
			reject(
				"interleaved_tool_batch",
				"Tool batch is interleaved with model-visible context before the selected boundary.",
			);
		}

		const message = entry.message;
		if (!isToolResultMessage(message)) {
			reject(
				"interleaved_tool_batch",
				"Tool batch is interleaved with a non-toolResult message before the selected boundary.",
			);
		}

		if (typeof message.toolCallId !== "string" || message.toolCallId.trim().length === 0) {
			reject("malformed_tool_result", "Tool result is missing a toolCallId.");
		}
		if (typeof message.toolName !== "string" || message.toolName.trim().length === 0) {
			reject("malformed_tool_result", `Tool result ${message.toolCallId} is missing a toolName.`);
		}
		if (!Array.isArray(message.content)) {
			reject("malformed_tool_result", `Tool result ${message.toolCallId} content must be an array.`);
		}
		if (message.content.length === 0) {
			reject("malformed_tool_result", `Tool result ${message.toolCallId} has no usable content.`);
		}
		for (const part of message.content as unknown[]) {
			if (!isRecord(part)) {
				reject("malformed_tool_result", `Tool result ${message.toolCallId} contains malformed content.`);
			}
			const validText = part.type === "text" && isNonblankString(part.text);
			const validImage = part.type === "image" && isNonblankString(part.data) && isNonblankString(part.mimeType);
			if (!validText && !validImage) {
				reject("malformed_tool_result", `Tool result ${message.toolCallId} contains blank or malformed content.`);
			}
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

function planInterruptedAssistant(
	entries: readonly SessionEntry[],
	failedEntry: SessionMessageEntry,
	expectedLeafId: string,
	timestamp: number,
): ContinuationPlan {
	const failedIndex = findEntryIndex(entries, failedEntry.id);
	if (failedIndex === 0 || failedEntry.parentId === null) {
		reject("missing_anchor", "Interrupted assistant has no parent entry to continue from.");
	}

	const failedAssistant = failedEntry.message as AssistantMessage;
	const inspected = inspectInterruptedAssistant(failedAssistant);
	const toolCalls = inspected.calls;
	const partialAssistantText = safePartialAssistantText(failedAssistant);
	if (inspected.malformed) {
		reject("malformed_tool_call", "Interrupted assistant contains a partial or malformed tool call.");
	}
	if (toolCalls.length === 0) {
		return {
			kind: "interrupted_assistant",
			anchorEntryId: failedEntry.parentId,
			expectedLeafId,
			contextMessages: contextThrough(entries, failedEntry.parentId),
			recoveryMessages: [],
			partialAssistantText,
		};
	}

	// An interrupted assistant cannot be replayed with stopReason=error/aborted:
	// providers reject tool calls on that assistant, and retry must never execute them.
	const recoveryAssistant = normalizedInterruptedAssistant(failedAssistant, toolCalls);
	if (!recoveryAssistant) {
		reject("malformed_tool_call", "Interrupted assistant tool calls could not be normalized safely.");
	}
	return {
		kind: "interrupted_assistant",
		anchorEntryId: failedEntry.parentId,
		expectedLeafId,
		contextMessages: [...contextThrough(entries, failedEntry.parentId), recoveryAssistant],
		recoveryMessages: [],
		providerRecoveryMessages: toolCalls.map((call) => createSyntheticToolResult(call.id, call.name, timestamp)),
		recoveryAssistant,
		partialAssistantText,
	};
}

function planToolBatch(
	entries: readonly SessionEntry[],
	assistantIndex: number,
	endIndex: number,
	expectedLeafId: string,
	timestamp: number,
): ContinuationPlan {
	const batch = validateToolBatch(entries, assistantIndex, endIndex, timestamp);
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
	const focusId = input.selectedEntryId ?? branchEntries[findLatestConversationEntryIndex(branchEntries)]!.id;
	const focusIndex = findEntryIndex(branchEntries, focusId);
	const focusEntry = branchEntries[focusIndex]!;

	if (!isMessageEntry(focusEntry)) {
		reject(
			"nothing_to_continue",
			`Nothing to continue: selected ${focusEntry.type} entry is not a user, assistant, or toolResult message.`,
		);
	}

	const focusMessage = focusEntry.message;
	const now = input.recoveryTimestamp;

	if (focusMessage.role === "user") {
		if (!hasUsableUserContent(focusMessage)) {
			reject("invalid_anchor", "Selected user message has no usable content.");
		}
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
			return planInterruptedAssistant(branchEntries, focusEntry, expectedLeafId, now);
		}
		if (focusMessage.stopReason === "stop") {
			reject(
				"assistant_eof",
				"Cannot retry: the previous AI response reached Assistant EOF. Send a new message if you want more detail.",
			);
		}
		if (focusMessage.stopReason === "length") {
			reject(
				"assistant_length_eof",
				"Cannot retry: the previous AI response reached Assistant EOF at its output limit. Use your length-continuation command or send a new message.",
			);
		}

		if (toolCallsOf(focusMessage).length > 0) {
			let batchEndIndex = focusIndex;
			for (let i = focusIndex + 1; i < branchEntries.length; i++) {
				const candidate = branchEntries[i]!;
				if (!isMessageEntry(candidate) || !isToolResultMessage(candidate.message)) {
					break;
				}
				batchEndIndex = i;
			}
			return planToolBatch(branchEntries, focusIndex, batchEndIndex, expectedLeafId, now);
		}

		reject("nothing_to_continue", "Nothing to continue: assistant response already completed.");
	}

	if (isToolResultMessage(focusMessage)) {
		if (typeof focusMessage.toolCallId !== "string" || focusMessage.toolCallId.length === 0) {
			reject("malformed_tool_result", "Tool result is missing a toolCallId.");
		}
		const assistantIndex = findOwningToolAssistantIndex(branchEntries, focusIndex);
		return planToolBatch(branchEntries, assistantIndex, focusIndex, expectedLeafId, now);
	}

	reject("nothing_to_continue", "Nothing to continue from the selected message role.");
}
