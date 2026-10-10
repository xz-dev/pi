import assert from "node:assert";
import { describe, it } from "node:test";
import xterm from "@xterm/headless";
import {
	clipLineStart,
	countVisibleGraphemes,
	getOsc8LinkAtColumn,
	stripTerminalSequences,
	visibleWidth,
} from "../src/utils.ts";

describe("countVisibleGraphemes", () => {
	it("counts plain ASCII clusters", () => {
		assert.strictEqual(countVisibleGraphemes("hello world"), 11);
	});

	it("ignores ANSI/OSC sequences entirely", () => {
		assert.strictEqual(countVisibleGraphemes("\x1b[1m\x1b[31mhello\x1b[0m"), 5);
		assert.strictEqual(countVisibleGraphemes("\x1b]8;;https://x\x1b\\ab\x1b]8;;\x1b\\"), 2);
	});

	it("counts a combined emoji or ZWJ sequence as one cluster", () => {
		assert.strictEqual(countVisibleGraphemes("👍🏽"), 1);
		assert.strictEqual(countVisibleGraphemes("👨‍👩‍👧"), 1);
		assert.strictEqual(countVisibleGraphemes("e\u0301"), 1);
		assert.strictEqual(countVisibleGraphemes("a中👨‍👩‍👧z"), 4);
	});

	it("counts a tab as one cluster despite its three-cell width", () => {
		assert.strictEqual(countVisibleGraphemes("a\tb"), 3);
	});
});

