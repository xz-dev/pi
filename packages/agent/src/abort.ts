export function abortError(signal?: AbortSignal): Error {
	return new Error(
		signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason ?? "Agent run aborted"),
	);
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

export async function abortable<T>(promise: Promise<T> | T, signal?: AbortSignal): Promise<T> {
	if (!signal) return await promise;
	if (signal.aborted) throw abortError(signal);

	return await new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(abortError(signal));
		};

		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(promise).then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

export async function callAbortable<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	return await abortable(Promise.resolve().then(fn), signal);
}
