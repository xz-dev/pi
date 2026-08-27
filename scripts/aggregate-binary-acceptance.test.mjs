import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUN_TARGETS, SMOKE_LIMITS, binaryArchiveName } from "./lib/bun-targets.mjs";

const digest = "a".repeat(64);
const notice = `# Third-Party Notices\n\nLicense SHA-256: ${digest}\n`;

function windowsFilesystemSnapshotEvidence(target) {
	return {
		apiVersion: 1,
		arch: target.arch,
		reparseRejected: true,
		ancestorReparseCanonicalized: true,
		extendedPathValidated: true,
		longPathValidated: true,
		uncValidated: true,
		concurrentSnapshotsCoherent: true,
		loader: {
			missingRejected: true,
			corruptRejectedWithoutFallback: true,
			oppositeArchitectureRejected: true,
			apiMismatchRejected: true,
			malformedNativeResultsRejected: true,
			malformedExportsRejected: true,
			malformedResultsRejected: true,
		},
	};
}

function record(target, archive = { sha256: digest, bytes: 1 }) {
	return {
		schemaVersion: 1,
		target: target.id,
		archive: {
			file: binaryArchiveName(target.id),
			sha256: archive.sha256,
			bytes: archive.bytes,
			extractedBytes: 1,
		},
		runner: {
			os: target.runnerOs,
			arch: target.runnerArch,
			osArchitecture: target.arch,
			cpuFeatures: target.requiredCpuFeatures.join(" "),
		},
		executor: {
			kind: target.executor,
			containerDigest: target.containerImage ?? null,
			emulated: false,
		},
		commands: target.requiredCommands.map((name) => ({ name, status: 0, elapsedMs: 1 })),
		tui: {
			harness: target.os === "windows" ? "Bun.Terminal ConPTY" : "Bun.Terminal PTY",
			elapsedMs: 1,
			outputBytes: 1,
			input: target.os === "windows" ? "startup-benchmark" : "ctrl-c,ctrl-d",
			childExitCode: 0,
			terminalClosed: true,
			terminalExitCode: 1,
			observedOutput: true,
			benchmarkCompleted: target.os === "windows" ? true : null,
			exitSent: target.os !== "windows",
			cleanExit: true,
		},
		clipboard: { loadedAndCalled: true },
		filesystemSnapshot: target.os === "windows" ? windowsFilesystemSnapshotEvidence(target) : null,
		thirdPartyNotices: {
			file: "THIRD_PARTY_NOTICES.md",
			sha256: createHash("sha256").update(notice).digest("hex"),
			bytes: Buffer.byteLength(notice),
		},
		timingsMs: { coldVersion: 1, version: 1, help: 1, listModels: 1, interactive: 1 },
		limits: SMOKE_LIMITS,
	};
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-acceptance-test-"));
	const records = join(root, "records");
	mkdirSync(records);
	const bundles = {};
	for (const target of BUN_TARGETS) {
		const stage = join(root, `stage-${target.id}`);
		mkdirSync(stage, { recursive: true });
		writeFileSync(join(stage, "THIRD_PARTY_NOTICES.md"), notice);
		const archivePath = join(root, binaryArchiveName(target.id));
		execFileSync("zip", ["-q", archivePath, "THIRD_PARTY_NOTICES.md"], { cwd: stage });
		const identity = {
			sha256: createHash("sha256").update(readFileSync(archivePath)).digest("hex"),
			bytes: statSync(archivePath).size,
		};
		bundles[target.id] = { file: binaryArchiveName(target.id), ...identity };
		writeFileSync(join(records, `${target.id}.json`), JSON.stringify(record(target, identity)));
	}
	const manifest = {
		schemaVersion: 5,
		commit: "b".repeat(40),
		bundles,
		attestation: { subjectsFile: "attestation-subjects.jsonl" },
	};
	writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
	writeFileSync(join(root, "SHA256SUMS"), "");
	writeFileSync(join(root, "attestation-subjects.jsonl"), "manifest.json\n");
	return {
		root,
		records,
		manifest: join(root, "manifest.json"),
		output: join(root, "binary-acceptance.json"),
	};
}

function runAggregator(value) {
	return spawnSync(
		process.execPath,
		[join(import.meta.dirname, "aggregate-binary-acceptance.mjs"), value.records, value.manifest, value.output],
		{ encoding: "utf8" },
	);
}

test("aggregator accepts exact authoritative target descriptors", () => {
	const value = fixture();
	try {
		execFileSync(process.execPath, [
			join(import.meta.dirname, "aggregate-binary-acceptance.mjs"),
			value.records,
			value.manifest,
			value.output,
		]);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("aggregator rejects self-asserted emulation and runner mismatch", () => {
	const value = fixture();
	try {
		const path = join(value.records, `${BUN_TARGETS[0].id}.json`);
		const changed = JSON.parse(readFileSync(path, "utf8"));
		changed.executor.emulated = true;
		writeFileSync(path, JSON.stringify(changed));
		const result = runAggregator(value);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /executor does not match authoritative descriptor/);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("aggregator rejects cold and warm version timings above their separate limits", () => {
	for (const [field, maximum] of [
		["coldVersion", SMOKE_LIMITS.coldVersionMs],
		["version", SMOKE_LIMITS.versionMs],
	]) {
		const value = fixture();
		try {
			const path = join(value.records, `${BUN_TARGETS[0].id}.json`);
			const changed = JSON.parse(readFileSync(path, "utf8"));
			changed.timingsMs[field] = maximum + 1;
			writeFileSync(path, JSON.stringify(changed));
			const result = runAggregator(value);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, new RegExp(`${field}Ms.*exceeds authoritative limit`));
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	}
});

test("aggregator rejects TUI evidence that does not match the target platform", () => {
	const value = fixture();
	try {
		const target = BUN_TARGETS.find(({ os }) => os !== "windows");
		const path = join(value.records, `${target.id}.json`);
		const changed = JSON.parse(readFileSync(path, "utf8"));
		changed.tui.harness = "Python standard-library PTY";
		changed.tui.input = "/exit\\r";
		writeFileSync(path, JSON.stringify(changed));
		const result = runAggregator(value);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /missing bounded TUI or clipboard acceptance/);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("aggregator rejects missing or malformed Windows filesystem snapshot evidence", () => {
	for (const mutate of [
		(record) => {
			delete record.filesystemSnapshot;
		},
		(record) => {
			record.filesystemSnapshot.loader.malformedNativeResultsRejected = false;
		},
	]) {
		const value = fixture();
		try {
			const target = BUN_TARGETS.find(({ os }) => os === "windows");
			const path = join(value.records, `${target.id}.json`);
			const changed = JSON.parse(readFileSync(path, "utf8"));
			mutate(changed);
			writeFileSync(path, JSON.stringify(changed));
			const result = runAggregator(value);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /missing Win32 filesystem snapshot acceptance/);
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	}
});

test("aggregator rejects notice evidence that does not match archive bytes", () => {
	const value = fixture();
	try {
		const path = join(value.records, `${BUN_TARGETS[0].id}.json`);
		const changed = JSON.parse(readFileSync(path, "utf8"));
		changed.thirdPartyNotices.sha256 = digest;
		writeFileSync(path, JSON.stringify(changed));
		const result = runAggregator(value);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /archived third-party notices do not match acceptance evidence/);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});
