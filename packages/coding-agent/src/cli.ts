#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { runMain } from "./cli-entry.ts";
import { main } from "./main.ts";
import { ownCliProcesses } from "./utils/process-owner.ts";

setupCli();
ownCliProcesses();
void runMain(() => main(process.argv.slice(2)));
