#!/usr/bin/env node

import { normalizeWindowsZipMetadata } from "./lib/github-release.mjs";

if (process.argv.length !== 3) {
	console.error("Usage: node scripts/normalize-windows-zip.mjs <archive.zip>");
	process.exit(1);
}

const archive = process.argv[2];
const entryCount = normalizeWindowsZipMetadata(archive);
console.log(`Normalized ${entryCount} Windows ZIP entries in ${archive}`);
