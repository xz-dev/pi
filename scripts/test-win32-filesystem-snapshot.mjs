#!/usr/bin/env node
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, toNamespacedPath } from "node:path";
import { pathToFileURL } from "node:url";

const helperArg = process.argv[2];
if (!helperArg) throw new Error("Usage: test-win32-filesystem-snapshot.mjs <pi-filesystem-snapshot.node>");
if (process.platform !== "win32") throw new Error(`Win32 filesystem snapshot smoke requires Windows, got ${process.platform}`);

const helperPath = resolve(helperArg);
const requireFromHelper = createRequire(pathToFileURL(join(dirname(helperPath), "package.json")));
const helper = requireFromHelper(helperPath);
assert.equal(helper.apiVersion, 1);
assert.equal(typeof helper.snapshotDirectory, "function");
assert.equal(typeof helper.snapshotRegularFile, "function");

const identityPattern = /^[0-9a-f]{16}:[0-9a-f]{32}$/;
const maximumContentBytes = 64 * 1024 * 1024;
const work = mkdtempSync(join(process.env.PI_WIN32_SNAPSHOT_WORK_ROOT || tmpdir(), "pi win32 snapshot "));
const normalizeWindowsPath = (path) =>
	resolve(path)
		.replace(/^\\\\\?\\UNC\\/i, "\\\\")
		.replace(/^\\\\\?\\/i, "")
		.toLowerCase();
const waitForLine = (stream) =>
	new Promise((resolveLine, reject) => {
		let output = "";
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			output += chunk;
			const newline = output.indexOf("\n");
			if (newline >= 0) resolveLine(output.slice(0, newline));
		});
		stream.once("error", reject);
	});
