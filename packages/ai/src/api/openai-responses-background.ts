import OpenAI from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";

/** Reattach a background response without replacing its parser or creating another generation. */
export async function* replayBackgroundResponses(
	initial: AsyncIterable<ResponseStreamEvent>,
	retrieve: (id: string, startingAfter: number) => Promise<AsyncIterable<ResponseStreamEvent>>,
	signal: AbortSignal | undefined,
	onUnavailable: () => void,
): AsyncGenerator<ResponseStreamEvent> {
	let iterator = initial[Symbol.asyncIterator]();
	let responseId: string | undefined;
	let cursor: number | undefined;
	let reattachments = 0;
	try {
		for (;;) {
			if (signal?.aborted) throw new Error("Request was aborted");
			let next: IteratorResult<ResponseStreamEvent>;
			try {
				next = await iterator.next();
			} catch (error) {
				// SDK wire decoding cannot distinguish truncated JSON from malformed JSON; both spend this same GET budget.
				if (error instanceof OpenAI.APIError && !(error instanceof OpenAI.APIConnectionError)) throw error;
				next = { done: true, value: undefined };
			}
			if (signal?.aborted) throw new Error("Request was aborted");
			if (next.done) {
				if (!responseId || cursor === undefined) {
					onUnavailable();
					throw new Error("Background response ended without a stable response ID and sequence cursor");
				}
				if (reattachments >= 2) {
					onUnavailable();
					throw new Error("Background response replay exhausted its two reattachments");
				}
				reattachments++;
				await iterator.return?.();
				if (signal?.aborted) throw new Error("Request was aborted");
				iterator = (await retrieve(responseId, cursor))[Symbol.asyncIterator]();
				continue;
			}
			const event = next.value;
			if (!Number.isSafeInteger(event.sequence_number) || event.sequence_number < 0) {
				throw new Error("Background response has an invalid sequence cursor");
			}
			if ("response" in event) {
				const id = event.response?.id;
				if (typeof id !== "string" || id.length === 0 || (responseId !== undefined && id !== responseId)) {
					throw new Error("Background response has a missing or changed response ID");
				}
				responseId = id;
			}
			if (cursor !== undefined && event.sequence_number <= cursor) continue;
			if (event.sequence_number !== (cursor === undefined ? 0 : cursor + 1)) {
				throw new Error("Background response replay has a sequence gap");
			}
			yield event;
			// Resumption after yield acknowledges that the existing parser and callback accepted the whole event.
			cursor = event.sequence_number;
			if (
				event.type === "response.completed" ||
				event.type === "response.incomplete" ||
				event.type === "response.failed" ||
				event.type === "error"
			)
				return;
			if ("response" in event && event.response.status === "cancelled") {
				throw new Error("Background response was cancelled");
			}
		}
	} finally {
		await iterator.return?.();
	}
}
