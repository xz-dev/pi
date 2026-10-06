import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	sliceByColumn,
	Text,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { ThinkingDisplayMode } from "../../../core/settings-manager.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export type { ThinkingDisplayMode };

/**
 * Single-row thinking preview used while a reasoning run is still streaming.
 * Applies the thinking markdown transform at render time (with the real
 * available width, so width-sensitive transformers behave like full Markdown),
 * then shows the tail of the last non-empty transformed line, clipped to the
 * available width using terminal-column accounting (ANSI, wide chars).
 */
class ThinkingPreviewText implements Component {
	private readonly text: string;
	private readonly paddingX: number;
	private readonly transform: (markdown: string, availableWidth: number) => string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string, paddingX = 1, transform: (markdown: string, availableWidth: number) => string) {
		this.text = text;
		this.paddingX = paddingX;
		this.transform = transform;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		if (width <= 0) {
			const result = [""];
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		const availableWidth = Math.max(1, width - paddingX * 2);
		const transformed = this.transform(this.text, availableWidth);
		const transformedLines = transformed.split("\n").filter((line) => line.trim().length > 0);
		const lastLine = (transformedLines.at(-1) ?? "").trim();
		const styled = theme.italic(theme.fg("thinkingText", lastLine));
		const clipped =
			visibleWidth(styled) > availableWidth
				? sliceByColumn(styled, visibleWidth(styled) - availableWidth, availableWidth, true)
				: styled;
		const line = `${" ".repeat(paddingX)}${clipped}\x1b[0m${" ".repeat(paddingX)}`;
		const paddingNeeded = Math.max(0, width - visibleWidth(line));
		const result = [line + " ".repeat(paddingNeeded)];
		this.cachedWidth = width;
		this.cachedLines = result;
		return result;
	}
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private thinkingDisplayMode: ThinkingDisplayMode;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private thinkingBulkOverride: boolean | null = null;
	private activeThinkingContentIndex: number | null = null;

	constructor(
		message?: AssistantMessage,
		thinkingDisplayMode: ThinkingDisplayMode = "preview",
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.thinkingDisplayMode = thinkingDisplayMode;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setThinkingDisplayMode(mode: ThinkingDisplayMode): void {
		this.thinkingDisplayMode = mode;
		this.thinkingVisibilityOverrides.clear();
		this.thinkingBulkOverride = null;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** Bulk expand/collapse (Ctrl+O): overrides every run and clears per-run mouse overrides. */
	setExpanded(expanded: boolean): void {
		this.thinkingBulkOverride = expanded;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(
		message: AssistantMessage,
		isStreaming = this.isStreaming,
		activeThinkingContentIndex: number | null = this.activeThinkingContentIndex,
	): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		if (!isStreaming) {
			this.activeThinkingContentIndex = null;
		} else {
			this.activeThinkingContentIndex = activeThinkingContentIndex;
		}

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				const runStartIndex = i;
				let runEndIndex = i;
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					runEndIndex = i;
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const runIndex = thinkingRunIndex++;
				const override = this.thinkingVisibilityOverrides.get(runIndex);
				const expanded = override ?? this.thinkingBulkOverride ?? this.thinkingDisplayMode === "expanded";
				const runIsLive =
					this.isStreaming &&
					this.activeThinkingContentIndex !== null &&
					this.activeThinkingContentIndex >= runStartIndex &&
					this.activeThinkingContentIndex <= runEndIndex;
				// Any folded live run shows the preview row; explicit expansion wins.
				const showPreview = this.thinkingDisplayMode === "preview" && runIsLive && !expanded;

				let thinkingComponent: Component;
				if (showPreview) {
					const transform = createMarkdownTransform(
						"assistant-thinking",
						this.isStreaming,
						this.markdownTransformers,
					);
					thinkingComponent = new ThinkingPreviewText(thinkingBlocks.join("\n\n"), this.outputPad, transform);
				} else if (expanded) {
					thinkingComponent = new Markdown(
						thinkingBlocks.join("\n\n"),
						this.outputPad,
						0,
						this.markdownTheme,
						{
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						},
						{
							transform: createMarkdownTransform(
								"assistant-thinking",
								this.isStreaming,
								this.markdownTransformers,
							),
						},
					);
				} else {
					thinkingComponent = new Text(
						theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)),
						this.outputPad,
						0,
					);
				}
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !expanded);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
