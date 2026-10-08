import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	clipLineStart,
	countVisibleGraphemes,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	stripTerminalSequences,
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

/** Muted prefix marking omitted thinking content: `… (N chars) ` when it fits, `… ` otherwise. */
function omissionHintText(hidden: number): string {
	return `\u2026 (${hidden} chars) `;
}

const BARE_HINT = "\u2026 ";
const MINIMAL_HINT = "\u2026";

/**
 * One styled reasoning row: a rolling tail window over the fully rendered
 * Markdown buffer. New text pushes old content off the left edge; the muted
 * `… (N chars)` hint reports hidden rendered-body grapheme clusters. Live and
 * completed runs use the identical algorithm, so thinking_end changes nothing.
 */
class ThinkingPreviewText implements Component {
	private readonly text: string;
	private readonly paddingX: number;
	private readonly markdownTheme: MarkdownTheme;
	private readonly transform: (markdown: string, availableWidth: number) => string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		text: string,
		paddingX: number,
		markdownTheme: MarkdownTheme,
		transform: (markdown: string, availableWidth: number) => string,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.markdownTheme = markdownTheme;
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
		// Render the entire buffer with Markdown first; crop styled output below.
		const rendered = new Markdown(
			this.text,
			0,
			0,
			{ ...this.markdownTheme, codeBlockBorder: () => "" },
			{ color: (text) => theme.fg("thinkingText", text), italic: true },
			{ transform: this.transform, overflow: "preserve" },
		).render(availableWidth);
		// A single-row preview cannot display terminal image rows.
		let hiddenBefore = 0;
		const textLines = rendered.filter((line) => !line.includes("\x1b_G") && !line.includes("\x1b]1337;"));
		const tailIndex = textLines.findLastIndex((line) => stripTerminalSequences(line).trim().length > 0);
		const tail = textLines[tailIndex] ?? "";
		for (let i = 0; i < tailIndex; i++) {
			hiddenBefore += countVisibleGraphemes(textLines[i]);
		}

		let content: string;
		const tailWidth = visibleWidth(tail);
		if (hiddenBefore === 0 && tailWidth <= availableWidth) {
			// Nothing omitted: show the styled body without a false ellipsis.
			content = tail;
		} else {
			// Pick a self-consistent hint/body pair: hint width depends on the count's
			// digit length, and the count depends on the kept suffix. Digit length is
			// monotone in the hidden count, so converge upward; if the counted form
			// cannot coexist with its own suffix, fall back once to the bare ellipsis.
			let hint = MINIMAL_HINT;
			let clipped = clipLineStart(tail, Math.max(0, availableWidth - visibleWidth(hint)));
			for (;;) {
				const total = hiddenBefore + clipped.hidden;
				const candidate = omissionHintText(total);
				const bodyWidth = availableWidth - visibleWidth(candidate);
				if (bodyWidth <= 0) {
					// Even the counted form alone does not fit; go bare.
					hint = availableWidth >= visibleWidth(BARE_HINT) ? BARE_HINT : MINIMAL_HINT;
					clipped = clipLineStart(tail, Math.max(0, availableWidth - visibleWidth(hint)));
					break;
				}
				const next = clipLineStart(tail, bodyWidth);
				if (hiddenBefore + next.hidden === total) {
					// Self-consistent: the printed count equals the true hidden count.
					// But if the counted form hides a final wide grapheme that fits with
					// the bare hint, the newest content wins over the count.
					const bare = availableWidth >= visibleWidth(BARE_HINT) ? BARE_HINT : MINIMAL_HINT;
					const bareClipped = clipLineStart(tail, availableWidth - visibleWidth(bare));
					if (next.width === 0 && bareClipped.width > 0) {
						hint = bare;
						clipped = bareClipped;
					} else {
						hint = candidate;
						clipped = next;
					}
					break;
				}
				hint = candidate;
				clipped = next;
			}
			content = `${theme.italic(theme.fg("muted", hint))}${clipped.text}`;
		}

		const line = `${" ".repeat(paddingX)}${content}\x1b[0m${" ".repeat(paddingX)}`;
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
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking;
					if (thinking.trim()) {
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
				// Folded preview-mode runs show the same rolling tail window while live and after completion.
				const showPreview = this.thinkingDisplayMode === "preview" && !expanded;

				let thinkingComponent: Component;
				if (showPreview) {
					const transform = createMarkdownTransform(
						"assistant-thinking",
						this.isStreaming,
						this.markdownTransformers,
					);
					thinkingComponent = new ThinkingPreviewText(
						thinkingBlocks.join("\n\n"),
						this.outputPad,
						this.markdownTheme,
						transform,
					);
				} else if (expanded) {
					thinkingComponent = new Markdown(
						thinkingBlocks.map((block) => block.trim()).join("\n\n"),
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
