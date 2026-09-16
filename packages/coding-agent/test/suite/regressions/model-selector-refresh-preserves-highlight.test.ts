import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

/** Return the model id of the highlighted (→) row in the rendered selector. */
function selectedModelId(rendered: string): string | undefined {
	const line = rendered.split("\n").find((l) => l.startsWith("→ "));
	if (!line) return undefined;
	const rest = line.replace(/^→\s*/, "");
	const id = rest.split(" [")[0]?.replace(/^✓\s*/, "");
	return id?.trim() || undefined;
}

// Gate the catalog refresh so tests can move the cursor before it completes.
let refreshGate: Promise<void> = Promise.resolve();
let releaseRefresh: () => void = () => {};

vi.mock("../../../src/modes/interactive/model-catalog-refresh.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../../src/modes/interactive/model-catalog-refresh.ts")>();
	return {
		...mod,
		refreshModelCatalogs: async (...args: Parameters<typeof mod.refreshModelCatalogs>) => {
			await refreshGate;
			return mod.refreshModelCatalogs(...args);
		},
	};
});

describe("model selector refresh preserves highlighted row", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
	});

	afterAll(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createSelector(): Promise<ModelSelectorComponent> {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
			],
		});
		harnesses.push(harness);
		const current = harness.getModel("alpha-1")!;
		return new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
	}

	it("keeps the browsed row when the background refresh completes", async () => {
		const selector = await createSelector();

		// Move down two rows while the refresh is still pending.
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-3");

		releaseRefresh();
		await vi.waitFor(() => {
			expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed.");
		});

		// The refresh must not yank the cursor back to the confirmed model (alpha-1).
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-3");
		selector.dispose();
	});

	it("keeps the highlighted match when a refresh completes with an active query", async () => {
		const selector = await createSelector();

		for (const char of "alpha") {
			selector.handleInput(char);
		}
		selector.handleInput("\x1b[B");
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-2");

		releaseRefresh();
		await vi.waitFor(() => {
			expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed.");
		});

		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-2");
		selector.dispose();
	});

	it("still anchors on the current model when nothing was browsed yet", async () => {
		const selector = await createSelector();

		releaseRefresh();
		await vi.waitFor(() => {
			expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed.");
		});

		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-1");
		selector.dispose();
	});
});
