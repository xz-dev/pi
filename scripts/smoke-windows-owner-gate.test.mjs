import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { passedWindowsOwnerGate } from "./fixtures/windows-owner-gate.mjs";
import { bunTarget } from "./lib/bun-targets.mjs";
import { artifactBunFromOwnerRows } from "./smoke-owner-lifecycle.mjs";
import { assertWindowsOwnerDependencies, assertWindowsOwnerGate, parseBunOwnerGate, parseWindowsOwnerGate, smokeWindowsOwnerGate, stageWindowsOwnerGate, WINDOWS_OWNER_GATE_TIMEOUT_MS, WINDOWS_OWNER_TEST_NAMES, windowsOwnerGateCommand, windowsOwnerGateDependencies } from "./smoke-windows-owner-gate.mjs";

const target = bunTarget("windows-x64-baseline");
const identity = { name: "host\\pi-owner-smoke" };
const digest = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const dependencies = windowsOwnerGateDependencies(lock);
const installedLock = { packages: Object.fromEntries(dependencies.map(({ name }) => [`node_modules/${name}`, lock.packages[`node_modules/${name}`]])) };
const tree = { dependencies: Object.fromEntries(dependencies.map((entry) => [entry.name, entry])) };

function output(gate = passedWindowsOwnerGate(target.id, digest)) {
	const runtime = gate.runtimes[0];
	return [
		{ type: "test:stdout", data: { message: `${JSON.stringify({ ...runtime.artifact, runtime: { node: process.versions.node } })}\n` } },
		{ type: "test:stdout", data: { message: `${JSON.stringify({ gateIdentity: runtime.identity })}\n` } },
		...runtime.tests.map(({ name, status }) => ({ type: status === "failed" ? "test:fail" : "test:pass", data: { name, ...(status === "skipped" ? { skip: "fixture unavailable" } : {}) } })),
	].map((entry) => JSON.stringify(entry)).join("\n");
}

test("Windows gate command uses runner Node built-in type stripping and structured reporter, no dev loader", () => {
	const command = windowsOwnerGateCommand("C:/isolated gate", "C:/node.exe");
	assert.equal(command[0], "C:/node.exe");
	assert.deepEqual(command.slice(1, 4), ["--experimental-strip-types", "--test", "--test-concurrency=1"]);
	assert.equal(command.at(-1), join("C:/isolated gate", "packages", "coding-agent", "test", "windows-owner-runtime.mjs"));
	assert.equal(command.some((arg) => /tsx|ts-node|loader/.test(arg)), false);
});

