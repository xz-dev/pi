import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stopThemeWatcher } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it.each(["/retry", "continue"])(
		"retains %s until session startup finishes, including custom editors",
		async (text) => {
			let allowSessionStart: () => void = () => {};
			let sessionStartEntered: () => void = () => {};
			const sessionStartReady = new Promise<void>((resolve) => {
				sessionStartEntered = resolve;
			});
			const sessionStartGate = new Promise<void>((resolve) => {
				allowSessionStart = resolve;
			});
			const harness = await createHarness({
				settings: { theme: "dark", quietStartup: true },
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async (_event, ctx) => {
							ctx.ui.setEditorComponent((tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings));
							sessionStartEntered();
							await sessionStartGate;
						});
					},
				],
			});
			const terminal = new VirtualTerminal(100, 30);
			const runtime = {
				session: harness.session,
				setBeforeSessionInvalidate: () => {},
				setRebindSession: () => {},
			} as unknown as AgentSessionRuntime;
			const mode = new InteractiveMode(runtime, { terminal, tuiMode: "regular", initialThemeSetting: "dark" });
			let initializing: Promise<void> | undefined;
			try {
				initializing = mode.init();
				await sessionStartReady;
				terminal.sendInput(text);
				terminal.sendInput("\r");
				const editor = Reflect.get(mode, "editor") as CustomEditor;
				expect(editor.getText()).toBe(text);
				expect(harness.faux.state.callCount).toBe(0);
				expect(Reflect.get(mode, "unsubscribe")).toBeUndefined();
				allowSessionStart();
				await initializing;
				expect(editor.getText()).toBe(text);
				expect(editor.onSubmit).toBe((Reflect.get(mode, "defaultEditor") as CustomEditor).onSubmit);
				if (text === "continue") {
					terminal.sendInput("\r");
					expect(await mode.getUserInput()).toBe(text);
				}
				expect(harness.faux.state.callCount).toBe(0);
			} finally {
				allowSessionStart();
				await initializing?.catch(() => {});
				mode.stop();
				stopThemeWatcher();
				harness.cleanup();
			}
		},
	);

	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		};

		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");

		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith("Startup is still in progress");
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});
