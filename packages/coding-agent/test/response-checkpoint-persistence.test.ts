/**
 * JSONL persistence for AssistantMessage.responseCheckpoint: the v1 metadata
 * survives SessionManager append + reopen so a new SDK connection can plan a
 * durable delta from reloaded history. The field is carried opaquely — coding-
 * agent plumbing (settings → options) is a later slice.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
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
