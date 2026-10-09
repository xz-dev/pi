/** A window of rendered items. Heights are terminal rows, not item counts. */
export interface SelectionWindow {
	lines: string[];
	startIndex: number;
	endIndex: number;
}

/** Keep the selected item in view, including when items wrap to several rows. */
export function renderSelectionWindow(
	items: readonly string[][],
	selectedIndex: number,
	height: number,
): SelectionWindow {
	const available = Math.max(0, Math.floor(height));
	if (available === 0 || items.length === 0) return { lines: [], startIndex: 0, endIndex: 0 };
	const selected = Math.max(0, Math.min(items.length - 1, selectedIndex));
	let startIndex = selected;
	let endIndex = selected + 1;
	let used = items[selected]!.length;
	// Balance preceding and following context, never dropping the selected item.
	while (startIndex > 0 || endIndex < items.length) {
		const before = startIndex > 0 ? items[startIndex - 1]!.length : Infinity;
		const after = endIndex < items.length ? items[endIndex]!.length : Infinity;
		const preferBefore = selected - startIndex <= endIndex - selected - 1;
		if (used + before <= available && (preferBefore || used + after > available)) {
			startIndex--;
			used += before;
		} else if (used + after <= available) {
			endIndex++;
			used += after;
		} else {
			break;
		}
	}
	return { lines: items.slice(startIndex, endIndex).flat().slice(0, available), startIndex, endIndex };
}
