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
import {
	buildSessionProjection,
	type CompactionEntry,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";

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

	it.each(["before", "after"] as const)(
		"adopts retained history when compaction is %s kept entries, without adopting later takeovers",
		(position) => {
			const retained: SessionMessageEntry = {
				type: "message",
				id: "retained",
				parentId: position === "before" ? "summary" : null,
				timestamp: "2026-10-23T00:00:00.000Z",
				message: { ...assistantWithCheckpoint(), responseAncestry: "server-dependent" },
			};
			const summary: CompactionEntry = {
				type: "compaction",
				id: "summary",
				parentId: position === "before" ? null : retained.id,
				timestamp: "2026-10-23T00:00:00.001Z",
				summary: "adopted summary",
				firstKeptEntryId: retained.id,
				tokensBefore: 100,
			};
			const concurrent: SessionMessageEntry = {
				...retained,
				id: "concurrent-takeover",
				parentId: position === "before" ? retained.id : summary.id,
				timestamp: summary.timestamp,
			};
			const later: SessionMessageEntry = {
				...retained,
				id: "later-takeover",
				parentId: concurrent.id,
				timestamp: "2026-10-23T00:00:00.002Z",
			};
			const entries =
				position === "before" ? [summary, retained, concurrent, later] : [retained, summary, concurrent, later];
			const original = JSON.stringify(entries);
			const assistants = buildSessionProjection(entries).messages.filter((message) => message.role === "assistant");
			expect(assistants).toHaveLength(3);
			expect(assistants[0]).toMatchObject({ responseAncestry: "local" });
			expect(assistants[0].responseCheckpoint).toBeUndefined();
			expect(assistants[0].responseId).toBeUndefined();
			expect(assistants.slice(1)).toEqual([concurrent.message, later.message]);
			expect(JSON.stringify(entries)).toBe(original);
		},
	);

	it.each(["2026-10-23T00:00:00.001Z", undefined, "not-a-timestamp", "2026-10-23T00:00:00.002Z"])(
		"stops retained adoption at timestamp %s, including any older entries after it",
		(timestamp) => {
			const summary: CompactionEntry = {
				type: "compaction",
				id: "summary",
				parentId: null,
				timestamp: "2026-10-23T00:00:00.001Z",
				summary: "adopted summary",
				firstKeptEntryId: "stop",
				tokensBefore: 100,
			};
			const stop: SessionMessageEntry = {
				type: "message",
				id: "stop",
				parentId: summary.id,
				timestamp: timestamp ?? "",
				message: { ...assistantWithCheckpoint(), responseAncestry: "server-dependent" },
			};
			if (timestamp === undefined) Reflect.deleteProperty(stop, "timestamp");
			const older: SessionMessageEntry = {
				...stop,
				id: "older-after-stop",
				parentId: stop.id,
				timestamp: "2026-10-23T00:00:00.000Z",
			};
			const entries = [summary, stop, older];
			const original = JSON.stringify(entries);
			const assistants = buildSessionProjection(entries).messages.filter((message) => message.role === "assistant");
			expect(assistants).toEqual([stop.message, older.message]);
			expect(JSON.stringify(entries)).toBe(original);
		},
	);

	it("keeps a newly appended takeover dependent after wall clock rolls back", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-10-23T00:00:10.000Z"));
			const session = SessionManager.inMemory();
			const retainedId = session.appendMessage({ role: "user", content: "retained", timestamp: 0 });
			session.appendCompaction("summary only of retained history", retainedId, 100);
			vi.setSystemTime(new Date("2026-10-23T00:00:09.000Z"));
			const takeover = {
				...assistantWithCheckpoint(),
				responseAncestry: "server-dependent" as const,
				responseId: "external-dependent",
			};
			session.appendMessage(takeover);
			const projected = session.buildSessionProjection().messages.find((message) => message.role === "assistant");
			expect(projected).toMatchObject({ responseAncestry: "server-dependent", responseId: "external-dependent" });
			expect(projected).toEqual(takeover);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not adopt a cold-loaded legacy post-summary takeover whose clock went backwards", () => {
		const takeover: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "new server-dependent takeover" }],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			responseId: "external-dependent",
			responseAncestry: "server-dependent",
			stopReason: "stop",
			timestamp: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "kept",
				parentId: null,
				timestamp: "2026-10-23T00:00:10.000Z",
				message: { role: "user", content: "retained", timestamp: 0 },
			},
			{
				type: "compaction",
				id: "summary",
				parentId: "kept",
				timestamp: "2026-10-23T00:00:10.000Z",
				firstKeptEntryId: "kept",
				summary: "summary only of retained history",
				tokensBefore: 100,
			},
			{
				type: "message",
				id: "takeover",
				parentId: "summary",
				timestamp: "2026-10-23T00:00:09.000Z",
				message: takeover,
			},
		];
		const original = JSON.stringify(entries);
		const projected = buildSessionProjection(JSON.parse(original)).messages.find(
			(message) => message.role === "assistant",
		);
		expect(projected).toMatchObject({ responseAncestry: "server-dependent", responseId: "external-dependent" });
		expect(JSON.stringify(entries)).toBe(original);
	});

	it.each(["retained", "later", "off-path", "missing"])(
		"adopts a post-summary run only when firstKept %s matches its start on the selected path",
		(firstKeptEntryId) => {
			const summary: CompactionEntry = {
				type: "compaction",
				id: "summary",
				parentId: null,
				timestamp: "2026-10-23T00:00:10.000Z",
				firstKeptEntryId,
				summary: "adopted summary",
				tokensBefore: 100,
			};
			const retained: SessionMessageEntry = {
				type: "message",
				id: "retained",
				parentId: summary.id,
				timestamp: "2026-10-23T00:00:09.000Z",
				message: { ...assistantWithCheckpoint(), responseAncestry: "server-dependent" },
			};
			const later: SessionMessageEntry = {
				...retained,
				id: "later",
				parentId: retained.id,
				timestamp: summary.timestamp,
			};
			const offPath: SessionMessageEntry = { ...retained, id: "off-path", parentId: null };
			const entries = [summary, retained, later, offPath];
			const original = JSON.stringify(entries);
			const projection = buildSessionProjection(entries, later.id);
			const assistants = projection.messages.filter((message) => message.role === "assistant");
			expect(assistants).toHaveLength(2);
			if (firstKeptEntryId === retained.id) {
				expect(assistants[0]).toMatchObject({ responseAncestry: "local" });
				expect(assistants[0].responseCheckpoint).toBeUndefined();
				expect(assistants[0].responseId).toBeUndefined();
			} else {
				expect(assistants[0]).toEqual(retained.message);
			}
			expect(assistants[1]).toEqual(later.message);
			expect(projection.entries.find((entry) => entry.sourceEntry.id === retained.id)?.sourceEntry).toBe(retained);
			expect(JSON.stringify(entries)).toBe(original);
		},
	);

	it.each(["writer", "reopen"] as const)(
		"keeps a later takeover dependent after compaction and clock rollback through %s",
		(mode) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-ancestry-clock-"));
			vi.useFakeTimers();
			try {
				vi.setSystemTime(new Date("2026-10-23T00:00:10.000Z"));
				let session = SessionManager.create(dir, dir);
				const retainedId = session.appendMessage({
					...assistantWithCheckpoint(),
					responseAncestry: "server-dependent",
				});
				session.appendCompaction("summary only of retained history", retainedId, 100);
				if (mode === "reopen") session = SessionManager.open(session.getSessionFile()!, dir);
				vi.setSystemTime(new Date("2026-10-23T00:00:09.000Z"));
				const takeover = {
					...assistantWithCheckpoint(),
					responseAncestry: "server-dependent" as const,
					responseId: "external-dependent",
				};
				session.appendMessage(takeover);
				const original = readFileSync(session.getSessionFile()!, "utf8");
				const assistants = session
					.buildSessionProjection()
					.messages.filter((message) => message.role === "assistant");
				expect(assistants).toHaveLength(2);
				expect(assistants[0]).toMatchObject({ responseAncestry: "local" });
				expect(assistants[0].responseId).toBeUndefined();
				expect(assistants[1]).toMatchObject({
					responseAncestry: "server-dependent",
					responseId: "external-dependent",
				});
				expect(assistants[1]).toEqual(takeover);
				expect(readFileSync(session.getSessionFile()!, "utf8")).toBe(original);
			} finally {
				vi.useRealTimers();
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
