import { Container, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	RetryStatusIndicator,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("background compaction status", () => {
	test.each([false, true])("keeps independent indicators (embedded=%s)", async (embedded) => {
		const previousColorLevel = chalk.level;
		chalk.level = 3;
		initTheme("dark");
		vi.useFakeTimers();
		const abortCompaction = vi.fn();
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 24, setProgress: vi.fn() },
			getClearOnShrink: () => false,
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: embedded,
		});
		const mode = Object.assign(
			Object.create(InteractiveMode.prototype) as {
				handleEvent(event: AgentSessionEvent): Promise<void>;
				showStatusIndicator(indicator: StatusIndicator): void;
				clearStatusIndicator(kind?: StatusIndicator["kind"]): void;
				statusContainer: Container;
				chatContainer: Container;
			},
			{
				isInitialized: true,
				ui: tui,
				editor,
				defaultEditor: editor,
				statusContainer: new Container(),
				chatContainer: new Container(),
				options: { tuiMode: "regular" },
				runtimeHost: {
					session: {
						thinkingLevel: "off",
						abortCompaction,
						settingsManager: { getShowTerminalProgress: () => false },
					},
				},
				footer: { invalidate: vi.fn() },
				programStatus: { handleEvent: vi.fn() },
				flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			},
		);
		let working = new WorkingStatusIndicator(tui, "Working(WS/full)");
		const retry = new RetryStatusIndicator(tui, 1, 3, 3000);
		const render = () => (embedded ? editor.render(120)[0]! : mode.statusContainer.render(120).join("\n"));
		try {
			mode.showStatusIndicator(working);
			await mode.handleEvent({ type: "background_compaction_state", active: true });
			const line = render();
			expect(stripAnsi(line)).toContain(`Working(WS/full)${embedded ? " ── " : " | "}⠋ Compacting(background)...`);
			expect(line.indexOf("\x1b[3m")).toBeGreaterThan(line.indexOf("Working"));
			expect(line).toContain("\x1b[23m");
			if (embedded) {
				for (const width of [1, 4, 10, 20, 80, 120]) expect(visibleWidth(editor.render(width)[0]!)).toBe(width);
			}
			working.setMessage("Working(SSE)");
			expect(stripAnsi(render())).toContain("Working(SSE)");
			expect(stripAnsi(render())).toContain("Compacting(background)...");
			mode.clearStatusIndicator("working");
			const backgroundFrame = stripAnsi(render());
			vi.advanceTimersByTime(100);
			expect(stripAnsi(render())).not.toBe(backgroundFrame);
			expect(stripAnsi(render())).not.toContain("Working");
			expect(stripAnsi(render())).toContain("Compacting(background)...");
			working = new WorkingStatusIndicator(tui, "Working(SSE)");
			mode.showStatusIndicator(working);
			await mode.handleEvent({ type: "compaction_wait_start", reason: "manual" });
			expect(stripAnsi(render())).not.toContain("Compacting context");
			expect(stripAnsi(render())).toContain("Compacting(background)...");
			editor.onEscape?.();
			expect(abortCompaction).toHaveBeenCalledOnce();
			await mode.handleEvent({ type: "background_compaction_state", active: false });
			const workingFrame = stripAnsi(render());
			vi.advanceTimersByTime(100);
			expect(stripAnsi(render())).not.toBe(workingFrame);
			expect(stripAnsi(render())).toContain("Working(SSE)");
			expect(stripAnsi(render())).not.toContain("Compacting(background)...");
			await mode.handleEvent({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted: false,
				willRetry: false,
				reused: true,
			});
			expect(stripAnsi(mode.chatContainer.render(120).join("\n"))).toContain(
				"Compaction skipped: reusing completed compaction",
			);
			expect(editor.onEscape).toBeUndefined();
			mode.showStatusIndicator(retry);
			await mode.handleEvent({ type: "background_compaction_state", active: true });
			expect(stripAnsi(render())).toContain("Retrying (1/3)");
			expect(stripAnsi(render())).toContain("Compacting(background)...");
			await mode.handleEvent({ type: "background_compaction_state", active: false });
			expect(stripAnsi(render())).toContain("Retrying (1/3)");
		} finally {
			mode.clearStatusIndicator();
			(Reflect.get(mode, "backgroundCompactionIndicator") as StatusIndicator | undefined)?.dispose();
			working.dispose();
			retry.dispose();
			vi.useRealTimers();
			chalk.level = previousColorLevel;
		}
	});
});
