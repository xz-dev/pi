import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type PortableCompactionProjection,
	readCompactionBoundaries,
	type StoredCompactionBoundaryEntry,
	toCompactionBoundary,
} from "../../src/core/compaction/boundary.ts";
import {
	buildSessionContext,
	type CompactionBoundaryAppendState,
	type CompactionBoundaryDraft,
	type CompactionEntry,
	createExtensionSessionManagerView,
	type ProviderCheckpoint,
	type ProviderCheckpointEntry,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "../../src/core/session-manager.ts";

const timestamp = "2026-07-24T00:00:00.000Z";
const identity = {
	adapter: "openai-responses-compact-v1" as const,
	realm: "private-realm",
	provider: "private-provider",
	endpoint: "https://private-endpoint.invalid/v1",
	modelFamily: "private-model",
};

const primaryUsage: Usage = {
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	cacheWrite1h: 5,
	reasoning: 6,
	totalTokens: 25,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};
const projectionUsage: Usage = {
	input: 7,
	output: 11,
	cacheRead: 13,
	cacheWrite: 17,
	cacheWrite1h: 19,
	reasoning: 23,
	totalTokens: 48,
	cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 },
};
const combinedUsage: Usage = {
	input: 17,
	output: 13,
	cacheRead: 16,
	cacheWrite: 21,
	cacheWrite1h: 24,
	reasoning: 29,
	totalTokens: 73,
	cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 },
};
const portableProjection: PortableCompactionProjection = {
	type: "portable_compaction_projection",
	version: 1,
	customType: "test.portable",
	summary: "portable context",
	details: { marker: "portable-detail" },
	usage: projectionUsage,
};

function checkpoint(frontierEntryId: string, predecessorEntryId?: string, windowGeneration = 1): ProviderCheckpoint {
	return {
		type: "provider_checkpoint",
		version: 1,
		identity,
		frontierEntryId,
		predecessorEntryId,
		windowGeneration,
		metadata: { providerHint: "private-metadata" },
		payload: {
			id: "private-payload",
			created_at: 1,
			object: "response.compaction",
			output: [{ type: "compaction", id: "private-output", encrypted_content: "private-encrypted" }],
			usage: {
				input_tokens: 10,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens: 1,
				output_tokens_details: { reasoning_tokens: 0 },
				total_tokens: 11,
			},
		},
	};
}

function user(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function storedText(id: string, parentId: string | null, firstKeptEntryId: string): StoredCompactionBoundaryEntry {
	return {
		type: "compaction_boundary",
		id,
		parentId,
		timestamp,
		boundary: {
			version: 1,
			tokensBefore: 100,
			primary: {
				kind: "text",
				summary: "text summary",
				firstKeptEntryId,
				details: { source: "test" },
				fromExtension: false,
				usage: primaryUsage,
			},
			projections: [portableProjection],
		},
	};
}

function storedCheckpoint(id: string, parentId: string): StoredCompactionBoundaryEntry {
	return {
		type: "compaction_boundary",
		id,
		parentId,
		timestamp,
		boundary: {
			version: 1,
			tokensBefore: 1200,
			primary: { kind: "checkpoint", checkpoint: checkpoint(parentId), usage: primaryUsage },
			projections: [portableProjection],
		},
	};
}

function legacyText(id: string, parentId: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp,
		summary: "legacy summary",
		firstKeptEntryId,
		tokensBefore: 90,
		details: { legacy: true },
		fromHook: true,
		usage: primaryUsage,
	};
}

function legacyCheckpoint(id: string, parentId: string): ProviderCheckpointEntry {
	return { type: "provider_checkpoint", id, parentId, timestamp, checkpoint: checkpoint(parentId) };
}

function textMessages(
	entries: SessionEntry[],
	options?: { providerCheckpoint: { identity: typeof identity } },
): string[] {
	return buildSessionContext(entries, entries.at(-1)?.id, undefined, options).messages.map((message) => {
		if (message.role === "compactionSummary") return message.summary;
		if (!("content" in message)) return "";
		if (typeof message.content === "string") return message.content;
		return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	});
}

