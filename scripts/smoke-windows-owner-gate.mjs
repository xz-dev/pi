#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_OWNER_GATE_TIMEOUT_MS = 900_000;
export const WINDOWS_OWNER_TEST_NAMES = [
	"shipped CLI respawn and console/ConPTY Ctrl-C",
	"unsigned statuses, exact separate binary stdio and Unicode/empty argv",
	...["tree", "nested"].flatMap((mode) => ["exit", "K", "lease-loss", "guardian-death"].map((stop) => `${mode}: ${stop} empties all recursive/new-console descendants; unrelated same-user peer lives`)),
	...[false, true].map((lost) => `delayed native cleanup (>50 ms), lease loss=${lost} cannot fake acknowledgment`),
	...["attach-opening", "attach-opened"].map((phase) => `${phase}: worker exit revokes identity before assignment`),
	"breakaway is denied",
	"fault flags disabled without opt-in; assignment/transport fail before payload; query failure never sends C",
	...["spawned", "transferred", "received", "assigned", "ready", "launch"].flatMap((phase) => ["guardian", "bootstrap", "launcher-death"].map((victim) => `${phase}: ${victim} death revokes launch or contains payload; no Job/control handle leak`)),
	"direct Node/Bun fork message, TCP handle transfer and disconnect through attached Job",
	"Chord contains double-detached descendants only after attach ack; failed attach kills P without init",
	"exec caller abort and timeout use lease, never terminate guardian before cleanup",
	"test phase permit expiry is bounded and cannot authorize payload",
	"Windows PowerShell and Git Bash preserve shell-specific quoting",
];

// Node's built-in reporter API keeps per-test results separate from fixture stdout.
export default async function* reporter(events) {
	for await (const event of events) {
		if (["test:pass", "test:fail", "test:stdout", "test:stderr", "test:summary"].includes(event.type)) yield `${JSON.stringify(event)}\n`;
	}
}

