import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode, type InteractiveModeOptions } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, stopThemeWatcher, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

vi.mock("../src/utils/version-check.ts", () => ({ checkForNewPiVersion: async () => undefined }));
vi.mock("../src/core/crash-log.ts", () => ({ takeUnnotifiedCrash: () => undefined }));

interface ModeSeams {
	checkForPackageUpdates(): Promise<string[]>;
	checkTmuxKeyboardSetup(): Promise<string | undefined>;
	maybeWarnAboutAnthropicSubscriptionAuth(): Promise<void>;
	renderWidgets(): void;
	shutdown(): Promise<void>;
	editor: CustomEditor;
	widgetContainerAbove: Container;
	pendingUserInputs: string[];
}

describe("cold-start retry", () => {
	const harnesses: Harness[] = [];
	const modes: InteractiveMode[] = [];
	afterEach(() => {
		for (const mode of modes.splice(0)) mode.stop();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		stopThemeWatcher();
		vi.unstubAllEnvs();
	});

	async function open(
		state: "started" | "finished" | "aborted" | "legacy" = "started",
		extensionFactories?: HarnessOptions["extensionFactories"],
	) {
		const original = await createHarness({
			sessionManagerFactory: (dir) => SessionManager.create(dir, dir),
			settings: { retry: { enabled: false }, theme: "dark" },
		});
		harnesses.push(original);
		original.sessionManager.appendMessage({ role: "user", content: "unfinished task", timestamp: Date.now() });
		original.sessionManager.appendMessage(fauxAssistantMessage("partial", { stopReason: "error" }));
		if (state !== "legacy") {
			const runId = original.sessionManager.appendRunState("started");
			if (state !== "started") original.sessionManager.appendRunState(state, runId);
		}
		const manager = SessionManager.open(original.sessionManager.getSessionFile()!, original.tempDir);
		const restored = await createHarness({
			sessionManager: manager,
			extensionFactories,
			settings: { retry: { enabled: false }, theme: "dark" },
		});
		harnesses.push(restored);
		restored.session.refreshContext();
		restored.setResponses([fauxAssistantMessage("continued")]);
		return restored;
	}

	function ui(harness: Harness, options: InteractiveModeOptions = {}) {
		vi.stubEnv("PI_OFFLINE", "1");
		initTheme("dark");
		let rebind = async () => {};
		const runtime = {
			session: harness.session,
			setBeforeSessionInvalidate: () => {},
			setRebindSession: (fn: () => Promise<void>) => {
				rebind = fn;
			},
			dispose: async () => {
				await AgentSessionRuntime.prototype.dispose.call(runtime as unknown as AgentSessionRuntime);
			},
		};
		const terminal = new VirtualTerminal(80, 24);
		vi.spyOn(terminal, "drainInput").mockResolvedValue();
		const mode = new InteractiveMode(runtime as unknown as AgentSessionRuntime, {
			terminal,
			initialThemeSetting: "dark",
			...options,
		});
		modes.push(mode);
		const seams = mode as unknown as ModeSeams;
		const init = vi.spyOn(mode, "init").mockResolvedValue();
		vi.spyOn(seams, "checkForPackageUpdates").mockResolvedValue([]);
		vi.spyOn(seams, "checkTmuxKeyboardSetup").mockResolvedValue(undefined);
		vi.spyOn(seams, "maybeWarnAboutAnthropicSubscriptionAuth").mockResolvedValue();
		const idle = new Error("test reached the input loop");
		vi.spyOn(mode, "getUserInput").mockRejectedValue(idle);
		return { mode, seams, idle, runtime, init, terminal, rebind: () => rebind() };
	}

	it("continues a reopened unfinished session exactly once before waiting for input", async () => {
		const harness = await open();
		const retry = vi.spyOn(harness.session, "retry");
		const { mode, idle } = ui(harness);
		await expect(mode.run()).rejects.toBe(idle);
		expect(retry).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getInterruptedRun()).toBeUndefined();
	});

	it.each(["regular", "fullscreen"] as const)("recovers after real %s initialization", async (tuiMode) => {
		const harness = await open();
		const { mode, idle, init } = ui(harness, { tuiMode });
		init.mockRestore();
		const retry = vi.spyOn(harness.session, "retry");
		await expect(mode.run()).rejects.toBe(idle);
		expect(retry).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getInterruptedRun()).toBeUndefined();
	});

	it("preserves input submitted during real initialization instead of auto-recovering", async () => {
		let entered = () => {};
		let release = () => {};
		const starting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await open("started", [
			(pi) => {
				pi.on("session_start", async () => {
					entered();
					await gate;
				});
			},
		]);
		const { mode, seams, idle, init, terminal } = ui(harness, { tuiMode: "regular" });
		init.mockRestore();
		const retry = vi.spyOn(harness.session, "retry");
		const run = mode.run();
		try {
			await starting;
			terminal.sendInput("fresh task");
			terminal.sendInput("\r");
			release();
			await expect(run).rejects.toBe(idle);
			expect(seams.editor.getText()).toBe("fresh task");
			expect(retry).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			release();
			await run.catch(() => {});
		}
	});

	it.each(["initial", "additional", "queued", "draft", "finished", "aborted", "legacy"] as const)(
		"does not insert retry for %s input/state",
		async (condition) => {
			const harness = await open(
				condition === "finished" || condition === "aborted" || condition === "legacy" ? condition : "started",
			);
			const retry = vi.spyOn(harness.session, "retry");
			const options =
				condition === "initial"
					? { initialMessage: "new task" }
					: condition === "additional"
						? { initialMessages: ["new task"] }
						: {};
			const { mode, seams, idle } = ui(harness, options);
			if (condition === "queued") seams.pendingUserInputs.push("new task");
			if (condition === "draft") seams.editor.setText("new task");
			await expect(mode.run()).rejects.toBe(idle);
			expect(retry).not.toHaveBeenCalled();
		},
	);

	it.each(["draft", "submission", "replacement"] as const)(
		"lets %s during authentication cancel startup recovery",
		async (input) => {
			const harness = await open();
			const replacement = input === "replacement" ? await open() : undefined;
			const { mode, seams, runtime, idle } = ui(harness);
			let entered = () => {};
			let release = () => {};
			const authenticating = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const modelRuntime = harness.session.modelRuntime;
			vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
			vi.spyOn(modelRuntime, "checkAuth").mockImplementation(async () => {
				entered();
				await gate;
				return { type: "api_key" };
			});
			const run = mode.run();
			await authenticating;
			if (input === "draft") seams.editor.setText("fresh input");
			if (input === "submission") seams.pendingUserInputs.push("fresh input");
			if (replacement) runtime.session = replacement.session;
			release();
			await expect(run).rejects.toBe(idle);
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.sessionManager.getInterruptedRun()).toBeDefined();
		},
	);

	it("does not recover an unfinished session loaded by later session rebinding", async () => {
		const initial = await open("finished");
		const replacement = await open();
		const retry = vi.spyOn(replacement.session, "retry");
		const { mode, idle, runtime, rebind, seams } = ui(initial);
		await expect(mode.run()).rejects.toBe(idle);
		runtime.session = replacement.session;
		await rebind();
		seams.renderWidgets();
		expect(retry).not.toHaveBeenCalled();
		expect(replacement.faux.state.callCount).toBe(0);
		expect(seams.widgetContainerAbove.render(80).join("\n")).toContain("/retry");
	});

	it("preserves unfinished work through the interactive quit cleanup path", async () => {
		const harness = await open("legacy");
		let entered = () => {};
		let release = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async () => {
				entered();
				await gate;
				return fauxAssistantMessage("late");
			},
		]);
		const prompt = harness.session.prompt("new work");
		await started;
		const { seams } = ui(harness);
		const exit = new Error("test intercepted process exit");
		const exiting = vi.spyOn(process, "exit").mockImplementation(() => {
			throw exit;
		});
		try {
			await expect(seams.shutdown()).rejects.toBe(exit);
			expect(SessionManager.open(harness.sessionManager.getSessionFile()!).getInterruptedRun()).toBeDefined();
		} finally {
			exiting.mockRestore();
			release();
			await prompt;
		}
	});

	it("renders a dim retry hint above the editor and removes it after completion", async () => {
		const harness = await open("aborted");
		const { seams } = ui(harness);
		seams.renderWidgets();
		expect(seams.widgetContainerAbove.render(80).join("\n")).toContain(
			theme.fg("dim", "Use /retry to retry or continue"),
		);
		await harness.session.followUp("new input");
		expect(seams.widgetContainerAbove.render(80).join("\n")).not.toContain("/retry");
		harness.session.clearQueue();
		const retry = harness.session.retry();
		expect(seams.widgetContainerAbove.render(80).join("\n")).not.toContain("/retry");
		await retry;
		expect(seams.widgetContainerAbove.render(80).join("\n")).not.toContain("/retry");
	});
});
