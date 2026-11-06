import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionShutdownProgress } from "../../core/extensions/runner.ts";
import { sanitizeTerminalSingleLine } from "../../utils/ansi.ts";

const CLEAR_LINE = "\r\x1b[2K";
const START_PREFIXES = ["Shutting down: ", "Down: "] as const;
const SLOW_PREFIXES = ["Slow shutdown hook: ", "Slow: "] as const;

function compactExtensionIdentity(extensionPath: string): string {
	return basename(sanitizeTerminalSingleLine(extensionPath)) || "extension";
}

function maxVisibleColumns(getWidth: () => number): number {
	try {
		const columns = getWidth();
		if (typeof columns === "number" && Number.isFinite(columns)) {
			return Math.max(0, Math.floor(columns) - 1);
		}
	} catch {
		// Diagnostics must never alter extension behavior.
	}
	return 79;
}

function reservedSuffix(entry: ExtensionShutdownProgress): string {
	const index = `#${entry.handlerIndex}`;
	if (entry.status === "start") {
		return index;
	}
	return `${index} · ${Math.round(entry.elapsedMs ?? 0)} ms`;
}

export function formatShutdownProgressLine(
	entry: ExtensionShutdownProgress,
	maxWidth = Number.POSITIVE_INFINITY,
): string {
	const identity = compactExtensionIdentity(entry.extensionPath);
	const suffix = reservedSuffix(entry);
	const prefixes = entry.status === "start" ? START_PREFIXES : SLOW_PREFIXES;
	if (!Number.isFinite(maxWidth)) {
		return `${prefixes[0]}${identity}${suffix}`;
	}
	const width = Math.max(0, Math.floor(maxWidth));
	if (width === 0) {
		return "";
	}

	for (const prefix of prefixes) {
		const room = width - visibleWidth(prefix) - visibleWidth(suffix);
		if (room <= 0) {
			continue;
		}
		const clipped = truncateToWidth(identity, room, "");
		if (clipped.length === 0) {
			continue;
		}
		return `${prefix}${clipped}${suffix}`;
	}

	for (const prefix of prefixes) {
		const compact = `${prefix}${suffix}`;
		if (visibleWidth(compact) <= width) {
			return compact;
		}
	}

	if (visibleWidth(suffix) <= width) {
		return suffix;
	}
	return truncateToWidth(suffix, width, "");
}

export function createInteractiveShutdownProgressWriter(
	write: (chunk: string) => void,
	getWidth: () => number,
): {
	write(entry: ExtensionShutdownProgress): void;
} {
	return {
		write(entry) {
			try {
				const line = formatShutdownProgressLine(entry, maxVisibleColumns(getWidth));
				if (entry.status === "start") {
					write(`${CLEAR_LINE}${line}`);
					return;
				}
				if (entry.slow) {
					write(`${CLEAR_LINE}${line}\n`);
					return;
				}
				write(CLEAR_LINE);
			} catch {
				// Diagnostics must never alter extension behavior.
			}
		},
	};
}
