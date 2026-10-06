import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import {
	ExtensionRunner,
	type ExtensionShutdownProgress,
	emitSessionShutdownEvent,
	formatSlowExtensionHook,
} from "../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	createInteractiveShutdownProgressWriter,
	formatShutdownProgressLine,
} from "../src/modes/interactive/shutdown-progress.ts";
import { sanitizeTerminalSingleLine } from "../src/utils/ansi.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

function visibleText(chunk: string): string {
	return stripAnsi(chunk).replace(/\n$/, "");
}

describe("sanitizeTerminalSingleLine", () => {
	const token = "private-token";
	const families = [
		{ name: "OSC", esc: "\x1b]", c1: "\x9d", command: "52;c;" },
		{ name: "DCS", esc: "\x1bP", c1: "\x90", command: "1$r" },
		{ name: "SOS", esc: "\x1bX", c1: "\x98", command: "!" },
		{ name: "PM", esc: "\x1b^", c1: "\x9e", command: "pmcmd" },
		{ name: "APC", esc: "\x1b_", c1: "\x9f", command: "%" },
	] as const;
	const terminators = ["\x07", "\x1b\\", "\x9c"] as const;

	function expectClean(value: string, command: string): void {
		expect(value).not.toContain(token);
		expect(value).not.toContain(command);
		expect(value).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
	}

	it("strips OSC/DCS/SOS/PM/APC for ESC and C1, BEL/ST/end, then controls", () => {
		for (const family of families) {
			for (const intro of [family.esc, family.c1]) {
				for (const st of terminators) {
					const sanitized = sanitizeTerminalSingleLine(`/tmp/${intro}${family.command}${token}${st}leak.ts`);
					expect(sanitized, `${family.name} terminated`).toBe("/tmp/leak.ts");
					expectClean(sanitized, family.command);
					const formatted = formatSlowExtensionHook({
						event: "session_shutdown",
						extensionPath: `/tmp/${intro}${family.command}${token}${st}leak.ts`,
						handlerIndex: 0,
						elapsedMs: 150,
						executionKind: "async",
					});
					expect(formatted).toBe("Slow async extension hook: session_shutdown · /tmp/leak.ts#0 · 150 ms");
					expectClean(formatted, family.command);
				}
				const unterminated = sanitizeTerminalSingleLine(`/tmp/${intro}${family.command}${token}leak.ts`);
				expect(unterminated).toBe("/tmp/");
				expectClean(unterminated, family.command);
			}
		}
	});

	it("keeps normal Unicode after collapsing controls and whitespace", () => {
		expect(sanitizeTerminalSingleLine("caf\u00e9\t\u4e2d\u6587\npath")).toBe("caf\u00e9 \u4e2d\u6587 path");
	});
});

