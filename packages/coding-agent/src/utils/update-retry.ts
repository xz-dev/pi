import { sleep } from "./sleep.ts";

/** Fixed backoff for `pi update` targets: three retries after 3s, 6s and 12s. */
export const UPDATE_RETRY_DELAYS_MS: readonly number[] = [3000, 6000, 12000];

export interface UpdateRetryOptions {
	/** Decide whether a failure may be retried. Defaults to retrying every failure. */
	shouldRetry?: (error: unknown) => boolean;
	/** Aborts the wait and skips further attempts; the pending operation still finishes. */
	signal?: AbortSignal;
	/** Called before each retry wait; attempt is 1-based and delayMs is the upcoming wait. */
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Run one `pi update` operation, retrying a failure after fixed delays.
 * Successful operations never rerun; the last failure rethrows unchanged.
 */
export async function retryUpdateOperation<T>(
	operation: () => Promise<T>,
	options: UpdateRetryOptions = {},
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		options.signal?.throwIfAborted();
		try {
			return await operation();
		} catch (error) {
			const delayMs = UPDATE_RETRY_DELAYS_MS[attempt];
			if (delayMs === undefined || options.signal?.aborted || options.shouldRetry?.(error) === false) {
				throw error;
			}
			options.onRetry?.(error, attempt + 1, delayMs);
			await sleep(delayMs, options.signal);
		}
	}
}
