import { beforeAll, describe, expect, it } from "vitest";
import type { CustomEntry } from "../src/core/session-manager.ts";
import { renderSlowExtensionHookEntry } from "../src/modes/interactive/components/slow-extension-hook-entry.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function entry(data: unknown, id: string): CustomEntry {
	return {
		type: "custom",
		customType: "pi.extension_hook_slow",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		data,
	};
}

function rendered(data: unknown, id: string): string {
	const component = renderSlowExtensionHookEntry(entry(data, id));
	expect(component).toBeDefined();
	return component!.render(120)[0];
}

const validData = {
	event: "in\nput\x00",
	extensionPath: "/tmp/private/\x9d52;c;c2VjcmV0\x9cslow.ts",
	handlerIndex: 2,
	elapsedMs: 143.4,
};

describe("slow extension hook transcript entry", () => {
	beforeAll(() => initTheme("dark"));

	it("renders sync entries as yellow warnings", () => {
		const output = rendered({ ...validData, executionKind: "sync" }, "entry-sync");
		expect(stripAnsi(output)).toContain("Slow sync extension hook: in put · /tmp/private/slow.ts#2 · 143 ms");
		expect(output).toContain(theme.fg("warning", "Slow sync extension hook:").slice(0, -5));
		expect(output).not.toContain("c2VjcmV0");
	});

	it("renders async and historical entries in default gray", () => {
		const asyncOutput = rendered({ ...validData, executionKind: "async" }, "entry-async");
		const legacyOutput = rendered(validData, "entry-legacy");
		expect(stripAnsi(asyncOutput)).toContain("Slow async extension hook: in put · /tmp/private/slow.ts#2 · 143 ms");
		expect(stripAnsi(legacyOutput)).toContain("Slow extension hook: in put · /tmp/private/slow.ts#2 · 143 ms");
		expect(asyncOutput).toContain(theme.fg("muted", "Slow async extension hook:").slice(0, -5));
		expect(legacyOutput).toContain(theme.fg("muted", "Slow extension hook:").slice(0, -5));
	});

	it("ignores malformed persisted entries", () => {
		expect(renderSlowExtensionHookEntry(entry({ event: "input" }, "entry-malformed"))).toBeUndefined();
		expect(
			renderSlowExtensionHookEntry(entry({ ...validData, executionKind: "unknown" }, "entry-invalid-kind")),
		).toBeUndefined();
	});
});