describe("clipLineStart", () => {
	it("returns the whole line when it fits", () => {
		const result = clipLineStart("hello", 10);
		assert.deepStrictEqual(result, { text: "hello", width: 5, hidden: 0 });
	});

	it("keeps the tail columns and counts dropped clusters", () => {
		const result = clipLineStart("abcdef", 3);
		assert.strictEqual(result.text, "def");
		assert.strictEqual(result.width, 3);
		assert.strictEqual(result.hidden, 3);
	});

	it("never splits a wide grapheme at the boundary and counts it hidden", () => {
		// 3 ASCII + 中(w2) + 2 ASCII: width 7. Keeping last 3 cols drops 中 entirely.
		const result = clipLineStart("abc中de", 3);
		assert.strictEqual(result.text, "de");
		assert.strictEqual(result.width, 2);
		assert.strictEqual(result.hidden, 4);
	});

	it("counts ZWJ emoji clusters as single hidden units", () => {
		const result = clipLineStart("ab👨‍👩‍👧cd", 2);
		assert.strictEqual(result.text, "cd");
		assert.strictEqual(result.hidden, 3);
	});

	it("does not split a grapheme across an ANSI boundary inside it", () => {
		// Style reset lands between ZWJ family members: still one cluster.
		const family = clipLineStart(`${"a".repeat(20)}👨\x1b[0m‍👩‍👧`, 2);
		assert.strictEqual(family.text, "👨\x1b[0m‍👩‍👧");
		assert.strictEqual(family.hidden, 20);
		assert.strictEqual(countVisibleGraphemes(`${"a".repeat(20)}👨\x1b[0m‍👩‍👧`), 21);

		// Combining acute after a style close stays attached to its base char.
		const acute = clipLineStart(`${"a".repeat(20)}e\x1b[0ḿ`, 2);
		assert.strictEqual(acute.text, "ae\x1b[0ḿ");
		assert.strictEqual(acute.width, 2);
		assert.strictEqual(acute.hidden, 19);
		assert.strictEqual(countVisibleGraphemes(`${"a".repeat(20)}e\x1b[0ḿ`), 21);
	});

	it("keeps style transitions inside omitted combining and ZWJ graphemes", async () => {
		for (const [line, bold, red] of [
			["\x1b[1mae\x1b[22ḿXYZ", false, false],
			["ae\x1b[31ḿXYZ\x1b[39m", false, true],
			["\x1b[31mae\x1b[39ḿXYZ", false, false],
			["\x1b[1ma👨\x1b[22m‍👩‍👧XYZ", false, false],
			["ae\x1b[1ḿXYZ\x1b[22m", true, false],
		] as const) {
			const result = clipLineStart(line, 3);
			assert.strictEqual(stripTerminalSequences(result.text), "XYZ");
			assert.strictEqual(result.hidden, 2);
			assert.strictEqual(result.width, 3);
			const terminal = new xterm.Terminal({ cols: 8, rows: 2, allowProposedApi: true });
			try {
				await new Promise<void>((resolve) => terminal.write(`${result.text}\x1b[0m\r\nNEXT`, resolve));
				const cell = terminal.buffer.active.getLine(0)!.getCell(0)!;
				assert.strictEqual(cell.getChars(), "X");
				assert.strictEqual(Boolean(cell.isBold()), bold);
				assert.strictEqual(cell.isFgDefault(), !red);
				if (red) assert.strictEqual(cell.getFgColor(), 1);
				const next = terminal.buffer.active.getLine(1)!.getCell(0)!;
				assert.strictEqual(next.isBold(), 0);
				assert.strictEqual(next.isFgDefault(), true);
			} finally {
				terminal.dispose();
			}
		}
	});

	it("keeps hyperlink state changes inside omitted graphemes and closes the kept suffix", () => {
		for (const end of ["\x07", "\x1b\\"]) {
			const open = `\x1b]8;;https://example.com${end}`;
			const close = `\x1b]8;;${end}`;
			for (const [line, expected] of [
				[`ae${open}́XYZ${close}`, "https://example.com"],
				[`${open}ae${close}́XYZ`, undefined],
			] as const) {
				const result = clipLineStart(line, 3);
				assert.strictEqual(getOsc8LinkAtColumn(result.text, 0), expected);
				assert.strictEqual(getOsc8LinkAtColumn(`${result.text}Z`, 3), undefined);
				assert.strictEqual(result.hidden, 2);
			}
		}
	});

	it("counts and clips long lines without changing their newest text", () => {
		const source = `${"x".repeat(100000)}tail`;
		assert.strictEqual(countVisibleGraphemes(source), 100004);
		assert.deepStrictEqual(clipLineStart(source, 80), {
			text: `${"x".repeat(76)}tail`,
			width: 80,
			hidden: 99924,
		});
	});

	it("keeps a trailing style close after the final kept grapheme", () => {
		const line = `\x1b[1m${"x".repeat(20)}\x1b[22m`;
		const result = clipLineStart(line, 4);
		assert.strictEqual(result.text, `\x1b[1m${"xxxx"}\x1b[22m`);
		assert.strictEqual(result.hidden, 16);
	});

	it("preserves ANSI codes inside the kept range and drops codes before it", () => {
		const line = "\x1b[31mredpart\x1b[1mBOLDtail\x1b[0m";
		const result = clipLineStart(line, 8);
		assert.strictEqual(result.text.includes("BOLDtail"), true);
		assert.strictEqual(visibleWidth(result.text), 8);
		assert.strictEqual(result.hidden, 7);
		// Style opened inside the kept region is carried through.
		assert.strictEqual(result.text.includes("\x1b[1m"), true);
	});

	it("reapplies pending ANSI state from before the window", () => {
		const line = "\x1b[31mabcdefghij\x1b[0m";
		const result = clipLineStart(line, 4);
		// The red code precedes the kept text so styling continues across the cut.
		assert.strictEqual(result.text.startsWith("\x1b[31m"), true);
		assert.strictEqual(result.hidden, 6);
	});

	it("handles zero and negative widths without overflow", () => {
		for (const w of [0, -1]) {
			const result = clipLineStart("abc", w);
			assert.strictEqual(result.text, "");
			assert.strictEqual(result.width, 0);
			assert.strictEqual(result.hidden, 3);
		}
	});
});
