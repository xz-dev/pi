import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { macOSOwnershipDiagnostics } from "../src/utils/macos-ownership-diagnostics.ts";

// Execute main's actual startup-selection expression, without launching the TUI or model runtime.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const expression = source.match(/^\tstartupDiagnostics = deduplicateDiagnostics\((\[[\s\S]*?\n\t\])\);/m)?.[1];
if (!expression) throw new Error("main startup diagnostic selection was not found");
const select = new Function(
	"args",
	"parsed",
	"appMode",
	"offlineMode",
	"settingsManager",
	"runtime",
	"startupDiagnostics",
	"macOSOwnershipDiagnostics",
	`return ${expression};`,
);
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
	Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
	vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "");
});
afterEach(() => {
	Object.defineProperty(process, "platform", originalPlatform);
	vi.unstubAllEnvs();
});
function diagnostics(argv: string[], mode = "interactive", quietStartup: boolean | "header" = false) {
	const parsed = parseArgs(argv);
	return select(
		argv,
		parsed,
		mode,
		parsed.offline ?? false,
		{ getQuietStartup: () => quietStartup },
		{ diagnostics: [] },
		[],
		macOSOwnershipDiagnostics,
	);
}

it("selects no macOS startup hint for the parsed CLI-only opt-out", () => {
	expect(diagnostics([])).toHaveLength(1);
	expect(diagnostics(["--no-process-ownership"])).toEqual([]);
});
it("does not treat option values or literal positional text as the parsed opt-out", () => {
	expect(diagnostics(["--system-prompt", "--no-process-ownership"])).toHaveLength(1);
	expect(diagnostics(["--", "--no-process-ownership"])).toHaveLength(1);
});
it("preserves environment, noninteractive, offline and quiet-startup suppression", () => {
	for (const mode of ["print", "json", "rpc"]) expect(diagnostics([], mode)).toEqual([]);
	expect(diagnostics(["--offline"])).toEqual([]);
	expect(diagnostics([], "interactive", true)).toEqual([]);
	vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "1");
	expect(diagnostics([])).toEqual([]);
});
