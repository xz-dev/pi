import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";

const MACOS_HINT =
	"macOS subprocess cleanup is best effort: a process that calls setsid and reparents within 25 ms can outlive Pi. For a hard boundary, run Pi in a container. See https://github.com/xz-dev/pi/blob/main/docs/process-ownership.md.";

/** macOS has no unprivileged process-tree containment; say so instead of implying a guarantee. */
export function macOSOwnershipDiagnostics(options: {
	offlineMode: boolean;
	quietStartup: boolean | "header";
}): AgentSessionRuntimeDiagnostic[] {
	if (process.platform !== "darwin" || options.offlineMode || options.quietStartup === true) return [];
	return [{ type: "info", message: MACOS_HINT }];
}
