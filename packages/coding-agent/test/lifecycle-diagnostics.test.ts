import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const cryptoState = vi.hoisted(() => ({ failRandomUUID: false }));

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		randomUUID: (...args: Parameters<typeof actual.randomUUID>) => {
			if (cryptoState.failRandomUUID) throw new Error("diagnostic setup unavailable");
			return actual.randomUUID(...args);
		},
	};
});

const extensionActions: ExtensionActions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: () => {},
	refreshTools: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
};

const extensionContextActions: ExtensionContextActions = {
	getModel: () => undefined,
	getScopedModels: () => [],
	isIdle: () => true,
	isProjectTrusted: () => true,
	getSignal: () => undefined,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: () => {},
	getSystemPrompt: () => "",
};

describe("extension lifecycle diagnostics", () => {
	let tempDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lifecycle-test-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tempDir;
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		cryptoState.failRandomUUID = false;
		vi.useRealTimers();
	});

	it("records module import and factory lifecycle without private error content", async () => {
		const extensionPath = path.join(tempDir, "private-load.ts");
		fs.writeFileSync(
			extensionPath,
			`await new Promise((resolve) => setTimeout(resolve, 1)); export default async function() { throw new Error("private factory detail"); }`,
		);

		await loadExtensions([extensionPath], tempDir);

		const logPath = path.join(tempDir, "logs", "extension-lifecycle.jsonl");
		const text = fs.readFileSync(logPath, "utf8");
		const entries = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(entries.map((entry) => [entry.operation, entry.status])).toEqual([
			["module_import", "start"],
			["module_import", "end"],
			["extension_factory", "start"],
			["extension_factory", "error"],
		]);
		expect(entries.every((entry) => entry.extensionPath === extensionPath && entry.pid === process.pid)).toBe(true);
		expect(text).not.toContain("private factory detail");
	});

	it("preserves factory and handler behavior when lifecycle setup fails", async () => {
		const extensionPath = path.join(tempDir, "failed-setup.ts");
		fs.writeFileSync(
			extensionPath,
			`export default function(pi) { pi.on("input", async () => ({ action: "handled" })); }`,
		);
		cryptoState.failRandomUUID = true;

		const result = await loadExtensions([extensionPath], tempDir);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);

		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir,
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		runner.bindCore(extensionActions, extensionContextActions);
		await expect(runner.emitInput("original", undefined, "interactive")).resolves.toEqual({ action: "handled" });
	});

	it("reports one slow entry per awaited handler and preserves hook results", async () => {
		vi.useFakeTimers();
		const extensionPath = path.join(tempDir, "slow.ts");
		fs.writeFileSync(
			extensionPath,
			`export default function(pi) {
				pi.on("input", async () => { await new Promise((resolve) => setTimeout(resolve, 101)); return { action: "transform", text: "transformed" }; });
				pi.on("input", async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
			}`,
		);
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
		runner.bindCore(extensionActions, extensionContextActions);

		const input = runner.emitInput("original", undefined, "interactive");
		await vi.advanceTimersByTimeAsync(201);
		await expect(input).resolves.toMatchObject({ action: "transform", text: "transformed" });

		const entries = sessionManager.getEntries().filter((entry) => entry.type === "custom");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: "custom",
			customType: "pi.extension_hook_slow",
			data: { event: "input", extensionPath, handlerIndex: 0, elapsedMs: 101 },
		});
		expect(sessionManager.buildSessionContext().messages).toEqual([]);
	});

	it("logs and reports startup handlers through the normal runner", async () => {
		vi.useFakeTimers();
		const extensionPath = path.join(tempDir, "startup.ts");
		fs.writeFileSync(
			extensionPath,
			`export default function(pi) { pi.on("session_start", async () => { await new Promise((resolve) => setTimeout(resolve, 101)); }); }`,
		);
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
		runner.bindCore(extensionActions, extensionContextActions);

		const startup = runner.emit({ type: "session_start", reason: "startup" });
		await vi.advanceTimersByTimeAsync(101);
		await startup;

		const entries = fs
			.readFileSync(path.join(tempDir, "logs", "extension-lifecycle.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => entry.operation === "session_start");
		expect(entries.map((entry) => entry.status)).toEqual(["start", "end"]);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(1);
	});

	it("continues hooks when diagnostic persistence fails", async () => {
		vi.useFakeTimers();
		const extensionPath = path.join(tempDir, "unwritable.ts");
		fs.writeFileSync(
			extensionPath,
			`export default function(pi) { pi.on("input", async () => { await new Promise((resolve) => setTimeout(resolve, 101)); return { action: "handled" }; }); }`,
		);
		const result = await loadExtensions([extensionPath], tempDir);
		const sessionManager = SessionManager.inMemory();
		vi.spyOn(sessionManager, "appendCustomEntry").mockImplementation(() => {
			throw new Error("diagnostic storage unavailable");
		});
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir,
			sessionManager,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			() => 100,
		);
		runner.bindCore(extensionActions, extensionContextActions);

		const input = runner.emitInput("original", undefined, "interactive");
		await vi.advanceTimersByTimeAsync(101);
		await expect(input).resolves.toEqual({ action: "handled" });
	});

	it("continues hooks when threshold parsing fails", async () => {
		const extensionPath = path.join(tempDir, "invalid-threshold.ts");
		fs.writeFileSync(
			extensionPath,
			`export default function(pi) { pi.on("tool_call", async () => ({ block: true, reason: "hook result" })); }`,
		);
		const result = await loadExtensions([extensionPath], tempDir);
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir,
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			() => {
				throw new Error("invalid diagnostic threshold");
			},
		);
		runner.bindCore(extensionActions, extensionContextActions);

		await expect(
			runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "call-1", input: {} }),
		).resolves.toEqual({ block: true, reason: "hook result" });
	});
});
