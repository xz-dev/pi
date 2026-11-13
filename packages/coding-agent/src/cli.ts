#!/usr/bin/env node
import "./cli-bootstrap.ts";
import { runMain } from "./cli-entry.ts";

// Entry-only lazy imports keep setup and the full CLI behind the ownership decision.
const { setupCli } = await import("./cli/setup.ts");
const { main } = await import("./main.ts");
setupCli();
void runMain(() => main(process.argv.slice(2)));
