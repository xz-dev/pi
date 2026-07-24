import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { OpenAIResponsesCheckpointIdentity } from "@earendil-works/pi-ai/api/openai-responses";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSessionContext,
	type ProviderCheckpoint,
	type ProviderCheckpointEntry,
	type SessionContext,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "../../src/core/session-manager.ts";

const STABLE_COMPACT_ADAPTER = "openai-responses-compact-v1" as const;

type ProviderCheckpointIdentity = OpenAIResponsesCheckpointIdentity;

interface ProviderProjectionOptions {
	providerCheckpoint: {
		identity: ProviderCheckpointIdentity;
	};
}

interface ProviderSessionContext extends SessionContext {
	providerCheckpoint?: ProviderCheckpoint;
}

type BuildProviderSessionContext = (
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
	options?: ProviderProjectionOptions,
) => ProviderSessionContext;

interface ProviderCheckpointAppendState {
	sessionId: string;
	generation: number;
	version: number;
	branch: string | null;
	identity: ProviderCheckpointIdentity;
}

interface AppendProviderCheckpointOptions {
	expected?: ProviderCheckpointAppendState;
	currentIdentity?: ProviderCheckpointIdentity;
}

type CaptureProviderCheckpointAppendState = (identity: ProviderCheckpointIdentity) => ProviderCheckpointAppendState;
type AppendProviderCheckpoint = (checkpoint: ProviderCheckpoint, options?: AppendProviderCheckpointOptions) => string;

const buildProviderSessionContext = buildSessionContext as unknown as BuildProviderSessionContext;

const identityA: ProviderCheckpointIdentity = {
	adapter: STABLE_COMPACT_ADAPTER,
	realm: "provider-owned:openai-primary",
	provider: "openai",
	endpoint: "https://api.openai.com/v1",
	modelFamily: "gpt-5",
};
const identityDifferentRealm: ProviderCheckpointIdentity = {
	...identityA,
	realm: "provider-owned:proxy-account-b",
};

function user(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-24T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function assistant(
	id: string,
	parentId: string | null,
	content: string | AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-24T00:00:01.000Z",
		message: {
			role: "assistant",
			content: typeof content === "string" ? [{ type: "text", text: content }] : content,
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: 2,
		},
	};
}

function checkpointEntry(id: string, parentId: string, checkpoint: ProviderCheckpoint): ProviderCheckpointEntry {
	return {
		type: "provider_checkpoint",
		id,
		parentId,
		timestamp: "2026-07-24T00:00:02.000Z",
		checkpoint,
	};
}

