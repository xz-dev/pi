import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { BUN_TARGET_IDS, BUN_TARGETS, binaryArchiveName, githubSmokeMatrix, releaseArchiveName, smokeLimits } from "./lib/bun-targets.mjs";
import { createReleaseArchive, forkDistributionVersion } from "./lib/github-release.mjs";
import { muslSmokeLibraries } from "./prepare-musl-smoke.mjs";
import { ownerLifecycleRows } from "./smoke-owner-lifecycle.mjs";
import { isUnixOwnerPtyRow } from "./smoke-unix-owner-pty.mjs";
import { passedUnixIdentity, passedUnixOwnerPtyRow } from "./fixtures/unix-owner-pty.mjs";
import { passedWindowsOwnerGate } from "./fixtures/windows-owner-gate.mjs";

const ROOT = join(import.meta.dirname, "..");
const workflow = parse(readFileSync(join(ROOT, ".github/workflows/publish-github-release.yml"), "utf8"));
const jobs = workflow.jobs;
const needs = (name) => [jobs[name].needs ?? []].flat();
const barriers = ["aggregate-release-candidate", "acceptance-record", "attest-release-candidate", "update-release-candidate", "update-freebsd-release-candidate", "publish-release"];

// Dependency-only model of default success() on main, not hosted Actions execution.
function outcome(name, forced) {
	if (Object.hasOwn(forced, name)) return forced[name];
	return needs(name).every((dependency) => outcome(dependency, forced) === "success") ? "success" : "skipped";
}

test("FreeBSD failure cannot suppress the twelve non-FreeBSD runtime targets", () => {
	const accept = jobs["accept-release-candidate"];
	assert.deepEqual(needs("accept-release-candidate"), ["release-matrix", "build-target"]);
	assert.equal(accept.strategy["fail-fast"], false);
	assert.equal(accept.strategy.matrix, "${{ fromJSON(needs.release-matrix.outputs.smoke-matrix) }}");
	const targets = githubSmokeMatrix().include.map(({ target }) => target);
	assert.equal(targets.length, 12);
	assert.deepEqual(targets, BUN_TARGET_IDS.filter((target) => !target.startsWith("freebsd-")));
	for (const status of ["failure", "cancelled", "skipped"]) {
		assert.equal(outcome("accept-release-candidate", { "build-freebsd": status }), "success");
		for (const name of barriers) assert.equal(outcome(name, { "build-freebsd": status }), "skipped", name);
	}
});

