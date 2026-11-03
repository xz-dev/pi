import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode, type InteractiveModeOptions } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, stopThemeWatcher, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, getAssistantTexts, type Harness, type HarnessOptions } from "./suite/harness.ts";

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
	startupRecovery:
		| { session: unknown; sessionId: string; leafId: string | null; generation: number; eligible: boolean }
		| undefined;
	switchTuiMode(mode: string, restoreProgress?: boolean, startRenderer?: boolean): boolean;
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

	it.each(["finished", "legacy"] as const)(
		"does not auto-recover an error tail with %s run records at cold start",
		async (state) => {
			const harness = await open(state);
			const retry = vi.spyOn(harness.session, "retry");
			const { mode, idle } = ui(harness);
			await expect(mode.run()).rejects.toBe(idle);
			// No working-start owns the tail, so cold start returns without auto retry.
			expect(retry).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(0);
		},
	);

	it("continues a reopened unfinished session exactly once before waiting for input", async () => {
		const harness = await open();
		const retry = vi.spyOn(harness.session, "retry");
		const { mode, idle } = ui(harness);
		await expect(mode.run()).rejects.toBe(idle);
		expect(retry).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.hasUnfinishedWork()).toBe(false);
	});

	it.each(["regular", "fullscreen"] as const)(
		"promises automatic recovery on the first %s render, then removes the hint after it runs",
		async (tuiMode) => {
			const harness = await open();
			const { mode, seams, terminal, idle, init } = ui(harness, { tuiMode });
			init.mockRestore();
			let firstHint: string | undefined;
			const write = terminal.write.bind(terminal);
			vi.spyOn(terminal, "write").mockImplementation((data) => {
				if (firstHint === undefined && data.includes("/retry")) firstHint = data;
				write(data);
			});
			// Hold recovery so the first real frame, not an eventual redraw, is observable.
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const modelRuntime = harness.session.modelRuntime;
			vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
			vi.spyOn(modelRuntime, "checkAuth").mockImplementation(async () => {
				await gate;
				return { type: "api_key" };
			});
			const run = mode.run();
			await vi.waitFor(async () => {
				const viewport = await terminal.flushAndGetViewport();
				expect(viewport.some((line) => line.includes("automatically run /retry shortly"))).toBe(true);
			});
			expect(firstHint).toContain("This session will automatically run /retry shortly.");
			expect(firstHint).not.toContain("Use /retry");
			release();
			await expect(run).rejects.toBe(idle);
			expect(harness.faux.state.callCount).toBe(1);
			const after = seams.widgetContainerAbove.render(80).join("\n");
			expect(after).not.toContain("/retry");
		},
	);

	it("keeps a manual hint for a retryable tail with an aborted run record", async () => {
		const harness = await open("aborted");
		const { mode, seams, idle } = ui(harness, { tuiMode: "regular" });
		await expect(mode.run()).rejects.toBe(idle);
		expect(seams.startupRecovery?.eligible).toBe(false);
		seams.renderWidgets();
		const lines = seams.widgetContainerAbove.render(80).join("\n");
		expect(lines).toContain(theme.fg("dim", "Use /retry to retry or continue"));
		expect(lines).not.toContain("(click to run)");
		expect(lines).not.toContain("automatically run /retry");
	});

	it("keeps the manual hint when /resume rebinds a recoverable session", async () => {
		const initial = await open("aborted");
		const replacement = await open();
		const { mode, seams, idle, runtime, rebind } = ui(initial, { tuiMode: "regular" });
		await expect(mode.run()).rejects.toBe(idle);
		runtime.session = replacement.session;
		await rebind();
		seams.renderWidgets();
		const lines = seams.widgetContainerAbove.render(80).join("\n");
		expect(lines).toContain(theme.fg("dim", "Use /retry to retry or continue"));
		expect(lines).not.toContain("automatically run /retry");
	});

	it.each(["regular", "fullscreen"] as const)("recovers after real %s initialization", async (tuiMode) => {
		const harness = await open();
		const { mode, idle, init } = ui(harness, { tuiMode });
		init.mockRestore();
		const retry = vi.spyOn(harness.session, "retry");
		await expect(mode.run()).rejects.toBe(idle);
		expect(retry).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.hasUnfinishedWork()).toBe(false);
	});

	it.each([
		{ auth: "fast", clicks: 3 },
		{ auth: "gated", clicks: 2 },
	] as const)("runs retry once on rapid fullscreen hint clicks ($auth auth)", async ({ auth, clicks }) => {
		const harness = await open("aborted");
		const { mode, terminal, seams, idle, init } = ui(harness, { tuiMode: "fullscreen" });
		init.mockRestore();
		let release = () => {};
		if (auth === "gated") {
			// Hold the retry at the auth boundary: a second click while it yields must not start another run.
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const modelRuntime = harness.session.modelRuntime;
			vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
			vi.spyOn(modelRuntime, "checkAuth").mockImplementation(async () => {
				await gate;
				return { type: "api_key" };
			});
		}
		const retry = vi.spyOn(harness.session, "retry");
		const run = mode.run();
		let row = -1;
		await vi.waitFor(async () => {
			const viewport = await terminal.flushAndGetViewport();
			row = viewport.findIndex((line) => line.includes("(click to run)"));
			expect(row).toBeGreaterThanOrEqual(0);
		});
		// A click is not a typed /retry: it must not clear an in-progress draft.
		seams.editor.setText("half-written draft");
		const click = `\x1b[<0;2;${row + 1}`;
		for (let i = 0; i < clicks; i++) {
			terminal.sendInput(`${click}M`);
			terminal.sendInput(`${click}m`);
		}
		await vi.waitFor(() => expect(retry).toHaveBeenCalled());
		// Another click while the first retry yields must not start a second provider run.
		terminal.sendInput(`${click}M`);
		terminal.sendInput(`${click}m`);
		release();
		await expect(run).rejects.toBe(idle);
		expect(retry).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(getAssistantTexts(harness).at(-1)).toBe("continued");
		expect(seams.editor.getText()).toBe("half-written draft");
	});

	it("ignores clicks on the regular-mode hint", async () => {
		const harness = await open("aborted");
		const { mode, seams, terminal, idle, init } = ui(harness, { tuiMode: "regular" });
		init.mockRestore();
		const retry = vi.spyOn(harness.session, "retry");
		const run = mode.run();
		await vi.waitFor(() => {
			expect(seams.widgetContainerAbove.render(80).join("\n")).toContain("Use /retry to retry or continue");
		});
		// Regular mode shows no click affordance; stray SGR sequences must not start a run.
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await expect(run).rejects.toBe(idle);
		expect(retry).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
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

	it.each(["initial", "additional", "queued", "draft", "aborted"] as const)(
		"does not insert retry for %s input/state",
		async (condition) => {
			const harness = await open(condition === "aborted" ? "aborted" : "started");
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
			expect(harness.sessionManager.hasUnfinishedWork()).toBe(true);
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
			expect(SessionManager.open(harness.sessionManager.getSessionFile()!).hasUnfinishedWork()).toBe(true);
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
			theme.fg("dim", "Use /retry to retry or continue (click to run)"),
		);
		await harness.session.followUp("new input");
		expect(seams.widgetContainerAbove.render(80).join("\n")).not.toContain("/retry");
		harness.session.clearQueue();
		const retry = harness.session.retry();
		expect(seams.widgetContainerAbove.render(80).join("\n")).not.toContain("/retry");
		await retry;
		expect(seams.widgetContainerAbove.render(80).join("\n")).not.toContain("/retry");
	});

	// R1 — a cancelled run's delayed error persistence must not lift its own veto.
	it.each(["prompt", "retry"] as const)(
		"keeps cancelled %s work stopped when its error persists late",
		async (operation) => {
			let entered = () => {};
			let release = () => {};
			const messageEnd = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const harness = await createHarness({
				sessionManagerFactory: (dir) => SessionManager.create(dir, dir),
				settings: { retry: { enabled: false }, theme: "dark" },
				extensionFactories: [
					(pi) => {
						pi.on("message_end", async (event) => {
							if (event.message.role === "assistant" && event.message.stopReason === "error") {
								entered();
								await gate;
							}
						});
					},
				],
			});
			harnesses.push(harness);
			if (operation === "retry") {
				harness.sessionManager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
				harness.sessionManager.appendMessage(fauxAssistantMessage("previous failure", { stopReason: "error" }));
				harness.session.refreshContext();
			}
			const previousLeaf = harness.sessionManager.getLeafId();
			await harness.session.bindExtensions({});
			harness.setResponses([fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "503 failed" })]);
			const running = operation === "retry" ? harness.session.retry() : harness.session.prompt("work");
			try {
				await messageEnd;
				const abort = harness.session.abort();
				release();
				await Promise.all([running, abort]);
				const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!, harness.tempDir);
				if (operation === "retry") expect(reopened.getLeafId()).not.toBe(previousLeaf);
				// The aborted record's working-end closes the run: no auto recovery.
				expect(reopened.hasUnfinishedWork()).toBe(false);
				const restored = await createHarness({ sessionManager: reopened, settings: { retry: { enabled: false } } });
				harnesses.push(restored);
				restored.session.refreshContext();
				expect(restored.session.canRetry).toBe(true);
				const restart = ui(restored);
				await expect(restart.mode.run()).rejects.toBe(restart.idle);
				expect(restored.faux.state.callCount).toBe(0);
			} finally {
				release();
				await running.catch(() => {});
			}
		},
	);

	// R2 — an unrelated sibling-branch run must not supersede the selected branch's cancellation.
	it("keeps the veto after running another branch and navigating back", async () => {
		const harness = await createHarness({
			sessionManagerFactory: (dir) => SessionManager.create(dir, dir),
			settings: { retry: { enabled: false }, theme: "dark" },
		});
		harnesses.push(harness);
		const m = harness.sessionManager;
		const rootId = m.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
		const cancelledTailId = m.appendMessage(fauxAssistantMessage("cancelled work", { stopReason: "error" }));
		const runA = m.appendRunState("started");
		m.appendRunState("aborted", runA);
		m.branch(rootId);
		const runB = m.appendRunState("started");
		m.appendMessage(fauxAssistantMessage("sibling", { stopReason: "stop" }));
		m.appendRunState("finished", runB);
		await harness.session.navigateTree(cancelledTailId, { label: "selected cancelled work" });
		const reopened = SessionManager.open(m.getSessionFile()!, harness.tempDir);
		// The sibling's later working-end does not reopen the selected branch's
		// aborted run: its own aborted end is reached first on this branch.
		expect(reopened.hasUnfinishedWork()).toBe(false);
	});

	// R3 — Esc during init/auth must permanently cancel pending startup recovery.
	it("lets Esc during authentication cancel startup recovery", async () => {
		const harness = await open();
		const { mode, terminal, idle, init } = ui(harness);
		init.mockRestore();
		let release = () => {};
		const entered = new Promise<void>((resolve) => {
			vi.spyOn(harness.session.modelRuntime, "checkAuth").mockImplementation(async () => {
				resolve();
				await new Promise<void>((r) => {
					release = r;
				});
				return { type: "api_key" };
			});
		});
		vi.spyOn(harness.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
		const run = mode.run();
		await entered;
		terminal.sendInput("\x1b");
		release();
		await expect(run).rejects.toBe(idle);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// R4 — navigation during startup must not redirect the automatic run to a different branch.
	it("cancels pending recovery when startup navigation changes the branch", async () => {
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
		const original = harness.sessionManager.getLeafId()!;
		const rootId = harness.sessionManager
			.getBranch()
			.find((e) => e.type === "message" && e.message.role === "user")!.id;
		harness.sessionManager.branch(rootId);
		const otherId = harness.sessionManager.appendMessage(
			fauxAssistantMessage("other cancelled task", { stopReason: "error" }),
		);
		const otherRun = harness.sessionManager.appendRunState("started");
		harness.sessionManager.appendRunState("aborted", otherRun);
		harness.sessionManager.branch(original);
		harness.session.refreshContext();
		const { mode, idle, init } = ui(harness);
		init.mockRestore();
		const run = mode.run();
		try {
			await starting;
			await harness.session.navigateTree(otherId);
			release();
			await expect(run).rejects.toBe(idle);
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			release();
			await run.catch(() => {});
		}
	});

	// Interrupts must stay cancelled after reopening, including before full key handlers exist.
	it.each([
		{ phase: "init", key: "\x1b" },
		{ phase: "init", key: "\x03" },
		{ phase: "auth", key: "\x1b" },
		{ phase: "auth", key: "\x03" },
	] as const)("persists $key cancellation during $phase across reopen", async ({ phase, key }) => {
		let entered = () => {};
		let release = () => {};
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await open(
			"started",
			phase === "init"
				? [
						(pi) => {
							pi.on("session_start", async () => {
								entered();
								await gate;
							});
						},
					]
				: undefined,
		);
		const { mode, terminal, idle, init } = ui(harness);
		init.mockRestore();
		if (phase === "auth") {
			vi.spyOn(harness.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
			vi.spyOn(harness.session.modelRuntime, "checkAuth").mockImplementation(async () => {
				entered();
				await gate;
				return { type: "api_key" };
			});
		}
		const run = mode.run();
		try {
			await ready;
			terminal.sendInput(key);
			release();
			await expect(run).rejects.toBe(idle);
			expect(harness.faux.state.callCount).toBe(0);
			mode.stop();
			const restored = await createHarness({
				sessionManager: SessionManager.open(harness.sessionManager.getSessionFile()!, harness.tempDir),
				settings: { retry: { enabled: false }, theme: "dark" },
			});
			harnesses.push(restored);
			restored.session.refreshContext();
			restored.setResponses([fauxAssistantMessage("manually continued")]);
			const reopened = ui(restored);
			await expect(reopened.mode.run()).rejects.toBe(reopened.idle);
			expect(restored.faux.state.callCount).toBe(0);
			await restored.session.retry();
			expect(getAssistantTexts(restored).at(-1)).toBe("manually continued");
		} finally {
			release();
			await run.catch(() => {});
		}
	});

	// R6 — after cancellation the hint must not keep promising the automatic run.
	it.each(["cancel", "draft"] as const)("drops the automatic promise immediately after %s", async (action) => {
		const harness = await open();
		const { mode, seams, terminal, idle, init } = ui(harness);
		init.mockRestore();
		let release = () => {};
		const entered = new Promise<void>((resolve) => {
			vi.spyOn(harness.session.modelRuntime, "checkAuth").mockImplementation(async () => {
				resolve();
				await new Promise<void>((r) => {
					release = r;
				});
				return { type: "api_key" };
			});
		});
		vi.spyOn(harness.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
		const run = mode.run();
		await entered;
		await vi.waitFor(async () => {
			const viewport = await terminal.flushAndGetViewport();
			expect(viewport.some((line) => line.includes("automatically run /retry"))).toBe(true);
		});
		// Wait for background grammar/theme invalidations to settle so only the
		// cancellation state decides what renders next.
		await new Promise((r) => setTimeout(r, 300));
		if (action === "cancel") terminal.sendInput("\x03");
		else terminal.sendInput("fresh draft");
		// Inspect the already-rendered component before any broad UI invalidation.
		expect(seams.widgetContainerAbove.render(80).join("\n")).not.toContain("automatically run /retry");
		release();
		await expect(run).rejects.toBe(idle);
		expect(harness.faux.state.callCount).toBe(0);
		await vi.waitFor(async () => {
			const viewport = await terminal.flushAndGetViewport();
			expect(viewport.some((line) => line.includes("automatically run /retry"))).toBe(false);
		});
		expect(seams.widgetContainerAbove.render(80).join("\n")).not.toContain("automatically run /retry");
	});

	// R7 — switching regular→fullscreen must keep the manual hint clickable.
	it("makes the manual hint clickable after switching to fullscreen", async () => {
		const harness = await open("aborted");
		const { mode, seams, terminal, idle, init } = ui(harness, { tuiMode: "regular" });
		init.mockRestore();
		const retry = vi.spyOn(harness.session, "retry");
		const run = mode.run();
		run.catch(() => {}); // idle error observed at the end
		await vi.waitFor(async () => {
			const viewport = await terminal.flushAndGetViewport();
			expect(viewport.some((line) => line.includes("Use /retry to retry or continue"))).toBe(true);
		});
		seams.switchTuiMode("fullscreen");
		let row = -1;
		await vi.waitFor(async () => {
			const viewport = await terminal.flushAndGetViewport();
			row = viewport.findIndex((line) => line.includes("(click to run)"));
			expect(row).toBeGreaterThanOrEqual(0);
		});
		terminal.sendInput(`\x1b[<0;2;${row + 1}M`);
		terminal.sendInput(`\x1b[<0;2;${row + 1}m`);
		await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
		// run() has already reached the input loop; the mouse-started retry is separate.
		await retry.mock.results[0]!.value;
		await expect(run).rejects.toBe(idle);
		expect(harness.faux.state.callCount).toBe(1);
		expect(getAssistantTexts(harness).at(-1)).toBe("continued");
	});
});
