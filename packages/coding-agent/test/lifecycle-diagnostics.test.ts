import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectTrustContext } from "../src/cli/project-trust.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner, emitProjectTrustEvent } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
	SlowExtensionHookEntry,
} from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const extensionActions: ExtensionActions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	spliceEntry: () => {},
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

describe("transient extension timing diagnostics", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hook-timing-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		Reflect.deleteProperty(globalThis, "__piThenReads");
		Reflect.deleteProperty(globalThis, "__piThrowingThenReads");
		vi.useRealTimers();
	});

	async function createRunner(source: string, threshold: () => number = () => -1) {
		const extensionPath = path.join(tempDir, "extension.ts");
		fs.writeFileSync(extensionPath, source);
		const result = await loadExtensions([extensionPath], tempDir);
		const sessionManager = SessionManager.inMemory();
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir,
			sessionManager,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			threshold,
		);
		runner.bindCore(extensionActions, extensionContextActions);
		return { extensionPath, result, runner, sessionManager };
	}

	const stubUi = {} as ExtensionUIContext;

	function bindNotices(runner: ExtensionRunner, mode: "tui" | "rpc" | "print" = "tui", ui?: ExtensionUIContext) {
		const notices: SlowExtensionHookEntry[] = [];
		runner.setUIContext(ui, mode);
		runner.setSlowHookSink((entry) => notices.push(entry));
		return notices;
	}

	it("prints sync and async slow hooks only in TUI without session or disk persistence", async () => {
		const { extensionPath, runner, sessionManager } = await createRunner(`export default function(pi) {
			pi.on("input", () => ({ action: "transform", text: "sync" }));
			pi.on("input", () => Promise.resolve({ action: "transform", text: "thenable" }));
			pi.on("input", async () => ({ action: "transform", text: "async" }));
			pi.on("input", () => { throw new Error("sync failure"); });
		}`);
		const notices = bindNotices(runner, "tui", stubUi);
		const errors: string[] = [];
		runner.onError((error) => errors.push(error.error));

		await expect(runner.emitInput("original", undefined, "interactive")).resolves.toMatchObject({
			action: "transform",
			text: "async",
		});

		expect(notices).toEqual([
			expect.objectContaining({ event: "input", extensionPath, handlerIndex: 0, executionKind: "sync" }),
			expect.objectContaining({ event: "input", extensionPath, handlerIndex: 1, executionKind: "async" }),
			expect.objectContaining({ event: "input", extensionPath, handlerIndex: 2, executionKind: "async" }),
			expect.objectContaining({ event: "input", extensionPath, handlerIndex: 3, executionKind: "sync" }),
		]);
		expect(errors).toEqual(["sync failure"]);
		expect(sessionManager.getEntries()).toEqual([]);
		expect(sessionManager.buildSessionContext().messages).toEqual([]);
		expect(fs.existsSync(path.join(tempDir, "logs", "extension-lifecycle.jsonl"))).toBe(false);
	});

	it("emits no timing diagnostics when TUI mode has no real UI", async () => {
		const { runner, sessionManager } = await createRunner(
			`export default function(pi) { pi.on("input", async () => ({ action: "handled" })); }`,
		);
		const notices = bindNotices(runner, "tui");

		await expect(runner.emitInput("original", undefined, "interactive")).resolves.toEqual({ action: "handled" });

		expect(notices).toEqual([]);
		expect(sessionManager.getEntries()).toEqual([]);
		expect(fs.existsSync(path.join(tempDir, "logs", "extension-lifecycle.jsonl"))).toBe(false);
	});

	it("emits one TUI notice when a real UI context is bound", async () => {
		const { runner, sessionManager } = await createRunner(
			`export default function(pi) { pi.on("input", async () => ({ action: "handled" })); }`,
		);
		const notices = bindNotices(runner, "tui", stubUi);

		await expect(runner.emitInput("original", undefined, "interactive")).resolves.toEqual({ action: "handled" });

		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ event: "input", executionKind: "async" });
		expect(sessionManager.getEntries()).toEqual([]);
	});

	it("emits no timing diagnostics in RPC or print even with a UI stub", async () => {
		const source = `export default function(pi) { pi.on("input", async () => ({ action: "handled" })); }`;
		for (const mode of ["rpc", "print"] as const) {
			const { runner, sessionManager } = await createRunner(source);
			const notices = bindNotices(runner, mode, stubUi);

			await expect(runner.emitInput("original", undefined, "interactive")).resolves.toEqual({ action: "handled" });

			expect(notices, mode).toEqual([]);
			expect(sessionManager.getEntries()).toEqual([]);
		}
	});

	it("keeps strict slow-hook threshold", async () => {
		vi.useFakeTimers();
		const { runner, sessionManager } = await createRunner(
			`export default function(pi) { pi.on("input", async () => { await new Promise((resolve) => setTimeout(resolve, 100)); }); }`,
			() => 100,
		);
		const notices = bindNotices(runner, "tui", stubUi);

		const input = runner.emitInput("original", undefined, "interactive");
		await vi.advanceTimersByTimeAsync(100);
		await input;

		expect(notices).toEqual([]);
		expect(sessionManager.getEntries()).toEqual([]);
	});

	it("assimilates custom thenables once without changing results or errors", async () => {
		const { runner } = await createRunner(`export default function(pi) {
			pi.on("input", () => ({
				get then() {
					Reflect.set(globalThis, "__piThenReads", Reflect.get(globalThis, "__piThenReads") + 1);
					return (resolve) => resolve({ action: "transform", text: "assimilated" });
				},
			}));
			pi.on("input", () => ({
				get then() {
					Reflect.set(globalThis, "__piThrowingThenReads", Reflect.get(globalThis, "__piThrowingThenReads") + 1);
					throw new Error("then getter failure");
				},
			}));
		}`);
		Reflect.set(globalThis, "__piThenReads", 0);
		Reflect.set(globalThis, "__piThrowingThenReads", 0);
		bindNotices(runner, "tui", stubUi);
		const errors: string[] = [];
		runner.onError((error) => errors.push(error.error));

		await expect(runner.emitInput("original", undefined, "interactive")).resolves.toMatchObject({
			action: "transform",
			text: "assimilated",
		});

		expect(Reflect.get(globalThis, "__piThenReads")).toBe(1);
		expect(Reflect.get(globalThis, "__piThrowingThenReads")).toBe(1);
		expect(errors).toEqual(["then getter failure"]);
	});

	it("keeps ctx.appendEntry semantics for extension-authored entries", async () => {
		const { runner, sessionManager } = await createRunner(
			`export default function(pi) { pi.on("input", () => { pi.appendEntry("note", { text: "kept" }); return { action: "handled" }; }); }`,
		);
		const notices = bindNotices(runner, "tui", stubUi);
		runner.bindCore(
			{
				...extensionActions,
				appendEntry: (customType, data) => {
					sessionManager.appendCustomEntry(customType, data);
				},
			},
			extensionContextActions,
		);

		await expect(runner.emitInput("original", undefined, "interactive")).resolves.toEqual({ action: "handled" });

		expect(notices).toHaveLength(1);
		expect(sessionManager.getEntries()).toEqual([
			expect.objectContaining({ type: "custom", customType: "note", data: { text: "kept" } }),
		]);
	});

	it("production project-trust factory presents notices only for interactive UI", async () => {
		const { result } = await createRunner(
			`export default function(pi) { pi.on("project_trust", async () => ({ trusted: "yes" })); }`,
		);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const settingsManager = { getThemeSetting: () => undefined } as never;

		for (const [mode, hasUI, expected] of [
			["interactive", true, 1],
			["print", false, 0],
			["rpc", false, 0],
		] as const) {
			const ctx = createProjectTrustContext({ cwd: tempDir, mode, settingsManager, hasUI });
			await emitProjectTrustEvent(result, { type: "project_trust", cwd: tempDir }, ctx, -1);
			expect(error.mock.calls, mode).toHaveLength(expected);
			error.mockClear();
		}
	});

	it("keeps TUI sinks on the replacement runner before reload lifecycle hooks", async () => {
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: path.join(tempDir, "models.json"),
		});
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async () => {});
						pi.on("resources_discover", async () => ({}));
						pi.on("session_shutdown", async () => {});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		session.settingsManager.getSlowHookThresholdMs = () => -1;
		const slowEvents: string[] = [];
		const shutdownEvents: string[] = [];
		await session.bindExtensions({
			uiContext: stubUi,
			mode: "tui",
			onSlowHook: (entry) => slowEvents.push(entry.event),
			onShutdownProgress: (entry) => shutdownEvents.push(entry.status),
		});
		slowEvents.length = 0;
		shutdownEvents.length = 0;

		await session.reload();

		expect(shutdownEvents).toEqual(["start", "end"]);
		expect(slowEvents).toEqual(["session_start", "resources_discover"]);
		session.dispose();
	});

	it("continues hooks when threshold parsing fails", async () => {
		const { runner } = await createRunner(
			`export default function(pi) { pi.on("tool_call", async () => ({ block: true, reason: "hook result" })); }`,
			() => {
				throw new Error("invalid diagnostic threshold");
			},
		);
		bindNotices(runner);

		await expect(
			runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "call-1", input: {} }),
		).resolves.toEqual({ block: true, reason: "hook result" });
	});
});