test("built-in reporter round-trips real Node test events and gate stdout", () => {
	const work = mkdtempSync(join(tmpdir(), "pi-gate-reporter-test-"));
	try {
		const file = join(work, "probe.mjs");
		writeFileSync(file, `import test from 'node:test'; console.log(${JSON.stringify(JSON.stringify(passedWindowsOwnerGate(target.id, digest).runtimes[0].artifact))}); test('reporter probe', () => {});`);
		const result = spawnSync(process.execPath, ["--test", `--test-reporter=${fileURLToPath(new URL("./smoke-windows-owner-gate.mjs", import.meta.url))}`, file], { encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
		assert.equal(result.status, 0, result.stderr);
		const parsed = parseWindowsOwnerGate(result.stdout);
		assert.deepEqual(parsed.tests, [{ name: "reporter probe", status: "passed" }]);
		assert.equal(parsed.artifact.cliSha256, digest);
	} finally { rmSync(work, { recursive: true, force: true }); }
});

test("runtime staging installs exact locked closure only in CI, verifies version/integrity and copies source/fixtures", () => {
	const work = mkdtempSync(join(tmpdir(), "pi-gate-stage-test-"));
	const calls = [];
	try {
		assert.throws(() => stageWindowsOwnerGate(work, { env: {}, run: () => assert.fail("must not install on user machine") }), /CI-only/);
		stageWindowsOwnerGate(work, { env: { GITHUB_ACTIONS: "true" }, run: (file, args) => {
			calls.push({ file, args });
			if (file === "bun") return { status: 0, stdout: args[0] === "--version" ? "1.3.14\n" : `${process.execPath}\n` };
			if (args.includes("install")) {
				assert.deepEqual(args.slice(args.indexOf("--save-exact") + 1), dependencies.map(({ name, version }) => `${name}@${version}`));
				for (const flag of ["--ignore-scripts", "--no-audit", "--no-fund"]) assert.ok(args.includes(flag));
				writeFileSync(join(work, "package-lock.json"), JSON.stringify(installedLock));
				return { status: 0 };
			}
			assert.ok(args.includes("--all") && args.includes("--json"));
			return { status: 0, stdout: JSON.stringify(tree) };
		} });
		assert.equal(calls.length, 4);
		assert.deepEqual(JSON.parse(readFileSync(join(work, "windows-gate-runtime-inputs.json"), "utf8")), { runnerBunVersion: "1.3.14", runnerBunError: null, runnerBunPath: join(work, "bun.exe"), runnerBunSha256: digest });
		assert.equal(createHash("sha256").update(readFileSync(join(work, "bun.exe"))).digest("hex"), digest);
		assert.deepEqual(JSON.parse(readFileSync(join(work, "windows-gate-dependencies.json"), "utf8")), dependencies);
		for (const path of ["packages/chord/src/manager.ts", "packages/coding-agent/src/utils/process-owner.ts", "packages/coding-agent/test/windows-owner-runtime.mjs", "packages/coding-agent/test/fixtures/windows-owner.cs"]) assert.equal(readFileSync(join(work, path), "utf8"), readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
		for (const field of ["version", "resolved", "integrity"]) {
			const wrong = structuredClone(installedLock);
			wrong.packages["node_modules/typebox"][field] = "wrong";
			assert.throws(() => assertWindowsOwnerDependencies(dependencies, wrong, tree), /version\/integrity/);
		}
		const wrongTree = structuredClone(tree);
		wrongTree.dependencies.typebox.version = "0.0.0";
		assert.throws(() => assertWindowsOwnerDependencies(dependencies, installedLock, wrongTree), /npm ls differs/);
		assert.throws(() => assertWindowsOwnerDependencies(dependencies, installedLock, {}), /npm ls missing/);
	} finally { rmSync(work, { recursive: true, force: true }); }
});

function junit(gate, file) {
	const runtime = gate.runtimes[1];
	const escape = (text) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	const counts = `tests="${runtime.tests.length}" failures="${runtime.tests.filter(({ status }) => status === "failed").length}" skipped="${runtime.tests.filter(({ status }) => status === "skipped" || status === "todo").length}"`;
	return `<?xml version="1.0" encoding="UTF-8"?><testsuites ${counts}><testsuite file="${escape(file)}" ${counts}>${runtime.tests.map(({ name, status }) => `<testcase name="${escape(name)}" file="${escape(file)}">${status === "passed" ? "" : status === "failed" ? '<failure message="failed">assertion failed</failure>' : `<skipped${status === "todo" ? ' message="TODO"' : ""} />`}</testcase>`).join("")}</testsuite></testsuites>`;
}

function runMockedBun({ artifactBunVersion = "1.3.14", runnerBunVersion = "1.3.14", status = 0, mutate = () => {}, report = "valid" } = {}) {
	const work = mkdtempSync(join(tmpdir(), "pi-gate-run-test-"));
	const calls = [];
	try {
		const runtime = join(work, "bun.exe");
		copyFileSync(process.execPath, runtime);
		writeFileSync(join(work, "windows-gate-dependencies.json"), JSON.stringify(dependencies));
		writeFileSync(join(work, "windows-gate-runtime-inputs.json"), JSON.stringify({ runnerBunVersion, runnerBunError: null, runnerBunPath: runtime, runnerBunSha256: digest }));
		// Missing output must not accidentally reuse old successful evidence.
		writeFileSync(join(work, "bun-junit.xml"), junit(passedWindowsOwnerGate(target.id, digest), windowsOwnerGateCommand(work).at(-1)));
		const evidence = smokeWindowsOwnerGate(process.execPath, target, "C:/materialized/process-owner/pi-env.exe", identity, { work, artifactBunVersion, env: { NODE_OPTIONS: "--import=untrusted" }, run: (file, args, options) => {
			calls.push([file, ...args]);
			assert.ok(options.timeout > 0 && options.timeout <= WINDOWS_OWNER_GATE_TIMEOUT_MS);
			assert.equal(options.env.PI_WINDOWS_OWNER_ARTIFACT, target.id);
			assert.equal(options.env.PI_PROCESS_OWNER_TEST_BINARY, "C:/materialized/process-owner/pi-env.exe");
			assert.equal(options.env.PI_WINDOWS_OWNER_TEST_CLI, process.execPath);
			assert.equal(options.env.NODE_OPTIONS, "");
			if (file === process.execPath) {
				assert.deepEqual([file, ...args], windowsOwnerGateCommand(work));
				return { status: 0, stdout: output(), stderr: "" };
			}
			assert.deepEqual([file, ...args], windowsOwnerGateCommand(work, runtime, "bun"));
			assert.deepEqual(args.slice(0, 6), ["test", "--reporter=junit", `--reporter-outfile=${join(work, "bun-junit.xml")}`, "--timeout", "60000", windowsOwnerGateCommand(work).at(-1)]);
			const gate = passedWindowsOwnerGate(target.id, digest);
			mutate(gate);
			if (report !== "missing") writeFileSync(join(work, "bun-junit.xml"), report === "valid" ? junit(gate, args.at(-1)) : report);
			return { status, stdout: `${JSON.stringify(gate.runtimes[1].artifact)}\n${JSON.stringify({ gateIdentity: gate.runtimes[1].identity })}\n`, stderr: "" };
		} });
		return { evidence, calls };
	} finally { rmSync(work, { recursive: true, force: true }); }
}

test("matched artifact and runner Bun versions run staged Bun with JUnit, exact inventory and real counts", () => {
	const { evidence, calls } = runMockedBun();
	assert.equal(calls.length, 2);
	assert.equal(evidence.status, "passed", JSON.stringify(evidence));
	const bun = evidence.runtimes[1];
	assert.equal(bun.match, true);
	assert.equal(bun.artifactBunVersion, "1.3.14");
	assert.equal(bun.runnerBunVersion, "1.3.14");
	assert.equal(bun.runnerBunSha256, digest);
	assert.deepEqual(bun.counts, { passed: WINDOWS_OWNER_TEST_NAMES.length, failed: 0, skipped: 0, todo: 0 });
});

for (const [label, artifactBunVersion, runnerBunVersion] of [["mismatch", "1.3.14", "1.4.2"], ["missing artifact", null, "1.4.2"], ["missing runner", "1.3.14", null]]) test(`Bun ${label} fails without running Bun and names both versions`, () => {
	const { evidence, calls } = runMockedBun({ artifactBunVersion, runnerBunVersion });
	assert.equal(calls.length, 1);
	assert.equal(evidence.runtimes[0].status, "passed");
	assert.equal(evidence.runtimes[1].status, "failed");
	assert.equal(evidence.runtimes[1].match, false);
	assert.equal(evidence.runtimes[1].error, `Bun version mismatch: artifact=${artifactBunVersion ?? "null"}, runner=${runnerBunVersion ?? "null"}`);
	assert.equal(evidence.status, "failed");
});

test("all owner rows must report one embedded Bun version; missing or disagreeing rows fail Windows Bun", () => {
	assert.deepEqual(artifactBunFromOwnerRows([{ name: "first", pi: { bun: "1.3.14" } }, { name: "second", pi: { bun: "1.3.14" } }]), { artifactBunVersion: "1.3.14", artifactBunError: null });
	for (const rows of [[], [{ name: "missing" }], [{ name: "first", pi: { bun: "1.3.14" } }, { name: "missing" }], [{ name: "first", pi: { bun: "1.3.14" } }, { name: "second", pi: { bun: "1.4.2" } }]]) {
		const derived = artifactBunFromOwnerRows(rows);
		assert.equal(derived.artifactBunVersion, null);
		assert.match(derived.artifactBunError, /no owner rows|missing embedded Bun|disagree/);
		assert.equal(runMockedBun(derived).evidence.runtimes[1].status, "failed");
	}
});

for (const state of ["failed", "skipped", "todo"]) test(`Bun ${state} testcase reports real counts and fails gate`, () => {
	const { evidence } = runMockedBun({ mutate: (gate) => { gate.runtimes[1].tests[0].status = state; } });
	const bun = evidence.runtimes[1];
	assert.equal(evidence.status, "failed");
	assert.equal(bun.status, "failed");
	assert.equal(bun.counts[state], 1);
	assert.equal(bun.counts.passed, WINDOWS_OWNER_TEST_NAMES.length - 1);
});

test("Bun exit failure cannot pass even with a complete successful JUnit inventory", () => {
	const { evidence } = runMockedBun({ status: 1 });
	assert.equal(evidence.status, "failed");
	assert.equal(evidence.runtimes[1].exitCode, 1);
	assert.equal(evidence.runtimes[1].counts.passed, WINDOWS_OWNER_TEST_NAMES.length);
});

test("Bun JUnit accepts the cwd-relative test file Bun writes, and nothing else", () => {
	const work = "C:\\pi-owner-nonadmin-x", file = `${work}\\packages\\coding-agent\\test\\windows-owner-runtime.mjs`;
	const xml = (path) => `<testsuites tests="${WINDOWS_OWNER_TEST_NAMES.length}" failures="0" skipped="0"><testsuite file="${path}" tests="${WINDOWS_OWNER_TEST_NAMES.length}" failures="0" skipped="0">${WINDOWS_OWNER_TEST_NAMES.map((name) => `<testcase name="${name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")}" file="${path}"></testcase>`).join("")}</testsuite></testsuites>`;
	for (const path of ["packages\\coding-agent\\test\\windows-owner-runtime.mjs", "packages/coding-agent/test/windows-owner-runtime.mjs", file]) assert.equal(parseBunOwnerGate(xml(path), "", file, work).counts.passed, WINDOWS_OWNER_TEST_NAMES.length);
	for (const path of ["windows-owner-runtime.mjs", "other\\windows-owner-runtime.mjs", "C:\\elsewhere\\packages\\coding-agent\\test\\windows-owner-runtime.mjs"]) assert.throws(() => parseBunOwnerGate(xml(path), "", file, work), /unexpected test file|testcase identity/);
});
test("Node gate failures keep a bounded cause, and each runtime has an independent budget", async () => {
	const { default: reporter } = await import("./smoke-windows-owner-gate.mjs");
	async function* events() { yield { type: "test:fail", data: { name: "x", details: { error: { cause: new Error("why it failed") } } } }; }
	let line = ""; for await (const chunk of reporter(events())) line += chunk;
	assert.equal(parseWindowsOwnerGate(line).tests[0].error.includes("why it failed"), true);
	assert.ok(windowsOwnerGateCommand("/work", "/node").includes("--test-force-exit"));
});
test("Node gate reporter is passed as a file URL (Windows drive paths are rejected by the ESM loader)", () => {
	const command = windowsOwnerGateCommand("/work", "/node");
	assert.match(command.find((arg) => arg.startsWith("--test-reporter=")), /^--test-reporter=file:\/\//);
});
for (const report of ["missing", "<invalid>", '<testsuites tests="0" failures="0" skipped="0"><testsuite file="unexpected" tests="0" failures="0" skipped="0"></testsuite></testsuites>']) test(`Bun missing or malformed JUnit cannot pass: ${report}`, () => {
	const { evidence } = runMockedBun({ report });
	assert.equal(evidence.status, "failed");
	assert.match(evidence.runtimes[1].error, /invalid reporter output/);
});

test("Bun JUnit rejects extra files, count drift and malformed testcase XML", () => {
	const file = "C:/gate/windows-owner-runtime.mjs";
	const valid = junit(passedWindowsOwnerGate(target.id, digest), file);
	for (const xml of [valid.replace('</testsuites>', '<testsuite file="other"></testsuite></testsuites>'), valid.replace(`tests="${WINDOWS_OWNER_TEST_NAMES.length}"`, 'tests="0"'), valid.replace('</testcase>', ''), valid.replace('name="breakaway is denied"', 'name="breakaway &unknown; is denied"')]) assert.throws(() => parseBunOwnerGate(xml, "", file), /JUnit/);
});

test("aggregation rejects missing, failed, skipped, todo, incomplete and wrong identity/hash evidence", () => {
	assert.doesNotThrow(() => assertWindowsOwnerGate(passedWindowsOwnerGate(target.id, digest), target.id, digest, identity, "1.3.14"));
	assert.throws(() => assertWindowsOwnerGate(undefined, target.id, digest, identity, "1.3.14"), /missing, failed/);
	for (const mutate of [
		(gate) => { gate.runtimes.pop(); },
		(gate) => { gate.runtimes[1].status = "failed"; },
		(gate) => { gate.runtimes[1].match = false; },
		(gate) => { gate.runtimes[1].artifactBunVersion = null; },
		(gate) => { gate.runtimes[1].runnerBunVersion = "1.4.2"; },
		(gate) => { gate.runtimes[1].runnerBunSha256 = null; },
		(gate) => { gate.runtimes[1].tests[0].status = "skipped"; },
		(gate) => { gate.runtimes[1].tests.pop(); },
		(gate) => { gate.runtimes[0].counts.skipped = 1; },
		(gate) => { gate.runtimes[0].tests[0].status = "skipped"; },
		(gate) => { gate.runtimes[0].counts.todo = 1; },
		(gate) => { gate.runtimes[0].tests.pop(); },
		(gate) => { gate.runtimes[0].artifact.cliSha256 = "f".repeat(64); },
		(gate) => { gate.runtimes[0].identity.whoamiAll += " S-1-5-32-544"; },
		(gate) => { gate.runtimes[0].identity.name = "host\\other-user"; },
		(gate) => { gate.elapsedMs = WINDOWS_OWNER_GATE_TIMEOUT_MS + 1; },
		(gate) => { gate.dependencies[0].integrity = "sha512-wrong"; },
	]) {
		const gate = passedWindowsOwnerGate(target.id, digest);
		mutate(gate);
		assert.throws(() => assertWindowsOwnerGate(gate, target.id, digest, identity, "1.3.14"), /Windows owner runtime gate/);
	}
	const skipped = passedWindowsOwnerGate(target.id, digest);
	skipped.runtimes[0].tests[0].status = "skipped";
	assert.equal(parseWindowsOwnerGate(output(skipped)).counts.skipped, 1);
});
