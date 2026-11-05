import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { setRawInputText } from "../src/core/raw-input-text.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const proto = InteractiveMode.prototype as unknown as Record<string, (...args: never[]) => unknown>;
const controller = InteractiveMode.prototype as unknown as {
	addMessageToChat(this: object, message: AgentMessage, options?: { populateHistory?: boolean }): void;
	getEntrySubmittedCommandText(this: object, entryId: string): string | undefined;
	getUserMessageDisplayText(this: object, message: AgentMessage): string;
};

const SKILL_TEXT =
	'<skill name="review" location="/x/SKILL.md">\nReferences are relative to /x.\n\nSkill body\n</skill>\n\nplease check';

function userMessage(text: string, origin: "interactive" | "sdk" = "interactive", raw?: string): AgentMessage {
	const message: AgentMessage = {
		role: "user",
		content: [{ type: "text", text }],
		origin: origin === "interactive" ? { type: "interactive" } : { type: "sdk" },
		timestamp: 1,
	};
	setRawInputText(message, raw);
	return message;
}

function createHost(collapse: boolean, sessionManager = SessionManager.inMemory()) {
	const history = vi.fn();
	const host = {
		chatContainer: new Container(),
		outputPad: 1,
		toolOutputExpanded: false,
		sessionManager,
		session: { extensionRunner: { getMessageRenderer: () => undefined } },
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getCollapseExpandedInput: () => collapse,
		},
		getUserMessageText: proto.getUserMessageText,
		getUserMessageDisplayText: proto.getUserMessageDisplayText,
		getSubmittedCommandTextFor: proto.getSubmittedCommandTextFor,
		getMarkdownThemeWithSettings: () => undefined,
		getMarkdownTransformers: () => [],
		editor: { addToHistory: history },
	};
	return { host, history };
}

function rendered(container: Container): string {
	return container.render(100).map(stripVTControlCharacters).join("\n");
}

describe("collapsed expanded input presentation", () => {
	beforeAll(() => initTheme("dark"));

	it("shows and records the template command when enabled", () => {
		const { host, history } = createHost(true);
		controller.addMessageToChat.call(host, userMessage("Review this code: a.ts", "interactive", "/review a.ts"), {
			populateHistory: true,
		});
		expect(rendered(host.chatContainer)).toContain("/review a.ts");
		expect(rendered(host.chatContainer)).not.toContain("Review this code");
		expect(history).toHaveBeenCalledWith("/review a.ts");
	});

	it("keeps the expanded body when disabled", () => {
		const { host, history } = createHost(false);
		controller.addMessageToChat.call(host, userMessage("Review this code: a.ts", "interactive", "/review a.ts"), {
			populateHistory: true,
		});
		expect(rendered(host.chatContainer)).toContain("Review this code: a.ts");
		expect(history).toHaveBeenCalledWith("Review this code: a.ts");
	});

	it("keeps the skill card in chat and uses the skill command for history", () => {
		for (const collapse of [true, false]) {
			const { host, history } = createHost(collapse);
			controller.addMessageToChat.call(host, userMessage(SKILL_TEXT), { populateHistory: true });
			expect(rendered(host.chatContainer)).toContain("[skill] review");
			expect(rendered(host.chatContainer)).not.toContain("Skill body");
			expect(history).toHaveBeenCalledWith(collapse ? "/skill:review please check" : SKILL_TEXT);
		}
	});

	it("does not present non-interactive messages as commands", () => {
		const { host } = createHost(true);
		const message = userMessage(SKILL_TEXT, "sdk", "/review spoof");
		expect(controller.getUserMessageDisplayText.call(host, message)).toBe(SKILL_TEXT);
	});

	it("resolves fork and tree refill text from the selected entry", () => {
		const sessionManager = SessionManager.inMemory();
		const templateId = sessionManager.appendMessage(
			userMessage("Review this code: a.ts", "interactive", "/review a.ts") as Parameters<
				SessionManager["appendMessage"]
			>[0],
		);
		const plainId = sessionManager.appendMessage(
			userMessage("hello") as Parameters<SessionManager["appendMessage"]>[0],
		);
		expect(sessionManager.getEntry(templateId)).toMatchObject({ __raw_inputText: "/review a.ts" });

		const enabled = createHost(true, sessionManager).host;
		expect(controller.getEntrySubmittedCommandText.call(enabled, templateId)).toBe("/review a.ts");
		expect(controller.getEntrySubmittedCommandText.call(enabled, plainId)).toBeUndefined();

		const disabled = createHost(false, sessionManager).host;
		expect(controller.getEntrySubmittedCommandText.call(disabled, templateId)).toBeUndefined();
	});
});
