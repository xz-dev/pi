#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectMacosCrashReports } from "./lib/macos-crash-reports.mjs";

const repository = "xz-dev/pi";
const target = "darwin-x64-modern";

export function validateCandidateRun(run, workflowId, runId) {
	assert.ok(Number.isSafeInteger(workflowId) && workflowId > 0, "Invalid release workflow ID");
	assert.equal(run.id, runId, "Source run ID differs");
	assert.equal(run.workflow_id, workflowId, "Source is not the release workflow");
	assert.equal(run.head_repository?.full_name, repository, "Source repository differs");
	assert.equal(run.head_branch, "main", "Only main candidates may be diagnosed");
	assert.ok(["push", "workflow_dispatch"].includes(run.event), "Unexpected source event");
	assert.equal(run.status, "completed", "Source run is not complete");
	assert.equal(run.conclusion, "failure", "Source run is not a failed candidate");
	assert.match(run.head_sha, /^[0-9a-f]{40}$/, "Invalid source commit");
	assert.ok(Number.isSafeInteger(run.run_number) && run.run_number > 0, "Invalid source run number");
	assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, "Invalid source attempt");
}

export function verifyOriginalBinary(input, expectedHash) {
	assert.match(expectedHash, /^[0-9a-f]{64}$/, "Expected the original binary SHA-256");
	assert.deepEqual(readdirSync(input), [`pi-${target}`], "Unexpected candidate artifact contents");
	const asset = join(input, `pi-${target}`);
	assert.ok(lstatSync(asset).isFile(), "Candidate is not a regular file");
	const bytes = readFileSync(asset);
	const hash = createHash("sha256").update(bytes).digest("hex");
	assert.equal(hash, expectedHash, "Candidate bytes differ from the original failed binary");
	return { asset, hash, bytes: bytes.length };
}

async function main() {
	const [runArg, expectedHash, outputArg] = process.argv.slice(2);
	const runId = Number(runArg);
	assert.ok(Number.isSafeInteger(runId) && runId > 0, "Expected a source run ID");
	assert.match(expectedHash ?? "", /^[0-9a-f]{64}$/, "Expected the original binary SHA-256");
	assert.ok(outputArg, "Expected a diagnostic output directory");
	assert.equal(platform(), "darwin", "Exact-candidate probe requires macOS");
	const output = resolve(outputArg);
	mkdirSync(output, { recursive: true });
	const api = (path) => JSON.parse(execFileSync("gh", ["api", `repos/${repository}/${path}`], { encoding: "utf8" }));
	const run = api(`actions/runs/${runId}`);
	validateCandidateRun(run, api("actions/workflows/publish-github-release.yml").id, runId);
	const packageFile = api(`contents/packages/coding-agent/package.json?ref=${run.head_sha}`);
	const packageVersion = JSON.parse(Buffer.from(packageFile.content, "base64").toString("utf8")).version;
	const version = `${packageVersion}-xz.${run.run_number}.1.g${run.head_sha.slice(0, 8)}`;
	const artifactName = `github-release-target-${run.head_sha}-${target}`;
	const work = mkdtempSync(join(tmpdir(), "pi-macos-candidate-probe-"));
	const env = { ...process.env, PI_OFFLINE: "1" };
	// The diagnostic child has no need for the artifact download credential.
	delete env.GH_TOKEN;
	delete env.GITHUB_TOKEN;
	delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
	try {
		const input = join(work, "input");
		execFileSync("gh", ["run", "download", String(runId), "--repo", repository, "--name", artifactName, "--dir", input], { stdio: "inherit" });
		const { asset, hash, bytes } = verifyOriginalBinary(input, expectedHash);
		chmodSync(asset, 0o755);
		const summary = {
			diagnosticOnly: true, sourceRunId: runId, sourceCommit: run.head_sha, version,
			artifactName, asset: { sha256: hash, bytes },
			probeCommit: process.env.GITHUB_SHA ?? null,
			bunRevision: execFileSync("bun", ["--revision"], { encoding: "utf8", env }).trim(),
			nodeVersion: process.version, imageOs: process.env.ImageOS ?? null,
			imageVersion: process.env.ImageVersion ?? null, cpuModel: cpus()[0]?.model ?? "unknown",
			cases: [],
		};
		assert.equal(summary.bunRevision, "1.4.3+c6da4a4d3", "Harness Bun revision differs from the original failure");
		for (const name of ["original-1", "original-2", "paste-off-control"]) {
			const recordPath = join(output, `${name}.json`);
			let result;
			if (name !== "paste-off-control") {
				result = spawnSync(process.execPath, [join(import.meta.dirname, "smoke-binary-release.mjs"), asset, target, version, recordPath], { encoding: "utf8", env, timeout: 90_000 });
			} else {
				const control = join(work, "control");
				const install = join(control, "install");
				const home = join(control, "home");
				const temp = join(control, "tmp");
				for (const directory of [install, home, temp, join(control, "agent")]) mkdirSync(directory, { recursive: true });
				const executable = join(install, "pi");
				copyFileSync(asset, executable);
				chmodSync(executable, 0o755);
				const startedMs = Date.now();
				const evidencePath = `${recordPath}.diagnostics`;
				result = spawnSync("bun", [join(import.meta.dirname, "smoke-bun-tui.mjs"), executable], {
					encoding: "utf8", timeout: 10_000,
					env: { ...env, NODE_ENV: "production", HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(control, "agent"), TMPDIR: temp, TEMP: temp, TMP: temp, TERM: "xterm-256color", PI_STARTUP_BENCHMARK: "0", PI_XZ_TUI_TIMEOUT_MS: "7000", PI_XZ_TUI_PASTE_PROBE: "0", PI_XZ_TUI_DIAGNOSTICS: evidencePath },
				});
				if (result.status !== 0) {
					let probe = null;
					try { probe = JSON.parse(readFileSync(evidencePath, "utf8")); } catch {}
					let crashReports = [];
					let collectionError = null;
					try {
						if (Number.isSafeInteger(probe?.childPid)) crashReports = collectMacosCrashReports([join(home, "Library", "Logs", "DiagnosticReports"), join(userInfo().homedir, "Library", "Logs", "DiagnosticReports"), "/Library/Logs/DiagnosticReports"], { pid: probe.childPid, names: ["pi", "bun"], sinceMs: startedMs, untilMs: Date.now() });
					} catch (error) { collectionError = error.message; }
					try { writeFileSync(evidencePath, `${JSON.stringify({ diagnosticOnly: true, probe, crashReports, collectionError }, null, 2)}\n`); } catch {}
				}
			}
			writeFileSync(`${recordPath}.stdout.log`, result.stdout ?? "");
			writeFileSync(`${recordPath}.stderr.log`, result.stderr ?? "");
			summary.cases.push({ name, diagnosticControl: name === "paste-off-control", status: result.status, signal: result.signal, error: result.error?.message ?? null });
			writeFileSync(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
		}
		console.log(JSON.stringify(summary));
		if (summary.cases.some(({ status }) => status !== 0)) process.exitCode = 1;
	} finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
