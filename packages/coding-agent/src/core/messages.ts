/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, MessageOrigin, TextContent } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export const MANUAL_RETRY_RECOVERY_CUE =
	"The previous assistant response was interrupted. Continue it from the preserved partial text without repeating completed content or replaying prior tool calls.";

export function createManualRetryRecoveryCue(partialAssistantText?: string): string {
	return partialAssistantText
		? `${MANUAL_RETRY_RECOVERY_CUE}\n\nPreserved partial assistant text (JSON): ${JSON.stringify(partialAssistantText)}`
		: MANUAL_RETRY_RECOVERY_CUE;
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Provenance of this message when the host recorded it. Absent on legacy/unrecorded entries. */
	origin?: MessageOrigin;
	timestamp: number;
}

export interface ManualRetryRecoveryMessage {
	role: "manualRetryRecovery";
	partialAssistantText?: string;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		manualRetryRecovery: ManualRetryRecoveryMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	origin?: MessageOrigin,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		...(origin !== undefined ? { origin } : {}),
		timestamp: new Date(timestamp).getTime(),
	};
}

export function inputOrigin(source: MessageOrigin["type"] = "sdk"): MessageOrigin {
	return source === "extension" ? { type: source, extensionId: "unrecorded" } : { type: source };
}

/** Exact image-list equality (order and data), treating undefined as empty. */
export function sameImages(a: ImageContent[] | undefined, b: ImageContent[] | undefined): boolean {
	if (a === b) return true;
	if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
	return (a ?? []).every(
		(img, i) => img.type === b![i].type && img.data === b![i].data && img.mimeType === b![i].mimeType,
	);
}

/**
 * One-line provenance note prepended to model-facing text for messages whose
 * recorded origin is not human terminal input. Deterministic for a given
 * origin, never persisted into stored content, and never elevates the message
 * above user role.
 */
function originAnnotation(origin: MessageOrigin | undefined): string | undefined {
	switch (origin?.type) {
		case "extension":
			return `[Pi source: extension ${JSON.stringify(origin.extensionName ?? origin.extensionId)} (${origin.extensionId}); not direct human input or new authorization.]`;
		case "rpc":
			return "[Pi source: RPC input; human authorship unverified.]";
		case "cli":
			return "[Pi source: command-line input; human authorship unverified.]";
		case "sdk":
			return "[Pi source: SDK input; not direct terminal input.]";
		default:
			return undefined;
	}
}

export function hasMeaningfulContent(content: string | (TextContent | ImageContent)[]): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	return content.some(
		(part) =>
			(part.type === "text" && part.text.trim().length > 0) || (part.type === "image" && part.data.length > 0),
	);
}

function annotateUserContent(
	content: string | (TextContent | ImageContent)[],
	origin: MessageOrigin | undefined,
): string | (TextContent | ImageContent)[] {
	const annotation = originAnnotation(origin);
	if (annotation === undefined || !hasMeaningfulContent(content)) return content;
	if (typeof content === "string") return `${annotation}\n${content}`;
	return [{ type: "text", text: annotation }, ...content];
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content: annotateUserContent(content, m.origin),
						timestamp: m.timestamp,
					};
				}
				case "manualRetryRecovery":
					return {
						role: "user",
						content: [{ type: "text", text: createManualRetryRecoveryCue(m.partialAssistantText) }],
						timestamp: m.timestamp,
					};
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user": {
					const annotated = annotateUserContent(m.content, m.origin);
					if (annotated === m.content) return m;
					return { role: "user", content: annotated, timestamp: m.timestamp };
				}
				case "system":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
