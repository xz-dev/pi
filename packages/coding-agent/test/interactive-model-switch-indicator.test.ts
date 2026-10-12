import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
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
