import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeSessionBranch } from "../../src/core/session-export.ts";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("SessionManager.newSession with custom id", () => {
	it("uses the provided id instead of generating one", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "my-custom-id" });
		expect(session.getSessionId()).toBe("my-custom-id");
	});

	it("uses the provided id when creating an in-memory session", () => {
		const session = SessionManager.inMemory(process.cwd(), { id: "memory-session-id" });
		expect(session.getSessionId()).toBe("memory-session-id");
		expect(session.getHeader()!.id).toBe("memory-session-id");
		expect(session.getSessionFile()).toBeUndefined();
	});

	it("allows alphanumeric session ids with interior punctuation", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "abc-123_def.456" });
		expect(session.getSessionId()).toBe("abc-123_def.456");
	});

	it("rejects invalid custom session ids", () => {
		const invalidIds = ["", "-abc", "abc-", "_abc", "abc_", ".abc", "abc.", "abc/def", "abc\\def", "abc def"];

		for (const id of invalidIds) {
			const session = SessionManager.inMemory();
			expect(() => session.newSession({ id })).toThrow(
				"Session id must be non-empty, contain only alphanumeric characters",
			);
		}
	});

	it("generates a UUIDv7 id when no id is provided", () => {
		const session = SessionManager.inMemory();
		session.newSession();
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("generates a UUIDv7 id when options is provided without id", () => {
		const session = SessionManager.inMemory();
		session.newSession({ parentSession: "parent.jsonl" });
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("includes the custom id in the session header", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "header-test-id" });

		const header = session.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toBe("header-test-id");
	});

	it("generates a UUIDv7 id when constructed without an explicit id", () => {
		const session = SessionManager.inMemory();
		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("uses the provided id when creating a persisted session", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		const session = SessionManager.create(tempDir, tempDir, { id: "created-session-id" });

		expect(session.getSessionId()).toBe("created-session-id");
		expect(session.getHeader()!.id).toBe("created-session-id");
		const sessionFile = session.getSessionFile()!;
		expect(sessionFile).toContain("created-session-id");
		expect(basename(sessionFile)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_created-session-id\.jsonl$/);
		expect(existsSync(sessionFile)).toBe(false);
	});

	it("generates a UUIDv7 id when creating a branched session", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});

		const generationBeforeBranch = session.getGeneration();
		session.createBranchedSession(firstId);

		expect(session.getGeneration()).toBeGreaterThan(generationBeforeBranch);
		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("generates a UUIDv7 id when forking from another session file", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		const sourcePath = join(tempDir, "source.jsonl");
		writeFileSync(
			sourcePath,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "legacy-session-id",
					timestamp: new Date().toISOString(),
					cwd: tempDir,
				}),
				JSON.stringify({
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.4",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				}),
			].join("\n")}
`,
		);

		const forked = SessionManager.forkFrom(sourcePath, tempDir, tempDir);
		const header = forked.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toMatch(UUID_V7_RE);
		expect(forked.getSessionId()).toBe(header!.id);
		expect(header!.parentSession).toBe(sourcePath);
	});

	it("uses the provided id when forking from another session file", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		const sourcePath = join(tempDir, "source.jsonl");
		writeFileSync(
			sourcePath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "source-session-id",
				timestamp: new Date().toISOString(),
				cwd: tempDir,
			})}\n`,
		);

		const forked = SessionManager.forkFrom(sourcePath, tempDir, tempDir, { id: "forked-session-id" });
		const header = forked.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toBe("forked-session-id");
		expect(header!.parentSession).toBe(sourcePath);
		const sessionFile = forked.getSessionFile()!;
		expect(sessionFile).toContain("forked-session-id");
		expect(basename(sessionFile)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_forked-session-id\.jsonl$/);
	});
});

describe("SessionManager.forkFrom", () => {
	it.each([true, false])(
		"keeps default/custom fork identities consistent before and after append and export (compressed=%s)",
		(compressSessions) => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-fork-identity-"));
			try {
				const source = SessionManager.create(tempDir, tempDir, { compressSessions: false });
				source.appendMessage({ role: "user", content: "source", timestamp: 1 });
				for (const id of [undefined, "custom-fork-id"]) {
					const forked = SessionManager.forkFrom(source.getSessionFile()!, tempDir, tempDir, {
						id,
						compressSessions,
					});
					const expectedId = forked.getHeader()!.id;
					const path = forked.getSessionFile()!;
					for (const append of [false, true]) {
						if (append) forked.appendMessage({ role: "user", content: "after fork", timestamp: 2 });
						expect(forked.getSessionId()).toBe(expectedId);
						expect(basename(path)).toContain(`_${expectedId}.jsonl`);
						expect(SessionManager.findById(tempDir, expectedId, tempDir)).toBe(path);
						expect(SessionManager.open(path).getSessionId()).toBe(expectedId);
						expect(JSON.parse(serializeSessionBranch(forked).split("\n")[0]).id).toBe(expectedId);
					}
				}
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);

	it("copies all entries unchanged into the forked session", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		try {
			const sourcePath = join(tempDir, "source.jsonl");
			const lines = [
				JSON.stringify({
					type: "session",
					version: 3,
					id: "source-id",
					timestamp: new Date().toISOString(),
					cwd: tempDir,
				}),
			];
			let parentId: string | null = null;
			for (let i = 0; i < 50; i++) {
				const id = `e${i}`;
				lines.push(
					JSON.stringify({
						type: "message",
						id,
						parentId,
						timestamp: new Date().toISOString(),
						message: { role: "user", content: `message ${i}`, timestamp: 0 },
					}),
				);
				parentId = id;
			}
			writeFileSync(sourcePath, `${lines.join("\n")}\n`);

			const forked = SessionManager.forkFrom(sourcePath, tempDir, join(tempDir, "sessions"));

			const written = loadEntriesFromFile(forked.getSessionFile()!);
			expect(written).toHaveLength(51);
			expect(written[0]).toMatchObject({ parentSession: sourcePath });
			expect(written.slice(1)).toEqual(lines.slice(1).map((line) => JSON.parse(line)));
			expect(forked.getEntries()).toHaveLength(50);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
