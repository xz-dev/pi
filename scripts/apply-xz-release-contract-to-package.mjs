#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const PACKAGE_PATH = "package.json";
const CHECK_ANCHOR = "npm run check:shrinkwrap && npm run check:install-lock:coding-agent";
const CHECK_REPLACEMENT =
	"npm run check:shrinkwrap && npm run check:xz-release-contract && npm run check:install-lock:coding-agent";
const CONTRACT_COMMAND =
	"node scripts/generate-xz-release-binary-contract.mjs --check && node scripts/xz-release-targets.test.mjs";

let source;
try {
	source = execFileSync("git", ["show", `:2:${PACKAGE_PATH}`], { encoding: "utf8" });
} catch (error) {
	console.error(`Unable to read the integrated side of ${PACKAGE_PATH}: ${error.message}`);
	process.exit(1);
}

const packageJson = JSON.parse(source);
if (typeof packageJson.scripts?.check !== "string") {
	throw new Error("integrated package.json has no scripts.check command");
}
if (Object.hasOwn(packageJson.scripts, "check:xz-release-contract")) {
	throw new Error("integrated package.json already defines check:xz-release-contract");
}
if (packageJson.scripts.check.split(CHECK_ANCHOR).length !== 2) {
	throw new Error("integrated scripts.check does not contain the expected unique insertion anchor");
}

const scripts = {};
for (const [name, command] of Object.entries(packageJson.scripts)) {
	scripts[name] = name === "check" ? command.replace(CHECK_ANCHOR, CHECK_REPLACEMENT) : command;
	if (name === "check") scripts["check:xz-release-contract"] = CONTRACT_COMMAND;
}
packageJson.scripts = scripts;
writeFileSync(PACKAGE_PATH, `${JSON.stringify(packageJson, null, "\t")}\n`);
