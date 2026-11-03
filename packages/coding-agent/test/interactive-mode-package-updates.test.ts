import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, type PackageUpdate } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type CheckContext = {
	sessionManager: { getCwd(): string };
	settingsManager: SettingsManager;
};

type NotificationContext = {
	chatContainer: Container;
	ui: { requestRender(): void };
};

const prototype = InteractiveMode.prototype as unknown as {
	checkForPackageUpdates(this: CheckContext): Promise<string[]>;
	showPackageUpdateNotification(this: NotificationContext, packages: string[]): void;
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("package update notification", () => {
	it("shows package, dependency and combined reasons in the existing notification", async () => {
		vi.stubEnv("PI_OFFLINE", "");
		const reasons: PackageUpdate["reason"][] = ["package", "dependencies", "both"];
		const updates: PackageUpdate[] = reasons.map((reason, index) => ({
			source: `npm:plugin-${index}`,
			displayName: `plugin-${index}`,
			type: "npm",
			scope: "user",
			reason,
		}));
		vi.spyOn(DefaultPackageManager.prototype, "checkForAvailableUpdates").mockResolvedValue(updates);
		const packages = await prototype.checkForPackageUpdates.call({
			sessionManager: { getCwd: () => process.cwd() },
			settingsManager: SettingsManager.inMemory(),
		});
		expect(packages).toEqual(["plugin-0", "plugin-1 (dependencies)", "plugin-2 (package and dependencies)"]);
		initTheme("dark");
		const context: NotificationContext = { chatContainer: new Container(), ui: { requestRender: vi.fn() } };
		prototype.showPackageUpdateNotification.call(context, packages);
		const rendered = context.chatContainer.render(120).join("\n");
		expect(rendered.match(/Package Updates Available/g)).toHaveLength(1);
		expect(rendered).toContain("pi update --extensions");
		expect(rendered).toContain("plugin-1 (dependencies)");
		expect(rendered).toContain("plugin-2 (package and dependencies)");
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});
