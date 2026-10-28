#!/usr/bin/env node
import "./sandbox-env-setup.ts";
import { runMain } from "../cli-entry.ts";
import { materializeNativeAddons } from "../config.ts";
import { ownCliProcesses } from "../utils/procward.ts";

void runMain(async () => {
	if (ownCliProcesses() === false) return;
	(globalThis as Record<symbol, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:materialize-native-addons")] =
		materializeNativeAddons;
	const args = process.argv.slice(2);
	if (!(args.length === 1 && (args[0] === "--version" || args[0] === "-v"))) await import("./runtime-setup.ts");
	await import("../cli.ts");
});
