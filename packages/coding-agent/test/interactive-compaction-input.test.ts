import { fauxAssistantMessage, type ImageContent } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Test private rendering seam without starting a terminal or loading real resources.
const prototype = InteractiveMode.prototype as unknown as {
	promptWithPendingDisplay(this: object, text: string, images?: ImageContent[]): Promise<void>;
	updatePendingMessagesDisplay(this: object): void;
	restoreSubmittedInput(this: object): void;
	handleEvent(this: object, event: AgentSessionEvent): Promise<void>;
};

describe("compaction input display", () => {
	it.each(["rejection", "error-event"] as const)("restores undelivered text after %s", async (failure) => {
		initTheme("dark");
		const editor = { getText: () => "new draft", setText: vi.fn() };
		const pendingMessagesContainer = new Container();
		const fake = {
			isInitialized: true,
			submittedInput: undefined as string | undefined,
			pendingMessagesContainer,
			editor,
			ui: { requestRender: vi.fn() },
			footer: { invalidate: vi.fn() },
			getAllQueuedMessages: () => ({ steering: [], followUp: [] }),
			updatePendingMessagesDisplay() {
				prototype.updatePendingMessagesDisplay.call(this);
			},
			restoreSubmittedInput() {
				prototype.restoreSubmittedInput.call(this);
			},
			session: {
				prompt: async () => {
					if (failure === "rejection") throw new Error("preflight failed");
					await prototype.handleEvent.call(fake, {
						type: "message_end",
						message: fauxAssistantMessage("", { stopReason: "error", errorMessage: "lifecycle failed" }),
					});
				},
			},
		};
		const prompt = prototype.promptWithPendingDisplay.call(fake, "saved input");
		if (failure === "rejection") await expect(prompt).rejects.toThrow("preflight failed");
		else await prompt;
		expect(editor.setText).toHaveBeenCalledWith("saved input\n\nnew draft");
		expect(pendingMessagesContainer.render(80).join("\n")).not.toContain("saved input");
	});

	it("shows submitted text as pending until user start, after compaction summary", async () => {
		initTheme("dark");
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chat: string[] = [];
		const pendingMessagesContainer = new Container();
		const fake = {
			isInitialized: true,
			submittedInput: undefined as string | undefined,
			pendingMessagesContainer,
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			session: { prompt: () => pending },
			getAllQueuedMessages: () => ({ steering: [], followUp: [] }),
			updatePendingMessagesDisplay() {
				prototype.updatePendingMessagesDisplay.call(this);
			},
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowTerminalProgress: () => false },
			sessionManager: { buildContextEntries: () => [{ type: "compaction" }] },
			chatContainer: {
				clear: () => {
					chat.length = 0;
				},
			},
			renderSessionEntries: vi.fn(),
			addMessageToChat: (message: { role: string }) => {
				chat.push(message.role);
			},
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn(),
		};
		const prompt = prototype.promptWithPendingDisplay.call(fake, "incoming input");
		expect(pendingMessagesContainer.render(80).join("\n")).toContain("Pending: incoming input");
		await prototype.handleEvent.call(fake, {
			type: "compaction_end",
			reason: "threshold",
			aborted: false,
			willRetry: false,
			result: { summary: "summary", firstKeptEntryId: "old", tokensBefore: 100 },
		});
		expect(pendingMessagesContainer.render(80).join("\n")).toContain("Pending: incoming input");
		await prototype.handleEvent.call(fake, {
			type: "message_start",
			message: { role: "user", content: "incoming input", timestamp: Date.now() },
		});
		expect(chat).toEqual(["compactionSummary", "user"]);
		expect(pendingMessagesContainer.render(80).join("\n")).not.toContain("incoming input");
		release();
		await prompt;
		expect(fake.submittedInput).toBeUndefined();
	});
});
