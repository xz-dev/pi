#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	loadWindowsFilesystemSnapshotHelper,
	snapshotWindowsDirectory,
	snapshotWindowsRegularFile,
} from "../packages/coding-agent/src/utils/win32-filesystem-snapshot.ts";

const [helperArg, oppositeArchArg, apiMismatchArg, malformedResultArg] = process.argv.slice(2);
if (!helperArg || !oppositeArchArg || !apiMismatchArg || !malformedResultArg) {
	throw new Error(
		"Usage: test-win32-filesystem-snapshot-loader.mjs <helper.node> <opposite-arch.node> <api-mismatch.node> <malformed-result.node>",
	);
}
if (process.platform !== "win32") throw new Error(`Win32 loader smoke requires Windows, got ${process.platform}`);

const helperPath = resolve(helperArg);
const oppositeArchPath = resolve(oppositeArchArg);
const apiMismatchPath = resolve(apiMismatchArg);
const malformedResultPath = resolve(malformedResultArg);
const work = mkdtempSync(join(tmpdir(), "pi win32 loader "));
try {
	const corruptPath = join(work, "corrupt.node");
	copyFileSync(helperPath, corruptPath);
	truncateSync(corruptPath, 128);
	assert.throws(
		() => loadWindowsFilesystemSnapshotHelper({ candidates: [corruptPath, helperPath] }),
		/Could not load Pi Windows filesystem snapshot helper/,
	);
	assert.throws(
		() => loadWindowsFilesystemSnapshotHelper({ candidates: [join(work, "missing.node")] }),
		/Pi Windows filesystem snapshot helper is missing/,
	);
	assert.throws(
		() => loadWindowsFilesystemSnapshotHelper({ candidates: [oppositeArchPath] }),
		/Could not load Pi Windows filesystem snapshot helper/,
	);
	assert.throws(
		() => loadWindowsFilesystemSnapshotHelper({ candidates: [apiMismatchPath] }),
		/has an invalid API/,
	);
	assert.throws(
		() => snapshotWindowsDirectory(work, loadWindowsFilesystemSnapshotHelper({ candidates: [malformedResultPath] })),
		/invalid directory snapshot/,
	);
	assert.throws(
		() =>
			loadWindowsFilesystemSnapshotHelper({
				candidates: ["malformed.node"],
				exists: () => true,
				loadModule: () => ({ apiVersion: 1, snapshotDirectory: () => ({}) }),
			}),
		/has an invalid API/,
	);

	const malformedIdentity = {
		apiVersion: 1,
		snapshotDirectory: () => ({ canonicalPath: "C:\\pi", identity: "bad" }),
		snapshotRegularFile: () => ({
			canonicalPath: "C:\\pi\\current",
			identity: "0123456789abcdef:00112233445566778899aabbccddeeff",
			size: 8,
			contents: Buffer.from("short"),
		}),
	};
	assert.throws(
		() => snapshotWindowsDirectory("C:\\pi", malformedIdentity),
		/invalid directory snapshot/,
	);
	assert.throws(
		() => snapshotWindowsRegularFile("C:\\pi\\current", 256, true, malformedIdentity),
		/invalid regular-file snapshot/,
	);

	console.log(
		JSON.stringify({
			arch: process.arch,
			missingRejected: true,
			corruptRejectedWithoutFallback: true,
			oppositeArchitectureRejected: true,
			apiMismatchRejected: true,
			malformedNativeResultsRejected: true,
			malformedExportsRejected: true,
			malformedResultsRejected: true,
		}),
	);
} finally {
	rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
