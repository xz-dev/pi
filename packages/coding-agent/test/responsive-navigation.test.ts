import { type Component, Container, setKeybindings, Text, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ResolvedPaths } from "../src/core/package-manager.ts";
import type { SessionInfo, SessionTreeNode } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { SelectorHost } from "../src/modes/interactive/components/selector-host.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const labels = Array.from({ length: 30 }, (_, i) => `item-${String(i).padStart(2, "0")}`);

describe.each([
	["fullscreen", 0],
	["regular", 0],
	["regular", 8],
	["regular", 9],
] as const)("responsive navigation in %s with %i trailing rows", (mode, trailingRows) => {
	beforeEach(() => {
		initTheme("dark");
		// Fullscreen reserves PageUp/PageDown for transcript navigation; selector bindings remain configurable.
		setKeybindings(new KeybindingsManager({ "tui.select.pageDown": "f6", "tui.select.pageUp": "f5" }));
	});

	// Regression for the allocated-height clipping reported in earendil-works/pi#10213.
	it.each(["session", "tree", "config"] as const)(
		"keeps %s search, highlight and page movement in bounds",
		async (kind) => {
			const terminal = new VirtualTerminal(40, 40);
			const ui =
				mode === "fullscreen"
					? new TuiAltScreen(terminal, false, "/var/tmp")
					: new TuiMainScreen(terminal, false, "/var/tmp");
			const selected: string[] = [];
			const settings = SettingsManager.inMemory();
			let component: Component;
			let focus: Component;
			if (kind === "session") {
				const sessions: SessionInfo[] = labels.map((name) => ({
					id: name,
					name,
					path: `/var/tmp/${name}.jsonl`,
					cwd: "/var/tmp",
					created: new Date(0),
					modified: new Date(0),
					messageCount: 1,
					firstMessage: name,
					allMessagesText: name,
				}));
				const selector = new SessionSelectorComponent(
					async () => sessions,
					async () => sessions,
					(path) => selected.push(path),
					() => {},
					() => {},
					() => ui.requestRender(),
					{ keybindings: new KeybindingsManager() },
				);
				component = selector;
				focus = selector.getSessionList();
			} else if (kind === "tree") {
				const tree: SessionTreeNode[] = labels.map((text) => ({
					entry: {
						type: "message",
						id: text,
						parentId: null,
						timestamp: new Date(0).toISOString(),
						message: { role: "user", content: text, timestamp: 0 },
					},
					children: [],
				}));
				const selector = new TreeSelectorComponent(
					tree,
					labels[0],
					40,
					(id) => selected.push(id),
					() => {},
				);
				component = selector;
				focus = selector.getTreeList();
			} else {
				const paths: ResolvedPaths = {
					extensions: [],
					skills: [],
					themes: [],
					prompts: labels.map((name) => ({
						path: `/var/tmp/agent/prompts/${name}.md`,
						enabled: true,
						metadata: { origin: "top-level", scope: "user", source: "auto" },
					})),
				};
				const selector = new ConfigSelectorComponent(
					{ global: paths, project: paths },
					settings,
					"/var/tmp",
					"/var/tmp/agent",
					() => {},
					() => {},
					() => ui.requestRender(),
					40,
				);
				component = selector;
				focus = selector.getResourceList();
			}
			const below = new Text(Array.from({ length: trailingRows }, (_, i) => `widget ${i}`).join("\n"), 0, 0);
			const host = new SelectorHost(ui, () => (trailingRows ? [below] : []));
			host.addChild(component);
			if (ui instanceof TuiMainScreen) {
				ui.addChild(host);
				if (trailingRows) ui.addChild(below);
			} else {
				ui.setLayoutRoot(
					createChatViewport({
						document: new Text("conversation", 0, 0),
						pendingMessages: new Container(),
						status: new Container(),
						editor: host,
						footer: new Text("footer", 0, 0),
					}).root,
				);
			}
			ui.setFocus(focus);
			ui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("item");
				for (let i = 0; i < 8; i++) terminal.sendInput("\x1b[B");
				terminal.resize(40, 12);
				await terminal.waitForRender();
				let screen = stripAnsi((await terminal.flushAndGetViewport()).join("\n"));
				expect(screen).toMatch(/[›>].*item-08/);
				expect(screen).toMatch(kind === "tree" ? /Type to search: item/ : />.*item/);
				const visibleCount = screen.split("\n").filter((line) => /item-\d\d/.test(line)).length;
				terminal.sendInput("\x1b[17~");
				await terminal.waitForRender();
				screen = stripAnsi((await terminal.flushAndGetViewport()).join("\n"));
				const next = Number(screen.match(/[›>].*item-(\d\d)/)?.[1]);
				expect(next).toBeGreaterThan(8);
				expect(next).toBeLessThanOrEqual(8 + visibleCount);
				terminal.sendInput("\x1b[15~");
				terminal.resize(40, 40);
				await terminal.waitForRender();
				expect(stripAnsi((await terminal.flushAndGetViewport()).join("\n"))).toMatch(/[›>].*item-08/);
				terminal.sendInput("\r");
				if (kind === "config") expect(settings.getGlobalSettings().prompts).toEqual(["-prompts/item-08.md"]);
				else expect(selected).toEqual([kind === "session" ? "/var/tmp/item-08.jsonl" : "item-08"]);
			} finally {
				ui.stop();
			}
		},
	);
});
