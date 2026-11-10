#!/usr/bin/env node
import { isBunBinary, resolveProcwardBinary } from "./config.ts";
import { runMain } from "./cli-entry.ts";
import { ownCliProcess } from "./utils/procward.ts";

// Wrap this process in a procward owner before any CLI side effects, so the
// whole tree (tools, MCP servers, background children) is owned. Returns an
// exit code when pi already ran as the outer bootstrap (owner finished), in
// which case the CLI must not start again.
const bootstrapStatus = ownCliProcess(process.argv.slice(2), {
	resolveBinary: resolveProcwardBinary,
	standalone: isBunBinary,
});
if (bootstrapStatus !== undefined) {
	process.exit(bootstrapStatus);
}

// Entry-only lazy imports keep setup and the full CLI behind the ownership decision.
const { setupCli } = await import("./cli/setup.ts");
const { main } = await import("./main.ts");
setupCli();
void runMain(() => main(process.argv.slice(2)));