export function windowsOwnerGateDependencies(lock) {
	const selected = new Map();
	function add(name) {
		if (selected.has(name)) return;
		const entry = lock.packages[`node_modules/${name}`];
		if (!entry?.version || !entry.resolved?.startsWith("https://registry.npmjs.org/") || !entry.integrity?.startsWith("sha512-")) throw new Error(`Windows gate dependency lacks locked provenance: ${name}`);
		selected.set(name, { name, version: entry.version, resolved: entry.resolved, integrity: entry.integrity });
		for (const dependency of Object.keys(entry.dependencies ?? {})) add(dependency);
	}
	for (const name of ["cross-spawn", "typebox"]) add(name);
	return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function assertWindowsOwnerDependencies(expected, installedLock, tree) {
	const actual = Object.entries(installedLock.packages ?? {}).filter(([path]) => path).map(([path, entry]) => ({ name: path.replace(/^node_modules\//, ""), version: entry.version, resolved: entry.resolved, integrity: entry.integrity })).sort((a, b) => a.name.localeCompare(b.name));
	if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Windows gate installed dependency version/integrity differs from root lockfile");
	const seen = new Set();
	// npm ls omits `resolved` on nested (deduped) entries; top-level entries and the lockfile above carry it.
	function visit(node, nested = false) {
		if (node.problems?.length) throw new Error("Windows gate npm ls reported dependency problems");
		for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
			const locked = expected.find((entry) => entry.name === name);
			if (!locked || dependency.version !== locked.version || (!nested && dependency.resolved !== locked.resolved)) throw new Error(`Windows gate npm ls differs from locked dependency: ${name}`);
			seen.add(name);
			visit(dependency, true);
		}
	}
	visit(tree);
	if (seen.size !== expected.length) throw new Error("Windows gate npm ls missing dependency");
}

export function stageWindowsOwnerGate(work, { env, run, source = fileURLToPath(new URL("../", import.meta.url)) }) {
	if (env.CI !== "true" && env.GITHUB_ACTIONS !== "true") throw new Error("Windows gate dependency installation is CI-only");
	const dependencies = windowsOwnerGateDependencies(JSON.parse(readFileSync(join(source, "package-lock.json"), "utf8")));
	writeFileSync(join(work, "package.json"), JSON.stringify({ private: true, type: "module" }));
	const npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	const install = run(process.execPath, [npm, "install", "--prefix", work, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", ...dependencies.map(({ name, version }) => `${name}@${version}`)], { encoding: "utf8", timeout: 120_000 });
	if (install.status !== 0) throw new Error(`Windows gate dependency install failed: ${install.stderr || install.error?.message || install.status}`);
	const listing = run(process.execPath, [npm, "ls", "--prefix", work, "--all", "--json"], { encoding: "utf8", timeout: 30_000 });
	if (listing.status !== 0) throw new Error(`Windows gate dependency listing failed: ${listing.stderr || listing.error?.message || listing.status}`);
	assertWindowsOwnerDependencies(dependencies, JSON.parse(readFileSync(join(work, "package-lock.json"), "utf8")), JSON.parse(listing.stdout));
	writeFileSync(join(work, "windows-gate-dependencies.json"), JSON.stringify(dependencies));
	const bun = run("bun", ["--version"], { encoding: "utf8", timeout: 10_000 });
	const runtimeInputs = { runnerBunVersion: bun.status === 0 ? bun.stdout.trim() || null : null, runnerBunError: bun.status === 0 ? null : bun.error?.message || bun.stderr || `exit ${bun.status}`, runnerBunPath: null, runnerBunSha256: null };
	if (runtimeInputs.runnerBunVersion) {
		try {
			const location = run("bun", ["-p", "process.execPath"], { encoding: "utf8", timeout: 10_000 });
			if (location.status !== 0 || !location.stdout?.trim()) throw new Error(`Bun executable lookup failed: ${location.error?.message || location.stderr || location.status}`);
			runtimeInputs.runnerBunPath = join(work, "bun.exe");
			copyFileSync(location.stdout.trim(), runtimeInputs.runnerBunPath);
			runtimeInputs.runnerBunSha256 = createHash("sha256").update(readFileSync(runtimeInputs.runnerBunPath)).digest("hex");
		} catch (error) { runtimeInputs.runnerBunError = error.message; }
	}
	writeFileSync(join(work, "windows-gate-runtime-inputs.json"), JSON.stringify(runtimeInputs));
	cpSync(join(source, "packages", "chord", "src"), join(work, "packages", "chord", "src"), { recursive: true });
	const files = ["package.json", "src/core/exec.ts", "src/config.ts", "src/utils/child-process.ts", "src/utils/process-owner.ts", "src/utils/paths.ts", "src/utils/text.ts", "test/windows-owner-runtime.mjs", "test/fixtures/windows-owner.cs", "test/fixtures/windows-owner-ipc.mjs", "test/fixtures/windows-owner-launcher.mjs"];
	for (const file of files) {
		const destination = join(work, "packages", "coding-agent", file);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(join(source, "packages", "coding-agent", file), destination);
	}
	mkdirSync(join(work, "scripts"), { recursive: true });
	copyFileSync(fileURLToPath(import.meta.url), join(work, "scripts", "smoke-windows-owner-gate.mjs"));
}

export function windowsOwnerGateCommand(work, runtime = process.execPath, name = "node") {
	const file = join(work, "packages", "coding-agent", "test", "windows-owner-runtime.mjs");
	if (name === "bun") return [runtime, "test", "--reporter=junit", `--reporter-outfile=${join(work, "bun-junit.xml")}`, "--timeout", "60000", file];
	return [runtime, "--experimental-strip-types", "--test", "--test-concurrency=1", `--test-reporter=${join(work, "scripts", "smoke-windows-owner-gate.mjs")}`, file];
}

function gateObservations(tests, logs) {
	let artifact, identity;
	for (const line of logs.split(/\r?\n/)) {
		try { const entry = JSON.parse(line); if (entry.ownerSha256) artifact = entry; if (entry.gateIdentity) identity = entry.gateIdentity; } catch {}
	}
	return { tests, counts: { passed: tests.filter(({ status }) => status === "passed").length, failed: tests.filter(({ status }) => status === "failed").length, skipped: tests.filter(({ status }) => status === "skipped").length, todo: tests.filter(({ status }) => status === "todo").length }, artifact, identity, logs };
}

export function parseWindowsOwnerGate(stdout) {
	const tests = [], summaries = [];
	let logs = "";
	for (const line of stdout.trim().split(/\r?\n/)) {
		const event = JSON.parse(line);
		if (event.type === "test:stdout" || event.type === "test:stderr") logs += event.data.message;
		if (event.type === "test:summary") summaries.push(event.data);
		if (event.type === "test:pass" || event.type === "test:fail") tests.push({ name: event.data.name, status: event.data.skip ? "skipped" : event.data.todo ? "todo" : event.type === "test:pass" ? "passed" : "failed" });
	}
	return { ...gateObservations(tests, logs), summaries };
}

// Accept only Bun's single-file JUnit schema; unknown/malformed XML fails closed.
export function parseBunOwnerGate(xml, logs, file) {
	function attributes(text) {
		const result = {};
		const rest = text.replace(/\s+([\w-]+)="([^"<>]*)"/g, (_match, key, value) => {
			if (key in result || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(value)) throw new Error("invalid JUnit attribute");
			result[key] = value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/g, (_entity, code) => code[0] === "#" ? String.fromCodePoint(code[1] === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[code]);
			return "";
		});
		if (rest.trim()) throw new Error("invalid JUnit attributes");
		return result;
	}
	const document = xml.trim().replace(/^<\?xml[^?]*\?>\s*/, "").match(/^<testsuites\b([^>]*)>([\s\S]*)<\/testsuites>$/);
	const suite = document?.[2].trim().match(/^<testsuite\b([^>]*)>([\s\S]*)<\/testsuite>$/);
	if (!suite) throw new Error("missing or invalid single-file Bun JUnit report");
	const root = attributes(document[1]), details = attributes(suite[1]);
	if (details.file?.replaceAll("\\", "/") !== file.replaceAll("\\", "/")) throw new Error("Bun JUnit report has unexpected test file");
	const tests = [];
	const rest = suite[2].replace(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g, (_match, attrs, body = "") => {
		const entry = attributes(attrs);
		if (!entry.name || entry.file?.replaceAll("\\", "/") !== file.replaceAll("\\", "/")) throw new Error("invalid Bun JUnit testcase identity");
		let status = "passed";
		if (body.trim()) {
			const outcome = body.trim().match(/^<(failure|error|skipped)\b([^>]*?)(?:\/>|>([^<]*)<\/\1>)$/);
			if (!outcome) throw new Error("invalid Bun JUnit testcase result");
			const info = attributes(outcome[2]);
			status = outcome[1] === "skipped" ? info.message === "TODO" ? "todo" : "skipped" : "failed";
		}
		tests.push({ name: entry.name, status });
		return "";
	});
	if (rest.trim()) throw new Error("unexpected Bun JUnit report content or extra test file");
	const result = gateObservations(tests, logs);
	for (const summary of [root, details]) {
		if (summary.tests !== String(tests.length) || summary.failures !== String(result.counts.failed) || summary.skipped !== String(result.counts.skipped + result.counts.todo) || (summary.errors !== undefined && summary.errors !== "0")) throw new Error("Bun JUnit counts disagree with testcase results");
	}
	return result;
}

export function assertWindowsOwnerGate(evidence, target, cliSha256, ownerIdentity, artifactBunVersion) {
	const fail = (detail) => { throw new Error(`Windows owner runtime gate: ${detail}`); };
	if (evidence?.status !== "passed" || evidence.target !== target || !Number.isSafeInteger(evidence.elapsedMs) || evidence.elapsedMs < 0 || evidence.elapsedMs > WINDOWS_OWNER_GATE_TIMEOUT_MS) fail("missing, failed or timed out");
	const expectedDependencies = windowsOwnerGateDependencies(JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")));
	if (JSON.stringify(evidence.dependencies) !== JSON.stringify(expectedDependencies)) fail("dependency provenance differs from root lockfile");
	if (JSON.stringify(evidence.runtimes?.map(({ name }) => name)) !== JSON.stringify(["node", "bun"])) fail("missing Node/Bun results");
	const bun = evidence.runtimes[1];
	if (!artifactBunVersion || bun.match !== true || bun.artifactBunVersion !== artifactBunVersion || bun.runnerBunVersion !== artifactBunVersion || bun.version !== artifactBunVersion) fail(`Bun version mismatch: artifact=${artifactBunVersion ?? "null"}, runner=${bun.runnerBunVersion ?? "null"}`);
	if (!bun.runnerBunPath || bun.command?.[0] !== bun.runnerBunPath || !/^[0-9a-f]{64}$/.test(bun.runnerBunSha256 ?? "")) fail("Bun staged executable provenance missing");
	for (const runtime of evidence.runtimes) {
		if (runtime.status !== "passed" || runtime.exitCode !== 0 || runtime.error || !runtime.version || runtime.counts?.passed !== WINDOWS_OWNER_TEST_NAMES.length || runtime.counts.failed !== 0 || runtime.counts.skipped !== 0 || runtime.counts.todo !== 0 || JSON.stringify(runtime.tests?.map(({ name }) => name)) !== JSON.stringify(WINDOWS_OWNER_TEST_NAMES) || runtime.tests.some(({ status }) => status !== "passed")) fail(`${runtime.name} missing, failed or skipped tests`);
		if (runtime.artifact?.artifact !== target || runtime.artifact.cliSha256 !== cliSha256 || !/^[0-9a-f]{64}$/.test(runtime.artifact.ownerSha256 ?? "") || runtime.artifact.platform !== "win32" || runtime.version !== runtime.artifact.runtime?.[runtime.name]) fail(`${runtime.name} artifact/runtime identity mismatch`);
		if (typeof runtime.identity?.name !== "string" || !runtime.identity.name || !ownerIdentity?.name || runtime.identity.name.toLowerCase() !== ownerIdentity.name.toLowerCase() || runtime.identity?.elevated !== false || runtime.identity?.admin !== false || typeof runtime.identity?.inheritedJob !== "boolean" || !runtime.identity?.whoamiAll || !/S-1-16-8192\b/.test(runtime.identity.whoamiAll) || /S-1-5-32-544|S-1-16-(?:12288|16384)/.test(runtime.identity.whoamiAll)) fail(`${runtime.name} nonadmin identity missing`);
	}
	if (evidence.runtimes[0].artifact.ownerSha256 !== evidence.runtimes[1].artifact.ownerSha256) fail("Node/Bun helpers differ");
}

export function smokeWindowsOwnerGate(executable, target, owner, identity, { work = process.env.PI_WINDOWS_GATE_ROOT, artifactBunVersion = null, run = spawnSync, env = process.env } = {}) {
	const started = performance.now();
	const evidence = { status: "failed", target: target.id, elapsedMs: 0, dependencies: [], runtimes: [] };
	let runtimeInputs = {};
	try { runtimeInputs = JSON.parse(readFileSync(join(work, "windows-gate-runtime-inputs.json"), "utf8")); } catch {}
	const runnerBunVersion = runtimeInputs.runnerBunVersion ?? null;
	// Only artifact-matched Bun copied before privilege drop can attest this shipped runtime.
	const bun = { name: "bun", status: "failed", ...runtimeInputs, artifactBunVersion, runnerBunVersion, match: artifactBunVersion !== null && runnerBunVersion !== null && artifactBunVersion === runnerBunVersion, version: runnerBunVersion, exitCode: null, command: null, counts: { passed: 0, failed: 0, skipped: 0, todo: 0 }, tests: [] };
	const node = { name: "node", version: process.versions.node, status: "failed", exitCode: null, command: null };
	evidence.runtimes.push(node, bun);
	if (!bun.match) bun.error = `Bun version mismatch: artifact=${artifactBunVersion ?? "null"}, runner=${runnerBunVersion ?? "null"}`;
	try {
		if (!work || !owner) throw new Error("missing staged runtime inputs or shipped materialized helper");
		evidence.dependencies = JSON.parse(readFileSync(join(work, "windows-gate-dependencies.json"), "utf8"));
		for (const runtime of evidence.runtimes) {
			if (runtime.error) continue;
			try {
				if (runtime.name === "bun") {
					if (runtime.runnerBunError || !runtime.runnerBunPath || createHash("sha256").update(readFileSync(runtime.runnerBunPath)).digest("hex") !== runtime.runnerBunSha256) throw new Error(`Bun staged executable unavailable or hash differs: ${runtime.runnerBunError ?? runtime.runnerBunPath ?? "missing path"}`);
					// Never accept a stale report from a previous invocation.
					rmSync(join(work, "bun-junit.xml"), { force: true });
				}
				runtime.command = windowsOwnerGateCommand(work, runtime.name === "bun" ? runtime.runnerBunPath : process.execPath, runtime.name);
				const remaining = Math.floor(WINDOWS_OWNER_GATE_TIMEOUT_MS - 60_000 - (performance.now() - started));
				if (remaining <= 0) throw new Error("Windows gate runtime budget exhausted");
				const result = run(runtime.command[0], runtime.command.slice(1), { encoding: "utf8", timeout: remaining, maxBuffer: 16 * 1024 * 1024, cwd: work, env: { ...env, NODE_OPTIONS: "", PI_WINDOWS_OWNER_ARTIFACT: target.id, PI_PROCESS_OWNER_TEST_BINARY: owner, PI_WINDOWS_OWNER_TEST_CLI: executable } });
				runtime.exitCode = result.status;
				runtime.stderr = result.stderr ?? "";
				try {
					Object.assign(runtime, runtime.name === "bun"
						? parseBunOwnerGate(readFileSync(join(work, "bun-junit.xml"), "utf8"), `${result.stdout ?? ""}\n${result.stderr ?? ""}`, runtime.command.at(-1))
						: parseWindowsOwnerGate(result.stdout ?? ""));
				} catch (error) { runtime.error = `invalid reporter output: ${error.message}`; }
				if (result.error) runtime.error = result.error.message;
				if (result.status === 0 && !runtime.error && runtime.counts?.passed === WINDOWS_OWNER_TEST_NAMES.length && runtime.counts.failed === 0 && runtime.counts.skipped === 0 && runtime.counts.todo === 0 && JSON.stringify(runtime.tests?.map(({ name }) => name)) === JSON.stringify(WINDOWS_OWNER_TEST_NAMES)) runtime.status = "passed";
				else runtime.error ??= `${runtime.name} gate failed, skipped tests or returned an incomplete inventory`;
			} catch (error) { runtime.error = error.message; }
		}
	} catch (error) { evidence.error = error.message; }
	evidence.elapsedMs = Math.round(performance.now() - started);
	try {
		evidence.status = "passed";
		assertWindowsOwnerGate(evidence, target.id, createHash("sha256").update(readFileSync(executable)).digest("hex"), identity, artifactBunVersion);
	} catch (error) { evidence.status = "failed"; evidence.error ??= error.message; }
	return evidence;
}
