import { Text } from "@earendil-works/pi-tui";
import type { SlowExtensionHookEntry } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";

function singleLine(value: unknown): string {
	return stripAnsi(String(value))
		.replace(/\x9d[\s\S]*?(?:\x07|\x9c|\x1b\\)/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function renderSlowExtensionHookEntry(entry: CustomEntry<unknown>): Text | undefined {
	const data = entry.data as Partial<SlowExtensionHookEntry> | undefined;
	if (
		typeof data?.event !== "string" ||
		typeof data.extensionPath !== "string" ||
		typeof data.handlerIndex !== "number" ||
		typeof data.elapsedMs !== "number" ||
		!Number.isFinite(data.elapsedMs) ||
		(data.executionKind !== undefined && data.executionKind !== "sync" && data.executionKind !== "async")
	) {
		return undefined;
	}
	const label = data.executionKind ? `Slow ${data.executionKind} extension hook` : "Slow extension hook";
	const text = `${label}: ${singleLine(data.event)} · ${singleLine(data.extensionPath)}#${data.handlerIndex} · ${Math.round(data.elapsedMs)} ms`;
	return new Text(theme.fg(data.executionKind === "sync" ? "warning" : "muted", text), 1, 0);
}
