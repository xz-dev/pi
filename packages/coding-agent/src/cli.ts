#!/usr/bin/env node
import { runMain } from "./cli-entry.ts";
import { VERSION } from "./config.ts";
import { ownCliProcesses } from "./utils/procward.ts";

void runMain(async () => {
	if (ownCliProcesses() === false) return;
	const args = process.argv.slice(2);
	if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
		console.log(VERSION);
		return;
	}
	// Only the managed primary may load settings, providers and extensions.
	const { setupCli } = await import("./cli/setup.ts");
	const { main } = await import("./main.ts");
	setupCli();
	await main(args);
});
