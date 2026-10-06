import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops with neutral truncation wording", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			"collapsed",
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Thinking...");
		expect(rendered).toContain("Response was truncated before completion.");
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			"collapsed",
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/Thinking\.\.\./g)).toHaveLength(1);
		expect(rendered).toContain("answer");
	});

	test("collapses individual thinking runs when clicked", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "second reasoning" },
			]),
			"expanded",
		);
		const width = 80;
		const lines = component.render(width);
		const firstThinkingRow = lines.findIndex((line) => stripAnsi(line).includes("first reasoning"));
		expect(firstThinkingRow).toBeGreaterThanOrEqual(0);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 1,
			y: firstThinkingRow,
			screenX: 1,
			screenY: firstThinkingRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);

		const collapsed = stripAnsi(component.render(width).join("\n"));
		expect(collapsed).not.toContain("first reasoning");
		expect(collapsed).toContain("Thinking...");
		expect(collapsed).toContain("second reasoning");
	});

	test("preview style shows the latest reasoning line while streaming and the label once thinking ends", () => {
		initTheme("dark");

		const streaming = new AssistantMessageComponent(undefined, "preview");
		streaming.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "first thought\nsecond thought tail" }]),
			true,
			0,
		);
		const streamingLines = streaming.render(40).map((line) => stripAnsi(line));
		expect(streamingLines.some((line) => line.includes("second thought tail"))).toBe(true);
		expect(streamingLines.some((line) => line.includes("first thought"))).toBe(false);
		expect(streamingLines.some((line) => line.includes("Thinking..."))).toBe(false);

		// thinking_end (no active thinking index) freezes the run into the static label.
		streaming.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "first thought\nsecond thought tail" }]),
			true,
			null,
		);
		const endedLines = streaming.render(40).map((line) => stripAnsi(line));
		expect(endedLines.some((line) => line.includes("Thinking..."))).toBe(true);
		expect(endedLines.some((line) => line.includes("second thought tail"))).toBe(false);

		const finished = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "done reasoning" },
				{ type: "text", text: "answer" },
			]),
			"preview",
		);
		const finishedLines = finished.render(40).map((line) => stripAnsi(line));
		expect(finishedLines.some((line) => line.includes("Thinking..."))).toBe(true);
		expect(finishedLines.some((line) => line.includes("done reasoning"))).toBe(false);
	});

	test("preview row follows the tail of a long reasoning line within terminal columns", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(undefined, "preview");
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "head-aaaaa bbbbb ccccc ddddd eeeee-tail" }]),
			true,
			0,
		);
		const width = 20;
		const lines = component.render(width).map((line) => stripAnsi(line));
		const previewLine = lines.find((line) => line.trim().length > 0);
		expect(previewLine).toBeDefined();
		expect(previewLine).toContain("tail");
		expect(previewLine).not.toContain("head");
		expect(visibleWidth(previewLine ?? "")).toBeLessThanOrEqual(width);
		// Single preview row plus the leading spacer.
		expect(lines.filter((line) => line.trim().length > 0)).toHaveLength(1);
	});

	test("preview respects thinking markdown transformers before picking the latest line", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 1, [
			(markdown) => `${markdown}\nredacted marker`,
		]);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "sensitive tail" }]), true, 0);
		const lines = component.render(40).map((line) => stripAnsi(line));
		expect(lines.some((line) => line.includes("redacted marker"))).toBe(true);
		expect(lines.some((line) => line.includes("sensitive tail"))).toBe(false);
	});

	test("preview passes the real available width to transformers and re-runs them on width change", () => {
		initTheme("dark");

		const widthsSeen: number[] = [];
		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 1, [
			(markdown, context) => {
				widthsSeen.push(context.availableWidth);
				return `${markdown} w=${context.availableWidth}`;
			},
		]);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "tail" }]), true, 0);
		// outputPad=1 -> 80-2=78
		expect(stripAnsi(component.render(80).join("\n"))).toContain("w=78");
		expect(stripAnsi(component.render(60).join("\n"))).toContain("w=58");
		expect(widthsSeen).toEqual([78, 58]);
	});

	test("clicking a live preview run expands it and clicking again returns to preview", () => {
		initTheme("dark");

		const message = createAssistantMessage([{ type: "thinking", thinking: "first line\nlast tail line" }]);
		const component = new AssistantMessageComponent(undefined, "preview");
		component.updateContent(message, true, 0);
		const width = 80;
		let lines = component.render(width);
		let rendered = stripAnsi(lines.join("\n"));
		// Preview row shows only the tail line, not the whole run.
		expect(rendered).toContain("last tail line");
		expect(rendered).not.toContain("first line");

		const previewRow = lines.findIndex((line) => stripAnsi(line).includes("last tail line"));
		expect(previewRow).toBeGreaterThanOrEqual(0);
		const click: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 1,
			y: previewRow,
			screenX: 1,
			screenY: previewRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(click)?.handled).toBe(true);

		// Expanded run renders the full multi-line markdown.
		lines = component.render(width);
		rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("first line");
		expect(rendered).toContain("last tail line");
		const expandedRow = lines.findIndex((line) => stripAnsi(line).includes("first line"));
		expect(expandedRow).toBeGreaterThanOrEqual(0);

		// Click again to collapse back to the live preview row.
		expect(
			component.handleMouse({ ...click, y: expandedRow, screenY: expandedRow, height: lines.length })?.handled,
		).toBe(true);
		lines = component.render(width);
		rendered = stripAnsi(lines.join("\n"));
		expect(rendered).not.toContain("first line");
		expect(rendered).toContain("last tail line");
		expect(rendered).not.toContain("Thinking...");
	});

	test("bulk setExpanded overrides every thinking run and clearing a run restores mode default", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "bulk reasoning" },
				{ type: "text", text: "answer" },
			]),
			"collapsed",
		);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("bulk reasoning");

		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("bulk reasoning");

		component.setExpanded(false);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("bulk reasoning");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Thinking...");
	});

	test("preview mode: folded live run keeps the tail after bulk collapse and mouse collapse", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(undefined, "preview");
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "earlier\nlive tail" }]), true, 0);

		// Bulk expand then collapse: folded live run still shows the preview row.
		component.setExpanded(true);
		component.setExpanded(false);
		let rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("live tail");
		expect(rendered).not.toContain("earlier");
		expect(rendered).not.toContain("Thinking...");

		// Mouse expand then collapse while live: preview row returns.
		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("earlier");
		const rows = component.render(80);
		const row = rows.findIndex((line) => stripAnsi(line).includes("earlier"));
		expect(row).toBeGreaterThanOrEqual(0);
		expect(
			component.handleMouse({
				type: "click",
				button: "left",
				x: 1,
				y: row,
				screenX: 1,
				screenY: row,
				width: 80,
				height: rows.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			})?.handled,
		).toBe(true);
		rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("live tail");
		expect(rendered).not.toContain("earlier");

		// thinking_end freezes the folded run into the label.
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "earlier\nlive tail" }]),
			true,
			null,
		);
		rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("Thinking...");
		expect(rendered).not.toContain("live tail");
	});

	test("preview row renders nothing visible at zero columns and stays within bounds for CJK text", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 0);
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "head\ntail 中文你好世界 end" }]),
			true,
			0,
		);
		for (const width of [0, 1, 2, 3, 4, 20, 80]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(width, 0));
			}
		}
		// Zero columns emits no visible cell.
		expect(component.render(0).map((line) => visibleWidth(line))).toEqual([0, 0]);
		// Re-render at a real width still produces the tail after the zero-width call.
		expect(stripAnsi(component.render(40).join("\n"))).toContain("end");
	});

	test("preview applies transformers (redaction) before clipping at every width", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 1, [
			(markdown) => markdown.replaceAll("secret", "[redacted]"),
		]);
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "old\nsecret tail 中文你好" }]),
			true,
			0,
		);
		for (const width of [80, 20, 7, 4, 3, 2, 1, 80]) {
			const rendered = stripAnsi(component.render(width).join("\n"));
			expect(rendered).not.toContain("secret");
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		expect(stripAnsi(component.render(80).join("\n"))).toContain("[redacted]");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			"expanded",
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("chains Markdown transformers in registration order", () => {
		initTheme("dark");
		const calls: string[] = [];
		const message = createAssistantMessage([{ type: "text", text: "The result is $x^2$." }]);
		const component = new AssistantMessageComponent(message, "expanded", undefined, "Thinking...", 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "assistant", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The result is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("identifies partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, "expanded", undefined, "Thinking...", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("reapplies Markdown transformers when available width changes", () => {
		initTheme("dark");
		const availableWidths: number[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
			"expanded",
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					availableWidths.push(context.availableWidth);
					return `${markdown} (${context.availableWidth})`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer (78)");
		component.render(80);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("answer (58)");
		expect(availableWidths).toEqual([78, 58]);
	});

	test("continues the Markdown transformer chain when a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			"expanded",
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("transforms text and thinking Markdown without mutating the original message", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, "expanded", undefined, "Thinking...", 1, [
			(markdown, { messageType }) => {
				return `${messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});
});
