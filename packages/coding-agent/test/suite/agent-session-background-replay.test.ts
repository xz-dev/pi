import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../../../ai/src/api/openai-responses.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

describe("AgentSession background response ownership", () => {
	it.each(["overflow", "length"])(
		"compacts and resumes a native background %s terminal through the existing policy",
		async (kind) => {
			const harness = await createHarness({
				models: [{ id: "background-agent", contextWindow: 10000, maxTokens: 1000 }],
				settings: {
					retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
					compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => ({
							compaction: {
								summary: "compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
					},
				],
			});
			harnesses.push(harness);
			let laterTurn = false;
			let posts = 0;
			const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
				const request = new Request(input, init);
				expect(request.method).toBe("POST");
				expect(await request.json()).toMatchObject({ background: true, store: true });
				posts++;
				const response = {
					id: laterTurn ? "resp_later" : posts > 1 ? "resp_recovered" : "resp_owned",
					status: "in_progress",
					output: [],
				};
				const item = {
					type: "message",
					id: "msg_owned",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "prefix", annotations: [] }],
				};
				const terminal =
					laterTurn || posts > 1
						? { type: "response.completed", response: { ...response, status: "completed", output: [item] } }
						: kind === "length"
							? {
									type: "response.incomplete",
									response: {
										...response,
										status: "incomplete",
										incomplete_details: { reason: "max_output_tokens" },
										output: [item],
										usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
									},
								}
							: {
									type: "response.failed",
									response: {
										...response,
										status: "failed",
										error: {
											code: "context_length_exceeded",
											message: "maximum context length exceeded; 503 overloaded",
										},
									},
								};
				const events = [
					{ type: "response.created", response },
					{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
					{ type: "response.output_text.delta", output_index: 0, delta: "prefix" },
					{ type: "response.output_item.done", output_index: 0, item },
					terminal,
				].map((event, sequence_number) => ({ ...event, sequence_number }));
				return new Response(
					events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			});
			harness.session.agent.streamFunction = (requestModel, requestContext, options) =>
				stream({ ...requestModel, api: "openai-responses", baseUrl: "http://127.0.0.1:1/v1" }, requestContext, {
					...options,
					apiKey: "sk-dummy",
					transport: "sse",
					responseReplay: true,
					fetch: fetchMock,
					maxRetries: 3,
					onPayload: (payload) => ({ ...(payload as Record<string, unknown>), background: true, store: true }),
				});
			await harness.session.prompt("one owned response");
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
			expect(harness.session.messages.findLast((message) => message.role === "assistant")).toMatchObject({
				stopReason: "stop",
				responseId: "resp_recovered",
			});
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "context_edit")).toHaveLength(1);
			laterTurn = true;
			await harness.session.prompt("explicit new turn");
			expect(fetchMock).toHaveBeenCalledTimes(3);
			expect(harness.session.messages.findLast((message) => message.role === "assistant")).toMatchObject({
				stopReason: "stop",
				responseId: "resp_later",
			});
			expect(harness.faux.state.callCount).toBe(0);
		},
	);
});
