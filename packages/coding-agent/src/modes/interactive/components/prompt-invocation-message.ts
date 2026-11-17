import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Prompt-template invocation card, styled like the skill card. Collapsed it shows only the command the
 * user typed; expanded it also shows the stored expansion. Expanded state lives only in this instance.
 */
export class PromptInvocationMessageComponent extends Box {
	private expanded = false;
	private command: string;
	private body: string;
	private markdownTheme: MarkdownTheme;

	constructor(command: string, body: string, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		this.command = command;
		this.body = body;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const content = new Container();
		const label = theme.fg("customMessageLabel", `\x1b[1m[prompt]\x1b[22m `);
		const command = theme.fg("customMessageText", this.command);
		if (this.expanded) {
			content.addChild(new Text(label + command, 0, 0));
			content.addChild(new Spacer(1));
			content.addChild(
				new Markdown(this.body, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			content.addChild(
				new Text(`${label}${command}${theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`)}`, 0, 0),
			);
		}

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
