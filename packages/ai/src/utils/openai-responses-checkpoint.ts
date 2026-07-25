function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidUsage(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (
		!isNonNegativeFiniteNumber(value.input_tokens) ||
		!isNonNegativeFiniteNumber(value.output_tokens) ||
		!isNonNegativeFiniteNumber(value.total_tokens) ||
		!isRecord(value.input_tokens_details) ||
		!isNonNegativeFiniteNumber(value.input_tokens_details.cached_tokens) ||
		!isRecord(value.output_tokens_details) ||
		!isNonNegativeFiniteNumber(value.output_tokens_details.reasoning_tokens)
	) {
		return false;
	}
	const cacheWriteTokens = value.input_tokens_details.cache_write_tokens;
	return cacheWriteTokens === undefined || isNonNegativeFiniteNumber(cacheWriteTokens);
}

/** Pure structural validation shared by checkpoint creation, persistence loading, and replay. */
export function isValidOpenAIResponsesCheckpointPayload(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || value.id.trim().length === 0) return false;
	if (!isNonNegativeFiniteNumber(value.created_at)) return false;
	if (value.object !== "response.compaction" || !isValidUsage(value.usage)) return false;
	if (!Array.isArray(value.output) || value.output.length === 0) return false;
	return value.output.every((item) => isRecord(item) && typeof item.type === "string" && item.type.trim().length > 0);
}
