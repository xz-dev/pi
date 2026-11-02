// Explicit offline conversion and read-only storage-format diagnostics.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isSessionFileName, parseSessionEntries, readSessionHeaderForDiscovery } from "./session-manager.ts";
import {
	encodeSessionTransaction,
	isCompressedSession,
	readCompressedSession,
	replaceSessionFile,
	summarizeSession,
} from "./session-storage.ts";

export interface SessionCompressionResult {
	converted: number;
	unchanged: number;
	skipped: number;
	failed: string[];
}

/** Enumerate only the chosen flat directory, or project directories under the default root. */
export function sessionCompressionFiles(root: string, scope: "directory" | "projects" = "directory"): string[] {
	if (!existsSync(root)) return [];
	const entries = readdirSync(root, { withFileTypes: true });
	if (scope === "projects")
		return entries
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) => sessionCompressionFiles(join(root, entry.name)));
	return entries
		.filter((entry) => entry.isFile() && isSessionFileName(entry.name))
		.map((entry) => join(root, entry.name));
}

/** Convert valid sessions atomically per file; report partial success without changing settings. */
export async function migrateSessionCompression(
	root: string,
	enabled: boolean,
	scope: "directory" | "projects" = "directory",
): Promise<SessionCompressionResult> {
	const result: SessionCompressionResult = { converted: 0, unchanged: 0, skipped: 0, failed: [] };
	for (const path of sessionCompressionFiles(root, scope)) {
		try {
			const compressed = isCompressedSession(path);
			let text = "";
			if (compressed) {
				const state = readCompressedSession(path, (part) => {
					text += part;
				});
				if (state.incompleteTail)
					throw new Error("Incomplete session append; resume and write to repair before migration");
			} else text = readFileSync(path, "utf8");
			const entries = parseSessionEntries(text);
			if (entries[0]?.type !== "session" || typeof entries[0].id !== "string") {
				if (compressed) throw new Error("Compressed file has no valid session header");
				result.skipped++;
				continue;
			}
			if (compressed === enabled) {
				result.unchanged++;
				continue;
			}
			const bytes = enabled ? encodeSessionTransaction(text, summarizeSession(entries)) : Buffer.from(text);
			replaceSessionFile(path, bytes, true);
			result.converted++;
		} catch (error) {
			result.failed.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}

/** Warn about mixed formats without rewriting files, settings, or protocol stdout. */
export function warnMixedSessionCompression(root: string, scope: "directory" | "projects" = "directory"): void {
	let plain = false;
	let compressed = false;
	for (const path of sessionCompressionFiles(root, scope)) {
		try {
			if (isCompressedSession(path)) compressed = true;
			else if (readSessionHeaderForDiscovery(path)) plain = true;
		} catch {
			continue;
		}
		if (plain && compressed) {
			console.error(
				"Warning: Mixed plain/compressed sessions. Offline-only, close all session writers before running pi --enable-compress-sessions=true or pi --enable-compress-sessions=false (add --session-dir for a custom directory).",
			);
			return;
		}
	}
}