describe("interactive shutdown progress", () => {
	it("formats a sanitized current line and a compact slow line", () => {
		const start: ExtensionShutdownProgress = {
			status: "start",
			extensionPath: "/tmp/private/\x9d52;c;c2VjcmV0\x9cslow.ts",
			handlerIndex: 2,
		};
		const slow: ExtensionShutdownProgress = {
			status: "error",
			extensionPath: start.extensionPath,
			handlerIndex: 2,
			elapsedMs: 143.4,
			slow: true,
		};
		expect(stripAnsi(formatShutdownProgressLine(start))).toBe("Shutting down: slow.ts#2");
		expect(stripAnsi(formatShutdownProgressLine(slow))).toBe("Slow shutdown hook: slow.ts#2 · 143 ms");
		expect(formatShutdownProgressLine(start)).not.toContain("c2VjcmV0");
		expect(formatShutdownProgressLine(slow)).not.toContain("private shutdown detail");
	});

	it("shows the current handler, erases fast work, and retains only slow lines", () => {
		const writes: string[] = [];
		const writer = createInteractiveShutdownProgressWriter(
			(chunk) => {
				writes.push(chunk);
			},
			() => 80,
		);
		const start0: ExtensionShutdownProgress = {
			status: "start",
			extensionPath: "/tmp/fast.ts",
			handlerIndex: 0,
		};
		const end0: ExtensionShutdownProgress = {
			status: "end",
			extensionPath: "/tmp/fast.ts",
			handlerIndex: 0,
			elapsedMs: 12,
			slow: false,
		};
		const start1: ExtensionShutdownProgress = {
			status: "start",
			extensionPath: "/tmp/slow.ts",
			handlerIndex: 1,
		};
		const end1: ExtensionShutdownProgress = {
			status: "end",
			extensionPath: "/tmp/slow.ts",
			handlerIndex: 1,
			elapsedMs: 30041,
			slow: true,
		};

		writer.write(start0);
		expect(stripAnsi(writes.at(-1) ?? "")).toContain("Shutting down: fast.ts#0");
		expect(writes.at(-1)).toMatch(/^\r\x1b\[2K/);
		expect(writes.at(-1)?.endsWith("\n")).toBe(false);

		writer.write(end0);
		expect(writes.at(-1)).toBe("\r\x1b[2K");

		writer.write(start1);
		writer.write(end1);
		expect(stripAnsi(writes.at(-1) ?? "")).toContain("Slow shutdown hook: slow.ts#1 · 30041 ms");
		expect(writes.at(-1)?.startsWith("\r\x1b[2K")).toBe(true);
		expect(writes.at(-1)?.endsWith("\n")).toBe(true);

		const retained = writes.filter((chunk) => chunk.endsWith("\n")).map((chunk) => stripAnsi(chunk));
		expect(retained).toEqual(["Slow shutdown hook: slow.ts#1 · 30041 ms\n"]);
	});

	it("bounds each progress line below the current terminal columns so a fast clear leaves no wrap residue", () => {
		const writes: string[] = [];
		const columns = 24;
		const writer = createInteractiveShutdownProgressWriter(
			(chunk) => {
				writes.push(chunk);
			},
			() => columns,
		);
		const extensionPath = "/tmp/pi-shutdown-screen-log.ts";
		writer.write({
			status: "start",
			extensionPath,
			handlerIndex: 0,
		});
		const startVisible = visibleText(writes.at(-1) ?? "");
		expect(visibleWidth(startVisible)).toBeLessThan(columns);
		expect(startVisible).toContain("#0");
		expect(startVisible).toMatch(/pi-/);
		expect(startVisible).not.toContain("\n");

		writer.write({
			status: "end",
			extensionPath,
			handlerIndex: 0,
			elapsedMs: 8,
			slow: false,
		});
		expect(writes.at(-1)).toBe("\r\x1b[2K");

		writer.write({
			status: "start",
			extensionPath,
			handlerIndex: 0,
		});
		writer.write({
			status: "end",
			extensionPath,
			handlerIndex: 0,
			elapsedMs: 351,
			slow: true,
		});
		const retained = writes.at(-1) ?? "";
		const retainedVisible = visibleText(retained);
		expect(retained.startsWith("\r\x1b[2K")).toBe(true);
		expect(retained.endsWith("\n")).toBe(true);
		expect(visibleWidth(retainedVisible)).toBeLessThan(columns);
		expect(retainedVisible).toContain("#0");
		expect(retainedVisible).toContain("351 ms");
		expect(retainedVisible).toMatch(/pi-/);
		expect(retainedVisible).not.toContain("\n");

		const tiny = createInteractiveShutdownProgressWriter(
			(chunk) => {
				writes.push(chunk);
			},
			() => 4,
		);
		tiny.write({
			status: "end",
			extensionPath,
			handlerIndex: 0,
			elapsedMs: 351,
			slow: true,
		});
		const tinyVisible = visibleText(writes.at(-1) ?? "");
		expect(visibleWidth(tinyVisible)).toBeLessThan(4);
		expect(tinyVisible).not.toContain("\n");
	});

	it("never prints handler errors, payloads, or OSC secrets", () => {
		const writes: string[] = [];
		const writer = createInteractiveShutdownProgressWriter(
			(chunk) => {
				writes.push(chunk);
			},
			() => 80,
		);
		writer.write({
			status: "start",
			extensionPath: "/tmp/\x1b]52;c;c2VjcmV0\x07leak.ts",
			handlerIndex: 0,
		});
		writer.write({
			status: "error",
			extensionPath: "/tmp/\x1b]52;c;c2VjcmV0\x07leak.ts",
			handlerIndex: 0,
			elapsedMs: 250,
			slow: true,
		});
		const output = writes.join("");
		expect(output).not.toContain("c2VjcmV0");
		expect(output).not.toContain("secret");
		expect(output).not.toContain("token");
		expect(output).not.toContain("Error");
		expect(stripAnsi(output)).toContain("Slow shutdown hook: leak.ts#0 · 250 ms");
	});

	it("strips every ECMA-48 string-control family before basename normalization", () => {
		const token = "private-token";
		const families = [
			{ name: "OSC", esc: "\x1b]", c1: "\x9d", command: "52;c;" },
			{ name: "DCS", esc: "\x1bP", c1: "\x90", command: "1$r" },
			{ name: "SOS", esc: "\x1bX", c1: "\x98", command: "!" },
			{ name: "PM", esc: "\x1b^", c1: "\x9e", command: "pmcmd" },
			{ name: "APC", esc: "\x1b_", c1: "\x9f", command: "%" },
		] as const;
		const terminators = ["\x07", "\x1b\\", "\x9c"] as const;

		function expectClean(line: string, command: string): void {
			expect(line).not.toContain(token);
			expect(line).not.toContain(command);
			expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
			expect(line).not.toMatch(/\x1b[P\]X^_]|[\x90\x98\x9d\x9e\x9f]/);
		}

		for (const family of families) {
			for (const intro of [family.esc, family.c1]) {
				for (const st of terminators) {
					const line = formatShutdownProgressLine({
						status: "start",
						extensionPath: `/tmp/${intro}${family.command}${token}${st}leak.ts`,
						handlerIndex: 0,
					});
					expect(line, `${family.name} terminated`).toBe("Shutting down: leak.ts#0");
					expectClean(line, family.command);
				}
				const unterminated = formatShutdownProgressLine({
					status: "start",
					extensionPath: `/tmp/${intro}${family.command}${token}leak.ts`,
					handlerIndex: 0,
				});
				expectClean(unterminated, family.command);
				expect(unterminated.startsWith("Shutting down: ")).toBe(true);
			}
		}
	});
});

