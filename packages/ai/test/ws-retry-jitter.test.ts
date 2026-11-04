import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { AssistantMessage } from "../src/types.ts";
import { getAssistantRetryPlan, type RetryPolicy, retryAssistantCall } from "../src/utils/retry.ts";

const policy: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 10_000 };

function websocketFailure(api: "openai-responses" | "openai-codex-responses" = "openai-responses"): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: "WebSocket closed" }),
		api,
		diagnostics: [
			{
				type: "provider_transport_failure",
				timestamp: 1,
				details: { configuredTransport: "auto", retryAttempt: 1 },
			},
		],
	};
}

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("WS retry scheduling jitter", () => {
	it.each([
		["openai-responses", "auto"],
		["openai-responses", "websocket"],
		["openai-responses", "websocket-cached"],
		["openai-codex-responses", "auto"],
		["openai-codex-responses", "websocket"],
		["openai-codex-responses", "websocket-cached"],
	] as const)(
		"adds one integer sample only when scheduling %s/%s, not previewing eligibility",
		async (api, configuredTransport) => {
			vi.useFakeTimers();
			const random = vi.spyOn(Math, "random").mockReturnValue(1375 / 5001);
			const failure = websocketFailure(api);
			failure.diagnostics = [
				{ type: "provider_transport_failure", timestamp: 1, details: { configuredTransport, retryAttempt: 1 } },
			];
			for (let i = 0; i < 3; i++) expect(getAssistantRetryPlan(failure, policy, 0)?.delayMs).toBe(2000);
			expect(random).not.toHaveBeenCalled();
			const produce = vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(fauxAssistantMessage("ok"));
			const scheduled = vi.fn();
			const result = retryAssistantCall(produce, policy, undefined, { onRetryScheduled: scheduled });
			await vi.advanceTimersByTimeAsync(0);
			expect(scheduled).toHaveBeenCalledExactlyOnceWith(1, 3, 3375, "WebSocket closed");
			expect(vi.getTimerCount()).toBe(1);
			expect(random).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(3374);
			expect(produce).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect((await result).stopReason).toBe("stop");
			expect(produce).toHaveBeenCalledTimes(2);
			expect(random).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		{ jitter: 0, cap: 10_000, expected: 2000 },
		{ jitter: 5000, cap: 10_000, expected: 7000 },
		{ jitter: 1375, cap: 2500, expected: 2500 },
		{ jitter: 5000, cap: 2000, expected: 2000 },
	])("keeps integer jitter $jitter within cap $cap", async ({ jitter, cap, expected }) => {
		vi.useFakeTimers();
		const random = vi.spyOn(Math, "random").mockReturnValue(jitter / 5001);
		const produce = vi
			.fn()
			.mockResolvedValueOnce(websocketFailure())
			.mockResolvedValueOnce(fauxAssistantMessage("ok"));
		const scheduled = vi.fn();
		const result = retryAssistantCall(produce, { ...policy, maxAgentDelayMs: cap }, undefined, {
			onRetryScheduled: scheduled,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(scheduled.mock.calls[0]?.[2]).toBe(expected);
		expect(random).toHaveBeenCalledTimes(1);
		await vi.runAllTimersAsync();
		await result;
	});

	it("cancels the single jittered wait without another call", async () => {
		vi.useFakeTimers();
		const random = vi.spyOn(Math, "random").mockReturnValue(1375 / 5001);
		const controller = new AbortController();
		const produce = vi.fn(async () => websocketFailure());
		const result = retryAssistantCall(produce, policy, controller.signal);
		await vi.advanceTimersByTimeAsync(1000);
		controller.abort();
		expect((await result).stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(random).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		"ordinary SSE",
		"non-WS API",
		"disabled ordinary",
		"exhausted",
		"terminal repair",
		"fallback SSE",
		"fallback SSE with retry attempt",
		"success",
	])("does not sample for $0", async (kind) => {
		vi.useFakeTimers();
		const random = vi.spyOn(Math, "random");
		let failure = websocketFailure();
		let selected = policy;
		if (kind === "ordinary SSE" || kind === "disabled ordinary") {
			failure = { ...failure, diagnostics: undefined };
			if (kind === "disabled ordinary") selected = { ...policy, enabled: false };
		} else if (kind === "non-WS API") {
			failure.api = "anthropic-messages";
		} else if (kind === "terminal repair") {
			failure.diagnostics?.push({ type: "provider_reference_repair_terminal", timestamp: 2 });
		} else if (kind.startsWith("fallback SSE")) {
			failure.diagnostics = [
				{
					type: "provider_transport_failure",
					timestamp: 1,
					details: {
						configuredTransport: "auto",
						retryAttempt: kind === "fallback SSE" ? 0 : 1,
						fallbackTransport: "sse",
						eventsEmitted: true,
					},
				},
			];
		} else if (kind === "exhausted") {
			failure.diagnostics = [
				{
					type: "provider_transport_failure",
					timestamp: 1,
					details: { configuredTransport: "auto", retryAttempt: 4 },
				},
			];
			selected = { ...policy, maxRetries: 0 };
		} else {
			failure = fauxAssistantMessage("ok");
		}
		const produce = vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(fauxAssistantMessage("ok"));
		const scheduled = vi.fn();
		const result = retryAssistantCall(produce, selected, undefined, { onRetryScheduled: scheduled });
		await vi.runAllTimersAsync();
		await result;
		expect(random).not.toHaveBeenCalled();
		if (kind === "ordinary SSE" || kind === "non-WS API") expect(scheduled.mock.calls[0]?.[2]).toBe(2000);
		else if (kind === "fallback SSE") expect(scheduled.mock.calls[0]?.[2]).toBe(0);
		else if (kind === "fallback SSE with retry attempt") expect(scheduled.mock.calls[0]?.[2]).toBe(2000);
		else expect(scheduled).not.toHaveBeenCalled();
	});
});
