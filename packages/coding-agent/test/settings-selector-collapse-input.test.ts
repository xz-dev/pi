import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("SettingsSelectorComponent collapsed command display", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("toggles collapsed command display through its own callback", () => {
		const onCollapseExpandedInputChange = vi.fn();
		const onEnableSkillCommandsChange = vi.fn();
		const config = {
			collapseExpandedInput: true,
			enableSkillCommands: true,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = { onCollapseExpandedInputChange, onEnableSkillCommandsChange } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		const items = (list as unknown as { items: Array<{ id: string; currentValue: string }> }).items;
		const item = items.find((i) => i.id === "collapse-expanded-input");
		expect(item?.currentValue).toBe("true");
		expect(items.findIndex((i) => i.id === "collapse-expanded-input")).toBe(
			items.findIndex((i) => i.id === "skill-commands") + 1,
		);

		list.selectItem("collapse-expanded-input");
		list.handleInput("\r");
		expect(onCollapseExpandedInputChange.mock.calls.flat()).toEqual([false]);
		expect(onEnableSkillCommandsChange).not.toHaveBeenCalled();
	});
});
