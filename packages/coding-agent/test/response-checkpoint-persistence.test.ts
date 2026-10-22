/**
 * JSONL persistence for AssistantMessage.responseCheckpoint: the v1 metadata
 * survives SessionManager append + reopen so a new SDK connection can plan a
 * durable delta from reloaded history. The field is carried opaquely — coding-
 * agent plumbing (settings → options) is a later slice.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { closeOpenAIResponsesWebSocketSessions, stream } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function assistantWithCheckpoint(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "stored turn" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.5",
		responseId: "resp_srv_1",
		responseCheckpoint: {
			version: 1,
			scopeHash: "a".repeat(64),
			requestHash: "b".repeat(64),
			prefixHash: "c".repeat(64),
			inputCount: 2,
			createdAt: 1_760_000_000_000,
			expiresAt: 1_760_000_060_000,
		},
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_760_000_000_000,
	};
}

describe("response ancestry projection and persistence", () => {
	afterEach(() => {
		closeOpenAIResponsesWebSocketSessions();
		vi.unstubAllGlobals();
	});

	it.each(["local", "server-dependent"] as const)(
		"JSONL, branch export and plain fork preserve %s ancestry without rewriting originals",
		(responseAncestry) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-ancestry-session-"));
			try {
				const session = SessionManager.create(dir, dir);
				const message = { ...assistantWithCheckpoint(), responseAncestry };
				const id = session.appendMessage(message);
				const original = readFileSync(session.getSessionFile()!, "utf8");
				const restored = SessionManager.open(session.getSessionFile()!, dir);
				expect(restored.buildSessionContext().messages[0]).toHaveProperty("responseAncestry", responseAncestry);
				const forked = SessionManager.forkFrom(session.getSessionFile()!, dir, dir);
				expect(forked.buildSessionContext().messages[0]).toHaveProperty("responseAncestry", responseAncestry);
				forked.createBranchedSession(id);
				expect(SessionManager.open(forked.getSessionFile()!, dir).buildSessionContext().messages[0]).toHaveProperty(
					"responseAncestry",
					responseAncestry,
				);
				expect(readFileSync(session.getSessionFile()!, "utf8")).toBe(original);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it.each(["compaction", "branch-summary"] as const)(
		"%s adopts retained dependent assistant only in projected copies; later takeover survives reload",
		async (boundary) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-ancestry-rebase-"));
			const sent: Record<string, unknown>[] = [];
			class Socket extends EventTarget {
				readyState = 1;
				constructor() {
					super();
					queueMicrotask(() => this.dispatchEvent(new Event("open")));
				}
				send(data: string): void {
					const frame = JSON.parse(data) as Record<string, unknown>;
					sent.push(frame);
					queueMicrotask(() => {
						const id = `resp_${sent.length}`;
						const item = {
							type: "message",
							id: `msg_${sent.length}`,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "answer", annotations: [] }],
						};
						for (const event of [
							{ type: "response.created", response: { id } },
							{ type: "response.output_item.done", output_index: 0, item },
							{ type: "response.completed", response: { id, status: "completed", store: true, output: [item] } },
						])
							this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
					});
				}
				close(): void {
					this.readyState = 3;
				}
			}
			vi.stubGlobal("WebSocket", Socket);
			const fetchMock = vi.fn<typeof fetch>();
			vi.stubGlobal("fetch", fetchMock);
			const model: Model<"openai-responses"> = {
				id: "gpt-5.5",
				name: "test",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 128000,
			};
			const options = { apiKey: "sk-offline", sessionId: "summary-session" };
			try {
				const session = SessionManager.create(dir, dir);
				session.appendMessage({ role: "user", content: "old input", timestamp: 1 });
				const oldLocal = await stream(
					model,
					normalizeContext({ messages: convertToLlm(session.buildSessionContext().messages) }),
					options,
				).result();
				expect(oldLocal.responseCheckpoint).toBeDefined();
				session.appendMessage(oldLocal);
				session.appendMessage({ role: "user", content: "old takeover", timestamp: 2 });
				const retained = await stream(
					model,
					normalizeContext({ messages: convertToLlm(session.buildSessionContext().messages) }),
					{
						...options,
						onPayload: (payload) => ({
							...(payload as Record<string, unknown>),
							previous_response_id: "external",
						}),
					},
				).result();
				expect(retained.responseAncestry).toBe("server-dependent");
				const retainedJson = JSON.stringify(retained);
				const retainedId = session.appendMessage(retained);
				if (boundary === "compaction") session.appendCompaction("adopted summary", retainedId, 100);
				else session.branchWithSummary(retainedId, "adopted summary");
				session.appendMessage({ role: "user", content: "new work", timestamp: 2 });
				const restored = SessionManager.open(session.getSessionFile()!, dir);
				const projected = restored.buildSessionProjection();
				expect(
					projected.messages
						.filter((m) => m.role === "assistant")
						.every(
							(m) =>
								m.responseAncestry === "local" &&
								m.responseCheckpoint === undefined &&
								m.responseId === undefined,
						),
				).toBe(true);
				expect((restored.getEntry(retainedId) as { message: AssistantMessage }).message.responseAncestry).toBe(
					"server-dependent",
				);
				expect(JSON.stringify((restored.getEntry(retainedId) as { message: AssistantMessage }).message)).toBe(
					retainedJson,
				);
				const local = await stream(
					model,
					normalizeContext({ messages: convertToLlm(projected.messages) }),
					options,
				).result();
				expect(local.stopReason).toBe("stop");
				expect(local.responseAncestry).toBe("local");
				expect(local.responseCheckpoint).toBeDefined();
				expect(sent[2].previous_response_id).toBeUndefined();
				expect(JSON.stringify(sent[2])).toContain("adopted summary");
				expect(JSON.stringify(sent[2])).toContain("answer");
				restored.appendMessage(local);
				restored.appendMessage({ role: "user", content: "takeover", timestamp: 3 });
				const caller = await stream(
					model,
					normalizeContext({ messages: convertToLlm(restored.buildSessionContext().messages) }),
					{
						...options,
						onPayload: (payload) => ({
							...(payload as Record<string, unknown>),
							previous_response_id: "external",
						}),
					},
				).result();
				expect(caller.responseAncestry).toBe("server-dependent");
				expect(caller.responseCheckpoint).toBeUndefined();
				restored.appendMessage(caller);
				restored.appendMessage({ role: "user", content: "after takeover", timestamp: 4 });
				const next = normalizeContext({ messages: convertToLlm(restored.buildSessionContext().messages) });
				const descendant = await stream(model, next, options).result();
				expect(descendant.responseAncestry).toBe("server-dependent");
				expect(descendant.responseCheckpoint).toBeUndefined();
				expect(sent[4].previous_response_id).toBe(caller.responseId);
				closeOpenAIResponsesWebSocketSessions();
				const cold = SessionManager.open(restored.getSessionFile()!, dir);
				const failed = await stream(
					model,
					normalizeContext({ messages: convertToLlm(cold.buildSessionContext().messages) }),
					options,
				).result();
				expect(failed.stopReason).toBe("error");
				expect(sent).toHaveLength(5);
				expect(JSON.stringify(sent)).not.toContain("responseAncestry");
				expect(fetchMock).not.toHaveBeenCalled();
				expect(retained.responseAncestry).toBe("server-dependent");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("responseCheckpoint JSONL persistence", () => {
	it("survives SessionManager write + reopen through buildSessionContext", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-session-"));
		try {
			const session = SessionManager.create(dir);
			session.appendMessage({ role: "user", content: "Hello", timestamp: 1 });
			session.appendMessage(assistantWithCheckpoint());
			const filePath = session.getSessionFile()!;
			expect(filePath).toBeTruthy();

			const reopened = SessionManager.open(filePath);
			const ctx = reopened.buildSessionContext();
			const assistant = ctx.messages.find((m) => m.role === "assistant") as AssistantMessage | undefined;
			expect(assistant).toBeDefined();
			expect(assistant!.responseId).toBe("resp_srv_1");
			expect(assistant!.responseCheckpoint).toEqual(assistantWithCheckpoint().responseCheckpoint);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
