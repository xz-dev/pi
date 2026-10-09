import {
	type Component,
	Container,
	dispatchMouseEvent,
	type TuiMouseEvent,
	truncateToWidth,
} from "@earendil-works/pi-tui";

/** Explicit compact presentation for built-in selectors; ordinary containers stay unbounded. */
export abstract class SelectorPanel extends Container {
	private compactView?: Container;

	protected abstract getCompactView(width: number, height: number): Container;

	override render(width: number): string[] {
		this.compactView = undefined;
		return super.render(width);
	}

	renderInBounds(width: number, height: number): string[] {
		const natural = this.render(width);
		const available = Math.max(0, Math.floor(height));
		if (available === 0) return [];
		if (natural.length <= available) return natural;
		this.compactView = this.getCompactView(width, available);
		return this.compactView.render(width).slice(0, available);
	}

	override handleMouse(event: TuiMouseEvent) {
		return this.compactView ? this.compactView.handleMouse(event) : super.handleMouse(event);
	}
}

/** Compose the existing input controls around a height-aware list. */
export function compactSelector(
	width: number,
	height: number,
	header: readonly Component[],
	list: Component | ((height: number) => string[]),
	footer: readonly Component[] = [],
): Container {
	const view = new Container();
	const headerHeight = header.reduce((sum, component) => sum + component.render(width).length, 0);
	const footerLines = footer.flatMap((component) => component.render(width));
	const visibleFooter = footerLines.slice(0, Math.max(0, height - headerHeight - 1));
	if (visibleFooter.length > 0 && visibleFooter.length < footerLines.length) {
		visibleFooter[visibleFooter.length - 1] = truncateToWidth("… resize for full details", width);
	}
	for (const component of header) view.addChild(component);
	const listHeight = Math.max(0, height - headerHeight - visibleFooter.length);
	view.addChild({
		render: () =>
			typeof list === "function"
				? list(listHeight)
				: (list.renderInBounds?.(width, listHeight) ?? list.render(width)),
		handleMouse: (event) => (typeof list === "function" ? undefined : dispatchMouseEvent(list, event)),
		invalidate: () => {
			if (typeof list !== "function") list.invalidate();
		},
	});
	view.addChild({ render: () => visibleFooter, invalidate: () => {} });
	return view;
}
