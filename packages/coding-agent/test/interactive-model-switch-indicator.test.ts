import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, type SelectList } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createView(_harness: Harness) {
	return {
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		settlePendingModelSwitch: Reflect.get(
			InteractiveMode.prototype,
			"settlePendingModelSwitch",
		) as InteractiveMode["settlePendingModelSwitch"],
		renderChat() {
			return stripAnsi(this.chatContainer.render(100).join("\n"));
		},
		async flush() {},
	};
}

function useScriptedStream(harness: Harness, responses: AssistantMessage[]): void {
	harness.setResponses(responses);
}

describe("Interactive model switch indicator", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	function createModelSwitchView(harness: Harness) {
		return createView(harness);
	}

	it("shows old → new until the next request starts, then settles to the new model in place", async () => {
		const harness = await createHarness({ models: [{ id: "model-a" }, { id: "model-b" }] });
		harnesses.push(harness);
		const view = createModelSwitchView(harness);
		useScriptedStream(harness, [fauxAssistantMessage("answer")]);

		const setPendingModelSwitch = Reflect.get(
			InteractiveMode.prototype,
			"setPendingModelSwitch",
		) as InteractiveMode["setPendingModelSwitch"];
		const settlePendingModelSwitch = Reflect.get(
			InteractiveMode.prototype,
			"settlePendingModelSwitch",
		) as InteractiveMode["settlePendingModelSwitch"];

		const [oldModel, newModel] = harness.models;
		await harness.session.setModel(newModel);
		setPendingModelSwitch.call(view as unknown as InteractiveMode, oldModel, newModel);
		await view.flush();

		// Pending: arrow form, before any request.
		expect(view.renderChat()).toContain("Model: model-a → model-b");

		// turn_start fires before the provider request; the indicator settles in place.
		settlePendingModelSwitch.call(view as unknown as InteractiveMode);
		await view.flush();
		expect(view.renderChat()).toContain("Model: model-b");
		expect(view.renderChat()).not.toContain("→");
	});

	it("ignores a no-op reselection of the current model", async () => {
		const harness = await createHarness({ models: [{ id: "model-a" }, { id: "model-b" }] });
		harnesses.push(harness);
		const view = createModelSwitchView(harness);

		const setPendingModelSwitch = Reflect.get(
			InteractiveMode.prototype,
			"setPendingModelSwitch",
		) as InteractiveMode["setPendingModelSwitch"];

		const current = harness.session.model;
		if (!current) throw new Error("session model missing");
		setPendingModelSwitch.call(view as unknown as InteractiveMode, current, current);
		await view.flush();
		expect(view.renderChat()).not.toContain("Model:");
	});
});

