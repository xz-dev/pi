import { BoundedHost, type Component, type TUI } from "@earendil-works/pi-tui";

/** The editor slot opts selectors into bounded rendering without changing custom editors. */
export class SelectorHost extends BoundedHost {
	private readonly tui: TUI;
	private readonly trailingComponents: () => readonly Component[];

	constructor(tui: TUI, trailingComponents: () => readonly Component[]) {
		super();
		this.tui = tui;
		this.trailingComponents = trailingComponents;
	}

	override render(width: number): string[] {
		if (this.tui.mode !== "regular" || this.children.length !== 1 || !this.children[0]?.renderInBounds) {
			return super.render(width);
		}
		// Regular mode scrolls preceding content into history. Reserve the actual
		// rendered rows below the selector, rather than a guessed terminal offset.
		const trailingHeight = this.trailingComponents().reduce(
			(sum, component) => sum + component.render(width).length,
			0,
		);
		return super.renderInBounds(width, Math.max(0, this.tui.terminal.rows - trailingHeight));
	}
}
