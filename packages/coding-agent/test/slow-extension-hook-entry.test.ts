import { beforeAll, describe, expect, it } from "vitest";
import type { CustomEntry } from "../src/core/session-manager.ts";
import { renderSlowExtensionHookEntry } from "../src/modes/interactive/components/slow-extension-hook-entry.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("slow extension hook transcript entry", () => {
	beforeAll(() => initTheme("dark"));

	it("renders only sanitized hook identity and elapsed time", () => {
		const component = renderSlowExtensionHookEntry({
			type: "custom",
			customType: "pi.extension_hook_slow",
			id: "entry-1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			data: {
				event: "in\nput\x00",
				extensionPath: "/tmp/private/\x9d52;c;c2VjcmV0\x9cslow.ts",
				handlerIndex: 2,
				elapsedMs: 143.4,
			},
		} satisfies CustomEntry);

		expect(component).toBeDefined();
		const rendered = stripAnsi(component!.render(120)[0]);
		expect(rendered).toContain("Slow extension hook: in put · /tmp/private/slow.ts#2 · 143 ms");
		expect(rendered).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(rendered).not.toContain("c2VjcmV0");
	});

	it("ignores malformed persisted entries", () => {
		expect(
			renderSlowExtensionHookEntry({
				type: "custom",
				customType: "pi.extension_hook_slow",
				id: "entry-2",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				data: { event: "input" },
			}),
		).toBeUndefined();
	});
});