function checkpointValue(
	id: string,
	frontierEntryId: string,
	options: {
		identity?: ProviderCheckpointIdentity;
		predecessorEntryId?: string;
		windowGeneration?: number;
	} = {},
): ProviderCheckpoint {
	return {
		type: "provider_checkpoint",
		version: 1,
		identity: options.identity ?? identityA,
		frontierEntryId,
		predecessorEntryId: options.predecessorEntryId,
		windowGeneration: options.windowGeneration ?? 1,
		payload: {
			id: `resp_${id}`,
			created_at: 1_753_000_000,
			object: "response.compaction",
			output: [{ type: "compaction", id, encrypted_content: `opaque-${id}` }],
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

function asSessionEntries(entries: Array<SessionEntry | ProviderCheckpointEntry>): SessionEntry[] {
	return entries as SessionEntry[];
}

function corruptCheckpoint(
	entry: ProviderCheckpointEntry,
	mutate: (checkpoint: Record<string, unknown>) => void,
): ProviderCheckpointEntry {
	const copy = structuredClone(entry) as unknown as ProviderCheckpointEntry & {
		checkpoint: Record<string, unknown>;
	};
	mutate(copy.checkpoint);
	return copy as ProviderCheckpointEntry;
}

function project(
	entries: Array<SessionEntry | ProviderCheckpointEntry>,
	identity = identityA,
	leafId?: string | null,
): ProviderSessionContext {
	return buildProviderSessionContext(asSessionEntries(entries), leafId, undefined, {
		providerCheckpoint: { identity },
	});
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

function fixtureWithCheckpoint(): Array<SessionEntry | ProviderCheckpointEntry> {
	return [
		user("u1", null, "original user one"),
		assistant("a1", "u1", "original assistant one"),
		checkpointEntry("cp1", "a1", checkpointValue("cmp_1", "a1")),
		user("u2", "cp1", "post-checkpoint user"),
		assistant("a2", "u2", "post-checkpoint assistant"),
	];
}

describe("provider checkpoint session projection", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
		}
	});

	it("projects the newest compatible checkpoint plus only its post-frontier suffix", () => {
		const expectedCheckpoint = checkpointValue("cmp_1", "a1");
		const context = project(fixtureWithCheckpoint());

		expect(context.providerCheckpoint).toEqual(expectedCheckpoint);
		expect(context.messages.map(messageText)).toEqual(["post-checkpoint user", "post-checkpoint assistant"]);
		expect(context.messages.some((message) => message.role === "compactionSummary")).toBe(false);
	});

	it("keeps intact history for the same display model on a different provider-owned realm", () => {
		const entries = fixtureWithCheckpoint();
		const incompatible = project(entries, identityDifferentRealm);
		const compatibleAgain = project(entries);

		expect(incompatible.providerCheckpoint).toBeUndefined();
		expect(incompatible.messages.map(messageText)).toEqual([
			"original user one",
			"original assistant one",
			"post-checkpoint user",
			"post-checkpoint assistant",
		]);
		expect(incompatible.messages.some((message) => message.role === "compactionSummary")).toBe(false);
		expect(compatibleAgain.providerCheckpoint).toEqual(checkpointValue("cmp_1", "a1"));
		expect(compatibleAgain.messages.map(messageText)).toEqual(["post-checkpoint user", "post-checkpoint assistant"]);
	});

	it("persists a first-class checkpoint and rebuilds the same compatible projection after restart", () => {
		const tempDir = join(tmpdir(), `pi-provider-checkpoint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.appendMessage({ role: "user", content: "original user", timestamp: 1 });
		const frontierId = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "original assistant" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const persistedCheckpoint = checkpointValue("cmp_restart", frontierId);
		const appendProviderCheckpoint = (
			manager as unknown as { appendProviderCheckpoint: AppendProviderCheckpoint }
		).appendProviderCheckpoint.bind(manager);
		appendProviderCheckpoint(persistedCheckpoint);
		manager.appendMessage({ role: "user", content: "after restart frontier", timestamp: 3 });

		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		const beforeRestart = project(manager.getEntries());
		const reopened = SessionManager.open(file!, tempDir);
		const afterRestart = project(reopened.getEntries());

		expect(afterRestart.providerCheckpoint).toEqual(persistedCheckpoint);
		expect(afterRestart).toEqual(beforeRestart);
		expect(afterRestart.messages.map(messageText)).toEqual(["after restart frontier"]);
	});

	it("detaches canonical checkpoint state and atomically rejects stale append expectations", () => {
		const tempDir = join(
			tmpdir(),
			`pi-provider-checkpoint-atomic-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.appendMessage({ role: "user", content: "original user", timestamp: 1 });
		const frontierId = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "original assistant" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const api = manager as unknown as {
			captureProviderCheckpointAppendState: CaptureProviderCheckpointAppendState;
			appendProviderCheckpoint: AppendProviderCheckpoint;
		};
		const checkpoint = checkpointValue("cmp_detached", frontierId);
		const expected = api.captureProviderCheckpointAppendState(identityA);
		api.appendProviderCheckpoint(checkpoint, { expected, currentIdentity: identityA });
		checkpoint.payload.output.push({ type: "compaction", id: "cmp_mutated", encrypted_content: "mutated" });

		expect(project(manager.getEntries()).providerCheckpoint).toEqual(checkpointValue("cmp_detached", frontierId));
		expect(() => {
			(project(manager.getEntries()).providerCheckpoint!.payload.output as unknown[]).push("mutated projection");
		}).not.toThrow();
		expect(project(manager.getEntries()).providerCheckpoint).toEqual(checkpointValue("cmp_detached", frontierId));

		const beforeStaleAttempts = manager.getEntries();
		expect(() => api.appendProviderCheckpoint(checkpointValue("stale-version", frontierId), { expected })).toThrow(
			/version/i,
		);
		expect(() =>
			api.appendProviderCheckpoint(checkpointValue("stale-identity", manager.getLeafId()!), {
				expected: api.captureProviderCheckpointAppendState(identityA),
				currentIdentity: identityDifferentRealm,
			}),
		).toThrow(/identity/i);
		expect(manager.getEntries()).toEqual(beforeStaleAttempts);

		const reloadExpectation = api.captureProviderCheckpointAppendState(identityA);
		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		manager.setSessionFile(file!);
		expect(() =>
			api.appendProviderCheckpoint(checkpointValue("stale-generation", manager.getLeafId()!), {
				expected: reloadExpectation,
				currentIdentity: identityA,
			}),
		).toThrow(/generation/i);

		const branchExpectation = api.captureProviderCheckpointAppendState(identityA);
		manager.branch(frontierId);
		expect(() =>
			api.appendProviderCheckpoint(checkpointValue("stale-branch", frontierId), {
				expected: branchExpectation,
				currentIdentity: identityA,
			}),
		).toThrow(/branch/i);
	});

	it("uses checkpoint ancestry for forks before and after the frontier", () => {
		const entries: Array<SessionEntry | ProviderCheckpointEntry> = [
			...fixtureWithCheckpoint(),
			user("parent-later", "a2", "parent-only later work"),
			user("fork-before", "a1", "fork before checkpoint"),
			user("fork-after", "cp1", "fork after checkpoint"),
		];

		const before = project(entries, identityA, "fork-before");
		const after = project(entries, identityA, "fork-after");

		expect(before.providerCheckpoint).toBeUndefined();
		expect(before.messages.map(messageText)).toEqual([
			"original user one",
			"original assistant one",
			"fork before checkpoint",
		]);
		expect(after.providerCheckpoint).toEqual(checkpointValue("cmp_1", "a1"));
		expect(after.messages.map(messageText)).toEqual(["fork after checkpoint"]);
		expect(after.messages.map(messageText)).not.toContain("parent-only later work");
	});

	it("selects only the newest compatible ancestral checkpoint after repeated compaction", () => {
		const first = checkpointValue("cmp_1", "a1");
		const second = checkpointValue("cmp_2", "a2", {
			predecessorEntryId: "cp1",
			windowGeneration: 2,
		});
		const entries: Array<SessionEntry | ProviderCheckpointEntry> = [
			user("u1", null, "original user one"),
			assistant("a1", "u1", "original assistant one"),
			checkpointEntry("cp1", "a1", first),
			user("u2", "cp1", "between checkpoints"),
			assistant("a2", "u2", "between checkpoint answer"),
			checkpointEntry("cp2", "a2", second),
			user("u3", "cp2", "after second checkpoint"),
		];

		const context = project(entries);

		expect(context.providerCheckpoint).toEqual(second);
		expect(context.messages.map(messageText)).toEqual(["after second checkpoint"]);
	});

	it.each([
		[
			"version",
			(entry: ProviderCheckpointEntry) =>
				corruptCheckpoint(entry, (checkpoint) => {
					checkpoint.version = 99;
				}),
		],
		[
			"type",
			(entry: ProviderCheckpointEntry) =>
				corruptCheckpoint(entry, (checkpoint) => {
					checkpoint.type = "wrong_checkpoint";
				}),
		],
		[
			"identity",
			(entry: ProviderCheckpointEntry) =>
				corruptCheckpoint(entry, (checkpoint) => {
					checkpoint.identity = { ...identityA, endpoint: "" };
				}),
		],
		[
			"frontier",
			(entry: ProviderCheckpointEntry) =>
				corruptCheckpoint(entry, (checkpoint) => {
					checkpoint.frontierEntryId = "u1";
				}),
		],
		[
			"generation",
			(entry: ProviderCheckpointEntry) =>
				corruptCheckpoint(entry, (checkpoint) => {
					checkpoint.windowGeneration = 2;
				}),
		],
	])("skips a malformed loaded checkpoint %s and preserves portable history", (_kind, makeMalformed) => {
		const valid = checkpointEntry("cp1", "a1", checkpointValue("cmp_1", "a1"));
		const malformed = makeMalformed(valid);
		const entries: Array<SessionEntry | ProviderCheckpointEntry> = [
			user("u1", null, "original user one"),
			assistant("a1", "u1", "original assistant one"),
			malformed,
			user("u2", "cp1", "after malformed checkpoint"),
		];

		expect(() => project(entries)).not.toThrow();
		const context = project(entries);
		expect(context.providerCheckpoint).toBeUndefined();
		expect(context.messages.map(messageText)).toEqual([
			"original user one",
			"original assistant one",
			"after malformed checkpoint",
		]);
	});

	it.each([
		["missing checkpoint", undefined],
		["null checkpoint", null],
		["primitive checkpoint", "checkpoint"],
		["missing identity", { ...checkpointValue("cmp_bad", "a1"), identity: undefined }],
		["null identity", { ...checkpointValue("cmp_bad", "a1"), identity: null }],
	])("skips a loaded provider checkpoint with %s without throwing", (_name, malformedCheckpoint) => {
		const malformed = {
			type: "provider_checkpoint",
			id: "cp1",
			parentId: "a1",
			timestamp: "2026-07-24T00:00:02.000Z",
			checkpoint: malformedCheckpoint,
		} as unknown as ProviderCheckpointEntry;
		const entries: Array<SessionEntry | ProviderCheckpointEntry> = [
			user("u1", null, "original user one"),
			assistant("a1", "u1", "original assistant one"),
			malformed,
			user("u2", "cp1", "after malformed checkpoint"),
		];

		expect(() => project(entries)).not.toThrow();
		expect(project(entries).providerCheckpoint).toBeUndefined();
		expect(project(entries).messages.map(messageText)).toEqual([
			"original user one",
			"original assistant one",
			"after malformed checkpoint",
		]);
	});

	it("does not replay a later valid checkpoint whose predecessor chain contains an invalid loaded checkpoint", () => {
		const first = corruptCheckpoint(checkpointEntry("cp1", "a1", checkpointValue("cmp_1", "a1")), (checkpoint) => {
			checkpoint.version = 99;
		});
		const dependent = checkpointEntry(
			"cp2",
			"a2",
			checkpointValue("cmp_2", "a2", { predecessorEntryId: "cp1", windowGeneration: 2 }),
		);
		const entries: Array<SessionEntry | ProviderCheckpointEntry> = [
			user("u1", null, "original user one"),
			assistant("a1", "u1", "original assistant one"),
			first,
			user("u2", "cp1", "between invalid and dependent"),
			assistant("a2", "u2", "between answer"),
			dependent,
			user("u3", "cp2", "after dependent checkpoint"),
		];

		const context = project(entries);
		expect(context.providerCheckpoint).toBeUndefined();
		expect(context.messages.map(messageText)).toEqual([
			"original user one",
			"original assistant one",
			"between invalid and dependent",
			"between answer",
			"after dependent checkpoint",
		]);
	});

	it("rejects a loaded checkpoint predecessor that is not the latest compatible ancestor", () => {
		const first = checkpointValue("cmp_1", "a1");
		const second = checkpointValue("cmp_2", "a2", { predecessorEntryId: "cp1", windowGeneration: 2 });
		const staleDependent = checkpointValue("cmp_3", "a3", { predecessorEntryId: "cp1", windowGeneration: 3 });
		const entries: Array<SessionEntry | ProviderCheckpointEntry> = [
			user("u1", null, "original user one"),
			assistant("a1", "u1", "original assistant one"),
			checkpointEntry("cp1", "a1", first),
			user("u2", "cp1", "between one and two"),
			assistant("a2", "u2", "answer two"),
			checkpointEntry("cp2", "a2", second),
			user("u3", "cp2", "between two and stale"),
			assistant("a3", "u3", "answer three"),
			checkpointEntry("cp3", "a3", staleDependent),
			user("u4", "cp3", "after stale dependent"),
		];

		const context = project(entries);
		expect(context.providerCheckpoint).toEqual(second);
		expect(context.messages.map(messageText)).toEqual([
			"between two and stale",
			"answer three",
			"after stale dependent",
		]);
	});

	it("uses the complete immutable compatibility identity", () => {
		const entries = fixtureWithCheckpoint();
		const incompatibleIdentities: ProviderCheckpointIdentity[] = [
			{ ...identityA, adapter: "future-compact-adapter" as typeof STABLE_COMPACT_ADAPTER },
			{ ...identityA, realm: "provider-owned:other-realm" },
			{ ...identityA, provider: "custom-proxy" },
			{ ...identityA, endpoint: "https://api.openai.com/v2" },
			{ ...identityA, modelFamily: "gpt-6" },
		];

		for (const identity of incompatibleIdentities) {
			const context = project(entries, identity);
			expect(context.providerCheckpoint).toBeUndefined();
			expect(context.messages.map(messageText)).toEqual([
				"original user one",
				"original assistant one",
				"post-checkpoint user",
				"post-checkpoint assistant",
			]);
		}
	});

	it("preserves append-only history when a newer incompatible checkpoint is ancestral", () => {
		const first = checkpointValue("cmp_1", "a1");
		const incompatible = checkpointValue("cmp_other", "a2", {
			identity: identityDifferentRealm,
			predecessorEntryId: "cp1",
			windowGeneration: 2,
		});
		const entries: Array<SessionEntry | ProviderCheckpointEntry> = [
			user("u1", null, "original user one"),
			assistant("a1", "u1", "original assistant one"),
			checkpointEntry("cp1", "a1", first),
			user("u2", "cp1", "between checkpoints"),
			assistant("a2", "u2", "between checkpoint answer"),
			checkpointEntry("cp-other", "a2", incompatible),
			user("u3", "cp-other", "after incompatible checkpoint"),
		];

		const context = project(entries);

		expect(context.providerCheckpoint).toEqual(first);
		expect(context.messages.map(messageText)).toEqual([
			"between checkpoints",
			"between checkpoint answer",
			"after incompatible checkpoint",
		]);
	});

	it("rejects non-ancestral and generation-incompatible predecessors atomically", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const firstFrontier = manager.appendMessage({ role: "user", content: "first frontier", timestamp: 2 });
		const firstId = manager.appendProviderCheckpoint(checkpointValue("cmp_1", firstFrontier));
		const mainFrontier = manager.appendMessage({ role: "user", content: "main frontier", timestamp: 3 });
		manager.branch(firstId);
		const siblingFrontier = manager.appendMessage({ role: "user", content: "sibling frontier", timestamp: 4 });
		const siblingId = manager.appendProviderCheckpoint(
			checkpointValue("cmp_sibling", siblingFrontier, { predecessorEntryId: firstId, windowGeneration: 2 }),
		);
		manager.branch(mainFrontier);
		const beforeAttempts = manager.getEntries();

		expect(() =>
			manager.appendProviderCheckpoint(
				checkpointValue("cmp_non_ancestral", mainFrontier, {
					predecessorEntryId: siblingId,
					windowGeneration: 3,
				}),
			),
		).toThrow(/predecessor.*ancestr|ancestr.*predecessor/i);
		expect(() =>
			manager.appendProviderCheckpoint(
				checkpointValue("cmp_generation", mainFrontier, {
					predecessorEntryId: firstId,
					windowGeneration: 7,
				}),
			),
		).toThrow(/window.*generation|generation.*window/i);
		expect(manager.getEntries()).toEqual(beforeAttempts);
	});

	it("preserves post-frontier message order and a closed tool call/result pair", () => {
		const entries: Array<SessionEntry | ProviderCheckpointEntry> = [
			user("u1", null, "original user one"),
			assistant("a1", "u1", "original assistant one"),
			checkpointEntry("cp1", "a1", checkpointValue("cmp_1", "a1")),
			assistant(
				"tool-call",
				"cp1",
				[{ type: "toolCall", id: "call_1|fc_1", name: "lookup", arguments: { key: "value" } }],
				"toolUse",
			),
			{
				type: "message",
				id: "tool-result",
				parentId: "tool-call",
				timestamp: "2026-07-24T00:00:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call_1|fc_1",
					toolName: "lookup",
					content: [{ type: "text", text: "tool result" }],
					isError: false,
					timestamp: 4,
				},
			},
			user("queued-steer", "tool-result", "queued steering"),
			user("queued-follow-up", "queued-steer", "queued follow-up"),
		];

		const context = project(entries);

		expect(context.messages.map((message) => message.role)).toEqual(["assistant", "toolResult", "user", "user"]);
		expect(context.messages[0]).toMatchObject({ content: [{ type: "toolCall", id: "call_1|fc_1" }] });
		expect(context.messages[1]).toMatchObject({ role: "toolResult", toolCallId: "call_1|fc_1" });
		expect(context.messages.slice(2).map(messageText)).toEqual(["queued steering", "queued follow-up"]);
	});
});
