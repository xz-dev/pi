import crypto from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { migrateSessionCompression, warnMixedSessionCompression } from "../src/core/session-compression.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { compressedSessionInfo, readCompressedSession, replaceSessionFile } from "../src/core/session-storage.ts";
import { filterAndSortSessions } from "../src/modes/interactive/components/session-selector-search.ts";
import { createTestSession } from "./utilities.ts";
import { decodeStandardZstd } from "./zstd-oracle.ts";

function message(content: string) {
	return { role: "user" as const, content, timestamp: 1 };
}

describe("session compression acceptance", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-compression-"));
		vi.stubEnv(ENV_AGENT_DIR, root);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("recognizes explicit migration booleans and rejects invalid or absent values", () => {
		expect(parseArgs(["--enable-compress-sessions=true"]).compressSessions).toBe(true);
		expect(parseArgs(["--enable-compress-sessions=false"]).compressSessions).toBe(false);
		for (const value of ["--enable-compress-sessions=invalid", "--enable-compress-sessions"]) {
			expect(parseArgs([value]).diagnostics).toEqual([expect.objectContaining({ type: "error" })]);
		}
	});

	it("defaults new sessions to compressed storage without converting an existing plain session", () => {
		const oldPath = join(root, "old.jsonl");
		const oldText = `${JSON.stringify({ type: "session", version: 3, id: "old", cwd: root, timestamp: "2026-01-01T00:00:00Z" })}\n`;
		writeFileSync(oldPath, oldText);
		SessionManager.open(oldPath);
		expect(readFileSync(oldPath, "utf8")).toBe(oldText);
		const session = SessionManager.create(root, root);
		session.appendMessage(message("keep every byte"));
		const stored = readFileSync(session.getSessionFile()!);
		expect(stored[0]).not.toBe("{".charCodeAt(0));
		expect(decodeStandardZstd(stored).toString()).toContain("keep every byte");
		expect(SessionManager.open(session.getSessionFile()!).getEntries()).toEqual(session.getEntries());
	});

	it("keeps plain sessions plain when disabled, including after a changed new-session default", () => {
		const session = SessionManager.create(root, root, { compressSessions: false });
		session.appendMessage(message("plain"));
		const path = session.getSessionFile()!;
		session.setCompressionEnabledForNewSessions(true);
		session.appendMessage(message("still plain"));
		expect(readFileSync(path, "utf8")).toContain('"content":"still plain"');
		expect(session.consolidateStorage()).toBe(false);
		expect(SessionManager.open(path).getEntries()).toEqual(session.getEntries());
	});

	it("consolidates persisted history once without changing identity, mtime or later appends", () => {
		const session = SessionManager.create(root, root);
		for (let i = 0; i < 1000; i++) session.appendMessage(message("short repeated record"));
		const path = session.getSessionFile()!;
		const before = readFileSync(path);
		const transcript = decodeStandardZstd(before);
		const time = new Date("2020-01-01T00:00:00Z");
		utimesSync(path, time, time);
		if (process.platform !== "win32") chmodSync(path, 0o640);
		expect(session.consolidateStorage()).toBe(true);
		expect(readFileSync(path).length).toBeLessThan(transcript.length / 4);
		expect(decodeStandardZstd(readFileSync(path))).toEqual(transcript);
		expect(statSync(path).mtimeMs).toBe(time.getTime());
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o640);
		expect(session.consolidateStorage()).toBe(false);
		session.appendMessage(message("after checkpoint"));
		const restored = SessionManager.open(path);
		expect(restored.getSessionId()).toBe(session.getSessionId());
		expect(restored.getEntries()).toEqual(session.getEntries());
		expect(restored.getEntries()).toHaveLength(1001);
	});

	it("consolidates on AgentSession disposal without starting a model request", async () => {
		const context = await createTestSession();
		try {
			for (let i = 0; i < 100; i++) context.sessionManager.appendMessage(message("persisted before close"));
			const path = context.sessionManager.getSessionFile()!;
			const transcript = decodeStandardZstd(readFileSync(path));
			expect(readCompressedSession(path).transactions).toBeGreaterThan(1);
			context.session.dispose();
			expect(readCompressedSession(path).transactions).toBe(1);
			expect(decodeStandardZstd(readFileSync(path))).toEqual(transcript);
		} finally {
			context.cleanup();
		}
	});

	it("keeps shutdown successful and persisted bytes intact if consolidation fails", async () => {
		const context = await createTestSession();
		try {
			context.sessionManager.appendMessage(message("durable before failure"));
			const path = context.sessionManager.getSessionFile()!;
			const bytes = readFileSync(path);
			const warning = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(context.sessionManager, "consolidateStorage").mockImplementation(() => {
				throw new Error("checkpoint failure");
			});
			expect(() => context.session.dispose()).not.toThrow();
			expect(readFileSync(path)).toEqual(bytes);
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("checkpoint failure"));
		} finally {
			vi.restoreAllMocks();
			context.cleanup();
		}
	});

	it("never removes an existing temporary file when exclusive creation fails", () => {
		const path = join(root, "guarded.jsonl");
		const uuid = "11111111-1111-4111-8111-111111111111";
		const temp = `${path}.${uuid}.tmp`;
		writeFileSync(path, "original");
		writeFileSync(temp, "other owner");
		const mocked = vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
		syncBuiltinESMExports();
		try {
			expect(() => replaceSessionFile(path, Buffer.from("replacement"))).toThrow();
			expect(readFileSync(path, "utf8")).toBe("original");
			expect(readFileSync(temp, "utf8")).toBe("other owner");
		} finally {
			mocked.mockRestore();
			syncBuiltinESMExports();
		}
	});

	// Windows symlink creation requires permissions not guaranteed by the test host.
	it.skipIf(process.platform === "win32")("keeps a session symlink when consolidating its target", () => {
		const session = SessionManager.create(root, root);
		session.appendMessage(message("first"));
		session.appendMessage(message("second"));
		const target = session.getSessionFile()!;
		const alias = join(root, "alias.jsonl");
		symlinkSync(target, alias);
		const transcript = decodeStandardZstd(readFileSync(target));
		expect(SessionManager.open(alias).consolidateStorage()).toBe(true);
		expect(lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(decodeStandardZstd(readFileSync(target))).toEqual(transcript);
		expect(readFileSync(alias)).toEqual(readFileSync(target));
	});

	it("does not create unused session files during consolidation", () => {
		const session = SessionManager.create(root, root);
		session.appendModelChange("faux", "faux");
		expect(session.consolidateStorage()).toBe(false);
		expect(existsSync(session.getSessionFile()!)).toBe(false);
	});

	it("shows plaintext browsing metadata while preserving full first-message and text search", async () => {
		const session = SessionManager.create(root, root);
		const first = `${"preview ".repeat(60)}unique-tail-search`;
		session.appendMessage(message(first));
		session.appendSessionInfo("Indexed title");
		const path = session.getSessionFile()!;
		expect(readFileSync(path).includes(Buffer.from("Indexed title"))).toBe(true);
		const load = vi.fn(() => ({ firstMessage: first, allMessagesText: first }));
		const info = compressedSessionInfo(path, load);
		expect(info.name).toBe("Indexed title");
		expect(info.firstMessagePreview).toHaveLength(200);
		expect(load).not.toHaveBeenCalled();
		expect(info.firstMessage).toBe(first);
		expect(info.allMessagesText).toBe(first);
		expect(load).toHaveBeenCalledTimes(1);
		const listed = await SessionManager.list(root, root);
		expect(filterAndSortSessions(listed, "unique-tail-search", "recent")).toHaveLength(1);
		expect(listed[0].firstMessage).toBe(first);
	});

	it("leaves incomplete reads untouched and repairs only the tail before an append", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const session = SessionManager.create(root, root);
		session.appendMessage(message("committed"));
		const path = session.getSessionFile()!;
		const prefix = readFileSync(path);
		session.appendMessage(message("interrupted"));
		const completed = readFileSync(path);
		const transaction = completed.subarray(prefix.length);
		for (const cut of [1, 16, 119, 123, 129, transaction.length - 1]) {
			const target = join(root, `partial-${cut}.jsonl`);
			const interrupted = Buffer.concat([prefix, transaction.subarray(0, cut)]);
			writeFileSync(target, interrupted);
			const restored = SessionManager.open(target);
			expect(restored.getEntries()).toHaveLength(1);
			expect(readFileSync(target)).toEqual(interrupted);
			expect(restored.consolidateStorage()).toBe(false);
			expect(readFileSync(target)).toEqual(interrupted);
			restored.appendMessage(message("after interruption"));
			expect(SessionManager.open(target).getEntries()).toEqual(restored.getEntries());
			expect(restored.getEntries()).toHaveLength(2);
			expect(decodeStandardZstd(readFileSync(target)).toString()).not.toContain('"content":"interrupted"');
		}
	});

	it("rejects incomplete first transactions and complete corruption without rewriting them", () => {
		const session = SessionManager.create(root, root);
		session.appendMessage(message("committed"));
		const bytes = readFileSync(session.getSessionFile()!);
		const invalid = [bytes.subarray(0, 100), Buffer.from(bytes), Buffer.from(bytes)];
		invalid[1][20] ^= 1;
		invalid[2][invalid[2].length - 1] ^= 1;
		for (const [index, contents] of invalid.entries()) {
			const path = join(root, `invalid-${index}.jsonl`);
			writeFileSync(path, contents);
			expect(() => SessionManager.open(path)).toThrow();
			expect(readFileSync(path)).toEqual(contents);
		}
	});

	it("opens ordinary zstd by magic and explicitly migrates it without requiring a suffix", async () => {
		const session = SessionManager.create(root, root, { compressSessions: false });
		session.appendMessage(message("external archive"));
		const path = session.getSessionFile()!;
		const original = readFileSync(path);
		writeFileSync(path, zstdCompressSync(original));
		expect(SessionManager.open(path).getEntries()).toEqual(session.getEntries());
		const migrated = await migrateSessionCompression(root, false);
		expect(migrated.failed).toEqual([]);
		expect(readFileSync(path)).toEqual(original);
	});

	it("discovers .jsonl.zst sessions by header and preserves their path during decompression", async () => {
		const path = join(root, "external.jsonl.zst");
		const original = `${JSON.stringify({ type: "session", version: 3, id: "archive", cwd: root, timestamp: "2020-01-01T00:00:00Z" })}\n`;
		writeFileSync(path, zstdCompressSync(Buffer.from(original)));
		expect((await SessionManager.list(root, root)).map((entry) => entry.path)).toEqual([path]);
		expect(SessionManager.findById(root, "archive", root)).toBe(path);
		expect(SessionManager.continueRecent(root, root).getSessionFile()).toBe(path);
		expect((await migrateSessionCompression(root, false)).converted).toBe(1);
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(SessionManager.open(path).getSessionId()).toBe("archive");
	});

	it("round-trips a supported legacy header without cwd without changing transcript bytes", async () => {
		const path = join(root, "legacy.jsonl");
		const original = `${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: "2020-01-01T00:00:00Z" })}\n${JSON.stringify({ type: "message", id: "first", parentId: null, timestamp: "2020-01-01T00:00:00Z", message: message("legacy history") })}\n`;
		writeFileSync(path, original);
		const entries = SessionManager.open(path).getEntries();
		expect(await SessionManager.listAll(root)).toEqual([expect.objectContaining({ id: "legacy", cwd: "" })]);
		expect((await migrateSessionCompression(root, true)).failed).toEqual([]);
		expect(SessionManager.open(path).getEntries()).toEqual(entries);
		const listed = await SessionManager.listAll(root);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ id: "legacy", cwd: "" });
		expect(listed[0].allMessagesText).toBe("legacy history");
		expect((await migrateSessionCompression(root, false)).failed).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("keeps stale-manager append protection outside runtime replacement", () => {
		const current = SessionManager.create(root, root);
		current.appendMessage(message("first"));
		current.appendMessage(message("second"));
		const path = current.getSessionFile()!;
		const stale = SessionManager.open(path);
		expect(current.consolidateStorage()).toBe(true);
		const before = readFileSync(path);
		expect(() => stale.appendMessage(message("must not append"))).toThrow("Session changed before append");
		expect(readFileSync(path)).toEqual(before);
	});

	it("preserves valid unterminated JSONL bytes through explicit true/false conversion", async () => {
		const path = join(root, "unterminated.jsonl");
		const text = JSON.stringify({
			type: "session",
			version: 3,
			id: "raw",
			cwd: root,
			timestamp: "2020-01-01T00:00:00Z",
		});
		writeFileSync(path, text);
		expect((await migrateSessionCompression(root, true)).failed).toEqual([]);
		expect((await migrateSessionCompression(root, false)).failed).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(text);
	});

	it("warns about mixed formats without decoding or changing complete compressed files", () => {
		const plain = SessionManager.create(root, root, { compressSessions: false });
		plain.appendMessage(message("plain"));
		const compressed = SessionManager.create(root, root);
		compressed.appendMessage(message("compressed"));
		const path = compressed.getSessionFile()!;
		const before = readFileSync(path);
		const warning = vi.spyOn(console, "error").mockImplementation(() => {});
		warnMixedSessionCompression(root);
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("pi --enable-compress-sessions=true"));
		expect(readFileSync(path)).toEqual(before);
		expect(readCompressedSession(path).incompleteTail).toBe(false);
	});
});
