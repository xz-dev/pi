import type { MessageOrigin, UserMessage } from "@earendil-works/pi-ai";
import { Box, type Component, Container, Image, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import { type CustomMessage, hasMeaningfulContent } from "../../../core/messages.ts";
import { theme } from "../theme/theme.ts";

export function formatMessageOrigin(origin: MessageOrigin | undefined): string {
	switch (origin?.type) {
		case "extension":
			return `Extension · ${origin.extensionName ?? origin.extensionId}`;
		case "rpc":
			return "RPC";
		case "cli":
			return "CLI";
		case "sdk":
			return "SDK";
		case "interactive":
			return "Interactive";
		default:
			return "Source unrecorded";
	}
}

/** Core-owned attribution shell, independent of extension body renderers. */
export class OriginMessageComponent extends Container {
	private readonly message: UserMessage | CustomMessage;
	private readonly renderer?: MessageRenderer;
	private expanded = false;
	private outputPad: number;
	private showImages: boolean;
	private imageWidthCells: number;

	constructor(
		message: UserMessage | CustomMessage,
		renderer?: MessageRenderer,
		outputPad = 1,
		showImages = true,
		imageWidthCells = 60,
	) {
		super();
		this.message = message;
		this.renderer = renderer;
		this.outputPad = outputPad;
		this.showImages = showImages;
		this.imageWidthCells = imageWidthCells;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.rebuild();
	}
	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}
	setShowImages(show: boolean): void {
		this.showImages = show;
		this.rebuild();
	}
	setImageWidthCells(width: number): void {
		this.imageWidthCells = width;
		this.rebuild();
	}
	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		if (!hasMeaningfulContent(this.message.content)) return;
		this.addChild(new Spacer(1));
		const box = new Box(this.outputPad, 1, (text) => theme.bg("toolPendingBg", text));
		const heading = new Text(theme.fg("muted", `[${formatMessageOrigin(this.message.origin)}]`), 0, 0);
		box.addChild(
			new MouseRegion(heading, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
		this.addChild(box);
		if (this.message.role === "custom" && !this.message.display && !this.expanded) return;

		let body: Component | undefined;
		if (this.renderer && this.message.role === "custom") {
			try {
				body = this.renderer(this.message, { expanded: this.expanded, outputPad: 0 }, theme);
			} catch {
				/* Fall back to the stored body, retaining the source heading. */
			}
		}
		if (body) {
			const component = body;
			box.addChild({
				render: (width) =>
					component.render(width).map((line) =>
						// Keep image and link protocols; replace text styling with the uniform source-message color.
						theme.fg("muted", line.replace(/\x1b\[[0-9;:]*m/g, "")),
					),
				invalidate: () => component.invalidate(),
				handleMouse: component.handleMouse?.bind(component),
			});
			return;
		}
		const content =
			typeof this.message.content === "string"
				? [{ type: "text" as const, text: this.message.content }]
				: this.message.content;
		for (const part of content) {
			if (part.type === "text") {
				const lines = part.text.replace(/\x1b\[[0-9;:]*m/g, "").split("\n");
				box.addChild(new Text(theme.fg("muted", (this.expanded ? lines : lines.slice(0, 10)).join("\n")), 0, 0));
			} else if (this.showImages) {
				box.addChild(
					new Image(
						part.data,
						part.mimeType,
						{ fallbackColor: (text) => theme.fg("muted", text) },
						{ maxWidthCells: this.imageWidthCells },
					),
				);
			} else {
				box.addChild(new Text(theme.fg("muted", `[image: ${part.mimeType}]`), 0, 0));
			}
		}
	}
}
