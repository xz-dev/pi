import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const WORKFLOWS = join(import.meta.dirname, "..", ".github", "workflows");
const nixText = readFileSync(join(WORKFLOWS, "nix.yml"), "utf8");
const nix = parse(nixText);
const releaseText = readFileSync(join(WORKFLOWS, "publish-github-release.yml"), "utf8");
const release = parse(releaseText);
const syncText = readFileSync(join(WORKFLOWS, "upstream-sync.yml"), "utf8");
const sync = parse(syncText);

const step = (job, name) => {
	const found = nix.jobs[job].steps.find((entry) => entry.name === name);
	assert.ok(found, `${job} must have step ${name}`);
	return found;
};
const releaseVersionFormula = (text) =>
	/version \+ "-xz\." \+ process\.env\.(\w+) \+ "\.1\.g" \+ process\.env\.(\w+)\.slice\(0, 8\)/.exec(text);

test("Nix workflow runs for ci/main pull requests, dispatch and completed main Releases only", () => {
	assert.deepEqual(Object.keys(nix.on).sort(), ["pull_request", "workflow_dispatch", "workflow_run"]);
	assert.deepEqual(nix.on.pull_request.branches, ["ci", "main"]);
	for (const path of [
		".github/workflows/nix.yml",
		".github/workflows/publish-github-release.yml",
		"flake.lock",
		"flake.nix",
		"nix/**",
		"scripts/lib/github-release.mjs",
		"scripts/nix-workflow.test.mjs",
		"scripts/publish-nix-flake.sh",
		"scripts/publish-nix-flake.test.mjs",
		"scripts/update-nix-package.mjs",
		"scripts/update-nix-package.test.mjs",
	]) {
		assert.ok(nix.on.pull_request.paths.includes(path), `pull requests touching ${path} must run Nix checks`);
	}
	// The trigger names the Release workflow; renaming it must fail here, not silently stop publication.
	assert.deepEqual(nix.on.workflow_run, { workflows: [release.name], types: ["completed"], branches: ["main"] });
	assert.equal(release.name, "Publish GitHub Release");
	// Release publication drives updates: no schedule, no push trigger, no stable or main mutation.
	assert.doesNotMatch(nixText, /schedule:|cron|git push|refs\/heads\/stable|update-stable|model-catalog|commit-pin/);
});

