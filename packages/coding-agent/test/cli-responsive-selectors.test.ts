import type * as TuiModule from "@earendil-works/pi-tui";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { selectConfig } from "../src/cli/config-selector.ts";
import { selectSession } from "../src/cli/session-picker.ts";
import * as startup from "../src/cli/startup-ui.ts";
import type { ResolvedPaths } from "../src/core/package-manager.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

let terminal: VirtualTerminal;
vi.mock("@earendil-works/pi-tui", async (importOriginal) => ({
	...(await importOriginal<typeof TuiModule>()),
	ProcessTerminal: vi.fn(function ProcessTerminalMock() {
		return terminal;
	}),
}));

afterEach(() => vi.restoreAllMocks());

describe("CLI selector height wiring", () => {
	it.each(["config", "resume"] as const)("keeps the %s choice visible after keyboard resize", async (kind) => {
		terminal = new VirtualTerminal(40, 40);
		initTheme("dark");
		const settings = SettingsManager.inMemory();
		const labels = Array.from({ length: 20 }, (_, i) => `item-${String(i).padStart(2, "0")}`);
		let pending: Promise<void> | Promise<string | null>;
		if (kind === "config") {
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
			pending = selectConfig({
				resolvedPaths: { global: paths, project: paths },
				settingsManager: settings,
				cwd: "/var/tmp",
				agentDir: "/var/tmp/agent",
				writeScope: "global",
				projectModeAvailable: true,
			});
		} else {
			const ui = new TuiMainScreen(terminal, false, "/var/tmp");
			// Resource discovery and terminal color queries are unrelated to selector layout.
			vi.spyOn(startup, "createStartupTui").mockResolvedValue(ui);
			vi.spyOn(startup, "startStartupTui").mockImplementation(() => ui.start());
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
			pending = selectSession(
				async () => sessions,
				async () => sessions,
				settings,
			);
		}
		try {
			await terminal.waitForRender();
			for (let i = 0; i < 8; i++) terminal.sendInput("\x1b[B");
			terminal.resize(40, 12);
			await terminal.waitForRender();
			expect(stripAnsi((await terminal.flushAndGetViewport()).join("\n"))).toMatch(/[›>].*item-08/);
			terminal.sendInput("\r");
			if (kind === "resume") expect(await pending).toBe("/var/tmp/item-08.jsonl");
			else expect(settings.getGlobalSettings().prompts).toEqual(["-prompts/item-08.md"]);
		} finally {
			terminal.sendInput("\x1b");
			await pending;
		}
	});
});
