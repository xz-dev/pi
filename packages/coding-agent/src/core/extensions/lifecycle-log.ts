import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { SessionShutdownEvent } from "./types.ts";

interface ExtensionLifecycleLogEntry {
	timestamp: string;
	status: "start" | "end" | "error";
	operation: string;
	operationId: string;
	pid: number;
	elapsedMs?: number;
	extensionPath?: string;
	handlerIndex?: number;
	reason?: SessionShutdownEvent["reason"];
}

function writeExtensionLifecycleLog(entry: ExtensionLifecycleLogEntry): void {
	try {
		const logDir = join(getAgentDir(), "logs");
		const logPath = join(logDir, "extension-lifecycle.jsonl");
		mkdirSync(logDir, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") chmodSync(logDir, 0o700);
		appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
		if (process.platform !== "win32") chmodSync(logPath, 0o600);
	} catch {
		// Diagnostics must never alter extension behavior.
	}
}

export function startExtensionLifecycleOperation(
	operation: string,
	details: Pick<ExtensionLifecycleLogEntry, "extensionPath" | "handlerIndex" | "reason"> = {},
): (status: "end" | "error", elapsedMs: number) => void {
	try {
		const operationId = randomUUID();
		writeExtensionLifecycleLog({
			timestamp: new Date().toISOString(),
			status: "start",
			operation,
			operationId,
			pid: process.pid,
			...details,
		});
		return (status, elapsedMs) => {
			writeExtensionLifecycleLog({
				timestamp: new Date().toISOString(),
				status,
				operation,
				operationId,
				pid: process.pid,
				elapsedMs,
				...details,
			});
		};
	} catch {
		return () => {};
	}
}
