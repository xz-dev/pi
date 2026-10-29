import type { AgentMessage } from "@earendil-works/pi-agent-core";

// The interactive command behind an expanded prompt-template message. Persisted as the
// downstream-only `__raw_inputText` session entry field; the message content keeps the expansion.
// Keyed by message identity: agent state, queues, events, and session entries share message objects.
const rawInputTexts = new WeakMap<AgentMessage, string>();

/** Return the value when it is a usable raw input text, otherwise undefined. */
export function normalizeRawInputText(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Associate the raw interactive command with the message built from its expansion. */
export function setRawInputText(message: AgentMessage, rawInputText: string | undefined): void {
	const value = normalizeRawInputText(rawInputText);
	if (value) rawInputTexts.set(message, value);
}

/** Raw interactive command recorded for a message, if its expansion was recorded. */
export function getRawInputText(message: AgentMessage): string | undefined {
	return rawInputTexts.get(message);
}
