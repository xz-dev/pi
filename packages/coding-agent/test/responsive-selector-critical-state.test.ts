import { setKeybindings, stripTerminalSequences, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { SelectorHost } from "../src/modes/interactive/components/selector-host.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness } from "./suite/harness.ts";

const session: SessionInfo = {
	id: "item-08",
	name: "item-08",
	path: "/var/tmp/item-08.jsonl",
	cwd: "/var/tmp",
	created: new Date(0),
	modified: new Date(0),
	messageCount: 1,
	firstMessage: "item-08",
	allMessagesText: "item-08",
};

describe("selector critical state at small allocations", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("blocks hidden permission confirmation through 8 -> 0 -> 40, without blocking cancel", () => {
		const selected = vi.fn();
		const cancel = vi.fn();
		const selector = new ExtensionSelectorComponent("Permission\n".repeat(20), ["Yes", "No"], selected, cancel);
		for (const height of [8, 0]) {
			selector.renderInBounds(40, height);
			selector.handleInput("\r");
			expect(selected).not.toHaveBeenCalled();
		}
		selector.handleInput("\x1b");
		expect(cancel).toHaveBeenCalledOnce();
		selector.renderInBounds(40, 40);
		selector.handleInput("\r");
		expect(selected).toHaveBeenCalledWith("Yes");
	});

	it("does not authorize an invisible permission choice after regular-mode resize", async () => {
		const terminal = new VirtualTerminal(40, 40);
		const ui = new TuiMainScreen(terminal, false, "/var/tmp");
		const selected = vi.fn();
		const cancel = vi.fn();
		const selector = new ExtensionSelectorComponent("Allow write?", ["Yes", "No"], selected, cancel, {
			description: "This grants write access.",
		});
		const below = new Text(Array.from({ length: 12 }, (_, i) => `widget ${i}`).join("\n"), 0, 0);
		const host = new SelectorHost(ui, () => [below]);
		host.addChild(selector);
		ui.addChild(host);
		ui.addChild(below);
		ui.setFocus(selector);
		ui.start();
		try {
			await terminal.waitForRender();
			terminal.resize(40, 12);
			await terminal.waitForRender();
			expect((await terminal.flushAndGetViewport()).join("\n")).not.toContain("Allow write?");
			terminal.sendInput("\r");
			expect(selected).not.toHaveBeenCalled();
			terminal.sendInput("\x1b");
			expect(cancel).toHaveBeenCalledOnce();
			terminal.resize(40, 40);
			await terminal.waitForRender();
			expect((await terminal.flushAndGetViewport()).join("\n")).toContain("Allow write?");
			terminal.sendInput("\r");
			expect(selected).toHaveBeenCalledWith("Yes");
		} finally {
			ui.stop();
			selector.dispose();
		}
	});

	it("keeps model errors indicated at one/two/three rows and restores the full message", async () => {
		const harness = await createHarness();
		const error = "Invalid models.json: broken configuration";
		const getError = vi.spyOn(harness.session.modelRuntime, "getError").mockReturnValue(error);
		const terminal = new VirtualTerminal(40, 40);
		const ui = new TuiMainScreen(terminal, false, "/var/tmp");
		const chosen = vi.fn();
		const selector = new ModelSelectorComponent(
			ui,
			harness.session.model,
			harness.session.modelRuntime,
			[],
			chosen,
			() => {},
		);
		const below = new Text(Array.from({ length: 10 }, (_, i) => `widget ${i}`).join("\n"), 0, 0);
		const host = new SelectorHost(ui, () => [below]);
		host.addChild(selector);
		ui.addChild(host);
		ui.addChild(below);
		ui.setFocus(selector);
		ui.start();
		try {
			await vi.waitFor(() => expect(stripAnsi(selector.render(80).join("\n"))).toContain(error));
			for (const height of [1, 2, 3]) {
				const lines = selector.renderInBounds(40, height);
				expect(lines.length).toBeLessThanOrEqual(height);
				expect(stripAnsi(lines.join("\n"))).toMatch(/Invalid models.json|resize/i);
				if (!stripAnsi(lines.join("\n")).includes("→")) {
					selector.handleInput("\r");
					expect(chosen).not.toHaveBeenCalled();
				}
			}
			terminal.resize(40, 12);
			await terminal.waitForRender();
			expect(stripAnsi((await terminal.flushAndGetViewport()).join("\n"))).toMatch(/Invalid models.json|resize/i);
			terminal.sendInput("\r");
			expect(chosen).not.toHaveBeenCalled();
			terminal.resize(80, 40);
			await terminal.waitForRender();
			expect(stripAnsi((await terminal.flushAndGetViewport()).join("\n"))).toContain(error);
			terminal.sendInput("\r");
			expect(chosen).toHaveBeenCalledOnce();
		} finally {
			selector.dispose();
			ui.stop();
			getError.mockRestore();
			harness.cleanup();
		}
	});

	it("preserves session errors and delete confirmation ahead of decorative hints", async () => {
		const selector = new SessionSelectorComponent(
			async () => [session],
			async () => [session],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);
		await vi.waitFor(() => expect(selector.render(80).join("\n")).toContain("item-08"));
		const list = selector.getSessionList();
		const deleted = vi.fn(async () => {});
		list.onDeleteSession = deleted;
		list.handleInput("\x04");
		const screen = stripAnsi(selector.renderInBounds(40, 3).join("\n"));
		expect(screen).toContain("Delete session?");
		expect(screen).toMatch(/›.*item-08/);
		selector.renderInBounds(40, 1);
		list.handleInput("\r");
		expect(deleted).not.toHaveBeenCalled();
		list.handleInput("\x1b");
		expect(stripAnsi(selector.renderInBounds(40, 3).join("\n"))).not.toContain("Delete session?");
		list.handleInput("\x04");
		selector.renderInBounds(40, 3);
		list.handleInput("\r");
		expect(deleted).toHaveBeenCalledWith(session.path);

		const failed = new SessionSelectorComponent(
			async () => {
				throw new Error("disk unavailable");
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);
		await vi.waitFor(() => expect(failed.render(80).join("\n")).toContain("disk unavailable"));
		expect(stripAnsi(failed.renderInBounds(40, 3).join("\n"))).toContain("Failed to load sessions");
		failed.handleInput("\x1b");
	});

	it("keeps rename input usable and cannot save while it is hidden", async () => {
		const rename = vi.fn(async () => {});
		const selector = new SessionSelectorComponent(
			async () => [session],
			async () => [session],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(), renameSession: rename },
		);
		await vi.waitFor(() => expect(selector.render(80).join("\n")).toContain("item-08"));
		selector.getSessionList().handleInput("\x1b[114;5u");
		expect(stripTerminalSequences(selector.renderInBounds(40, 3).join("\n"))).toContain("item-08");
		selector.renderInBounds(40, 0);
		selector.handleInput("\r");
		expect(rename).not.toHaveBeenCalled();
		selector.renderInBounds(40, 3);
		selector.handleInput("\r");
		await vi.waitFor(() => expect(rename).toHaveBeenCalledWith(session.path, session.name));
	});
});
