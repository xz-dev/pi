// Read session text for developer reports without changing source files.
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { isCompressedSession, readCompressedSession } from "../packages/coding-agent/src/core/session-storage.ts";

/** Decode committed session text in either storage format. Corruption remains an error. */
export function readSessionText(path: string): string {
	if (!isCompressedSession(path)) return readFileSync(path, "utf8");
	let text = "";
	readCompressedSession(path, (part) => {
		text += part;
	});
	return text;
}

/** Preserve streaming for plain files and existing per-line parser diagnostics. */
export async function* readSessionLines(path: string): AsyncGenerator<string> {
	if (isCompressedSession(path)) {
		yield* readSessionText(path).split(/\r?\n/);
		return;
	}
	const input = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		yield* lines;
	} finally {
		lines.close();
		input.destroy();
	}
}
