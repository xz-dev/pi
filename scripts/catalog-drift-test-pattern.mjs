#!/usr/bin/env node
// Print a vitest --testNamePattern that excludes the titles listed in
// scripts/catalog-drift-test-skips.txt (empty list -> match everything).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const listPath = join(import.meta.dirname, "catalog-drift-test-skips.txt");
const titles = readFileSync(listPath, "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line && !line.startsWith("#"));
const escaped = titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
process.stdout.write(escaped.length ? `^(?!.*(?:${escaped.join("|")})$)` : "");
