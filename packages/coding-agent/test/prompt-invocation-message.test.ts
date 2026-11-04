import { stripVTControlCharacters } from "node:util";
import { setKeybindings, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { PromptInvocationMessageComponent } from "../src/modes/interactive/components/prompt-invocation-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function lines(component: PromptInvocationMessageComponent, width = 80): string[] {
	return component.render(width).map(stripVTControlCharacters);
}

function click(component: PromptInvocationMessageComponent, width = 80): void {
	const rendered = lines(component, width);
	const y = rendered.findIndex((line) => line.includes("[prompt]"));
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width,
		height: rendered.length,
		shift: false,
		alt: false,
		ctrl: false,
	};
	expect(component.handleMouse(event)?.handled).toBe(true);
}

describe("PromptInvocationMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("shows only the command when collapsed and the stored body when expanded", () => {
		const component = new PromptInvocationMessageComponent('/review "src/a b.ts"', "Review this code: src/a b.ts");
		let text = lines(component).join("\n");
		expect(text).toContain('[prompt] /review "src/a b.ts"');
		expect(text).toContain("to expand");
		expect(text).not.toContain("Review this code");

		click(component);
		text = lines(component).join("\n");
		expect(text).toContain('[prompt] /review "src/a b.ts"');
		expect(text).toContain("Review this code: src/a b.ts");
		expect(text).not.toContain("to expand");

		click(component);
		expect(lines(component).join("\n")).not.toContain("Review this code");
	});

	it("follows setExpanded and keeps its state across invalidate", () => {
		const component = new PromptInvocationMessageComponent("/review a", "Body text");
		component.setExpanded(true);
		component.invalidate();
		expect(lines(component).join("\n")).toContain("Body text");
		component.setExpanded(false);
		expect(lines(component).join("\n")).not.toContain("Body text");
	});

	it("fits narrow widths with wide characters and multi-line commands", () => {
		const component = new PromptInvocationMessageComponent("/审查 第一行参数很长很长很长\n第二行", "正文".repeat(40));
		for (const expanded of [false, true]) {
			component.setExpanded(expanded);
			for (const width of [12, 20, 40]) {
				for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		expect(lines(component, 40).join("\n")).toContain("第二行");
	});
});
