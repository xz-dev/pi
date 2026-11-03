import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	type ContinuationCommit,
	loadEntriesFromFile,
	parseSessionEntries,
	SessionManager,
} from "../src/core/session-manager.ts";
import { encodeSessionTransaction, isCompressedSession, summarizeSession } from "../src/core/session-storage.ts";

const usage = {
	input: 5,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 6,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function continuation(manager: SessionManager): ContinuationCommit {
	return {
		expectedSessionId: manager.getSessionId(),
		expectedLeafId: manager.getLeafId(),
		expectedGeneration: manager.getGeneration(),
		expectedEntryCount: manager.getEntryCount(),
		branchFromId: manager.getBranch()[0].id,
		messages: [fauxAssistantMessage("recovered")],
	};
}

describe.each([true, false])("downstream atomic session publications (compressed=%s)", (compressed) => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-compression-integration-"));
		vi.stubEnv(ENV_AGENT_DIR, root);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function createSession(): SessionManager {
		const path = join(root, "session.jsonl");
		const text = `${JSON.stringify({ type: "session", version: 3, id: "integration", cwd: root, timestamp: "2020-01-01T00:00:00Z" })}\n${JSON.stringify({ type: "message", id: "first", parentId: null, timestamp: "2020-01-01T00:00:00Z", __raw_inputText: "/typed", message: { role: "user", content: "expanded question", timestamp: 1, origin: { type: "interactive" } } })}\n`;
		writeFileSync(
			path,
			compressed ? encodeSessionTransaction(text, summarizeSession(parseSessionEntries(text))) : text,
		);
		return SessionManager.open(path);
	}

	it("publishes a retry sibling while preserving run cancellation, usage and raw message fields exactly once", () => {
		const manager = createSession();
		manager.appendMessage(fauxAssistantMessage("partial", { stopReason: "aborted" }));
		const run = manager.appendRunState("started");
		const commit = continuation(manager);
		manager.appendCustomEntry("state", { flag: true });
		manager.appendUsage("background_compaction", "faux", "faux", usage);
		manager.appendRunState("aborted", run, commit.expectedLeafId);
		const leaf = manager.commitContinuation(commit);
		const path = manager.getSessionFile()!;
		expect(isCompressedSession(path)).toBe(compressed);
		expect(manager.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
		expect(manager.getBranch().filter((entry) => entry.type === "usage")).toHaveLength(0);
		expect(manager.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(1);
		expect(manager.getLeafId()).toBe(leaf);
		expect(manager.hasUnfinishedWork()).toBe(false);
		manager.appendMessage({ role: "user", content: "after retry", timestamp: 2 });
		const reopened = SessionManager.open(path);
		expect(reopened.getEntries()).toEqual(manager.getEntries());
		expect(reopened.getEntries().filter((entry) => entry.type === "message")).toHaveLength(4);
		expect(reopened.hasUnfinishedWork()).toBe(false);
		expect(loadEntriesFromFile(path).filter((entry) => entry.type === "run_state")).toHaveLength(3);
		expect(reopened.getEntry("first")).toMatchObject({
			__raw_inputText: "/typed",
			message: { origin: { type: "interactive" } },
		});
	});

	it("keeps a boundary compaction encoded and preserves the leaf, working run and later appends", () => {
		const manager = createSession();
		const kept = manager.appendMessage({ role: "user", content: "keep", timestamp: 2 });
		manager.appendRunState("started");
		manager.appendUsage("background_compaction", "faux", "faux", usage);
		const leaf = manager.getLeafId();
		const summary = manager.appendCompaction("summary", kept, 100);
		expect(manager.getLeafId()).toBe(leaf);
		expect(manager.getEntry(kept)?.parentId).toBe(summary);
		manager.appendMessage({ role: "user", content: "after compaction", timestamp: 3 });
		const path = manager.getSessionFile()!;
		expect(isCompressedSession(path)).toBe(compressed);
		const reopened = SessionManager.open(path);
		expect(reopened.getEntries()).toEqual(manager.getEntries());
		expect(reopened.hasUnfinishedWork()).toBe(true);
		expect(reopened.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(1);
		expect(reopened.buildContextEntries().map((entry) => entry.id)).toEqual(
			manager.buildContextEntries().map((entry) => entry.id),
		);
		expect(reopened.getEntry("first")).toMatchObject({ __raw_inputText: "/typed" });
	});

	it.each(["continuation", "compaction"])("preserves disk and memory when %s publication fails", (kind) => {
		const manager = createSession();
		const kept = manager.appendMessage({ role: "user", content: "keep", timestamp: 2 });
		const path = manager.getSessionFile()!;
		const original = readFileSync(path);
		const entries = JSON.stringify(manager.getEntries());
		const generation = manager.getGeneration();
		const leaf = manager.getLeafId();
		const writer = manager.continuationFileWriter;
		manager.continuationFileWriter = (temporary, _destination, contents) => {
			writeFileSync(temporary, contents);
			throw new Error("injected publication failure");
		};
		expect(() =>
			kind === "continuation"
				? manager.commitContinuation(continuation(manager))
				: manager.appendCompaction("summary", kept, 100),
		).toThrow("injected publication failure");
		expect(readFileSync(path)).toEqual(original);
		expect(JSON.stringify(manager.getEntries())).toBe(entries);
		expect(manager.getGeneration()).toBe(generation);
		expect(manager.getLeafId()).toBe(leaf);
		expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		manager.continuationFileWriter = writer;
		manager.appendMessage({ role: "user", content: "after failure", timestamp: 3 });
		expect(SessionManager.open(path).getEntries()).toEqual(manager.getEntries());
		expect(isCompressedSession(path)).toBe(compressed);
	});

	it("does not copy source execution ownership into a fork", () => {
		const manager = createSession();
		manager.appendRunState("started");
		const fork = SessionManager.forkFrom(manager.getSessionFile()!, root, root, { compressSessions: compressed });
		expect(fork.hasUnfinishedWork()).toBe(false);
		expect(loadEntriesFromFile(fork.getSessionFile()!).some((entry) => entry.type === "run_state")).toBe(false);
	});
});

describe("compressed publication guards", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-compression-guards-"));
		vi.stubEnv(ENV_AGENT_DIR, root);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});
	it.each(["continuation", "compaction"])("rejects corrupt or incomplete source before %s publication", (kind) => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = SessionManager.create(root, root);
		const kept = manager.appendMessage({ role: "user", content: "committed", timestamp: 1 });
		const path = manager.getSessionFile()!;
		const prefix = readFileSync(path);
		manager.appendMessage({ role: "user", content: "uncommitted", timestamp: 2 });
		const appended = readFileSync(path).subarray(prefix.length);
		writeFileSync(path, Buffer.concat([prefix, appended.subarray(0, 16)]));
		const recovered = SessionManager.open(path);
		const incomplete = readFileSync(path);
		expect(() =>
			kind === "continuation"
				? recovered.commitContinuation(continuation(recovered))
				: recovered.appendCompaction("summary", kept, 100),
		).toThrow("Incomplete session append");
		expect(readFileSync(path)).toEqual(incomplete);
		writeFileSync(path, prefix);
		const current = SessionManager.open(path);
		const corrupt = Buffer.from(prefix);
		corrupt[corrupt.length - 1] ^= 1;
		writeFileSync(path, corrupt);
		expect(() =>
			kind === "continuation"
				? current.commitContinuation(continuation(current))
				: current.appendCompaction("summary", kept, 100),
		).toThrow();
		expect(readFileSync(path)).toEqual(corrupt);
	});
});
