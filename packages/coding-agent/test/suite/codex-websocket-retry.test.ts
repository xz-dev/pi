import {
	closeOpenAICodexWebSocketSessions,
	resetOpenAICodexWebSocketDebugStats,
	stream,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const apiKey = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } })).toString("base64")}.bbb`;
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// Exercise the real transport parser behind a faux-authenticated session. All WS/HTTP
// operations are intercepted; these tests never use provider credentials or the network.
function installFailingTransport(harness: Harness, partial: boolean, protocolRepairProbe = false) {
	const sent: Record<string, unknown>[] = [];
	const payloads: unknown[] = [];
	class Socket extends EventTarget {
		readyState = 1;
		constructor() {
			super();
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		send(body: string) {
			sent.push(JSON.parse(body));
			queueMicrotask(() => {
				if (protocolRepairProbe && sent.length === 5) {
					for (const data of [
						{ type: "response.created", response: { id: "probe" } },
						{ type: "error", code: "previous_response_not_found" },
					])
						this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(data) }));
					return;
				}
				if (partial && !(protocolRepairProbe && sent.length === 6)) {
					for (const data of [
						{ type: "response.created", response: { id: "interrupted" } },
						{
							type: "response.output_item.added",
							item: { type: "message", id: "msg", role: "assistant", content: [] },
						},
						{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
						{ type: "response.output_text.delta", delta: "discarded partial" },
					])
						this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(data) }));
				}
				this.dispatchEvent(Object.assign(new Event("error"), { message: "socket dropped" }));
			});
		}
		close() {
			this.readyState = 3;
		}
	}
	const fetchMock = vi.fn(async () => new Response("Service unavailable", { status: 503 }));
	vi.stubGlobal("WebSocket", Socket);
	vi.stubGlobal("fetch", fetchMock);
	harness.session.agent.transport = harness.settingsManager.getTransport();
	harness.session.agent.sessionId = harness.session.sessionId;
	harness.session.agent.streamFunction = (model, context, options) =>
		stream({ ...model, api: "openai-codex-responses" }, context, {
			...options,
			apiKey,
			onPayload: (body) => {
				payloads.push(body);
			},
		});
	return { sent, fetchMock, payloads };
}

describe("Codex retries through Pi settings", () => {
	it.each([false, true])(
		"uses fixed auto WS retries and an independent SSE budget with enabled=%s",
		async (enabled) => {
			const harness = await createHarness({
				settings: { transport: "auto", retry: { enabled, maxRetries: 1, baseDelayMs: 10, maxAgentDelayMs: 15 } },
			});
			harnesses.push(harness);
			const { sent, fetchMock } = installFailingTransport(harness, true);
			vi.useFakeTimers();
			const request = harness.session.prompt("Keep this user input");
			await vi.advanceTimersByTimeAsync(100);
			await request;
			expect(sent).toHaveLength(4);
			expect(fetchMock).toHaveBeenCalledTimes(enabled ? 2 : 1);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual(
				enabled ? [10, 15, 15, 0, 10] : [10, 15, 15, 0],
			);
			expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual(
				enabled ? [true, true, true, true, true, false] : [true, true, true, true, false],
			);
			expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
			expect(
				harness.session.messages.some(
					(message) =>
						message.role === "assistant" && JSON.stringify(message.content).includes("discarded partial"),
				),
			).toBe(false);
			expect(sent.every((body) => body.previous_response_id === undefined)).toBe(true);
			expect(sent.every((body) => !JSON.stringify(body.input).includes("discarded partial"))).toBe(true);
			expect(
				harness.sessionManager
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							JSON.stringify(entry.message.content).includes("discarded partial"),
					),
			).toHaveLength(4);
			expect(harness.session.retryAttempt).toBe(0);
			expect(harness.session.isIdle).toBe(true);
		},
	);

	it.each(["websocket", "websocket-cached"] as const)(
		"honors global attempts for explicit %s without SSE",
		async (transport) => {
			const harness = await createHarness({
				settings: { transport, retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
			});
			harnesses.push(harness);
			const { sent, fetchMock } = installFailingTransport(harness, false);
			await harness.session.prompt("test");
			expect(sent).toHaveLength(2);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		},
	);

	it("ends a started cooldown probe before its repaired socket failure switches to SSE", async () => {
		const harness = await createHarness({
			settings: { transport: "auto", retry: { enabled: false, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		const { sent, fetchMock, payloads } = installFailingTransport(harness, true, true);
		fetchMock.mockImplementation(
			async () =>
				new Response(
					`data: ${JSON.stringify({
						type: "response.completed",
						response: { id: "sse", status: "completed" },
					})}\n\n`,
				),
		);
		vi.useFakeTimers();
		const initial = harness.session.prompt("First request");
		await vi.advanceTimersByTimeAsync(100);
		await initial;
		await vi.advanceTimersByTimeAsync(300_000);
		const probe = harness.session.prompt("Probe request");
		await vi.advanceTimersByTimeAsync(100);
		await probe;
		expect(sent).toHaveLength(6);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(5);
		expect(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error",
				),
		).toHaveLength(5);
		expect(payloads.every((body) => !JSON.stringify(body).includes("discarded partial"))).toBe(true);
		expect(
			harness.session.messages.some(
				(message) => message.role === "assistant" && JSON.stringify(message.content).includes("discarded partial"),
			),
		).toBe(false);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});

	it("cancels auto recovery synchronously from retry notification even with global retry disabled", async () => {
		const harness = await createHarness({
			settings: { transport: "auto", retry: { enabled: false, baseDelayMs: 60_000 } },
		});
		harnesses.push(harness);
		const { sent, fetchMock } = installFailingTransport(harness, false);
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") harness.session.abortRetry();
		});
		await harness.session.prompt("test");
		expect(sent).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({
			success: false,
			finalError: "Retry cancelled",
		});
		expect(harness.session.isIdle).toBe(true);
	});
});
