import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type FileEntry, loadEntriesFromFile, SessionManager } from "../src/core/session-manager.ts";
import { encodeSessionTransaction, readCompressedSession, summarizeSession } from "../src/core/session-storage.ts";
import { filterAndSortSessions } from "../src/modes/interactive/components/session-selector-search.ts";
import { decodeStandardZstd } from "./zstd-oracle.ts";

describe("compressed session read boundaries", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-compression-boundaries-"));
		vi.stubEnv(ENV_AGENT_DIR, root);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("preserves unknown extension flags outside maintenance", () => {
		const parsed = parseArgs(["--extension-option", "value"]);
		expect(parsed.unknownFlags.get("extension-option")).toBe("value");
		expect(parsed.diagnostics).toEqual([]);
	});

	it.each([1, 2])(
		"rejects v%s schema migration with an incomplete compressed tail without changing bytes",
		async (version) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			const manager = SessionManager.create(root, root);
			manager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
			const path = manager.getSessionFile()!;
			const entries: FileEntry[] = [
				{
					type: "session",
					...(version === 2 ? { version } : {}),
					id: manager.getSessionId(),
					cwd: root,
					timestamp: "2020-01-01T00:00:00Z",
				},
				{
					type: "message",
					id: "committed",
					parentId: null,
					timestamp: "2020-01-01T00:00:00Z",
					message: { role: "user", content: "legacy committed history", timestamp: 1 },
				},
			];
			const text = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
			const interrupted = Buffer.concat([
				encodeSessionTransaction(text, summarizeSession(entries)),
				Buffer.from([0x50]),
			]);
			writeFileSync(path, interrupted);
			expect(() => SessionManager.open(path)).toThrow(
				"Cannot migrate a legacy compressed session with an incomplete append",
			);
			expect(readFileSync(path)).toEqual(interrupted);
			expect(loadEntriesFromFile(path)).toEqual(entries);
			const listed = await SessionManager.list(root, root);
			expect(listed).toHaveLength(1);
			expect(listed[0].allMessagesText).toBe("legacy committed history");
			expect(filterAndSortSessions(listed, "legacy committed", "recent")).toHaveLength(1);
			expect(manager.consolidateStorage()).toBe(false);
			expect(readCompressedSession(path).incompleteTail).toBe(true);
			expect(readFileSync(path)).toEqual(interrupted);

			const plain = join(root, `plain-v${version}.jsonl`);
			writeFileSync(plain, text);
			const migrated = SessionManager.open(plain);
			expect(migrated.getHeader()?.version).toBe(3);
			migrated.appendMessage({ role: "user", content: "after plain migration", timestamp: 2 });
			expect(
				SessionManager.open(plain)
					.getEntries()
					.map((entry) =>
						entry.type === "message" && entry.message.role === "user" ? entry.message.content : undefined,
					),
			).toEqual(["legacy committed history", "after plain migration"]);
		},
	);

	it("loads every raw concatenated and skippable frame without normalizing JSONL bytes", () => {
		const header: FileEntry = {
			type: "session",
			version: 3,
			id: "raw-frames",
			cwd: root,
			timestamp: "2020-01-01T00:00:00Z",
		};
		const first = `${JSON.stringify(header)}\r\n`;
		const second = `${JSON.stringify({ type: "custom", id: "x", parentId: null, timestamp: header.timestamp, customType: "raw", data: "漢字" })}\n`;
		const skip = Buffer.from([0x5f, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
		for (const prefix of [Buffer.alloc(0), skip]) {
			const path = join(root, "raw-frames.jsonl");
			writeFileSync(
				path,
				Buffer.concat([
					prefix,
					zstdCompressSync(Buffer.from(first)),
					skip,
					zstdCompressSync(Buffer.from(second)),
					skip,
				]),
			);
			let text = "";
			readCompressedSession(path, (part) => {
				text += part;
			});
			expect(text).toBe(first + second);
			expect(loadEntriesFromFile(path)).toHaveLength(2);
		}
	});

	it("rejects complete transaction descriptors containing truncated or multiple payload frames", () => {
		const entries: FileEntry[] = [
			{ type: "session", version: 3, id: "bad-payload", cwd: root, timestamp: "2020-01-01T00:00:00Z" },
		];
		const transaction = encodeSessionTransaction(`${JSON.stringify(entries[0])}\n`, summarizeSession(entries));
		const start = 128 + transaction.readUInt32LE(16);
		const payload = transaction.subarray(start);
		for (const replacement of [
			payload.subarray(0, payload.length - 1),
			Buffer.concat([payload, zstdCompressSync(Buffer.from("extra"))]),
		]) {
			const bytes = Buffer.concat([transaction.subarray(0, start), replacement]);
			bytes.writeUInt32LE(replacement.length, 20);
			createHash("sha256").update(replacement).digest().copy(bytes, 56);
			createHash("sha256").update(bytes.subarray(0, 88)).digest().copy(bytes, 88);
			const path = join(root, "bad-payload.jsonl");
			writeFileSync(path, bytes);
			expect(() => SessionManager.open(path)).toThrow();
			expect(readFileSync(path)).toEqual(bytes);
		}
	});

	it("loads large plain, framed and ordinary-zstd histories and reopens after consolidation", () => {
		const recordCount = 150_000;
		const entries: FileEntry[] = [
			{ type: "session", version: 3, id: "large", cwd: root, timestamp: "2020-01-01T00:00:00Z" },
		];
		for (let i = 0; i < recordCount; i++) {
			const base = { id: String(i), parentId: i === 0 ? null : String(i - 1), timestamp: "2020-01-01T00:00:00Z" };
			entries.push(
				i === 0
					? {
							...base,
							type: "message",
							message: { role: "user", content: "large committed history", timestamp: 1 },
						}
					: { ...base, type: "custom", customType: "counter", data: i },
			);
		}
		const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`);
		const text = lines.join("");
		const metadata = summarizeSession(entries);
		const plain = join(root, "plain.jsonl");
		const framed = join(root, "framed.jsonl");
		const ordinary = join(root, "ordinary.jsonl");
		writeFileSync(plain, text);
		writeFileSync(framed, encodeSessionTransaction(text, metadata));
		writeFileSync(ordinary, zstdCompressSync(Buffer.from(text)));
		for (const path of [plain, framed, ordinary]) {
			const loaded = loadEntriesFromFile(path);
			expect(loaded).toHaveLength(recordCount + 1);
			for (const index of [0, Math.floor(recordCount / 2), recordCount])
				expect(loaded[index]).toEqual(entries[index]);
		}

		const split = Math.floor(lines.length / 2);
		const path = join(root, "two-transactions.jsonl");
		writeFileSync(
			path,
			Buffer.concat([
				encodeSessionTransaction(lines.slice(0, split).join(""), summarizeSession(entries.slice(0, split))),
				encodeSessionTransaction(lines.slice(split).join(""), metadata),
			]),
		);
		const manager = SessionManager.open(path);
		expect(manager.getEntryCount()).toBe(recordCount);
		expect(manager.consolidateStorage()).toBe(true);
		expect(readCompressedSession(path).transactions).toBe(1);
		expect(decodeStandardZstd(readFileSync(path)).toString("utf8")).toBe(text);
		const reopened = SessionManager.open(path);
		expect(reopened.getEntries()).toHaveLength(recordCount);
		expect(reopened.getBranch()).toHaveLength(recordCount);
		expect(reopened.getEntry(String(recordCount - 1))).toEqual(entries.at(-1));
	}, 20_000);
});
