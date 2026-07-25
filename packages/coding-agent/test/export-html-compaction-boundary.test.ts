import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import type { CompactionBoundaryDraft, ProviderCheckpoint } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const cleanup: string[] = [];

function decodeSessionData(html: string): unknown {
	const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	if (!encoded) throw new Error("exported session data missing");
	return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

describe("export HTML compaction boundaries", () => {
	afterEach(() => {
		while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
	});

	it("exports a sanitized checkpoint boundary without private checkpoint sentinels", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-export-boundary-"));
		cleanup.push(dir);
		mkdirSync(dir, { recursive: true });
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "portable history", timestamp: 1 });
		const frontier = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "portable answer" }],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const identity = {
			adapter: "openai-responses-compact-v1" as const,
			realm: "private-realm-sentinel",
			provider: "private-provider-sentinel",
			endpoint: "https://private-endpoint-sentinel.invalid/v1",
			modelFamily: "private-model-sentinel",
		};
		const checkpoint: ProviderCheckpoint = {
			type: "provider_checkpoint",
			version: 1,
			identity,
			frontierEntryId: frontier,
			windowGeneration: 1,
			metadata: { private: "private-metadata-sentinel" },
			payload: {
				id: "private-payload-sentinel",
				created_at: 1,
				object: "response.compaction",
				output: [{ type: "compaction", id: "private-output", encrypted_content: "private-encrypted-sentinel" }],
				usage: {
					input_tokens: 1,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 1,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 2,
				},
			},
		};
		const draft: CompactionBoundaryDraft = {
			version: 1,
			tokensBefore: 10,
			primary: { kind: "checkpoint", checkpoint },
			projections: [
				{
					type: "portable_compaction_projection",
					version: 1,
					customType: "test.export",
					summary: "portable projection",
				},
			],
		};
		manager.appendCompactionBoundary(draft, {
			expected: manager.captureCompactionBoundaryAppendState(),
			currentCheckpointIdentity: identity,
		});
		const output = join(dir, "session.html");

		await exportSessionToHtml(manager, undefined, { outputPath: output });

		const serialized = JSON.stringify(decodeSessionData(readFileSync(output, "utf8")));
		expect(serialized).toContain("compaction_boundary");
		expect(serialized).toContain("portable projection");
		for (const sentinel of [
			identity.realm,
			identity.provider,
			identity.endpoint,
			identity.modelFamily,
			"private-metadata-sentinel",
			"private-payload-sentinel",
			"private-encrypted-sentinel",
		]) {
			expect(serialized).not.toContain(sentinel);
		}
	});
});
