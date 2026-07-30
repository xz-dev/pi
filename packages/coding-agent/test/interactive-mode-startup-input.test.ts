import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

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
		assertOperationAllowed: (operation: string) => void;
		extensionRunner: { emitUserBash: (event: unknown) => Promise<unknown> };
	};
	flushPendingBashComponents: () => void;
	handleBashCommand: (command: string, excludeFromContext?: boolean) => Promise<void>;
	isBashMode: boolean;
	showError: (message: string) => void;
	updateEditorBorderColor: () => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type ShutdownContext = {
	isShuttingDown: boolean;
	runtimeHost: { assertOperationAllowed: (operation: string) => void; dispose: () => Promise<void> };
	themeController: { disableAutoSync: () => void };
	ui: { terminal: { drainInput: (timeout: number) => Promise<void> } };
	stop: () => void;
	showError: (message: string) => void;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	shutdown(this: ShutdownContext): Promise<void>;
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
			assertOperationAllowed: vi.fn(),
			extensionRunner: { emitUserBash: vi.fn(async () => undefined) },
		},
		flushPendingBashComponents: vi.fn(),
		handleBashCommand: vi.fn(async () => {}),
		isBashMode: false,
		showError: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it.each([
		"Cannot execute direct bash while manual retry is pending admission.",
		"Cannot execute direct bash after manual retry admission.",
	])("guards direct bash submission before side effects: %s", async (message) => {
		const context = createSubmitContext();
		context.session.assertOperationAllowed = vi.fn(() => {
			throw new Error(message);
		});
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("!echo guarded");

		expect(context.session.assertOperationAllowed).toHaveBeenCalledWith("execute direct bash");
		expect(context.handleBashCommand).not.toHaveBeenCalled();
		expect(context.session.extensionRunner.emitUserBash).not.toHaveBeenCalled();
		expect(context.editor.addToHistory).not.toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("!echo guarded");
		expect(context.showError).toHaveBeenCalledWith(message);
	});

	it("preflights normal shutdown before terminal teardown and recovers rejection", async () => {
		const error = new Error("Cannot dispose the runtime while manual retry is in progress.");
		const context: ShutdownContext = {
			isShuttingDown: false,
			runtimeHost: {
				assertOperationAllowed: vi.fn(() => {
					throw error;
				}),
				dispose: vi.fn(),
			},
			themeController: { disableAutoSync: vi.fn() },
			ui: { terminal: { drainInput: vi.fn(async () => {}) } },
			stop: vi.fn(),
			showError: vi.fn(),
		};

		await interactiveModePrototype.shutdown.call(context);

		expect(context.themeController.disableAutoSync).not.toHaveBeenCalled();
		expect(context.ui.terminal.drainInput).not.toHaveBeenCalled();
		expect(context.stop).not.toHaveBeenCalled();
		expect(context.showError).toHaveBeenCalledWith(error.message);
		expect(context.isShuttingDown).toBe(false);
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