describe("generic compaction boundaries", () => {
	const tempPaths: string[] = [];

	afterEach(() => {
		while (tempPaths.length > 0) rmSync(tempPaths.pop()!, { recursive: true, force: true });
	});

	it("round-trips a text boundary and aggregates usage exactly", () => {
		const stored = storedText("b1", "m2", "m2");
		expect(toCompactionBoundary(stored)).toEqual({
			type: "compaction_boundary",
			id: "b1",
			parentId: "m2",
			timestamp,
			boundary: {
				id: "b1",
				parentId: "m2",
				timestamp,
				version: 1,
				kind: "text",
				tokensBefore: 100,
				text: {
					summary: "text summary",
					firstKeptEntryId: "m2",
					details: { source: "test" },
					fromExtension: false,
				},
				projections: [portableProjection],
				usage: combinedUsage,
			},
		});
	});

	it("sanitizes a checkpoint boundary without retaining private checkpoint fields", () => {
		const boundary = toCompactionBoundary(storedCheckpoint("b1", "m1"));
		expect(boundary).toEqual({
			type: "compaction_boundary",
			id: "b1",
			parentId: "m1",
			timestamp,
			boundary: {
				id: "b1",
				parentId: "m1",
				timestamp,
				version: 1,
				kind: "checkpoint",
				tokensBefore: 1200,
				projections: [portableProjection],
				usage: combinedUsage,
			},
		});
		expect(JSON.stringify(boundary)).not.toMatch(
			/provider|api|model|realm|endpoint|identity|encrypted_content|payload/i,
		);
	});

	it("adapts historical compaction and provider checkpoint rows", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-boundary-read-"));
		tempPaths.push(dir);
		const path = join(dir, "session.jsonl");
		const rows = [
			{ type: "session", version: 3, id: "session", timestamp, cwd: dir },
			user("m1", null, "one"),
			legacyText("c1", "m1", "m1"),
			legacyCheckpoint("cp1", "c1"),
		];
		writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

		expect(readCompactionBoundaries(path)).toEqual([
			expect.objectContaining({ id: "c1", boundary: expect.objectContaining({ kind: "text" }) }),
			expect.objectContaining({
				id: "cp1",
				boundary: expect.objectContaining({ kind: "checkpoint", projections: [] }),
			}),
		]);
		expect(JSON.stringify(readCompactionBoundaries(path))).not.toContain("private-encrypted");
	});

	it("uses the last ancestral reduction row across text and checkpoint kinds", () => {
		const checkpointBoundary = storedCheckpoint("b-checkpoint", "m3");
		const textThenCheckpoint: SessionEntry[] = [
			user("m1", null, "old"),
			user("m2", "m1", "kept"),
			storedText("b-text", "m2", "m2"),
			user("m3", "b-text", "between"),
			checkpointBoundary,
			user("m4", "b-checkpoint", "after checkpoint"),
		];
		const checkpointThenText: SessionEntry[] = [
			user("m1", null, "old"),
			legacyCheckpoint("cp1", "m1"),
			user("m2", "cp1", "kept"),
			storedText("b-text", "m2", "m2"),
			user("m3", "b-text", "after text"),
		];

		expect(textMessages(textThenCheckpoint, { providerCheckpoint: { identity } })).toEqual([
			"portable context",
			"after checkpoint",
		]);
		expect(textMessages(checkpointThenText, { providerCheckpoint: { identity } })).toEqual([
			"text summary",
			"portable context",
			"kept",
			"after text",
		]);
	});

	it("falls back to intact history for malformed and incompatible checkpoints while preserving projections", () => {
		const malformed = storedCheckpoint("b1", "m2");
		(malformed.boundary.primary as { checkpoint: { version: number } }).checkpoint.version = 99;
		const incompatible = storedCheckpoint("b2", "m3");
		(incompatible.boundary.primary as { checkpoint: ProviderCheckpoint }).checkpoint.identity = {
			...identity,
			realm: "other-private-realm",
		};
		const entries: SessionEntry[] = [
			user("m1", null, "one"),
			user("m2", "m1", "two"),
			malformed,
			user("m3", "b1", "three"),
			incompatible,
			user("m4", "b2", "four"),
		];

		expect(textMessages(entries, { providerCheckpoint: { identity } })).toEqual([
			"one",
			"two",
			"three",
			"portable context",
			"four",
		]);
	});

	it("ignores unknown JSON-loaded boundary versions without throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-boundary-version-"));
		tempPaths.push(dir);
		const path = join(dir, "session.jsonl");
		const unknown = storedText("b1", "m1", "m1") as unknown as { boundary: { version: number } };
		unknown.boundary.version = 2;
		writeFileSync(
			path,
			`${[{ type: "session", version: 3, id: "session", timestamp, cwd: dir }, user("m1", null, "one"), unknown]
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);

		expect(() => readCompactionBoundaries(path)).not.toThrow();
		expect(readCompactionBoundaries(path)).toEqual([]);
	});

	it("fails safe for malformed loaded boundaries across context and every extension reader", () => {
		const malformedRows: unknown[] = [
			{ ...storedText("bad-outer", "m1", "m1"), unexpected: "private-sentinel" },
			{ ...storedText("bad-boundary", "m1", "m1"), boundary: { version: 2 } },
			{
				...storedText("bad-text", "m1", "m1"),
				boundary: {
					...storedText("x", "m1", "m1").boundary,
					primary: { kind: "text", summary: "", firstKeptEntryId: "m1", fromExtension: false },
				},
			},
			{
				...storedCheckpoint("bad-checkpoint", "m1"),
				boundary: {
					...storedCheckpoint("x", "m1").boundary,
					primary: { kind: "checkpoint", checkpoint: { private: "private-sentinel" } },
				},
			},
			{
				...storedText("bad-projection", "m1", "m1"),
				boundary: {
					...storedText("x", "m1", "m1").boundary,
					projections: [
						{ type: "portable_compaction_projection", version: 1, customType: "", summary: "private-sentinel" },
					],
				},
			},
			{
				...storedText("bad-usage", "m1", "m1"),
				boundary: {
					...storedText("x", "m1", "m1").boundary,
					primary: { ...storedText("x", "m1", "m1").boundary.primary, usage: { input: Number.POSITIVE_INFINITY } },
				},
			},
		];
		for (const [index, malformed] of malformedRows.entries()) {
			const dir = mkdtempSync(join(tmpdir(), `pi-malformed-boundary-${index}-`));
			tempPaths.push(dir);
			const path = join(dir, "session.jsonl");
			const rows = [
				{ type: "session", version: 3, id: `session-${index}`, timestamp, cwd: dir },
				user("m1", null, "intact portable history"),
				malformed,
			];
			writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
			const manager = SessionManager.open(path);
			expect(textMessages(manager.getEntries())).toContain("intact portable history");
			const view = createExtensionSessionManagerView(manager);
			const publicValues = [
				view.getEntries(),
				view.getBranch(),
				view.buildContextEntries(),
				view.getTree(),
				view.getEntry("m1"),
				view.getLeafEntry(),
			];
			expect(() => JSON.stringify(publicValues)).not.toThrow();
			expect(JSON.stringify(publicValues)).not.toContain("private-sentinel");
			expect(readCompactionBoundaries(path)).toEqual([]);
		}
	});

	it("resets a checkpoint chain after a superseding text boundary", () => {
		const manager = SessionManager.inMemory();
		const firstFrontier = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const firstExpected = manager.captureCompactionBoundaryAppendState();
		const firstCheckpointId = manager.appendCompactionBoundary(
			{
				version: 1,
				tokensBefore: 100,
				primary: { kind: "checkpoint", checkpoint: checkpoint(firstFrontier) },
				projections: [],
			},
			{ expected: firstExpected, currentCheckpointIdentity: identity },
		);
		const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		manager.appendCompactionBoundary(
			{
				version: 1,
				tokensBefore: 80,
				primary: { kind: "text", summary: "text reset", firstKeptEntryId: keptId, fromExtension: false },
				projections: [],
			},
			{ expected: manager.captureCompactionBoundaryAppendState() },
		);
		const frontier = manager.appendMessage({ role: "user", content: "after text", timestamp: 3 });
		const nextId = manager.appendCompactionBoundary(
			{
				version: 1,
				tokensBefore: 60,
				primary: { kind: "checkpoint", checkpoint: checkpoint(frontier) },
				projections: [],
			},
			{ expected: manager.captureCompactionBoundaryAppendState(), currentCheckpointIdentity: identity },
		);
		const next = manager.getEntry(nextId);
		expect(next?.type).toBe("compaction_boundary");
		if (next?.type !== "compaction_boundary" || next.boundary.primary.kind !== "checkpoint")
			throw new Error("checkpoint missing");
		expect(next.boundary.primary.checkpoint).toMatchObject({ windowGeneration: 1, predecessorEntryId: undefined });
		expect(firstCheckpointId).not.toBe(nextId);
	});

	it("rejects text boundaries whose first kept entry is not an earlier active ancestor", () => {
		const manager = SessionManager.inMemory();
		const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const siblingId = manager.appendMessage({ role: "user", content: "sibling", timestamp: 2 });
		manager.branch(rootId);
		const activeId = manager.appendMessage({ role: "user", content: "active", timestamp: 3 });
		const expected = manager.captureCompactionBoundaryAppendState();
		const textDraft = (firstKeptEntryId: string): CompactionBoundaryDraft => ({
			version: 1,
			tokensBefore: 100,
			primary: {
				kind: "text",
				summary: "summary",
				firstKeptEntryId,
				fromExtension: true,
			},
			projections: [],
		});

		expect(() => manager.appendCompactionBoundary(textDraft(siblingId), { expected })).toThrow(/ancestr/i);
		expect(() => manager.appendCompactionBoundary(textDraft("future-entry"), { expected })).toThrow(/not found/i);
		expect(manager.getLeafId()).toBe(activeId);
		expect(manager.getEntries().filter((entry) => entry.type === "compaction_boundary")).toHaveLength(0);
	});

	it("appends one cloned boundary row and rejects stale expected state atomically", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-boundary-append-"));
		tempPaths.push(dir);
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "frontier" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: primaryUsage,
			stopReason: "stop",
			timestamp: 1,
		});
		const expected: CompactionBoundaryAppendState = manager.captureCompactionBoundaryAppendState();
		const draft: CompactionBoundaryDraft = {
			version: 1,
			tokensBefore: 1200,
			primary: { kind: "checkpoint", checkpoint: checkpoint(manager.getLeafId()!), usage: primaryUsage },
			projections: [portableProjection],
		};
		const boundaryId = manager.appendCompactionBoundary(draft, { expected, currentCheckpointIdentity: identity });
		(draft.projections[0].details as { marker: string }).marker = "mutated";
		(
			(draft.primary as { checkpoint: ProviderCheckpoint }).checkpoint.payload.output[0] as {
				encrypted_content: string;
			}
		).encrypted_content = "mutated";

		const stored = manager.getEntry(boundaryId) as StoredCompactionBoundaryEntry;
		expect(stored.boundary.projections[0].details).toEqual({ marker: "portable-detail" });
		expect(JSON.stringify(stored)).toContain("private-encrypted");
		expect(manager.getEntries().filter((entry) => entry.type === "compaction_boundary")).toHaveLength(1);
		expect(manager.getEntries().filter((entry) => entry.type === "provider_checkpoint")).toHaveLength(0);
		expect(readFileSync(manager.getSessionFile()!, "utf8").match(/"type":"compaction_boundary"/g)).toHaveLength(1);

		const before = structuredClone(manager.getEntries());
		expect(() => manager.appendCompactionBoundary(draft, { expected })).toThrow(/version/i);
		expect(manager.getEntries()).toEqual(before);
	});

	it("leaves memory and JSONL unchanged when a boundary append cannot be persisted", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-boundary-write-failure-"));
		tempPaths.push(dir);
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "frontier" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: primaryUsage,
			stopReason: "stop",
			timestamp: 1,
		});
		const sessionFile = manager.getSessionFile()!;
		const memoryBefore = structuredClone(manager.getEntries());
		const leafBefore = manager.getLeafId();
		const diskBefore = readFileSync(sessionFile, "utf8");
		const expected = manager.captureCompactionBoundaryAppendState();
		const draft: CompactionBoundaryDraft = {
			version: 1,
			tokensBefore: 1200,
			primary: { kind: "checkpoint", checkpoint: checkpoint(leafBefore!), usage: primaryUsage },
			projections: [portableProjection],
		};

		const displacedFile = `${sessionFile}.displaced`;
		renameSync(sessionFile, displacedFile);
		mkdirSync(sessionFile);
		try {
			expect(() =>
				manager.appendCompactionBoundary(draft, { expected, currentCheckpointIdentity: identity }),
			).toThrow();
		} finally {
			rmSync(sessionFile, { recursive: true });
			renameSync(displacedFile, sessionFile);
		}
		expect(manager.getEntries()).toEqual(memoryBefore);
		expect(manager.getLeafId()).toBe(leafBefore);
		expect(readFileSync(sessionFile, "utf8")).toBe(diskBefore);
		expect(manager.getEntries().some((entry) => entry.type === "compaction_boundary")).toBe(false);
	});
});