test("release-wide publication still requires successful full builds and runtime acceptance", () => {
	assert.deepEqual(needs("aggregate-release-candidate"), ["release-matrix", "validate-source", "build-target", "build-freebsd"]);
	assert.deepEqual(needs("acceptance-record"), ["release-matrix", "aggregate-release-candidate", "accept-release-candidate"]);
	for (const name of ["accept-release-candidate", ...barriers]) {
		assert.equal(jobs[name]["continue-on-error"], undefined, name);
		assert.doesNotMatch(jobs[name].if ?? "", /always\(|failure\(|cancelled\(/, name);
		for (const step of jobs[name].steps) assert.equal(step["continue-on-error"], undefined, name);
	}
	for (const failure of ["validate-source", "build-target", "accept-release-candidate"]) {
		assert.equal(outcome("acceptance-record", { [failure]: "failure" }), "skipped");
		assert.equal(outcome("publish-release", { [failure]: "failure" }), "skipped");
	}
	assert.equal(jobs["attest-release-candidate"].if, "github.ref == 'refs/heads/main'");
	assert.equal(jobs["publish-release"].if, "github.ref == 'refs/heads/main'");
	const aggregate = jobs["aggregate-release-candidate"].steps.find((step) => step.run)?.run;
	assert.match(aggregate, /-eq 14/);
	assert.doesNotMatch(aggregate, /--platform/);
	const record = jobs["acceptance-record"].steps.find((step) => step.run?.includes("aggregate-binary-acceptance.mjs"));
	assert.match(record.run, /verify-github-release\.mjs all/);
});

test("runtime jobs stage only their own target without exporting a subset release", () => {
	const steps = jobs["accept-release-candidate"].steps;
	const downloads = steps.filter((step) => step.uses?.startsWith("actions/download-artifact@"));
	assert.deepEqual(downloads.map((step) => step.with.name), [
		"github-release-target-${{ github.sha }}-${{ matrix.target }}",
		"owner-pty-${{ github.sha }}-${{ matrix.target }}",
	]);
	assert.ok(downloads.every((step) => step.with.pattern === undefined));
	assert.equal(downloads[0].with.path, "${{ runner.temp }}/prebuilt");
	assert.equal(downloads[1].if, "runner.os != 'Windows'");
	const prepare = steps.find((step) => step.run?.includes("prepare-github-release.mjs"));
	assert.ok(prepare, "reuse existing per-target preparation");
	assert.match(prepare.run, /node scripts\/prepare-github-release\.mjs --prebuilt "\$RUNNER_TEMP\/prebuilt" --platform '\$\{\{ matrix\.target \}\}' --out "\$RUNNER_TEMP\/pi-github-release"/);
	assert.ok(steps.indexOf(prepare) > steps.indexOf(downloads[0]));
	assert.ok(steps.indexOf(prepare) < steps.findIndex((step) => step.name === "Execute final native archive"));
	const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
	assert.deepEqual(uploads.map((step) => step.with.name), [
		"embedded-package-manager-${{ github.sha }}",
		"github-release-smoke-${{ github.sha }}-${{ matrix.target }}",
		"smoke-diagnostics-${{ github.sha }}-${{ matrix.target }}",
	]);
	assert.equal(uploads.at(-1).if, "always()");
	assert.equal(uploads.at(-1).with["if-no-files-found"], "ignore");
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function runScript(script, args, env = process.env) {
	return spawnSync(process.execPath, [join(ROOT, "scripts", script), ...args], { cwd: ROOT, env, encoding: "utf8" });
}

function releaseFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-runtime-topology-"));
	const records = join(root, "records");
	mkdirSync(records);
	const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
	assert.equal(git.status, 0, git.stderr);
	const commit = git.stdout.trim();
	const env = { ...process.env, GITHUB_SHA: commit, GITHUB_RUN_NUMBER: "123", GITHUB_RUN_ATTEMPT: "2" };
	const apiVersion = JSON.parse(readFileSync(join(ROOT, "packages/coding-agent/package.json"), "utf8")).version;
	const version = forkDistributionVersion(apiVersion, env);
	const bundles = {};
	for (const target of BUN_TARGETS) {
		const body = Buffer.from(`fixture executable:${target.id}`);
		const archive = createReleaseArchive(target.executable, body);
		const file = releaseArchiveName(target.id);
		writeFileSync(join(root, file), archive);
		const asset = { file: binaryArchiveName(target.id), sha256: sha256(body), bytes: body.length };
		bundles[target.id] = { file, bytes: archive.length, sha256: sha256(archive), executable: asset };
		const record = {
			schemaVersion: 1, target: target.id, version, asset,
			runner: { os: target.runnerOs, arch: target.runnerArch, osArchitecture: target.arch, cpuFeatures: target.requiredCpuFeatures.join(" ") },
			executor: { kind: target.executor, emulated: target.emulated, containerDigest: target.containerImage ?? null, libraries: target.libc === "musl" ? muslSmokeLibraries(target.arch) : null },
			ownerLifecycle: {
				status: "passed", target: target.id, cliSha256: asset.sha256, artifactBunVersion: "1.3.14",
				identity: { name: "host\\pi-owner-smoke", elevated: false, ...(target.os === "windows" ? { mediumIntegrity: true } : passedUnixIdentity()) },
				...(target.os === "windows" ? { windowsRuntimeGate: passedWindowsOwnerGate(target.id, asset.sha256) } : {}),
				rows: ownerLifecycleRows(target.os).map((name) => isUnixOwnerPtyRow(name) ? passedUnixOwnerPtyRow(name, target.os, target.id, asset.sha256) : ({ name, pi: { bun: "1.3.14" }, status: name === "darwin-fast-escape" ? "known-limitation" : "passed", limitation: name === "darwin-fast-escape" ? "unseen setsid escape" : undefined, aliveBefore: true, aliveAfter: false, peerAlive: true, immediateChecks: 1, piStopped: true, stopped: true, resumed: true, peerRunning: true, ownershipDisabled: true })),
			},
			commands: target.requiredCommands.map((name) => ({ name, status: 0, elapsedMs: 1 })),
			timingsMs: { coldVersion: 1, version: 1, help: 1, listModels: 1 },
			tui: { harness: target.os === "windows" ? "Bun.Terminal ConPTY" : "Bun.Terminal PTY", elapsedMs: 1, outputBytes: 1, input: target.os === "windows" ? "startup-benchmark" : "ctrl-c,ctrl-d", childExitCode: 0, terminalClosed: true, terminalExitCode: 0, observedOutput: true, benchmarkCompleted: target.os === "windows" ? true : null, exitSent: target.os !== "windows", cleanExit: true },
			clipboard: { helper: `${target.nativeHelperDir}/${target.nativeHelperFile}`, sha256: "c".repeat(64), loadedAndCalled: true, textRead: true, imageRead: true, elapsedMs: 1 },
			limits: smokeLimits(target.id),
		};
		writeFileSync(join(records, `${target.id}.json`), JSON.stringify(record));
	}
	const manifest = {
		schemaVersion: 7, repository: "xz-dev/pi", tag: `xz-v${version}`, distributionVersion: version, apiVersion, commit, packaging: "binary", bundles,
		acceptance: { file: "binary-acceptance.json", targetCount: 14 },
		attestation: { repository: "xz-dev/pi", signerWorkflow: "xz-dev/pi/.github/workflows/publish-github-release.yml", signerRef: "refs/heads/main", denySelfHostedRunners: true, subjectsFile: "attestation-subjects.jsonl" },
	};
	const manifestPath = join(root, "release-manifest.json");
	writeFileSync(manifestPath, JSON.stringify(manifest));
	writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "# Third-Party Notices\nLicense SHA-256: fixture\n");
	const assets = [...Object.values(bundles).map(({ file }) => file), "release-manifest.json", "THIRD_PARTY_NOTICES.md"];
	const refreshSums = () => writeFileSync(join(root, "SHA256SUMS"), assets.map((file) => `${sha256(readFileSync(join(root, file)))}  ${file}\n`).join(""));
	refreshSums();
	writeFileSync(join(root, "attestation-subjects.jsonl"), [...assets, "SHA256SUMS"].join("\n") + "\n");
	return { root, records, manifest, manifestPath, env, assets, refreshSums };
}

test("private per-target preparation preserves full-manifest executable, version and source identity", () => {
	const value = releaseFixture();
	try {
		// A musl fixture is never probed as a host executable by preparation.
		const target = "linux-x64-musl-baseline";
		const prebuilt = join(value.root, "prebuilt");
		mkdirSync(prebuilt);
		const file = binaryArchiveName(target);
		writeFileSync(join(prebuilt, file), `fixture executable:${target}`);
		chmodSync(join(prebuilt, file), 0o755);
		for (const output of ["private-one", "private-two"]) {
			const result = runScript("prepare-github-release.mjs", ["--prebuilt", prebuilt, "--platform", target, "--out", join(value.root, output)], value.env);
			assert.equal(result.status, 0, result.stderr);
			const staged = JSON.parse(readFileSync(join(value.root, output, "release-manifest.json"), "utf8"));
			assert.deepEqual(Object.keys(staged.bundles), [target]);
			assert.deepEqual(staged.bundles[target], value.manifest.bundles[target]);
			assert.equal(staged.distributionVersion, value.manifest.distributionVersion);
			assert.equal(staged.commit, value.manifest.commit);
			assert.equal(sha256(readFileSync(join(value.root, output, file))), staged.bundles[target].executable.sha256);
			const boundary = runScript("verify-github-release.mjs", ["all", join(value.root, output, "release-manifest.json")]);
			assert.notEqual(boundary.status, 0);
			assert.match(boundary.stderr, /must cover exactly the 14 canonical Bun targets/);
		}
	} finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("full14 validators accept hash-bound records without executing synthetic binaries", () => {
	const value = releaseFixture();
	try {
		const result = runScript("aggregate-binary-acceptance.mjs", [value.records, value.manifestPath, join(value.root, "binary-acceptance.json")]);
		assert.equal(result.status, 0, result.stderr);
		const acceptance = JSON.parse(readFileSync(join(value.root, "binary-acceptance.json"), "utf8"));
		assert.equal(acceptance.targetCount, 14);
		assert.equal(acceptance.manifest.sha256, sha256(readFileSync(value.manifestPath)));
		assert.equal(acceptance.manifest.commit, value.manifest.commit);
		// Only ZIPs exist: verifier validates bytes and records, never launches a fixture.
		const verified = runScript("verify-github-release.mjs", ["all", value.manifestPath]);
		assert.equal(verified.status, 0, verified.stderr);
	} finally { rmSync(value.root, { recursive: true, force: true }); }
});

for (const [label, mutate, error] of [
	["missing target", (value, path) => rmSync(path), /expected exactly 14 smoke records, found 13/],
	["failed target", (value, path) => { const record = JSON.parse(readFileSync(path, "utf8")); record.commands[0].status = 1; writeFileSync(path, JSON.stringify(record)); }, /invalid command evidence/],
	["executable sha mismatch", (value, path) => { const record = JSON.parse(readFileSync(path, "utf8")); record.asset.sha256 = "f".repeat(64); writeFileSync(path, JSON.stringify(record)); }, /asset identity mismatch/],
]) test(`full14 aggregation rejects ${label}`, () => {
	const value = releaseFixture();
	try {
		mutate(value, join(value.records, `${BUN_TARGET_IDS[0]}.json`));
		const result = runScript("aggregate-binary-acceptance.mjs", [value.records, value.manifestPath, join(value.root, "binary-acceptance.json")]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, error);
	} finally { rmSync(value.root, { recursive: true, force: true }); }
});

for (const field of ["manifest version", "source"]) test(`release-wide verifier rejects mismatched ${field}`, () => {
	const value = releaseFixture();
	try {
		const output = join(value.root, "binary-acceptance.json");
		assert.equal(runScript("aggregate-binary-acceptance.mjs", [value.records, value.manifestPath, output]).status, 0);
		if (field === "manifest version") {
			value.manifest.distributionVersion = value.manifest.distributionVersion.replace(/\.g[0-9a-f]{8}$/, ".gffffffff");
			value.manifest.tag = `xz-v${value.manifest.distributionVersion}`;
			writeFileSync(value.manifestPath, JSON.stringify(value.manifest));
		} else {
			const acceptance = JSON.parse(readFileSync(output, "utf8"));
			acceptance.manifest.commit = "f".repeat(40);
			writeFileSync(output, JSON.stringify(acceptance));
		}
		value.assets.push("binary-acceptance.json");
		value.refreshSums();
		const result = runScript("verify-github-release.mjs", ["all", value.manifestPath]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, field === "manifest version" ? /Invalid GitHub Release manifest/ : /Invalid binary acceptance record/);
	} finally { rmSync(value.root, { recursive: true, force: true }); }
});

for (const boundary of ["aggregate", "release verifier"]) for (const targetIndex of [0, BUN_TARGET_IDS.length - 1]) for (const invalid of ["wrong run", "missing", "null", "number", "object"]) {
	const target = BUN_TARGET_IDS[targetIndex];
	test(`${boundary} rejects ${invalid} record.version for ${target}`, (context) => {
		const value = releaseFixture();
		try {
			const output = join(value.root, "binary-acceptance.json");
			const args = [value.records, value.manifestPath, output];
			const aggregated = runScript("aggregate-binary-acceptance.mjs", args);
			assert.equal(aggregated.status, 0, aggregated.stderr);
			const verified = runScript("verify-github-release.mjs", ["all", value.manifestPath]);
			assert.equal(verified.status, 0, verified.stderr);
			const manifestBefore = readFileSync(value.manifestPath);
			const acceptance = JSON.parse(readFileSync(output, "utf8"));
			const recordPath = join(value.records, `${target}.json`);
			const record = boundary === "aggregate" ? JSON.parse(readFileSync(recordPath, "utf8")) : acceptance.targets[targetIndex];
			const before = structuredClone(record);
			const wrongVersion = forkDistributionVersion(value.manifest.apiVersion, { ...value.env, GITHUB_RUN_NUMBER: "124" });
			if (invalid === "missing") delete record.version;
			else record.version = invalid === "wrong run" ? wrongVersion : invalid === "null" ? null : invalid === "number" ? 123 : { value: before.version };
			assert.deepEqual({ ...record, version: before.version }, before, "only record.version changes");
			if (boundary === "aggregate") writeFileSync(recordPath, JSON.stringify(record));
			else {
				writeFileSync(output, JSON.stringify(acceptance));
				const sumsPath = join(value.root, "SHA256SUMS");
				const sums = readFileSync(sumsPath, "utf8");
				assert.match(sums, /^[0-9a-f]{64}  binary-acceptance\.json$/m);
				writeFileSync(sumsPath, sums.replace(/^[0-9a-f]{64}  binary-acceptance\.json$/m, `${sha256(readFileSync(output))}  binary-acceptance.json`));
			}
			assert.ok(readFileSync(value.manifestPath).equals(manifestBefore), "manifest/source/version unchanged");
			const result = boundary === "aggregate" ? runScript("aggregate-binary-acceptance.mjs", args) : runScript("verify-github-release.mjs", ["all", value.manifestPath]);
			const error = `${target} version identity mismatch`;
			context.diagnostic(JSON.stringify({ boundary, target, invalid, expectedVersion: value.manifest.distributionVersion, actualVersion: record.version, status: result.status, error: result.stderr.split("\n").find((line) => line.startsWith("Error:")) ?? null }));
			assert.notEqual(result.status, 0, `${boundary} accepted ${invalid} record.version`);
			assert.ok(result.stderr.includes(`Error: ${error}\n`), result.stderr);
		} finally { rmSync(value.root, { recursive: true, force: true }); }
	});
}
