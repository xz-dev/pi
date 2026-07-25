import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionPersistenceOperations } from "../../src/core/session-manager.ts";

const cleanup: string[] = [];

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
	};
}

function faultOperations(point: "open" | "write" | "fsync" | "close" | "rename") {
	let armed = false;
	let wrote = false;
	const operations: SessionPersistenceOperations = {
		open(path, flags) {
			if (armed && point === "open") throw new Error("injected staged open failure");
			return openSync(path, flags);
		},
		write(fd, data) {
			writeFileSync(fd, data);
			wrote = true;
			if (armed && point === "write") throw new Error("injected staged write failure");
		},
		fsync(fd) {
			if (armed && point === "fsync") throw new Error("injected staged fsync failure");
			fsyncSync(fd);
		},
		close(fd) {
			closeSync(fd);
			if (armed && point === "close") throw new Error("injected staged close failure");
		},
		rename(source, target) {
			if (armed && point === "rename") throw new Error("injected staged rename failure");
			renameSync(source, target);
		},
		link(source, target) {
			if (armed && point === "rename") throw new Error("injected staged rename failure");
			linkSync(source, target);
		},
		unlink: unlinkSync,
	};
	return {
		operations,
		arm() {
			armed = true;
			wrote = false;
		},
		disarm() {
			armed = false;
		},
		wasWritten() {
			return wrote;
		},
	};
}

