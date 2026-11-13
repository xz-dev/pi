import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BoundedHost } from "../src/bounded-host.ts";
import { SelectList } from "../src/components/select-list.ts";
import { SettingsList } from "../src/components/settings-list.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { renderSelectionWindow } from "../src/selection-window.ts";
import { type Component, Container, CURSOR_MARKER, type TuiMouseEvent } from "../src/tui.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { defaultSelectListTheme } from "./test-themes.ts";

describe("bounded selection rendering", () => {
	it("retains the selected rendered item through shrinking, including wrapped rows", () => {
		const items = [["one"], ["two", "二"], ["→ three", "三", "3"], ["four"], ["five"]];
		assert.deepEqual(renderSelectionWindow(items, 2, 8).lines, items.flat());
		for (const height of [6, 4, 3, 2, 1]) {
			const window = renderSelectionWindow(items, 2, height);
			assert.ok(window.lines.length <= height);
			assert.ok(window.lines.includes("→ three"));
			assert.ok(window.startIndex <= 2 && window.endIndex > 2);
		}
		assert.deepEqual(renderSelectionWindow(items, 2, 0).lines, []);
		assert.deepEqual(renderSelectionWindow([], 0, 3).lines, []);
		assert.deepEqual(renderSelectionWindow(items, 2, 8).lines, items.flat());
	});

	it("forwards only the allocated region and retains natural measurement", () => {
		const budgets: number[] = [];
		const child: Component = {
			render: () => Array.from({ length: 10 }, () => "natural"),
			renderInBounds: (_width, height) => {
				budgets.push(height);
				return [`${CURSOR_MARKER}search`, "→ selected"].slice(0, height);
			},
			invalidate: () => {},
		};
		const host = new BoundedHost();
		host.addChild(child);
		const root = new VStack([
			{ component: host, grow: 1 },
			{ component: { render: () => ["footer"], invalidate: () => {} }, shrink: 0 },
		]);
		assert.equal(host.render(20).length, 10);
		const frame = renderLayoutFrame(root, 20, 3, () => {});
		assert.deepEqual(budgets, [2]);
		assert.deepEqual(frame.lines, [`${CURSOR_MARKER}search`, "→ selected", "footer"]);
		assert.equal(host.render(20).length, 10);
	});

	it("does not opt ordinary containers or custom render overrides into height allocation", () => {
		class CustomContainer extends Container {
			override render(): string[] {
				return ["custom", "presentation", "unchanged"];
			}
		}
		for (const container of [new Container(), new CustomContainer()]) {
			container.addChild({
				render: () => ["natural", "rows"],
				renderInBounds: () => {
					throw new Error("unexpected opt-in");
				},
				invalidate: () => {},
			});
			const host = new BoundedHost();
			host.addChild(container);
			assert.deepEqual(host.renderInBounds(20, 1), container.render(20));
		}
	});
	it("maps clicks to the bounded SelectList window even after press recenters it", () => {
		const list = new SelectList(
			Array.from({ length: 20 }, (_, i) => ({ value: `${i}`, label: `Item ${i}` })),
			10,
			defaultSelectListTheme,
		);
		list.setSelectedIndex(10);
		let chosen: string | undefined;
		list.onSelect = (item) => {
			chosen = item.value;
		};
		const before = list.render(40);
		const compact = list.renderInBounds(40, 3).map(stripTerminalSequences);
		assert.ok(compact.some((line) => line.startsWith("→ Item 10")));
		const visibleId = compact[0]!.match(/Item (\d+)/)![1];
		const press: TuiMouseEvent = {
			type: "press",
			button: "left",
			x: 1,
			y: 0,
			screenX: 1,
			screenY: 0,
			width: 40,
			height: 3,
			shift: false,
			alt: false,
			ctrl: false,
		};
		list.handleMouse(press);
		list.renderInBounds(40, 3);
		list.handleMouse({ ...press, type: "click" });
		assert.equal(chosen, visibleId);
		assert.equal(list.render(40).length, before.length);
	});

	it("keeps settings search, selected row and bounded pointer geometry aligned", () => {
		const changes: string[] = [];
		const list = new SettingsList(
			Array.from({ length: 20 }, (_, i) => ({
				id: `${i}`,
				label: `Item ${i}`,
				currentValue: "off",
				values: ["off", "on"],
				description: "Long description ".repeat(20),
			})),
			10,
			{
				label: (text) => text,
				value: (text) => text,
				description: (text) => text,
				cursor: "→ ",
				hint: (text) => text,
			},
			(id) => changes.push(id),
			() => {},
			{ enableSearch: true },
		);
		list.selectItem("10");
		const lines = list.renderInBounds(40, 5);
		assert.equal(lines.length, 5);
		assert.ok(lines[0]!.includes(">"));
		assert.ok(lines.some((line) => line.startsWith("→ Item 10")));
		const visibleId = lines[1]!.match(/Item (\d+)/)![1];
		const press: TuiMouseEvent = {
			type: "press",
			button: "left",
			x: 1,
			y: 1,
			screenX: 1,
			screenY: 1,
			width: 40,
			height: 5,
			shift: false,
			alt: false,
			ctrl: false,
		};
		list.handleMouse(press);
		list.renderInBounds(40, 5);
		list.handleMouse({ ...press, type: "click" });
		assert.deepEqual(changes, [visibleId]);
		assert.ok(list.render(40).length > 5);
	});
});