describe("Interactive thinking level indicator", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	/** A `this` shaped like InteractiveMode for the thinking-switch seam: real methods, stub UI. */
	function createThinkingView(harness: Harness) {
		const errors: string[] = [];
		const view = {
			session: harness.session,
			settingsManager: harness.settingsManager,
			chatContainer: new Container(),
			editorContainer: new Container(),
			editor: { marker: "editor" },
			footer: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn(), setFocus: vi.fn(), terminal: { setProgress: vi.fn() } },
			isInitialized: true,
			workingVisible: false,
			activeStatusIndicator: undefined,
			programStatus: { handleEvent: vi.fn() },
			clearStatusIndicator: vi.fn(),
			showWorkingStatusIndicator: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			setPendingModelSwitch: Reflect.get(InteractiveMode.prototype, "setPendingModelSwitch"),
			showSelector: Reflect.get(InteractiveMode.prototype, "showSelector"),
			disposeActiveSelector: Reflect.get(InteractiveMode.prototype, "disposeActiveSelector"),
			activeSelectorToken: undefined,
			activeSelectorDispose: undefined,
			selectThinkingLevel: Reflect.get(InteractiveMode.prototype, "selectThinkingLevel"),
			settlePendingModelSwitch: Reflect.get(
				InteractiveMode.prototype,
				"settlePendingModelSwitch",
			) as InteractiveMode["settlePendingModelSwitch"],
			settlePendingThinkingLevelSwitch: Reflect.get(InteractiveMode.prototype, "settlePendingThinkingLevelSwitch"),
			setPendingThinkingLevelSwitch: Reflect.get(InteractiveMode.prototype, "setPendingThinkingLevelSwitch"),
			showStatus: Reflect.get(InteractiveMode.prototype, "showStatus"),
			showError: vi.fn((message: string) => {
				errors.push(message);
			}),
			renderChat() {
				return stripAnsi(this.chatContainer.render(100).join("\n"));
			},
		};
		const cycleThinkingLevel = Reflect.get(
			InteractiveMode.prototype,
			"cycleThinkingLevel",
		) as InteractiveMode["cycleThinkingLevel"];
		const selectThinkingLevel = Reflect.get(InteractiveMode.prototype, "selectThinkingLevel") as unknown as (
			this: InteractiveMode,
			level: ThinkingLevel,
			persist: boolean,
		) => void;
		const showThinkingSelector = Reflect.get(InteractiveMode.prototype, "showThinkingSelector") as unknown as (
			this: InteractiveMode,
		) => void;
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as InteractiveMode["handleEvent"];
		// Only turn_start exercises the pending-switch seam; other events need full mode internals.
		harness.session.subscribe((event) => {
			if (event.type === "turn_start") void handleEvent.call(view as unknown as InteractiveMode, event);
		});
		return {
			harness,
			errors,
			view,
			cycle: () => cycleThinkingLevel.call(view as unknown as InteractiveMode),
			select: (level: ThinkingLevel, persist = false) =>
				selectThinkingLevel.call(view as unknown as InteractiveMode, level, persist),
			openSelector: () => showThinkingSelector.call(view as unknown as InteractiveMode),
			command: (level: string) => Reflect.get(InteractiveMode.prototype, "handleThinkingCommand").call(view, level),
			chat: () => view.renderChat(),
		};
	}

	it("shows old → new on cycle, then a real turn_start settles to the new level in place", async () => {
		const harness = await createHarness({ models: [{ id: "model-a", reasoning: true }] });
		harnesses.push(harness);
		harness.session.setThinkingLevel("low");
		const t = createThinkingView(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);

		t.cycle();
		expect(t.chat()).toContain("Thinking level: low → medium");

		await harness.session.prompt("go");
		expect(t.chat()).toContain("Thinking level: medium");
		expect(t.chat()).not.toContain("→");
		expect(harness.session.thinkingLevel).toBe("medium");
	});

	it("/thinking xhigh leaves the issued request unchanged and applies to the next request", async () => {
		const harness = await createHarness({ models: [{ id: "model-a", reasoning: true }] });
		harnesses.push(harness);
		const model = harness.models[0];
		model.thinkingLevelMap = { xhigh: "xhigh" };
		harness.session.modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: model.api,
			models: [model],
		});
		harness.session.setThinkingLevel("high");
		const t = createThinkingView(harness);
		harness.setResponses([
			(_context, options) => {
				expect(options?.reasoning).toBe("high");
				t.command("xhigh");
				expect(t.chat()).toContain("Thinking level: high → xhigh");
				return fauxAssistantMessage("first answer");
			},
			(_context, options) => {
				expect(options?.reasoning).toBe("xhigh");
				return fauxAssistantMessage("next answer");
			},
		]);

		await harness.session.prompt("first");
		expect(t.chat()).toContain("Thinking level: high → xhigh");
		await harness.session.prompt("next");
		expect(t.chat()).toContain("Thinking level: xhigh");
		expect(t.chat()).not.toContain("→");
	});

	it("keeps pending model and thinking lines independent until one turn_start settles both", async () => {
		const harness = await createHarness({
			models: [
				{ id: "model-a", reasoning: true },
				{ id: "model-b", reasoning: true },
			],
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("high");
		const t = createThinkingView(harness);
		const view = t.view;
		const setPendingModelSwitch = Reflect.get(
			InteractiveMode.prototype,
			"setPendingModelSwitch",
		) as InteractiveMode["setPendingModelSwitch"];

		const [oldModel, newModel] = harness.models;
		await harness.session.setModel(newModel);
		setPendingModelSwitch.call(view as unknown as InteractiveMode, oldModel, newModel);
		t.cycle(); // high → off on model-b (faux model maps xhigh/max away)

		const rendered = t.chat();
		expect(rendered).toContain("Model: model-a → model-b");
		expect(rendered).toContain("Thinking level: high → off");

		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("go");
		const settled = t.chat();
		expect(settled).toContain("Model: model-b");
		expect(settled).toContain("Thinking level: off");
		expect(settled).not.toContain("→");
	});

	it.each(["command", "cycle", "reselect"] as const)(
		"reconciles pending thinking after model %s resets the effective level",
		async (action) => {
			const harness = await createHarness({
				models: [
					{ id: "reasoning-a", reasoning: true },
					{ id: "model-b", reasoning: action !== "command" },
				],
			});
			harnesses.push(harness);
			const target = action === "reselect" ? harness.models[0] : harness.models[1];
			const effectiveLevel = action === "command" ? "off" : "low";
			if (action !== "command") {
				harness.settingsManager.setModelThinkingLevel(target.provider, target.id, "low");
			}
			harness.session.setThinkingLevel("medium");
			const t = createThinkingView(harness);
			Object.assign(t.view, { findExactModelMatch: async () => target });
			t.select("high");
			expect(t.chat()).toContain("Thinking level: medium → high");

			if (action === "cycle") {
				await Reflect.get(InteractiveMode.prototype, "cycleModel").call(t.view, "forward");
			} else {
				await Reflect.get(InteractiveMode.prototype, "handleModelCommand").call(t.view, target.id);
			}
			expect(t.errors).toEqual([]);
			expect(harness.session.thinkingLevel).toBe(effectiveLevel);
			expect(t.chat()).toContain(`Thinking level: high → ${effectiveLevel}`);
			expect(t.chat()).not.toContain("Thinking level: medium → high");
			if (action === "reselect") expect(t.chat()).not.toContain("Model:");

			harness.setResponses([
				(_context, options) => {
					expect(options?.reasoning ?? "off").toBe(effectiveLevel);
					return fauxAssistantMessage("answer");
				},
			]);
			await harness.session.prompt("go");
			expect(t.chat()).toContain(`Thinking level: ${effectiveLevel}`);
			expect(t.chat()).not.toContain("→");
		},
	);

	it("shows the previous → effective level when the requested level is clamped", async () => {
		const harness = await createHarness({ models: [{ id: "model-a", reasoning: true }] });
		harnesses.push(harness);
		harness.session.setThinkingLevel("medium");
		const t = createThinkingView(harness);

		// The faux model maps xhigh/max away, so "max" clamps down to the last supported level.
		t.select("max");
		expect(t.chat()).toContain("Thinking level: medium → high");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("selector selection renders the pending arrow; saving a different level keeps both affordances", async () => {
		const harness = await createHarness({ models: [{ id: "model-a", reasoning: true }] });
		harnesses.push(harness);
		harness.session.setThinkingLevel("medium");
		const t = createThinkingView(harness);
		const view = t.view;

		// Select through the real selector component (public handleInput → confirm).
		t.openSelector();
		const selector = view.editorContainer.children[0]!;
		const list = (selector as unknown as { getSelectList(): SelectList }).getSelectList();
		// Move to "high": items are off,minimal,low,medium,high,xhigh,max minus unmapped.
		list.setSelectedIndex(4);
		(selector as unknown as { handleInput(keyData: string): void }).handleInput("\r");
		expect(t.chat()).toContain("Thinking level: medium → high");

		// Saving a different level still registers the pending session switch AND the status line.
		t.select("low", true);
		expect(harness.session.thinkingLevel).toBe("low");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("low");
		const rendered = t.chat();
		const lines = rendered.split("\n").map((line) => line.trim());
		expect(lines).toContain("Thinking level: high"); // stale pending settled in place
		expect(rendered).toContain("Thinking level: high → low"); // new pending switch
		expect(rendered).toContain("Default thinking level: low"); // real showStatus appended
		expect(rendered.match(/→/g)?.length ?? 0).toBe(1);
	});

	it("persisted selection of a different level registers the pending switch and the default status", async () => {
		const harness = await createHarness({ models: [{ id: "model-a", reasoning: true }] });
		harnesses.push(harness);
		harness.session.setThinkingLevel("medium");
		const t = createThinkingView(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);

		t.select("high", true);
		expect(t.chat()).toContain("Thinking level: medium → high");
		expect(t.chat()).toContain("Default thinking level: high");

		await harness.session.prompt("go");
		expect(t.chat()).toContain("Thinking level: high");
		expect(t.chat()).not.toContain("→");
	});

	it("repeated switches settle the stale pending line; a no-op selection adds nothing", async () => {
		const harness = await createHarness({ models: [{ id: "model-a", reasoning: true }] });
		harnesses.push(harness);
		harness.session.setThinkingLevel("medium");
		const t = createThinkingView(harness);

		t.select("high"); // pending medium → high
		t.select("low"); // settles stale line to high, then pending high → low
		const rendered = t.chat();
		const lines = rendered.split("\n").map((line) => line.trim());
		expect(lines).toContain("Thinking level: high");
		expect(rendered).toContain("Thinking level: high → low");
		expect(rendered.match(/→/g)?.length).toBe(1);

		// No-op reselection (already low) leaves no new pending line.
		t.select("low");
		expect(t.chat().match(/→/g)?.length ?? 0).toBe(1);
	});
});
