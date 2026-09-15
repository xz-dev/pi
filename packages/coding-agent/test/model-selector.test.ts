import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	function getRenderedRows(selector: ModelSelectorComponent): string[] {
		return stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.filter((line) => line.trimStart().startsWith("→"))
			.map((line) => line.trim());
	}

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`${id} [`))
				?.trimEnd();

		expect(getModelRow("current-model")).toBe(`→ ✓ current-model [${currentModel.provider}]`);
		selector.handleInput("\x1b[B");
		expect(getModelRow("current-model")).toBe(`  ✓ current-model [${currentModel.provider}]`);
		expect(getModelRow("browsed-model")).toBe(`→   browsed-model [${currentModel.provider}]`);
		selector.dispose();
	});

	it("preserves the browsed selection when a background refresh completes", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
				{ id: "third-model", name: "Third Model", reasoning: true },
			],
		});
		let releaseRefresh: ((result: { aborted: boolean; errors: Map<string, Error> }) => void) | undefined;
		const refreshPromise = new Promise<{ aborted: boolean; errors: Map<string, Error> }>((resolve) => {
			releaseRefresh = resolve;
		});
		vi.spyOn(harness.session.modelRuntime, "refresh").mockReturnValue(refreshPromise);

		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		selector.handleInput("\x1b[B"); // move highlight to browsed-model (row 1)
		expect(getRenderedRows(selector)[0]).toContain("browsed-model");

		releaseRefresh!({ aborted: false, errors: new Map() });
		await vi.waitFor(() => {
			// Refresh completed: highlight must stay on browsed-model, not snap back to row 0.
			expect(getRenderedRows(selector)).toEqual([expect.stringContaining("browsed-model")]);
		});
		selector.dispose();
	});

	it("preserves the filtered selection when a background refresh completes with an active query", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
				{ id: "third-model", name: "Third Model", reasoning: true },
			],
		});
		let releaseRefresh: ((result: { aborted: boolean; errors: Map<string, Error> }) => void) | undefined;
		const refreshPromise = new Promise<{ aborted: boolean; errors: Map<string, Error> }>((resolve) => {
			releaseRefresh = resolve;
		});
		vi.spyOn(harness.session.modelRuntime, "refresh").mockReturnValue(refreshPromise);

		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		selector.handleInput("m"); // filter by query; highlight moves to top match
		selector.handleInput("\x1b[B"); // move highlight off the first filtered row
		const highlighted = getRenderedRows(selector)[0];

		releaseRefresh!({ aborted: false, errors: new Map() });
		await vi.waitFor(() => {
			expect(getRenderedRows(selector)[0]).toBe(highlighted);
		});
		selector.dispose();
	});

	it("falls back to the current-model highlight when the browsed model disappears after refresh", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		let releaseRefresh: ((result: { aborted: boolean; errors: Map<string, Error> }) => void) | undefined;
		const refreshPromise = new Promise<{ aborted: boolean; errors: Map<string, Error> }>((resolve) => {
			releaseRefresh = resolve;
		});
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(async () => {
			const result = await refreshPromise;
			// Simulate the model vanishing from the catalog between selection and refresh.
			const runtime = harness!.session.modelRuntime as unknown as {
				availableModels: Array<{ id: string }> | undefined;
			};
			runtime.availableModels = runtime.availableModels?.filter((model) => model.id !== "browsed-model");
			return result;
		});

		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		selector.handleInput("\x1b[B"); // highlight browsed-model
		expect(getRenderedRows(selector)[0]).toContain("browsed-model");

		releaseRefresh!({ aborted: false, errors: new Map() });
		await vi.waitFor(() => {
			// browsed-model is gone; fallback highlights the current model row instead.
			expect(getRenderedRows(selector)).toEqual([expect.stringContaining("current-model")]);
		});
		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Ctrl+R to set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});
});