test("only the publish job can write, and only for a trusted main Release run", () => {
	assert.deepEqual(nix.permissions, {});
	assert.deepEqual(Object.keys(nix.jobs), ["scripts", "flake", "build", "publish"]);
	for (const [name, job] of Object.entries(nix.jobs)) {
		assert.deepEqual(job.permissions, { contents: name === "publish" ? "write" : "read" }, name);
		for (const entry of job.steps) {
			assert.equal(entry["continue-on-error"], undefined, `${name}/${entry.name} must fail visibly`);
			if (!entry.uses) continue;
			assert.match(entry.uses, /@[0-9a-f]{40}$/, `action must be SHA-pinned: ${entry.uses}`);
			if (entry.uses.startsWith("actions/checkout@")) assert.equal(entry.with["persist-credentials"], false);
		}
	}
	assert.equal(nix.jobs.scripts.if, "github.event_name != 'workflow_run'");
	const trusted = nix.jobs.flake.if;
	for (const condition of [
		"github.event_name != 'workflow_run' || (",
		"github.event.workflow_run.conclusion == 'success'",
		"github.event.workflow_run.head_branch == 'main'",
		"github.event.workflow_run.head_repository.full_name == 'xz-dev/pi'",
		"(github.event.workflow_run.event == 'push' || github.event.workflow_run.event == 'workflow_dispatch')",
	]) {
		assert.ok(trusted.includes(condition), `flake gate must require ${condition}`);
	}
	const publish = nix.jobs.publish;
	assert.equal(publish.if, "github.event_name == 'workflow_run'");
	assert.deepEqual(publish.needs, ["flake", "build"]);
	assert.equal(step("publish", "Checkout the released commit").with.ref, "${{ github.event.workflow_run.head_sha }}");
	for (const [name, job] of Object.entries(nix.jobs)) {
		for (const entry of job.steps) {
			if (JSON.stringify(entry).includes("secrets.")) {
				assert.equal(`${name}/${entry.name}`, "publish/Publish the nix branch", "only branch publication sees a token");
			}
		}
	}
	const publication = step("publish", "Publish the nix branch");
	assert.deepEqual(publication.env, { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" });
	assert.equal(
		publication.run,
		'bash scripts/publish-nix-flake.sh "$RUNNER_TEMP/nix-flake/release/release-manifest.json" "$RUNNER_TEMP/nix-flake/flake"',
	);
});

test("a Release pin comes from the exact authenticated tag of the triggering run", () => {
	assert.equal(step("flake", "Checkout").with.ref, "${{ github.event.workflow_run.head_sha }}");
	const assemble = step("flake", "Assemble the distributed three-file flake").run;
	assert.match(assemble, /cp flake\.nix flake\.lock "\$RUNNER_TEMP\/nix-flake\/flake\/"/);
	assert.match(assemble, /cp nix\/package\.nix "\$RUNNER_TEMP\/nix-flake\/flake\/nix\/"/);
	const pin = step("flake", "Pin the exact authenticated Release");
	assert.equal(pin.if, "github.event_name == 'workflow_run'");
	assert.deepEqual(pin.env, {
		RELEASE_RUN_NUMBER: "${{ github.event.workflow_run.run_number }}",
		RELEASE_SHA: "${{ github.event.workflow_run.head_sha }}",
	});
	assert.match(pin.run, /test "\$\(git rev-parse HEAD\)" = "\$RELEASE_SHA"/);
	// Same formula as the Release build, so the URL names that run's immutable tag.
	const build = release.jobs["build-target"].steps.find((entry) => entry.name === "Build one canonical production target");
	assert.deepEqual(releaseVersionFormula(build.run).slice(1), ["GITHUB_RUN_NUMBER", "GITHUB_SHA"]);
	assert.deepEqual(releaseVersionFormula(pin.run).slice(1), ["RELEASE_RUN_NUMBER", "RELEASE_SHA"]);
	assert.match(pin.run, /https:\/\/github\.com\/xz-dev\/pi\/releases\/download\/xz-v\$version\/\$asset/);
	assert.match(pin.run, /for asset in release-manifest\.json attestation-subjects\.jsonl; do/);
	assert.doesNotMatch(pin.run, /releases\/latest|GITHUB_TOKEN|GH_TOKEN|Authorization/);
	assert.match(pin.run, /\.commit' "\$release\/release-manifest\.json"\)" = "\$RELEASE_SHA"/);
	assert.match(
		pin.run,
		/node scripts\/update-nix-package\.mjs "\$release\/release-manifest\.json" "\$RUNNER_TEMP\/nix-flake\/flake\/nix\/package\.nix"/,
	);
	const upload = step("flake", "Upload the flake");
	assert.equal(upload.with.name, "nix-flake");
	assert.equal(upload.with.path, "${{ runner.temp }}/nix-flake");
	for (const job of ["build", "publish"]) {
		const download = nix.jobs[job].steps.find((entry) => entry.uses?.startsWith("actions/download-artifact@"));
		assert.deepEqual(download.with, { name: "nix-flake", path: "${{ runner.temp }}/nix-flake" }, job);
	}
});

test("every native runner builds and smokes the flake before publication", () => {
	const build = nix.jobs.build;
	assert.equal(build.needs, "flake");
	assert.equal(build.if, undefined, "a skipped or failed flake job must skip every build");
	assert.equal(build.strategy["fail-fast"], false);
	assert.deepEqual(
		build.strategy.matrix.include.map(({ runner, system }) => [runner, system]),
		[
			["ubuntu-latest", "x86_64-linux"],
			["ubuntu-24.04-arm", "aarch64-linux"],
			["macos-latest", "aarch64-darwin"],
			["macos-15-intel", "x86_64-darwin"],
		],
	);
	assert.deepEqual(
		build.steps.map((entry) => entry.name),
		[
			"Download the flake",
			"Enable FHS namespaces on the ephemeral Linux runner",
			"Install Nix",
			"Select the native flake",
			"Evaluate all systems",
			"Build",
			"Smoke-test the CLI and the Nix-managed self-update refusal",
		],
	);
	const namespaces = step("build", "Enable FHS namespaces on the ephemeral Linux runner");
	assert.equal(namespaces.if, "runner.os == 'Linux'");
	assert.match(namespaces.run, /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/);
	const select = step("build", "Select the native flake").run;
	assert.match(select, /nix eval --impure --raw --expr builtins\.currentSystem\)" = '\$\{\{ matrix\.system \}\}'/);
	assert.match(select, /FLAKE=path:\$RUNNER_TEMP\/nix-flake\/flake/);
	const evaluate = step("build", "Evaluate all systems");
	assert.equal(evaluate.if, "${{ matrix.system == 'x86_64-linux' }}");
	assert.equal(evaluate.run, 'nix flake check --all-systems --no-build --no-update-lock-file "$FLAKE"');
	assert.equal(step("build", "Build").if, undefined);
	assert.equal(step("build", "Build").run, 'nix build -L --no-update-lock-file "$FLAKE"');
	const smoke = step("build", "Smoke-test the CLI and the Nix-managed self-update refusal");
	assert.equal(smoke.if, undefined, "runtime smoke is mandatory on every runner");
	assert.match(smoke.run, /set -euo pipefail/);
	assert.match(smoke.run, /export HOME="\$home" PI_OFFLINE=1 PI_CODING_AGENT_DIR="\$home\/agent"/);
	assert.match(smoke.run, /test "\$\("\$pi" --version\)" = "\$version"/);
	assert.match(smoke.run, /"\$pi" --help > \/dev\/null/);
	assert.match(smoke.run, /"\$pi" update --self "\$@"/);
	assert.match(smoke.run, /grep -F 'is managed by nix; self-update is disabled'/);
	assert.match(smoke.run, /\n\s*refuses\n\s*refuses --force\n/);
});

// Nix run 41019342707: Darwin builders keep HOME=/homeless-shelter on a read-only root, and pi
// writes startup state under HOME. This checks the phase's shell contract, not a native macOS build.
test("the shared install check runs the CLI with a fresh private HOME", (t) => {
	const recipe = readFileSync(join(import.meta.dirname, "..", "nix", "package.nix"), "utf8");
	const phase = /installCheckPhase = ''\n([\s\S]*?)\n\s*'';/.exec(recipe)?.[1];
	assert.ok(phase, "package.nix must define installCheckPhase");
	const version = "1.2.3-xz.4.1.gabcdef12";
	const body = phase.replaceAll("${version}", version);
	assert.doesNotMatch(body, /\$\{|''/, "the phase may only take ${version} from Nix");
	const root = mkdtempSync(join(tmpdir(), "pi-nix-install-check-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// A HOME below a regular file can never be created, not even by root.
	writeFileSync(join(root, "read-only-root"), "");
	const out = join(root, "out");
	const tmp = join(root, "tmp");
	const hooks = join(root, "hooks.log");
	mkdirSync(join(out, "bin"), { recursive: true });
	mkdirSync(tmp);
	// Like the release binary, the fixture writes startup state under HOME before it handles any flag.
	writeFileSync(
		join(out, "bin", "pi"),
		`#!/usr/bin/env bash\nset -eu\nmkdir -p "$HOME/.pi/agent"\nprintf '%s\\n' "$1" >> "$HOME/.pi/agent/startup.log"\nif [[ $1 == --version ]]; then echo ${version}; fi\n`,
		{ mode: 0o755 },
	);
	const runPhase = (stubs, hooksLog, outPath) =>
		spawnSync("bash", ["-eu", "-c", `${stubs}\n${body}`], {
			env: {
				PATH: process.env.PATH,
				HOME: join(root, "read-only-root", "homeless-shelter"),
				TMPDIR: tmp,
				HOOKS: hooksLog,
				out: outPath,
			},
			// Builders run with stdin on /dev/null; a socket on stdin makes bash source ~/.bashrc.
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
		});
	const result = runPhase(`runHook() { printf '%s %s\\n' "$1" "$HOME" >> "$HOOKS"; }`, hooks, out);
	assert.equal(result.status, 0, result.stderr);
	const hookLines = readFileSync(hooks, "utf8").split("\n");
	const home = hookLines[0].replace(/^preInstallCheck /, "");
	assert.deepEqual(hookLines, [`preInstallCheck ${home}`, `postInstallCheck ${home}`, ""]);
	assert.equal(dirname(home), tmp, "HOME must be a new directory from mktemp");
	assert.equal(statSync(home).mode & 0o777, 0o700);
	assert.equal(readFileSync(join(home, ".pi", "agent", "startup.log"), "utf8"), "--version\n--help\n");
	// `export HOME="$(mktemp -d)"` hides a mktemp failure and runs the hooks with an empty HOME.
	const failedHooks = join(root, "failed-hooks.log");
	const failed = runPhase(
		`mktemp() { return 73; }\nrunHook() { echo "$1" >> "$HOOKS"; return 74; }`,
		failedHooks,
		join(root, "unreached"),
	);
	assert.equal(failed.status, 73, failed.stderr);
	assert.ok(!existsSync(failedHooks), "a failed mktemp must stop the phase before any hook or CLI call");
});

test("Nix pins never mutate generated main during upstream sync, and Releases do not publish Nix directly", () => {
	assert.doesNotMatch(syncText, /update-nix-package|publish-nix-flake|nix\/package\.nix/);
	assert.ok(!sync.jobs["sync-main-with-squash-branches"].steps.some((entry) => /nix/i.test(entry.name ?? "")));
	assert.doesNotMatch(releaseText, /update-nix-package|publish-nix-flake|refs\/heads\/nix/);
});
