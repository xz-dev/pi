import {
	type Component,
	Container,
	dispatchMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "./tui.ts";

/** A single-child host that explicitly forwards its allocated height. */
export class BoundedHost extends Container {
	private renderedHeight?: number;

	override render(width: number): string[] {
		this.renderedHeight = undefined;
		return super.render(width);
	}

	renderInBounds(width: number, height: number): string[] {
		const child: Component | undefined = this.children.length === 1 ? this.children[0] : undefined;
		if (!child?.renderInBounds) return this.render(width);
		const lines = child.renderInBounds(width, height);
		this.renderedHeight = lines.length;
		return lines;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (this.renderedHeight === undefined) return super.handleMouse(event);
		const child = this.children[0];
		if (!child || event.y < 0 || event.y >= this.renderedHeight) return undefined;
		return dispatchMouseEvent(child, { ...event, height: this.renderedHeight });
	}
}
