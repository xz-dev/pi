import type { JsonObject } from "../types.ts";

export interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

export interface AssistantMessageDiagnostic {
	/**
	 * On a failed openai-responses message, provider_reference_repair_terminal means
	 * its permitted full-history reference repair started and then failed without abort.
	 * Automatic retry consumers must veto replay of this message, not later turns.
	 * Hosts without that consumer ignore the diagnostic and do not provide this guarantee.
	 * provider_response_replay_unavailable instead makes an unrecoverable background
	 * stream eligible for the ordinary retry policy; it does not grant a retry budget.
	 */
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: JsonObject;
}

export function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
	if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
	const code = (error as Error & { code?: unknown }).code;
	return {
		name: error.name || undefined,
		message: error.message || error.name,
		stack: error.stack,
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
	};
}

export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: JsonObject,
): AssistantMessageDiagnostic {
	return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