function tempResidue(dir: string): string[] {
	return readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

afterEach(() => {
	while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("SessionManager atomic persistence", () => {
	it.each(["open", "write", "fsync", "close", "rename"] as const)(
		"keeps an initial session nonexistent after a staged %s failure and permits retry",
		(point) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-session-atomic-initial-"));
			cleanup.push(dir);
			const fault = faultOperations(point);
			const manager = SessionManager.create(dir, dir, undefined, fault.operations);
			const userId = manager.appendMessage({ role: "user", content: "visible user", timestamp: 1 });
			const before = structuredClone(manager.getEntries());
			const stateBefore = manager.captureCompactionBoundaryAppendState();
			const sessionFile = manager.getSessionFile()!;
			fault.arm();

			expect(() => manager.appendMessage(assistant("first attempt"))).toThrow(`injected staged ${point} failure`);
			expect(fault.wasWritten()).toBe(point !== "open");
			expect(existsSync(sessionFile)).toBe(false);
			expect(tempResidue(dir)).toEqual([]);
			expect(manager.getEntries()).toEqual(before);
			expect(manager.getEntry(userId)).toEqual(before[0]);
			expect(manager.getLeafId()).toBe(userId);
			expect(manager.captureCompactionBoundaryAppendState()).toEqual(stateBefore);

			fault.disarm();
			manager.appendMessage(assistant("retry succeeds"));
			expect(readFileSync(sessionFile, "utf8")).toContain("retry succeeds");
		},
	);

	it.each(["open", "write", "fsync", "close", "rename"] as const)(
		"keeps an existing session byte-identical after a staged %s failure and permits retry",
		(point) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-session-atomic-append-"));
			cleanup.push(dir);
			const fault = faultOperations(point);
			const manager = SessionManager.create(dir, dir, undefined, fault.operations);
			manager.appendMessage({ role: "user", content: "visible user", timestamp: 1 });
			manager.appendMessage(assistant("existing assistant"));
			const sessionFile = manager.getSessionFile()!;
			const diskBefore = readFileSync(sessionFile);
			const memoryBefore = structuredClone(manager.getEntries());
			const stateBefore = manager.captureCompactionBoundaryAppendState();
			fault.arm();

			expect(() => manager.appendMessage(assistant("failed append"))).toThrow(`injected staged ${point} failure`);
			expect(fault.wasWritten()).toBe(point !== "open");
			expect(readFileSync(sessionFile)).toEqual(diskBefore);
			expect(tempResidue(dir)).toEqual([]);
			expect(manager.getEntries()).toEqual(memoryBefore);
			expect(manager.getLeafId()).toBe(stateBefore.branch);
			expect(manager.captureCompactionBoundaryAppendState()).toEqual(stateBefore);

			fault.disarm();
			manager.appendMessage(assistant("retry succeeds"));
			expect(readFileSync(sessionFile, "utf8")).toContain("retry succeeds");
		},
	);

	it("does not remove an existing temporary-path collision that it did not create", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-atomic-collision-"));
		cleanup.push(dir);
		let collidedPath: string | undefined;
		const operations: SessionPersistenceOperations = {
			open(path) {
				collidedPath = path;
				writeFileSync(path, "must survive");
				const error = new Error("injected temporary collision");
				Object.assign(error, { code: "EEXIST" });
				throw error;
			},
			write: writeFileSync,
			fsync: fsyncSync,
			close: closeSync,
			rename: renameSync,
			link: linkSync,
			unlink: unlinkSync,
		};
		const manager = SessionManager.create(dir, dir, undefined, operations);
		manager.appendMessage({ role: "user", content: "visible user", timestamp: 1 });

		expect(() => manager.appendMessage(assistant("collision attempt"))).toThrow("injected temporary collision");
		if (!collidedPath) throw new Error("temporary path was not captured");
		expect(readFileSync(collidedPath, "utf8")).toBe("must survive");
		expect(manager.getEntries()).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")("creates the first persisted session with mode 0600", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-private-mode-initial-"));
		cleanup.push(dir);
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "visible user", timestamp: 1 });
		manager.appendMessage(assistant("private first flush"));

		expect(statSync(manager.getSessionFile()!).mode & 0o777).toBe(0o600);
	});

	it.skipIf(process.platform === "win32")("keeps an existing private session at mode 0600 after replacement", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-private-mode-replace-"));
		cleanup.push(dir);
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "visible user", timestamp: 1 });
		manager.appendMessage(assistant("initial private mode"));
		const sessionFile = manager.getSessionFile()!;
		expect(statSync(sessionFile).mode & 0o777).toBe(0o600);

		manager.appendMessage(assistant("replacement private mode"));

		expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
	});

	it("opens every staged temporary session file with explicit mode 0600", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-private-temp-mode-"));
		cleanup.push(dir);
		const observedModes: Array<number | undefined> = [];
		const operations: SessionPersistenceOperations = {
			open(path, flags, mode) {
				observedModes.push(mode);
				return openSync(path, flags, mode);
			},
			write: writeFileSync,
			fsync: fsyncSync,
			close: closeSync,
			rename: renameSync,
			link: linkSync,
			unlink: unlinkSync,
		};
		const manager = SessionManager.create(dir, dir, undefined, operations);
		manager.appendMessage({ role: "user", content: "visible user", timestamp: 1 });
		manager.appendMessage(assistant("private staging"));
		manager.appendMessage(assistant("private replacement staging"));

		expect(observedModes).toEqual([0o600, 0o600]);
	});

	it("keeps a successful first flush committed when temporary cleanup fails once after linking", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-atomic-post-link-cleanup-"));
		cleanup.push(dir);
		let failCleanupOnce = true;
		const operations: SessionPersistenceOperations = {
			open: openSync,
			write: writeFileSync,
			fsync: fsyncSync,
			close: closeSync,
			rename: renameSync,
			link: linkSync,
			unlink(path) {
				if (failCleanupOnce && path.includes(".tmp-")) {
					failCleanupOnce = false;
					throw new Error("injected post-link cleanup failure");
				}
				unlinkSync(path);
			},
		};
		const manager = SessionManager.create(dir, dir, undefined, operations);
		manager.appendMessage({ role: "user", content: "visible user", timestamp: 1 });

		expect(() => manager.appendMessage(assistant("committed assistant"))).not.toThrow();
		const sessionFile = manager.getSessionFile()!;
		expect(readFileSync(sessionFile, "utf8")).toContain("committed assistant");
		expect(manager.getEntries()).toHaveLength(2);
		expect(tempResidue(dir)).toEqual([]);
	});

	it("keeps in-memory managers independent from disk persistence", () => {
		const manager = SessionManager.inMemory(process.cwd());

		manager.appendMessage({ role: "user", content: "visible user", timestamp: 1 });
		manager.appendMessage(assistant("in memory"));

		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.getEntries()).toHaveLength(2);
		expect(manager.getLeafEntry()).toMatchObject({ type: "message", message: { role: "assistant" } });
	});
});