try {
	const directory = join(work, "safe");
	const file = join(directory, "payload.txt");
	mkdirSync(directory);
	writeFileSync(file, "snapshot payload\n");

	const directorySnapshot = helper.snapshotDirectory(directory);
	assert.match(directorySnapshot.identity, identityPattern);
	assert.equal(normalizeWindowsPath(directorySnapshot.canonicalPath), normalizeWindowsPath(directory));

	const alternateCaseDirectory = `${directory.slice(0, 1).toLowerCase()}${directory.slice(1).toUpperCase()}`;
	assert.equal(helper.snapshotDirectory(alternateCaseDirectory).identity, directorySnapshot.identity);
	assert.equal(helper.snapshotDirectory(toNamespacedPath(directory)).identity, directorySnapshot.identity);

	const metadataSnapshot = helper.snapshotRegularFile(file, 1024, false);
	assert.match(metadataSnapshot.identity, identityPattern);
	assert.equal(metadataSnapshot.size, Buffer.byteLength("snapshot payload\n"));
	assert.equal(metadataSnapshot.contents, undefined);

	const contentSnapshot = helper.snapshotRegularFile(file, 1024, true);
	assert.equal(contentSnapshot.identity, metadataSnapshot.identity);
	assert.equal(contentSnapshot.contents.toString("utf8"), "snapshot payload\n");
	assert.throws(() => helper.snapshotRegularFile(file, contentSnapshot.size - 1, true), /allowed size/);
	assert.throws(() => helper.snapshotRegularFile(file, maximumContentBytes + 1, true), /64 MiB/);
	assert.throws(() => helper.snapshotRegularFile(directory, 1024, false), /safe regular file/);
	assert.throws(() => helper.snapshotDirectory(file), /safe directory/);

	const replacement = join(directory, "replacement.txt");
	writeFileSync(replacement, "replacement\n");
	renameSync(replacement, file);
	const replacedSnapshot = helper.snapshotRegularFile(file, 1024, true);
	assert.notEqual(replacedSnapshot.identity, contentSnapshot.identity);
	assert.equal(readFileSync(file, "utf8"), "replacement\n");

	const fileLink = join(work, "payload-link.txt");
	symlinkSync(file, fileLink, "file");
	assert.throws(() => helper.snapshotRegularFile(fileLink, 1024, true), /safe regular file/);

	const directoryLink = join(work, "safe-junction");
	symlinkSync(directory, directoryLink, "junction");
	assert.throws(() => helper.snapshotDirectory(directoryLink), /safe directory/);

	const descendantThroughJunction = helper.snapshotRegularFile(join(directoryLink, "payload.txt"), 1024, false);
	assert.notEqual(
		resolve(descendantThroughJunction.canonicalPath).toLowerCase(),
		resolve(join(directoryLink, "payload.txt")).toLowerCase(),
	);

	const emptyFile = join(directory, "empty.bin");
	writeFileSync(emptyFile, Buffer.alloc(0));
	const emptySnapshot = helper.snapshotRegularFile(emptyFile, 1, true);
	assert.equal(emptySnapshot.size, 0);
	assert.equal(emptySnapshot.contents.byteLength, 0);

	let longDirectory = directory;
	while (longDirectory.length < 280) longDirectory = join(longDirectory, "long-path-segment");
	mkdirSync(longDirectory, { recursive: true });
	const longFile = join(longDirectory, "payload.txt");
	writeFileSync(longFile, "long path\n");
	assert.equal(helper.snapshotRegularFile(toNamespacedPath(longFile), 1024, true).contents.toString(), "long path\n");

	const uncRoot = process.env.PI_WIN32_SNAPSHOT_UNC_ROOT;
	if (process.env.PI_REQUIRE_WIN32_SNAPSHOT_UNC === "1" && !uncRoot) {
		throw new Error("PI_WIN32_SNAPSHOT_UNC_ROOT is required for Windows acceptance");
	}
	let uncValidated = false;
	if (uncRoot) {
		const sharedRoot = resolve(process.env.PI_WIN32_SNAPSHOT_WORK_ROOT || tmpdir());
		const relativeDirectory = directory.slice(sharedRoot.length).replace(/^[/\\]+/, "");
		const uncDirectory = join(uncRoot, relativeDirectory);
		const uncFile = join(uncDirectory, "payload.txt");
		const uncSnapshot = helper.snapshotRegularFile(uncFile, 1024, false);
		assert.match(uncSnapshot.identity, identityPattern);
		assert.equal(normalizeWindowsPath(uncSnapshot.canonicalPath), normalizeWindowsPath(uncFile));
		assert.equal(helper.snapshotRegularFile(toNamespacedPath(uncFile), 1024, false).identity, uncSnapshot.identity);
		uncValidated = true;
	}

	const raceFile = join(directory, "race.bin");
	const raceStop = join(directory, "race.stop");
	const raceBytes = 8 * 1024 * 1024;
	writeFileSync(raceFile, Buffer.alloc(raceBytes, 0x41));
	const writerCode =
		"const fs=require('node:fs');const [file,stop,size]=process.argv.slice(1);const a=Buffer.alloc(Number(size),0x41),b=Buffer.alloc(Number(size),0x42);process.stdout.write('ready\\n');let i=0;while(!fs.existsSync(stop)){try{fs.writeFileSync(file,(i++&1)?a:b)}catch{}}";
	const writer = spawn(process.execPath, ["-e", writerCode, raceFile, raceStop, String(raceBytes)], {
		stdio: ["ignore", "pipe", "inherit"],
		windowsHide: true,
	});
	const writerExit = new Promise((resolveExit, reject) => {
		writer.once("exit", (code) => (code === 0 ? resolveExit() : reject(new Error(`race writer exited ${code}`))));
		writer.once("error", reject);
	});
	await waitForLine(writer.stdout);
	let coherentSnapshots = 0;
	let rejectedSnapshots = 0;
	try {
		for (let attempt = 0; attempt < 24; attempt++) {
			try {
				const raceSnapshot = helper.snapshotRegularFile(raceFile, raceBytes, true);
				const first = raceSnapshot.contents[0];
				assert.ok(first === 0x41 || first === 0x42);
				assert.equal(raceSnapshot.contents.every((byte) => byte === first), true);
				coherentSnapshots++;
			} catch (error) {
				assert.match(String(error), /Could not open Windows path|changed while being snapshotted/);
				rejectedSnapshots++;
			}
		}
	} finally {
		writeFileSync(raceStop, "stop\n");
		await writerExit;
	}
	assert.equal(coherentSnapshots + rejectedSnapshots, 24);

	console.log(
		JSON.stringify({
			apiVersion: helper.apiVersion,
			arch: process.arch,
			directoryIdentity: directorySnapshot.identity,
			regularFileIdentity: replacedSnapshot.identity,
			reparseRejected: true,
			ancestorReparseCanonicalized: true,
			extendedPathValidated: true,
			longPathValidated: true,
			uncValidated,
			concurrentSnapshotsCoherent: true,
			coherentSnapshots,
			rejectedSnapshots,
		}),
	);
} finally {
	rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
