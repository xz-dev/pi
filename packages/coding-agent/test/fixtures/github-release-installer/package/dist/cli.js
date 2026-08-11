#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(
	readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
if (process.argv.includes("--version")) {
	console.log(packageJson.version);
} else if (process.argv.includes("--help")) {
	console.log("Usage: pi [options]");
} else {
	console.log(`pi fixture ${packageJson.version}`);
}
