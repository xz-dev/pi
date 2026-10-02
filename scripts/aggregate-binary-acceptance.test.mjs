import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUN_TARGETS, SMOKE_LIMITS, binaryArchiveName, releaseArchiveName, smokeLimits } from "./lib/bun-targets.mjs";
import { muslSmokeLibraries } from "./prepare-musl-smoke.mjs";

const nativeBytes = Buffer.from("native helper fixture");
const nativeDigest = createHash("sha256").update(nativeBytes).digest("hex");

function record(target, assetIdentity) {
	return {
		schemaVersion: 1,
		target: target.id,
		asset: {
			file: binaryArchiveName(target.id),
			sha256: assetIdentity.sha256,
			bytes: assetIdentity.bytes,
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
			libraries: target.libc === "musl" ? muslSmokeLibraries(target.arch) : null,
			emulated: target.emulated,
		},
		commands: target.requiredCommands.map((name) => ({ name, status: 0, elapsedMs: 1 })),
		tui: {
			harness: target.os === "windows" ? "Bun.Terminal ConPTY" : "Bun.Terminal PTY",
			elapsedMs: 1,
			outputBytes: 1,
			input: target.os === "windows" ? "startup-benchmark" : "ctrl-v,ctrl-c,ctrl-d",
			childExitCode: 0,
			terminalClosed: true,
			terminalExitCode: 1,
			observedOutput: true,
			benchmarkCompleted: target.os === "windows" ? true : null,
			exitSent: target.os !== "windows",
			cleanExit: true,
		},
		clipboard: { helper: `${target.nativeHelperDir}/${target.nativeHelperFile}`, sha256: nativeDigest, loadedAndCalled: true, textRead: true, imageRead: true, elapsedMs: 1 },
		timingsMs: { coldVersion: 1, version: 1, help: 1, listModels: 1, interactive: 1 },
		limits: smokeLimits(target.id),
	};
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-acceptance-test-"));
	const records = join(root, "records");
	mkdirSync(records);
	const bundles = {};
	for (const target of BUN_TARGETS) {
		const assetPath = join(root, binaryArchiveName(target.id));
		writeFileSync(assetPath, `executable:${target.id}`);
		const identity = {
			sha256: createHash("sha256").update(readFileSync(assetPath)).digest("hex"),
			bytes: statSync(assetPath).size,
		};
		bundles[target.id] = { file: releaseArchiveName(target.id), bytes: 1, sha256: "d".repeat(64), executable: { file: binaryArchiveName(target.id), ...identity } };
		writeFileSync(join(records, `${target.id}.json`), JSON.stringify(record(target, identity)));
	}
	const manifest = {
		schemaVersion: 7,
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

test("aggregator applies scaled timing budgets only to emulated targets", () => {
	const emulated = BUN_TARGETS.find((target) => target.emulated);
	const native = BUN_TARGETS.find((target) => !target.emulated);
	const value = fixture();
	try {
		const emulatedPath = join(value.records, `${emulated.id}.json`);
		const slow = JSON.parse(readFileSync(emulatedPath, "utf8"));
		slow.timingsMs.coldVersion = SMOKE_LIMITS.coldVersionMs + 1;
		writeFileSync(emulatedPath, JSON.stringify(slow));
		assert.equal(runAggregator(value).status, 0);
		const nativePath = join(value.records, `${native.id}.json`);
		const claimed = JSON.parse(readFileSync(nativePath, "utf8"));
		claimed.limits = smokeLimits(emulated.id);
		writeFileSync(nativePath, JSON.stringify(claimed));
		const result = runAggregator(value);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /self-reported limits do not equal authoritative limits/);
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

test("aggregator accepts display-less musl TUI evidence without a paste", () => {
	const value = fixture();
	try {
		// The musl container probe has no display, so it never sends ctrl+v; the
		// in-display paste probe that materializes the helper is separate.
		for (const target of BUN_TARGETS.filter(({ libc }) => libc === "musl")) {
			const path = join(value.records, `${target.id}.json`);
			const changed = JSON.parse(readFileSync(path, "utf8"));
			changed.tui.input = "ctrl-c,ctrl-d";
			writeFileSync(path, JSON.stringify(changed));
		}
		const result = runAggregator(value);
		assert.equal(result.status, 0, result.stderr);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("aggregator rejects TUI evidence that does not match the target platform", () => {
	const value = fixture();
	try {
		const target = BUN_TARGETS.find(({ os }) => os !== "windows");
		const path = join(value.records, `${target.id}.json`);
		const changed = JSON.parse(readFileSync(path, "utf8"));
		changed.tui.harness = "Python standard-library PTY";
		changed.tui.input = "/exit\r";
		writeFileSync(path, JSON.stringify(changed));
		const result = runAggregator(value);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /missing bounded TUI acceptance/);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

for (const [label, mutate] of [
	["presence-only clipboard", (record) => { record.clipboard = { packaged: true }; }],
	["missing image call", (record) => { delete record.clipboard.imageRead; }],
	["unverified musl libraries", (record) => { delete record.executor.libraries; }],
]) test(`aggregator rejects ${label}`, () => {
	const value = fixture();
	try {
		const target = BUN_TARGETS.find(({ libc }) => libc === "musl");
		const path = join(value.records, `${target.id}.json`);
		const changed = JSON.parse(readFileSync(path, "utf8"));
		mutate(changed); writeFileSync(path, JSON.stringify(changed));
		const result = runAggregator(value);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /clipboard|native helper|musl library/);
	} finally { rmSync(value.root, { recursive: true, force: true }); }
});