describe("ExtensionRunner shutdown progress", () => {
	let tempDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shutdown-progress-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tempDir;
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		vi.restoreAllMocks();
	});

	async function loadShutdownRunner(options?: { listener?: boolean }) {
		const extensionPath = path.join(tempDir, "shutdown.ts");
		fs.writeFileSync(extensionPath, "export default function() {}");
		const result = await loadExtensions([extensionPath], tempDir);
		const sessionManager = SessionManager.inMemory();
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir,
			sessionManager,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			() => 100,
		);
		const progress: ExtensionShutdownProgress[] = [];
		if (options?.listener) {
			runner.setShutdownProgressListener((entry) => {
				progress.push({ ...entry });
			});
		}
		return { extensionPath, result, runner, sessionManager, progress };
	}

	it("emits serial handler progress without writing session, model context, or disk diagnostics", async () => {
		const { extensionPath, result, runner, sessionManager, progress } = await loadShutdownRunner({
			listener: true,
		});
		let releaseFast: (() => void) | undefined;
		let releaseSlow: (() => void) | undefined;
		const fast = new Promise<void>((resolve) => {
			releaseFast = resolve;
		});
		const slow = new Promise<void>((_resolve, reject) => {
			releaseSlow = () => reject(new Error("private shutdown token sk-secret"));
		});
		let now = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		result.extensions[0].handlers.set("session_shutdown", [
			async () => {
				now += 10;
				await fast;
			},
			async () => {
				now += 150;
				await slow;
			},
		]);

		const shutdown = emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "quit" });
		expect(progress).toEqual([
			{
				status: "start",
				extensionPath,
				handlerIndex: 0,
			},
		]);

		releaseFast?.();
		releaseSlow?.();
		await expect(shutdown).resolves.toBe(true);

		expect(progress).toEqual([
			{
				status: "start",
				extensionPath,
				handlerIndex: 0,
			},
			{
				status: "end",
				extensionPath,
				handlerIndex: 0,
				elapsedMs: 10,
				slow: false,
			},
			{
				status: "start",
				extensionPath,
				handlerIndex: 1,
			},
			{
				status: "error",
				extensionPath,
				handlerIndex: 1,
				elapsedMs: 150,
				slow: true,
			},
		]);
		expect(JSON.stringify(progress)).not.toContain("sk-secret");
		expect(sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
		expect(sessionManager.buildSessionContext().messages).toEqual([]);

		expect(fs.existsSync(path.join(tempDir, "logs", "extension-lifecycle.jsonl"))).toBe(false);
	});

	it("uses the TUI sink for slow shutdown when no interactive listener is attached", async () => {
		const { result, runner, sessionManager, progress } = await loadShutdownRunner();
		const notices: Array<{ event: string; executionKind: string }> = [];
		runner.setUIContext({} as ExtensionUIContext, "tui");
		runner.setSlowHookSink((entry) => notices.push({ event: entry.event, executionKind: entry.executionKind }));
		let now = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		result.extensions[0].handlers.set("session_shutdown", [
			async () => {
				now += 150;
			},
		]);

		await expect(emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "reload" })).resolves.toBe(
			true,
		);

		expect(progress).toEqual([]);
		expect(notices).toEqual([{ event: "session_shutdown", executionKind: "async" }]);
		expect(sessionManager.getEntries()).toEqual([]);
		expect(sessionManager.buildSessionContext().messages).toEqual([]);
		expect(fs.existsSync(path.join(tempDir, "logs", "extension-lifecycle.jsonl"))).toBe(false);
	});

	it("keeps no-listener shutdown silent when TUI mode has no real UI", async () => {
		const { result, runner, progress } = await loadShutdownRunner();
		const notices: Array<{ event: string }> = [];
		runner.setUIContext(undefined, "tui");
		runner.setSlowHookSink((entry) => notices.push({ event: entry.event }));
		let now = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		result.extensions[0].handlers.set("session_shutdown", [
			async () => {
				now += 150;
			},
		]);

		await expect(emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "reload" })).resolves.toBe(
			true,
		);
		expect(progress).toEqual([]);
		expect(notices).toEqual([]);
	});

	it("does not duplicate shutdown timing when a listener already rendered it", async () => {
		const { result, runner } = await loadShutdownRunner({ listener: true });
		const notices: Array<{ event: string }> = [];
		runner.setUIContext({} as ExtensionUIContext, "tui");
		runner.setSlowHookSink((entry) => notices.push({ event: entry.event }));
		let now = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		result.extensions[0].handlers.set("session_shutdown", [
			async () => {
				now += 150;
			},
		]);

		await expect(emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "quit" })).resolves.toBe(true);
		expect(notices).toEqual([]);
	});

	it("treats elapsedMs exactly at the threshold as fast and leaves no retained terminal line", async () => {
		const writes: string[] = [];
		const { extensionPath, result, runner, sessionManager } = await loadShutdownRunner();
		const writer = createInteractiveShutdownProgressWriter(
			(chunk) => {
				writes.push(chunk);
			},
			() => 80,
		);
		const progress: ExtensionShutdownProgress[] = [];
		runner.setShutdownProgressListener((entry) => {
			progress.push({ ...entry });
			writer.write(entry);
		});
		let now = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		result.extensions[0].handlers.set("session_shutdown", [
			async () => {
				now += 100;
			},
		]);

		await expect(emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "quit" })).resolves.toBe(true);

		expect(progress).toEqual([
			{
				status: "start",
				extensionPath,
				handlerIndex: 0,
			},
			{
				status: "end",
				extensionPath,
				handlerIndex: 0,
				elapsedMs: 100,
				slow: false,
			},
		]);
		expect(writes.at(-1)).toBe("\r\x1b[2K");
		expect(writes.filter((chunk) => chunk.endsWith("\n"))).toEqual([]);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
		expect(sessionManager.buildSessionContext().messages).toEqual([]);
	});

	it("does not emit shutdown progress for other events", async () => {
		const extensionPath = path.join(tempDir, "startup.ts");
		fs.writeFileSync(extensionPath, `export default function(pi) { pi.on("session_start", async () => {}); }`);
		const result = await loadExtensions([extensionPath], tempDir);
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir,
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		const progress: ExtensionShutdownProgress[] = [];
		runner.setShutdownProgressListener((entry) => progress.push(entry));
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(progress).toEqual([]);
	});
});
