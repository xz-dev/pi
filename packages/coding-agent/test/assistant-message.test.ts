import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { Chalk } from "chalk";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// Force decoration ANSI codes on: the real theme gates bold/italic on terminal color
// support, which is off under the offline test env.
const probeChalk = new Chalk({ level: 3 });
const thinkingMarkdownTheme = {
	...getMarkdownTheme(),
	bold: (text: string) => probeChalk.bold(text),
	italic: (text: string) => probeChalk.italic(text),
};

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

	test("preview style renders identical styled tail rows while streaming and after thinking ends", () => {
		initTheme("dark");

		const streaming = new AssistantMessageComponent(undefined, "preview", thinkingMarkdownTheme);
		streaming.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "summary **lead** here\nsecond thought tail **bold** `code`" },
			]),
			true,
			0,
		);
		const streamingLines = streaming.render(80);
		const liveRow = streamingLines.find((line) => stripAnsi(line).includes("second thought tail")) ?? "";
		expect(stripAnsi(streamingLines.join("\n"))).not.toContain("summary");
		expect(stripAnsi(liveRow)).not.toContain("**");
		expect(stripAnsi(liveRow)).not.toContain("`");
		expect(liveRow).toMatch(/\x1b\[1m(?:\x1b\[[\d;]*m)*bold/);
		expect(liveRow).toContain(theme.fg("mdCode", "code"));
		// The earlier line is omitted with a muted grapheme count, not silently dropped.
		expect(stripAnsi(liveRow).trimStart()).toMatch(/^\u2026 \(17 chars\) /);

		// thinking_end (no active thinking index) keeps the identical rolling tail row.
		streaming.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "summary **lead** here\nsecond thought tail **bold** `code`" },
			]),
			true,
			null,
		);
		const endedLines = streaming.render(80);
		expect(endedLines).toEqual(streamingLines);
		expect(stripAnsi(endedLines.join("\n"))).not.toContain("Thinking...");

		// Settled preview also shows the tail of a long final line, with the hidden count.
		const longFirst = new AssistantMessageComponent(undefined, "preview", thinkingMarkdownTheme);
		longFirst.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: `${"x".repeat(120)} head-end\nshort tail` }]),
			false,
		);
		const longLines = longFirst.render(40).map((line) => stripAnsi(line));
		const longRow = longLines.find((line) => line.includes("short tail")) ?? "";
		expect(longRow).toContain("(129 chars)");
		expect(longRow).not.toContain("head-end");
		expect(longRow).not.toContain("x");

		const finished = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "done **bold** reasoning `code`" },
				{ type: "text", text: "answer" },
			]),
			"preview",
			thinkingMarkdownTheme,
		);
		const finishedLines = finished.render(80);
		const finishedRow = finishedLines.find((line) => stripAnsi(line).includes("done")) ?? "";
		expect(stripAnsi(finishedRow)).toContain("done bold reasoning code");
		expect(stripAnsi(finishedRow)).not.toContain("\u2026");
		expect(stripAnsi(finishedRow)).not.toContain("**");
		expect(stripAnsi(finishedRow)).not.toContain("`");
		expect(finishedRow).toMatch(/\x1b\[1m(?:\x1b\[[\d;]*m)*bold/);
		expect(finishedRow).toContain(theme.fg("mdCode", "code"));
		expect(stripAnsi(finishedLines.join("\n"))).not.toContain("Thinking...");
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

	test("mouse and bulk folds keep the same tail row after completion without expanding the body", () => {
		initTheme("dark");
		const width = 80;
		const clickRow = (component: AssistantMessageComponent, needle: string) => {
			const lines = component.render(width);
			const y = lines.findIndex((line) => stripAnsi(line).includes(needle));
			expect(y).toBeGreaterThanOrEqual(0);
			expect(
				component.handleMouse({
					type: "click",
					button: "left",
					x: 1,
					y,
					screenX: 1,
					screenY: y,
					width,
					height: lines.length,
					shift: false,
					alt: false,
					ctrl: false,
					clickCount: 1,
				})?.handled,
			).toBe(true);
		};
		const message = createAssistantMessage([{ type: "thinking", thinking: "summary line\nsecond tail" }]);
		for (const bulk of [false, true]) {
			const component = new AssistantMessageComponent(undefined, "preview");
			component.updateContent(message, true, 0);
			component.setExpanded(true);
			if (bulk) component.setExpanded(false);
			else clickRow(component, "summary line");
			expect(stripAnsi(component.render(width).join("\n"))).toContain("second tail");
			component.updateContent(message, true, null);
			component.updateContent(message, false);
			// Completion keeps the identical tail row: same omission hint, no first line.
			let rendered = stripAnsi(component.render(width).join("\n"));
			expect(rendered).toContain("\u2026 (12 chars) second tail");
			expect(rendered).not.toContain("summary line");
			expect(rendered).not.toContain("Thinking...");
			clickRow(component, "second tail");
			expect(stripAnsi(component.render(width).join("\n"))).toContain("summary line");
			clickRow(component, "second tail");
			rendered = stripAnsi(component.render(width).join("\n"));
			expect(rendered).toContain("\u2026 (12 chars) second tail");
			expect(rendered).not.toContain("summary line");
		}
	});

	test("preview keeps the complete logical tail across wrapping boundaries", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview", thinkingMarkdownTheme, "Thinking...", 0);
		for (const length of [17, 18, 19, 36, 37]) {
			for (const wide of [false, true]) {
				const text = wide ? "中".repeat(length) : "1234567890".repeat(4).slice(0, length);
				for (const markdown of [text, `**${text}**`]) {
					component.updateContent(createAssistantMessage([{ type: "thinking", thinking: markdown }]), true, 0);
					const rendered = stripAnsi(component.render(18).join("\n")).trim();
					if (visibleWidth(text) <= 18) {
						// Fits: full body, no omission marker.
						expect(rendered).toBe(text);
						continue;
					}
					// Omission: hidden-grapheme count plus the tail that fits one row.
					expect(visibleWidth(rendered)).toBeLessThanOrEqual(18);
					const match = /^\u2026 \((\d+) chars\) (.*)$/.exec(rendered) ?? /^\u2026 (.*)$/.exec(rendered);
					expect(match).not.toBeNull();
					const shown = match!.length === 3 ? match![2] : match![1];
					// The visible body is a suffix of the full text; count covers the rest.
					expect(text.endsWith(shown)).toBe(true);
					const shownClusters = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(shown)]
						.length;
					if (match!.length === 3) {
						expect(Number(match![1])).toBe(length - shownClusters);
					}
				}
			}
		}
	});

	test("preview preserves literal Markdown symbols and omits only code block decoration", () => {
		initTheme("dark");
		for (const [text, expected] of [
			["`#`", "#"],
			["\\#", "#"],
			["```\n###\n```", "###"],
			["> ```ts\n> const answer = 42;\n> ```", "const answer = 42;"],
			["- ```ts\n  const answer = 42;\n  ```", "const answer = 42;"],
		]) {
			for (const live of [true, false]) {
				const component = new AssistantMessageComponent(undefined, "preview");
				component.updateContent(
					createAssistantMessage([{ type: "thinking", thinking: text }]),
					live,
					live ? 0 : null,
				);
				const rendered = stripAnsi(component.render(80).join("\n")).trim();
				expect(rendered).toContain(expected);
				expect(rendered).not.toContain("```");
			}
		}
	});

	test("preview restores thinking text styling after inline code", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview", thinkingMarkdownTheme);
		const message = createAssistantMessage([{ type: "thinking", thinking: "prefix `code` suffix" }]);
		for (const live of [true, false]) {
			component.updateContent(message, live, live ? 0 : null);
			const rendered = component.render(80).join("\n");
			expect(rendered).toContain(theme.fg("mdCode", "code"));
			expect(rendered).toContain(theme.fg("thinkingText", " suffix"));
		}
	});

	test("completed tails stay visible while a later folded run streams", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview");
		const message = createAssistantMessage([
			{ type: "thinking", thinking: "first summary\nfirst body" },
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "second summary\nsecond tail" },
		]);
		component.setExpanded(false);
		for (const active of [null, 2, null]) {
			component.updateContent(message, true, active);
			const rendered = stripAnsi(component.render(80).join("\n"));
			expect(rendered).toContain("first body");
			expect(rendered).not.toContain("first summary");
			expect(rendered).toContain("second tail");
			expect(rendered).not.toContain("second summary");
		}
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

	test("preview mode: folded live run keeps the tail after bulk collapse, mouse collapse, and completion", () => {
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

		// thinking_end keeps the identical tail row instead of switching to a summary.
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "earlier\nlive tail" }]),
			true,
			null,
		);
		rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("\u2026 (7 chars) live tail");
		expect(rendered).not.toContain("Thinking...");
		expect(rendered).not.toContain("earlier");
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
		// Count is computed from post-redaction rendered content, not the raw source.
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("[redacted] tail 中文你好");
		expect(rendered).toContain("\u2026 (3 chars)");
	});

	test("preview hidden count spans preceding lines and the clipped prefix of the tail line", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 0);
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: `abc\n中中\n${"x".repeat(30)}tail` }]),
			true,
			0,
		);
		// Width 20, no padding: full hint "… (NN chars) " is 13 cols -> 7 tail cols fit.
		const row = stripAnsi(component.render(20).join("\n")).trimEnd();
		// Hidden: 3 + 2 (prior lines) + 27 clipped in-line = 32 clusters.
		expect(row).toContain("\u2026 (32 chars)");
		expect(row.endsWith("xxxtail")).toBe(true);
	});

	test("preview count grows across the 9-to-10 digit boundary without changing the tail", () => {
		initTheme("dark");
		for (const hidden of [9, 10]) {
			const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 0);
			component.updateContent(
				createAssistantMessage([{ type: "thinking", thinking: `${"a".repeat(hidden)}\n${"b".repeat(30)}` }]),
				true,
				0,
			);
			// Width 50: plenty of tail fits; only the count digits differ.
			const row = stripAnsi(component.render(50).join("\n")).trimEnd();
			expect(row).toContain(`\u2026 (${hidden} chars)`);
			// The tail fills the remaining columns of the single row.
			const hintWidth = `\u2026 (${hidden} chars) `.length;
			expect(row.endsWith("b".repeat(Math.min(30, 50 - hintWidth)))).toBe(true);
		}
	});

	test("preview drops the count before the ellipsis at narrow widths and never overflows", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 0);
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: `earlier\n${"t".repeat(50)}` }]),
			true,
			0,
		);
		for (const width of [1, 2, 3, 4, 5, 6, 10, 14, 15]) {
			const row = stripAnsi(component.render(width).join("\n")).trimEnd();
			expect(visibleWidth(row)).toBeLessThanOrEqual(Math.max(width, 0));
			if (width >= 2) {
				expect(row.includes("\u2026")).toBe(true);
			}
			if (width >= 2 && width < 14) {
				// Too narrow for the count: bare ellipsis separator plus tail.
				expect(row).not.toContain("chars");
			}
		}
		// Width 15 fits "… (56 chars) " (13) plus a couple of tail columns.
		const fifteen = stripAnsi(component.render(15).join("\n")).split("\n").pop()!.trimEnd();
		expect(fifteen).toBe("\u2026 (55 chars) tt");
		expect(stripAnsi(component.render(1).join("\n")).split("\n").pop()!.trimEnd()).toBe("\u2026");
	});

	test("preview tail follows the latest content line as streamed text moves to a new line", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 0);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "first line" }]), true, 0);
		expect(stripAnsi(component.render(40).join("\n"))).toContain("first line");
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "first line\nsecond" }]), true, 0);
		let rendered = stripAnsi(component.render(40).join("\n"));
		expect(rendered).toContain("second");
		expect(rendered).not.toContain("first");
		// Trailing newline / blank tail does not flash an empty row.
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "first line\nsecond\n" }]),
			true,
			0,
		);
		rendered = stripAnsi(component.render(40).join("\n"));
		expect(rendered).toContain("second");
	});

	test("preview recomputes the tail and count after resize", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 0);
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: `start\n${"y".repeat(40)}` }]),
			false,
		);
		const wide = stripAnsi(component.render(50).join("\n")).trimEnd();
		// "start" (5) + 2 clipped tail clusters = 7 hidden at width 50.
		expect(wide).toContain("\u2026 (7 chars)");
		const narrow = stripAnsi(component.render(20).join("\n")).trimEnd();
		// Same content, narrower row: more of the tail is hidden and counted.
		expect(narrow).toContain("\u2026 (38 chars)");
		expect(narrow.endsWith("y".repeat(7))).toBe(true);
		// Wide again restores the larger tail window.
		expect(stripAnsi(component.render(50).join("\n")).trimEnd()).toBe(wide);
	});

	test("preview counts combined emoji and CJK as single clusters", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 0);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "👨‍👩‍👧中e\u0301\nlast" }]), false);
		const row = stripAnsi(component.render(80).join("\n")).trimEnd();
		// 3 clusters hidden (👨‍👩‍👧, 中, e+́), shown by the count, not cell widths.
		expect(row).toContain("\u2026 (3 chars) last");
	});

	test("preview keeps bold styling on the cropped tail without leaking markers", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview", thinkingMarkdownTheme, "Thinking...", 0);
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: `pre\n**${"q".repeat(40)}**` }]),
			false,
		);
		const lines = component.render(20);
		const row = lines.find((line) => line.includes("q")) ?? "";
		expect(stripAnsi(row)).not.toContain("**");
		// Crop boundary inside the bold run keeps bold on the surviving text.
		expect(row).toMatch(/\x1b\[1m(?:\x1b\[[\d;]*m)*q/);
	});

	test("preview published count always equals the true hidden cluster count", () => {
		initTheme("dark");
		const clusterCount = (text: string) =>
			[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
		const cases: Array<{ text: string; width: number; pad: number }> = [
			{ text: "abcdefghijklmn", width: 13, pad: 0 },
			{ text: `${"x".repeat(101)}Z`, width: 14, pad: 0 },
			{ text: "abcdefghijklmnop", width: 12, pad: 0 },
			{ text: "abcdefghijklmnop", width: 13, pad: 0 },
			{ text: "abcdefghijklmnop", width: 14, pad: 0 },
			{ text: "abcdefghijklmnop", width: 15, pad: 0 },
			{ text: `old\n${"q".repeat(30)}`, width: 12, pad: 1 },
			{ text: `old\n${"q".repeat(30)}`, width: 15, pad: 1 },
			// Digit boundary: 9 vs 10 and 99 vs 100 hidden clusters.
			{ text: `${"a".repeat(9)}\n${"b".repeat(60)}`, width: 20, pad: 0 },
			{ text: `${"a".repeat(10)}\n${"b".repeat(60)}`, width: 20, pad: 0 },
			{ text: `${"a".repeat(99)}\n${"b".repeat(120)}`, width: 30, pad: 0 },
			{ text: `${"a".repeat(100)}\n${"b".repeat(120)}`, width: 30, pad: 0 },
		];
		for (const { text, width, pad } of cases) {
			const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", pad);
			component.updateContent(createAssistantMessage([{ type: "thinking", thinking: text }]), true, 0);
			const row = stripAnsi(component.render(width).join("\n")).split("\n").pop()!;
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			const countMatch = /\u2026 \((\d+) chars\) /.exec(row.trim());
			if (countMatch) {
				const suffix = row.trim().slice(countMatch[0].length);
				const prior = text
					.split("\n")
					.slice(0, -1)
					.reduce((n, l) => n + clusterCount(l), 0);
				// Newline separators are not body characters; total excludes them.
				const bodyTotal = text.split("\n").reduce((n, l) => n + clusterCount(l), 0);
				expect(Number(countMatch[1]) + clusterCount(suffix)).toBe(bodyTotal);
				expect(prior).toBeLessThanOrEqual(Number(countMatch[1]));
			}
		}
	});

	test("preview prefers a bare ellipsis over hiding a fitting wide final grapheme", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 0);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "old\n中" }]), true, 0);
		// Width 13: counted form "… (N chars) " leaves 1 col, dropping 中; bare form keeps it.
		const row = stripAnsi(component.render(13).join("\n")).split("\n").pop()!.trimEnd();
		expect(row).toBe("\u2026 中");
	});

	test("preview preserves a combining mark and ZWJ family across style boundaries", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview", thinkingMarkdownTheme, "Thinking...", 0);
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: `${"x".repeat(25)}**e**́` }]),
			false,
		);
		// The acute lands after the bold close but still belongs to the kept grapheme.
		const acute = stripAnsi(component.render(20).join("\n")).split("\n").pop()!.trimEnd();
		expect(acute.endsWith("é")).toBe(true);

		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: `${"x".repeat(25)}\`👨\`‍👩‍👧` }]),
			false,
		);
		const family = stripAnsi(component.render(20).join("\n")).split("\n").pop()!.trimEnd();
		expect(family.endsWith("👨‍👩‍👧")).toBe(true);
	});

	test("preview omits renderer code indentation from the count but keeps real code spaces", () => {
		initTheme("dark");
		for (const codeBlockIndent of [undefined, "        "]) {
			const mdTheme = codeBlockIndent ? { ...getMarkdownTheme(), codeBlockIndent } : getMarkdownTheme();
			const component = new AssistantMessageComponent(undefined, "preview", mdTheme, "Thinking...", 0);
			component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "```\na\nb\n```" }]), false);
			// Only the one real body char on the earlier code line is hidden, regardless of indent.
			const row = stripAnsi(component.render(40).join("\n")).split("\n").pop()!.trimEnd();
			expect(row).toMatch(/^\u2026 \(1 chars\)/);
		}
		// Genuine leading code indentation still counts as body characters.
		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 0);
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "```\n  indented\nx\n```" }]),
			false,
		);
		const row = stripAnsi(component.render(40).join("\n")).split("\n").pop()!.trimEnd();
		expect(row).toMatch(/^\u2026 \(10 chars\)/);
	});

	test("preview counts body spaces without generated continuation or table padding", () => {
		initTheme("dark");
		for (const [thinking, hidden] of [
			["- a\n  b\n\nend", 4],
			["- p\n  - a\n    b\n\nend", 7],
			["```\na\n  \nb\n```", 3],
			["| a | long |\n|---|---|\n| x | y |\n\nend", 9],
		] as const) {
			const component = new AssistantMessageComponent(
				createAssistantMessage([{ type: "thinking", thinking }]),
				"preview",
				undefined,
				"Thinking...",
				0,
			);
			for (const width of [20, 40, 80]) {
				const row = stripAnsi(component.render(width).at(-1)!);
				expect(row).toContain(`… (${hidden} chars) `);
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("preview counts genuine code trailing spaces consistently across production highlighters", () => {
		initTheme("dark");
		for (const language of ["", "text", "js", "python", "json"]) {
			for (const codeBlockIndent of ["", "        "]) {
				const thinking = `\`\`\`${language}\n  a  \nb\n\`\`\``;
				const component = new AssistantMessageComponent(
					createAssistantMessage([{ type: "thinking", thinking }]),
					"preview",
					{ ...getMarkdownTheme(), codeBlockIndent },
					"Thinking...",
					0,
				);
				expect(stripAnsi(component.render(40).at(-1)!)).toContain("… (5 chars) b");
			}
		}
	});

	test("preview preserves raw thinking indentation and unfinished code trailing spaces", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "preview", undefined, "Thinking...", 0);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "    **literal**" }]));
		expect(stripAnsi(component.render(40).at(-1)!)).toContain("**literal**");
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "```text\nold\n  b  " }]), true, 0);
		const live = component.render(16);
		expect(stripAnsi(live.at(-1)!)).toBe("… (4 chars)  b  ");
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "```text\nold\n  b  " }]), false);
		expect(component.render(16)).toEqual(live);
	});

	test("preview retains the last styled table content row rather than a box border", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "| key | value |\n|---|---|\n| last | **tail** |" }]),
			"preview",
			thinkingMarkdownTheme,
			"Thinking...",
			0,
		);
		const row = component.render(40).at(-1)!;
		expect(stripAnsi(row).trimEnd()).toBe("… (9 chars) last│tail");
		expect(row).toMatch(/\x1b\[1m(?:\x1b\[[\d;]*m)*tail/);
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
