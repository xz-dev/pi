import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW_PATH = join(
  ROOT,
  ".github",
  "workflows",
  "publish-github-release.yml",
);
const workflowText = readFileSync(WORKFLOW_PATH, "utf8");
const workflow = parse(workflowText);
const syncWorkflowText = readFileSync(join(ROOT, ".github", "workflows", "upstream-sync.yml"), "utf8");
const syncWorkflow = parse(syncWorkflowText);
const escWorkflow = parse(
  readFileSync(join(ROOT, ".github", "workflows", "esc-abort-integration.yml"), "utf8"),
);

const syncScript = readFileSync(join(ROOT, "scripts", "rebuild-from-inputs.sh"), "utf8");

function orderBlock(script) {
	return script.slice(script.indexOf("PATCH_ORDER=("), script.indexOf(")\n", script.indexOf("PATCH_ORDER=(")));
}

function assertPatchIntegrated(script, name) {
	assert.ok(
		orderBlock(script).includes(`\n\t${name}\n`),
		`PATCH_ORDER must list ${name}`,
	);
	// Integration happens through the generic loop: squash merge for
	// independent patches, predecessor-relative range apply for chain
	// descendants. There are no per-patch merge call sites anymore.
	assert.match(script, /merge_squash "\$p" "merge patch\/\$p branch"/);
	assert.match(script, /apply_range "\$p" "merge patch\/\$p branch" "\$local_pred"/);
}

function assertChainEdge(script, predecessor, descendant) {
	assert.ok(
		script.includes(`\t${predecessor}:${descendant}\n`),
		`CHAIN_EDGES must list ${predecessor}:${descendant}`,
	);
}

function pinnedUses() {
  return Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : [])),
  );
}

test("upstream sync fetches and merges the persistent native wrapper patch", () => {
	assert.match(
		syncWorkflowText,
		/\+refs\/heads\/patch\/native-wrapper-release:refs\/remotes\/origin\/patch\/native-wrapper-release/,
	);
	// The merge itself is owned by the replay script; here we prove the
	// workflow feeds the patch's frozen SHA into it.
	assert.match(syncWorkflowText, /native-wrapper-release \\\n/);
	assert.match(syncWorkflowText, /rebuild_args\+=\(--patch "\$ref=\$\(git rev-parse \"origin\/patch\/\$ref\"\)"\)/);
	assertPatchIntegrated(syncScript, "native-wrapper-release");
	assert.doesNotMatch(syncScript, /resolve-release-self-update-squash-conflicts/);
});

test("upstream sync keeps the unsafe synchronized-cursor patch retired", () => {
  assert.doesNotMatch(syncWorkflowText, /patch\/tui-synchronized-cursor-fleet/);
  assert.match(readFileSync(join(ROOT, "README.md"), "utf8"), /`patch\/tui-synchronized-cursor-fleet` is temporarily retired/);
  assert.match(readFileSync(join(ROOT, "MAINTAIN.md"), "utf8"), /can emit excessive terminal data/);
  assert.match(readFileSync(join(ROOT, "MAINTAIN.md"), "utf8"), /do not fetch, merge, or add a CI conflict resolver/);
});

test("upstream sync rejects patch branches that touch upstream changelogs", () => {
  // The changelog guard moved into scripts/rebuild-from-inputs.sh; the workflow
  // must run that script (which fails before merging anything when a patch
  // branch touches packages/*/CHANGELOG.md).
  assert.match(syncWorkflowText, /scripts\/rebuild-from-inputs\.sh "\$\{rebuild_args\[@\]\}"/);
  const script = readFileSync(join(ROOT, "scripts", "rebuild-from-inputs.sh"), "utf8");
  assert.match(script, /git diff --name-only "\$base\.\.\$ref" -- 'packages\/\*\/CHANGELOG\.md'/);
  assert.match(script, /modifies an upstream-maintained packages\/\*\/CHANGELOG\.md/);
  assert.ok(
    script.indexOf("offenders") < script.indexOf("merge_squash ci"),
    "changelog guard must run before any squash merge",
  );
  assert.match(readFileSync(join(ROOT, "MAINTAIN.md"), "utf8"), /never carry `packages\/\*\/CHANGELOG\.md` hunks/);
});

test("upstream sync integrates and tests managed tool execution compatibility", () => {
  const script = syncScript;
  const names = ["agent-run-failure-seam", "managed-tool-executions", "esc-abort", "manual-retry"];
  for (const [index, name] of names.entries()) {
    if (index) assert.ok(orderBlock(script).indexOf(names[index - 1]) < orderBlock(script).indexOf(name));
    assertPatchIntegrated(script, name);
  }
  // The chain is integrated as predecessor-relative range diffs; each
  // descendant keeps the predecessor patch tip in its ancestry.
  assertChainEdge(script, "agent-run-failure-seam", "managed-tool-executions");
  assertChainEdge(script, "managed-tool-executions", "esc-abort");
  assertChainEdge(script, "esc-abort", "manual-retry");
  assert.match(script, /require_ancestor "\$pred" "\$name"/);
  assert.doesNotMatch(script, /resolve-(?:agent-run-failure-seam|managed-tool|esc-abort|manual-retry)/);
  assert.match(syncWorkflowText, /test\/managed-tool-executions\.test\.ts/);
  assert.match(syncWorkflowText, /test\/managed-tool-executions-esc-abort\.test\.ts/);
  assert.match(readFileSync(join(ROOT, "README.md"), "utf8"), /patch\/managed-tool-executions/);
  assert.match(readFileSync(join(ROOT, "MAINTAIN.md"), "utf8"), /tool cancellation signal from the current-run interrupt signal/);
});

test("upstream sync requires formatter-stable rebuilt sources", () => {
  assert.match(syncWorkflowText, /status="\$\(git status --porcelain=v1 --untracked-files=all\)"/);
  assert.match(syncWorkflowText, /::error::Check mutated rebuilt main/);
  assert.match(syncWorkflowText, /git diff --name-status/);
});

test("upstream sync check tolerates only the known model-catalog drift class", () => {
  // AGENTS.md "Known Pre-existing Failures": model-ID/catalog TS2345/TS7053
  // errors in packages/*/test are always-ignore noise; anything else fails.
  assert.match(syncWorkflowText, /check-ts-errors\.log/);
  assert.match(syncWorkflowText, /error TS\(2345\|7053\)/);
  assert.match(syncWorkflowText, /packages\/\(ai\|agent\|coding-agent\)\/\(test\|examples\)/);
  assert.match(syncWorkflowText, /failed outside tsc/);
  assert.match(syncWorkflowText, /outside the known model-catalog drift class/);
});

for (const scenario of ["unchanged", "formatted", "check fails"]) {
  test(`post-merge skip marker: ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-marker-"));
    const repo = join(dir, "repo");
    const bin = join(dir, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, RUNNER_TEMP: dir };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) delete env[key];
    const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: "pipe" }).trim();
    try {
      git("init", "-q");
      git("config", "user.name", "fixture");
      git("config", "user.email", "fixture@invalid");
      git("config", "commit.gpgsign", "false");
      writeFileSync(join(repo, "source.txt"), "original\n");
      git("add", "source.txt");
      git("commit", "-qm", "base");
      const marker = execFileSync("bash", [join(ROOT, "scripts/rebuild-from-inputs.sh"), "--print-marker"], { encoding: "utf8" }).trim();
      const markerFile = join(dir, "rebuilt-inputs-marker.txt");
      writeFileSync(markerFile, `${marker}\n`);
      git("commit", "-q", "--allow-empty", "-F", markerFile);
      const before = git("rev-parse", "HEAD");
      writeFileSync(join(bin, "npx"), scenario === "unchanged" ? "#!/bin/sh\nexit 0\n" : "#!/bin/sh\nprintf 'normalized\\n' > source.txt\n", { mode: 0o755 });
      writeFileSync(join(bin, "npm"), `#!/bin/sh\nexit ${scenario === "check fails" ? 1 : 0}\n`, { mode: 0o755 });
      const run = syncWorkflow.jobs["sync-main-with-squash-branches"].steps.find((step) => step.name === "Check rebuilt main").run;
      const check = () => execFileSync("bash", ["-eo", "pipefail", "-c", run], { cwd: repo, env, stdio: "pipe" });
      if (scenario === "check fails") {
        assert.throws(check);
        assert.equal(git("show", "-s", "--format=%s", "HEAD"), "style: apply post-merge formatting");
      } else {
        check();
        assert.equal(git("show", "-s", "--format=%B", "HEAD"), marker, "the exact workflow skip comparison must still match");
        if (scenario === "unchanged") assert.equal(git("rev-parse", "HEAD"), before);
        else assert.equal(git("show", "-s", "--format=%s", "HEAD^"), "style: apply post-merge formatting");
      }
      assert.equal(git("status", "--porcelain"), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("fixed publication can pin upstream and reject a different fetched vector", () => {
  const step = syncWorkflow.jobs["sync-main-with-squash-branches"].steps.find((step) => step.name === "Rebuild main from upstream and squash branches");
  assert.equal(syncWorkflow.on.workflow_dispatch.inputs.upstream_sha.type, "string");
  assert.equal(syncWorkflow.on.workflow_dispatch.inputs.expected_inputs_sha256.type, "string");
  assert.match(step.run, /--upstream "\$upstream_sha"/);
  assert.ok(step.run.indexOf("Fetched inputs differ from the approved vector") < step.run.indexOf('scratch_target="$RUNNER_TEMP/rebuilt-main"'));
  assert.match(step.run, /git merge-base --is-ancestor "\$PINNED_UPSTREAM_SHA" upstream\/main/);
});

test("upstream sync carries and tests the model catalog list refresh patch", () => {
  assert.match(
    syncWorkflowText,
    /\+refs\/heads\/patch\/model-catalog-extension-refresh:refs\/remotes\/origin\/patch\/model-catalog-extension-refresh/,
  );
  assertPatchIntegrated(syncScript, "model-catalog-extension-refresh");
  assertChainEdge(syncScript, "model-startup-refresh-barrier", "model-catalog-extension-refresh");
  // list-models-refresh and args tests are covered by the coding-agent auto-discovery run.
  assert.match(readFileSync(join(ROOT, "README.md"), "utf8"), /`pi --list-models`/);
  assert.match(readFileSync(join(ROOT, "README.md"), "utf8"), /`pi update --models` extension-free/);
});

test("upstream sync carries the Bun bytecode entrypoint patch", () => {
  assert.match(
    syncWorkflowText,
    /\+refs\/heads\/patch\/bun-bytecode-entrypoint:refs\/remotes\/origin\/patch\/bun-bytecode-entrypoint/,
  );
  assertPatchIntegrated(syncScript, "bun-bytecode-entrypoint");
});

test("upstream sync carries and tests the bounded startup benchmark patch", () => {
  assert.match(syncWorkflowText, /\+refs\/heads\/patch\/startup-benchmark-exit:refs\/remotes\/origin\/patch\/startup-benchmark-exit/);
  assertPatchIntegrated(syncScript, "startup-benchmark-exit");
  assert.doesNotMatch(syncScript, /resolve-startup-benchmark-squash-conflicts/);
  // startup-benchmark and tools-manager tests are covered by the coding-agent auto-discovery run.
});

test("upstream sync retires the obsolete OpenCode completions fixture patch", () => {
  assert.doesNotMatch(syncWorkflowText, /patch\/opencode-completions-test-narrowing/);
});

test("upstream sync requires ci to merge cleanly without source rewriting", () => {
  const script = readFileSync(join(ROOT, "scripts", "rebuild-from-inputs.sh"), "utf8");
  assert.match(script, /git merge --squash "origin\/\$\(label_of "\$name"\)"/);
  assert.match(script, /Unexpected .*squash conflict/);
  // README.md is the one allowed conflict: the fork README is a full rewrite on ci,
  // so the sync takes the ci version when README.md is the only conflicted file.
  assert.match(script, /git checkout --theirs -- README\.md/);
  assert.doesNotMatch(script, /resolve-ci-squash-conflicts/);
});

test("upstream sync globally retires the runner-sensitive compaction characterization", () => {
  assert.match(
    syncWorkflowText,
    /\+refs\/heads\/patch\/compaction-test-exclusion:refs\/remotes\/origin\/patch\/compaction-test-exclusion/,
  );
  assertPatchIntegrated(syncScript, "compaction-test-exclusion");
  assert.doesNotMatch(syncWorkflowText, /--exclude test\/suite\/agent-session-compaction\.test\.ts/);
  assert.match(readFileSync(join(ROOT, "MAINTAIN.md"), "utf8"), /one policy/);
});

test("upstream sync keeps provider-transparent compaction temporarily retired", () => {
  assert.doesNotMatch(syncWorkflowText, /patch\/provider-transparent-compaction/);
  assert.doesNotMatch(syncWorkflowText, /patch\/pre-provider-compaction/);
  assert.doesNotMatch(syncWorkflowText, /Responses compaction/);
  assert.match(readFileSync(join(ROOT, "README.md"), "utf8"), /Temporarily disabled/);
  assert.match(readFileSync(join(ROOT, "MAINTAIN.md"), "utf8"), /temporarily retired/);
});

test("upstream sync carries the unified TUI-only slow-hook patch", () => {
  assert.match(
    syncWorkflowText,
    /\+refs\/heads\/patch\/slow-hook-tui-only:refs\/remotes\/origin\/patch\/slow-hook-tui-only/,
  );
  assertPatchIntegrated(syncScript, "slow-hook-tui-only");
  assertChainEdge(syncScript, "retry-non-retryable-patterns", "slow-hook-tui-only");
  assert.doesNotMatch(syncWorkflowText, /patch\/(?:shutdown-lifecycle-log|slow-hook-execution-kind|shutdown-screen-log)/);
  assert.doesNotMatch(syncWorkflowText, /test\/slow-extension-hook-entry\.test\.ts/);
});

test("upstream sync preserves bounded slow-hook and session-tree compatibility", () => {
  assert.doesNotMatch(syncScript, /resolve-(?:slow-hook|session-tree-splice)-squash-conflicts\.py/);
  assertChainEdge(syncScript, "slow-hook-tui-only", "session-tree-splice");
  assert.ok(
    orderBlock(syncScript).indexOf("slow-hook-tui-only") < orderBlock(syncScript).indexOf("session-tree-splice"),
  );
  assert.doesNotMatch(syncWorkflowText, /patch\/provider-transparent-compaction/);
  assert.doesNotMatch(syncWorkflowText, /patch\/pre-provider-compaction/);
});

test("esc abort integration builds the workspace dependency graph before focused regressions", () => {
  const steps = escWorkflow.jobs["esc-abort-integration"].steps;
  assert.equal(
    steps.find((step) => step.name === "Build workspace packages")?.run,
    "npm run build:offline",
  );
  assert.match(
    steps.find((step) => step.name === "Run esc abort focused regressions")?.run ?? "",
    /test\/suite\/regressions\/6234-esc-abort-stuck-extension-tmux\.test\.ts/,
  );
});

test("Release publication workflow has trusted triggers, exact checkout, and least-privilege jobs", () => {
  assert.ok(workflow.on.push.branches.includes("main"));
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs["release-matrix"].permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs["validate-source"].permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs["build-target"].permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs["aggregate-release-candidate"].permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs["accept-release-candidate"].permissions, {
    contents: "read",
  });
  assert.deepEqual(workflow.jobs["update-release-candidate"].permissions, {
    contents: "read",
  });
  assert.deepEqual(workflow.jobs["publish-release"].permissions, {
    contents: "write",
    "id-token": "write",
    attestations: "write",
  });
  assert.match(workflowText, /github\.repository == 'xz-dev\/pi'/);
  assert.match(workflowText, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflowText, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflowText, /refs\/heads\/main:push\|refs\/heads\/\*:workflow_dispatch/);
  assert.equal(workflow.jobs["publish-release"].if, "github.ref == 'refs/heads/main'");
  assert.match(workflowText, /git rev-parse HEAD[^\n]*GITHUB_SHA/);
  assert.match(workflowText, /git status --porcelain=v1 --untracked-files=all/);
  for (const uses of pinnedUses()) {
    assert.match(uses, /@[0-9a-f]{40}$/, `action must be SHA-pinned: ${uses}`);
  }
  assert.doesNotMatch(workflowText, /npm\.pkg\.github\.com|packages:\s*write/);
  // build-binaries.yml is persistently removed from generated main.
  assert.throws(() => readFileSync(join(ROOT, ".github", "workflows", "build-binaries.yml"), "utf8"), /ENOENT/);
});

test("workflow generates the authoritative matrix and parallel-builds one artifact per target", () => {
  assert.match(workflowText, /bun-targets\.mjs --matrix/);
  assert.match(workflowText, /fromJSON\(needs\.release-matrix\.outputs\.matrix\)/);
  assert.match(workflowText, /--platform '\$\{\{ matrix\.id \}\}'/);
  assert.match(
    workflowText,
    /github-release-target-\$\{\{ github\.sha \}\}-\$\{\{ matrix\.id \}\}/,
  );
  const releaseArtifactReferences = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? [])
      .flatMap((step) => [step.with?.name, step.with?.pattern])
      .filter((value) => typeof value === "string" && value.startsWith("github-release-")),
  );
  assert.ok(releaseArtifactReferences.length > 0);
  // Attempt-less artifact names plus overwrite:true keep "re-run failed jobs"
  // working: reused successful jobs keep their attempt-1 artifacts, while
  // re-run jobs on later attempts must resolve the same names.
  for (const reference of releaseArtifactReferences) {
    assert.doesNotMatch(reference, /github\.run_attempt/);
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      const isUpload = typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact@");
      if (isUpload && typeof step.with?.name === "string" && step.with.name.startsWith("github-release-")) {
        assert.equal(step.with?.overwrite, true, `upload step must overwrite: ${step.with.name}`);
      }
    }
  }
  assert.match(workflowText, /--prebuilt/);
  assert.match(workflowText, /-eq 12/);
  const nativeRunnerStep = workflow.jobs["build-target"].steps.find((step) => step.name === "Assert native build runner");
  assert.equal(nativeRunnerStep?.shell, "bash");
  assert.match(nativeRunnerStep?.run ?? "", /test "\$RUNNER_OS" = '\$\{\{ matrix\.runnerOs \}\}'/);
  assert.match(nativeRunnerStep?.run ?? "", /test "\$RUNNER_ARCH" = '\$\{\{ matrix\.runnerArch \}\}'/);
  const aggregateRun = workflow.jobs["aggregate-release-candidate"].steps.find((step) => step.run)?.run;
  assert.ok(aggregateRun.indexOf("-eq 12") < aggregateRun.indexOf("prepare-github-release.mjs"));
  assert.doesNotMatch(workflowText, /macos-13/);
  assert.match(workflowText, /macos-15-intel|bun-targets\.mjs --matrix/);

  const buildStep = workflow.jobs["build-target"].steps.find(
    (step) => step.name === "Build one canonical production target",
  );
  assert.equal(buildStep.env.NODE_ENV, "production");
  assert.match(
    buildStep.run,
    /args=\(--skip-install --skip-deps --skip-build --platform '\$\{\{ matrix\.id \}\}' --out "\$RUNNER_TEMP\/target" --distribution-version "\$version"\)/,
  );
  assert.match(
    buildStep.run,
    /if \[\[ '\$\{\{ matrix\.id \}\}' == windows-\* \]\]; then args\+\=\(--hydrate-target-deps\); fi/,
  );
  assert.match(
    buildStep.run,
    /if \[\[ '\$\{\{ matrix\.id \}\}' == \*-musl\* \]\]; then args\+\=\(--clipboard-musl-dir "\$RUNNER_TEMP\/clipboard-musl"\); fi/,
  );
  assert.match(buildStep.run, /--skip-deps/);
  assert.match(workflowText, /build-target:[\s\S]*- run: npm ci --ignore-scripts/);
});

test("acceptance matrix is generated from explicit per-target smoke descriptors", () => {
  const updateHarness = readFileSync(join(ROOT, "scripts", "e2e-binary-self-update.mjs"), "utf8");
  assert.match(workflowText, /bun-targets\.mjs --smoke-matrix/);
  assert.match(workflowText, /fromJSON\(needs\.release-matrix\.outputs\.smoke-matrix\)/);
  assert.match(workflowText, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(workflowText, /matrix\.executor == 'native'/);
  assert.match(workflowText, /matrix\.executor == 'pinned-musl-container'/);
  assert.match(workflowText, /smoke-binary-release\.mjs/);
  assert.match(workflowText, /PI_XZ_VERIFY_TARGET/);
  assert.match(workflowText, /verify-github-release\.mjs all/);
  assert.match(workflowText, /smoke-bun-tui\.mjs/);
  assert.match(workflowText, /--network none[^\n]*-e NODE_ENV=production[^\n]*-e PI_OFFLINE=1[^\n]*-e PI_CODING_AGENT_DIR=\/tmp\/isolated-agent/);
  assert.doesNotMatch(workflowText, /smoke-unix-tui\.py/);
  assert.doesNotMatch(workflowText, /AppActivate|SendKeys|Docker allocated TTY|fabricated/);
  assert.match(workflowText, /e2e-binary-self-update\.mjs/);
  // xz-release-update, win32-filesystem-snapshot and package-command-paths tests are
  // covered by the coding-agent auto-discovery run in the sync workflow.
  assert.match(updateHarness, /PI_XZ_LATEST_RELEASE_URL: `\$\{releaseBase\}latest-release\.json`/);
  assert.match(updateHarness, /digest: `sha256:\$\{servedBundle\.sha256\}`/);
  assert.match(updateHarness, /const activatedBundle = join\(install, "bundles", expectedVersion\)/);
  assert.match(updateHarness, /createHash\("sha256"\)\.update\(readFileSync\(wrapper\)\)\.digest\("hex"\) !== wrapperSha256/);
  assert.match(updateHarness, /Identical POSIX root wrapper was replaced/);
  assert.match(updateHarness, /await run\(join\(managedPreviousBundle, target\.wrapper\), \["update", "--self", "--force"\]/);
  assert.match(updateHarness, /Managed previous bundle did not start through its own launcher/);
  assert.doesNotMatch(updateHarness, /published a root launcher|POSIX root wrapper was not atomically replaced/);
  assert.doesNotMatch(updateHarness, /join\(install, "(?:current|previous)"\)/);
  for (const failure of [
    "missing-helper",
    "corrupt-helper",
    "opposite-architecture-helper",
    "malformed-result-helper",
    "api-mismatch-helper",
  ]) assert.match(updateHarness, new RegExp(`"${failure}",`));
  assert.match(workflowText, /PI_WIN32_SNAPSHOT_UNC_ROOT/);
  assert.match(workflowText, /PI_WIN32_SNAPSHOT_OPPOSITE_HELPER/);
  assert.match(workflowText, /PI_WIN32_SNAPSHOT_API_MISMATCH_HELPER/);
  assert.match(workflowText, /PI_WIN32_SNAPSHOT_MALFORMED_RESULT_HELPER/);
  assert.match(workflowText, /malformed-result\.node" 1 1/);
  assert.match(updateHarness, /escaped the isolated helper probe into a destination bundle/);
  assert.match(updateHarness, /update retry retained no quarantined rejected bundle/);
  assert.match(updateHarness, /assets: \[/);
  assert.match(updateHarness, /rmSync\(work, \{ recursive: true, force: true, maxRetries: 60, retryDelay: 500 \}\)/);
  assert.deepEqual(workflow.jobs["publish-release"].needs, "update-release-candidate");
});

test("Linux archive smoke provisions a headless display without bypassing clipboard", () => {
  const smoke = readFileSync(join(ROOT, "scripts", "smoke-binary-release.mjs"), "utf8");
  const syncSteps = syncWorkflow.jobs["sync-main-with-squash-branches"].steps;
  const syncDisplay = syncSteps.find((step) => step.name === "Install Linux smoke display");
  const syncSmoke = syncSteps.find((step) => step.name === "Smoke test host binary packaging path");
  assert.match(syncDisplay?.run ?? "", /apt-get install -y xvfb/);
  assert.match(syncSmoke?.run ?? "", /Xvfb :99[^\n]*-nolisten tcp -ac/);
  assert.match(syncSmoke?.run ?? "", /test -S \/tmp\/\.X11-unix\/X99/);
  assert.match(syncSmoke?.run ?? "", /DISPLAY=:99 node scripts\/smoke-binary-release\.mjs/);

  const acceptSteps = workflow.jobs["accept-release-candidate"].steps;
  const displayInstall = acceptSteps.find((step) => step.name === "Install Linux smoke display");
  const nativeSmoke = acceptSteps.find((step) => step.name === "Execute final native archive");
  const muslSmoke = acceptSteps.find((step) => step.name === "Execute final archive in immutable native musl userspace");
  assert.equal(displayInstall?.if, "runner.os == 'Linux'");
  assert.match(displayInstall?.run ?? "", /apt-get install -y xvfb/);
  assert.match(nativeSmoke?.run ?? "", /if \[\[ "\$RUNNER_OS" == Linux \]\]/);
  assert.match(nativeSmoke?.run ?? "", /Xvfb :99[^\n]*-nolisten tcp -ac/);
  assert.match(nativeSmoke?.run ?? "", /export DISPLAY=:99/);
  assert.match(muslSmoke?.run ?? "", /Xvfb :99[^\n]*-nolisten tcp -ac/);
  assert.match(muslSmoke?.run ?? "", /-e DISPLAY=:99/);
  assert.match(muslSmoke?.run ?? "", /-v \/tmp\/\.X11-unix:\/tmp\/\.X11-unix:ro/);
  assert.match(smoke, /run\("clipboard", "bun"/);
  assert.match(smoke, /test-native-clipboard\.mjs/);
  const clipboardProbe = readFileSync(join(ROOT, "scripts", "test-native-clipboard.mjs"), "utf8");
  assert.match(clipboardProbe, /await helper\.getText\(\)/);
  assert.match(clipboardProbe, /await helper\.getImage\(\)/);
  const prepare = acceptSteps.find((step) => step.name === "Prepare hash-pinned musl XCB test libraries");
  assert.equal(prepare?.if, "matrix.executor == 'pinned-musl-container'");
  assert.match(prepare?.run ?? "", /prepare-musl-smoke\.mjs/);
  assert.match(muslSmoke?.run ?? "", /-e LD_LIBRARY_PATH=\/musl-libraries\/usr\/lib/);
  assert.match(muslSmoke?.run ?? "", /musl-libraries:\/musl-libraries:ro/);
  assert.match(muslSmoke?.run ?? "", /-e GITHUB_SHA/);
  const tuiCommand = muslSmoke.run.split("\n").find((line) => line.includes("bun scripts/smoke-bun-tui.mjs"));
  assert.doesNotMatch(tuiCommand, /LD_LIBRARY_PATH|musl-libraries/);
  assert.match(tuiCommand, /--network none/);
  assert.equal(syncSteps.find((step) => step.name === "Test release packaging scripts")?.run, "npm run test:scripts");
  assert.doesNotMatch(`${syncWorkflowText}\n${workflowText}\n${smoke}`, /skip[-_]clipboard|PI_XZ_SKIP_CLIPBOARD/i);
});

test("final native smoke proves every executable contains bytecode", () => {
  const smoke = readFileSync(join(ROOT, "scripts", "smoke-binary-release.mjs"), "utf8");
  assert.match(smoke, /run\("bytecode", nativeExecutable/);
  assert.match(smoke, /BUN_JSC_verboseDiskCache: "1"/);
  assert.match(smoke, /\[Disk Cache\] Cache hit for sourceCode/);
  assert.match(smoke, /did not load its entrypoint from embedded bytecode/);
});
test("Windows ConPTY uses Bun 1.4.2's native Terminal implementation", () => {
  const smoke = readFileSync(join(ROOT, "scripts", "smoke-binary-release.mjs"), "utf8");
  const harness = readFileSync(join(ROOT, "scripts", "smoke-bun-tui.mjs"), "utf8");
  assert.match(workflowText, /bun-version: ["']?1\.4\.2/);
  assert.match(smoke, /platform\(\) === "win32" \? "tui-pseudoconsole" : "tui-pseudoterminal"/);
  assert.match(smoke, /"bun", \[join\(process\.cwd\(\), "scripts", "smoke-bun-tui\.mjs"\), executable\]/);
  assert.doesNotMatch(smoke, /smoke-windows-tui\.ps1/);
  assert.match(harness, /process\.platform === "win32" \? "Bun\.Terminal ConPTY" : "Bun\.Terminal PTY"/);
  assert.match(harness, /cwd: dirname\(executable\)/);
  assert.match(harness, /Promise\.all\(\[child\.exited, terminalClosure\.promise\]\)/);
  assert.match(harness, /__PI_STARTUP_BENCHMARK_COMPLETE__/);
  assert.match(harness, /decoder\.decode\(data, \{ stream: true \}\)/);
  assert.match(harness, /diagnosticTailLength = 512/);
  assert.match(harness, /slice\(-diagnosticTailLength\)/);
  assert.match(harness, /lastStage=\$\{lastBenchmarkStage\}/);
  assert.match(harness, /tail=\$\{JSON\.stringify\(diagnosticTail\)\}/);
  assert.doesNotMatch(harness, /outputText/);
  assert.match(harness, /!benchmarkCompleted/);
  assert.doesNotMatch(harness, /onExit\(/);
  assert.match(harness, /terminalClosed: true/);
  assert.match(harness, /if \(!startupBenchmark\)/);
});

test("stages upstream musl helpers with provenance and uses optimized Bun 1.4.2", () => {
  assert.match(workflowText, /build-musl-clipboard\.sh/);
  assert.match(workflowText, /--clipboard-musl-dir/);
  assert.match(workflowText, /bun-version: ["']?1\.4\.2/);
  assert.match(workflowText, /NODE_ENV: production/);
  const builder = readFileSync(join(ROOT, "scripts", "build-musl-clipboard.sh"), "utf8");
  assert.doesNotMatch(builder, /curl|apk add --no-cache|apk update/);
  assert.match(builder, /node "\$ROOT\/scripts\/lib\/musl-provenance\.mjs"/);
  const provenance = readFileSync(join(ROOT, "scripts", "lib", "musl-provenance.mjs"), "utf8");
  assert.match(provenance, /method: "upstream-prebuilt"/);
  assert.match(provenance, /copyFileSync\(join\(repoRoot, provenance\.source\.path\), helper\)/);
  const libraries = readFileSync(join(ROOT, "scripts", "prepare-musl-smoke.mjs"), "utf8");
  assert.match(libraries, /APK digest mismatch/);
  assert.match(libraries, /musl library digest mismatch/);
  const packager = readFileSync(join(ROOT, "scripts", "build-binaries.sh"), "utf8");
  assert.match(packager, /build-win32-filesystem-snapshot\.sh/);
  assert.match(packager, /filesystemHelperDir/);
  assert.match(packager, /filesystemHelperFile/);
  const sourceArchive = readFileSync(join(ROOT, "scripts", "create-source-archive.sh"), "utf8");
  for (const required of [
    "scripts/build-win32-filesystem-snapshot.sh",
    "scripts/test-win32-filesystem-snapshot.mjs",
    "scripts/test-win32-filesystem-snapshot-loader.mjs",
    "native/pi-filesystem-snapshot.c",
  ]) assert.ok(sourceArchive.includes(`\"${required}\"`), `source archive missing ${required}`);
  const releaseContract = readFileSync(join(ROOT, "scripts", "lib", "github-release.mjs"), "utf8");
  assert.match(releaseContract, /info\.filesystemHelperDir/);
  assert.match(releaseContract, /info\.filesystemHelperFile/);
  assert.match(packager, /--hydrate-target-deps/);
  assert.match(packager, /bun-targets\.mjs --build-flags/);
  assert.match(packager, /command -v cygpath/);
  assert.match(packager, /7z a -bd -tzip -mm=Deflate/);
  assert.match(packager, /normalize-windows-zip\.mjs "\$archive_path"/);
  assert.match(packager, /zip -qr/);
  assert.match(packager, /rm -f "\$archive_path"/);
  // macOS runners ship bash 3.2 without mapfile; keep flag reading portable.
  assert.doesNotMatch(packager, /^\s*mapfile\s/m);
  assert.match(packager, /verify-musl-provenance\.mjs/);
  assert.match(packager, /cp "\$CLIPBOARD_MUSL_DIR\/provenance\.json" "\$target_dir\/clipboard-native-provenance\.json"/);
  assert.match(packager, /cp \.\.\/\.\.\/LICENSE "\$target_dir\/native\/LICENSE"/);
});

test("publication attests final subjects before draft publication and keeps audit list separate", () => {
  const publisher = readFileSync(
    join(ROOT, "scripts", "publish-github-release.mjs"),
    "utf8",
  );
  const attestIndex = workflowText.indexOf("Attest exact Release subjects");
  const verifyIndex = workflowText.indexOf(
    "Stage and verify public attestation bundle",
  );
  const publishIndex = workflowText.indexOf("Publish immutable GitHub Release");
  assert.ok(
    attestIndex >= 0 && attestIndex < verifyIndex && verifyIndex < publishIndex,
  );
  assert.match(workflowText, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  for (const subject of [
    "*.zip",
    "release-manifest.json",
    "binary-acceptance.json",
    "SHA256SUMS",
  ]) {
    assert.ok(
      workflowText.includes(subject),
      `missing attestation subject ${subject}`,
    );
  }
  const attestationBlock = workflowText.slice(attestIndex, verifyIndex);
  assert.doesNotMatch(attestationBlock, /attestation-subjects\.jsonl/);
  assert.match(workflowText, /steps\.attest\.outputs\.bundle-path/);
  assert.match(workflowText, /cp "\$BUNDLE_PATH" "\$bundle"/);
  assert.match(workflowText, /cp "\$bundle" "\$subjects"/);
  assert.match(workflowText, /GH_CONFIG_DIR="\$empty_gh_config" GH_TOKEN= GITHUB_TOKEN=/);
  assert.doesNotMatch(workflowText, /mapfile|readarray/);
  assert.match(workflowText, /while IFS= read -r subject/);
  assert.match(workflowText, /test "\$subject_count" -eq 15/);
  assert.match(workflowText, /gh attestation verify/);
  assert.match(workflowText, /--bundle "\$bundle"/);
  assert.match(workflowText, /--source-digest "\$GITHUB_SHA"/);
  assert.match(publisher, /\.\.\.subjectPaths, subjectsPath/);
});

test("publisher stages a resumable immutable draft and rechecks main before final latest decision", () => {
  const publisher = readFileSync(
    join(ROOT, "scripts", "publish-github-release.mjs"),
    "utf8",
  );
  assert.match(publisher, /draft: true/);
  assert.match(publisher, /allowSubset: true/);
  assert.match(publisher, /Existing published Release.*incomplete asset set/);
  assert.match(publisher, /Existing Release asset.*sha256 mismatch/);
  assert.match(publisher, /uploadMissingAssets/);
  assert.match(publisher, /make_latest: makeLatest \? "true" : "false"/);
  assert.ok(
    publisher.indexOf("mainBranchSha(api, token)") <
      publisher.indexOf("publishDraft(api, token"),
  );
  assert.doesNotMatch(publisher, /clobber|DELETE/);
});

test("published Releases update the isolated Scoop bucket branch", () => {
  const steps = workflow.jobs["publish-release"].steps;
  const publishIndex = steps.findIndex((step) => step.name === "Publish immutable GitHub Release");
  const scoopIndex = steps.findIndex((step) => step.name === "Update Scoop bucket branch");
  assert.ok(publishIndex >= 0 && scoopIndex > publishIndex);
  assert.match(steps[scoopIndex].run, /bash scripts\/publish-scoop-bucket\.sh/);
  assert.deepEqual(steps[scoopIndex].env, { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" });
  const publisher = readFileSync(join(ROOT, "scripts", "publish-scoop-bucket.sh"), "utf8");
  assert.match(publisher, /manifest_commit=.*require\(process\.argv\[1\]\)\.commit/);
  assert.match(publisher, /current_main=.*ls-remote "\$remote" refs\/heads\/main/);
  assert.match(publisher, /Scoop bucket update skipped for historical Release/);
  assert.match(publisher, /ls-remote --exit-code --heads origin scoop/);
  assert.match(publisher, /fetch -q --depth=1 origin scoop/);
  assert.match(publisher, /checkout -q --orphan scoop/);
  assert.match(publisher, /find "\$work"[^\n]*! -name \.git[^\n]*rm -rf/);
  assert.match(publisher, /git -C "\$work" add -A/);
  assert.match(publisher, /git -C "\$work" config commit\.gpgsign false/);
  assert.match(publisher, /push origin HEAD:scoop/);
  assert.doesNotMatch(publisher, /--force/);
});

test("upstream sync smoke packages and executes only the hydrated Linux host target", () => {
  const syncSteps = syncWorkflow.jobs["sync-main-with-squash-branches"].steps;
  assert.match(
    syncSteps.find((step) => step.name === "Setup Bun").uses,
    /oven-sh\/setup-bun@[0-9a-f]{40}/,
  );
  const smokeStep = syncSteps.find(
    (step) => step.name === "Smoke test host binary packaging path",
  );
  assert.ok(smokeStep, "host packaging smoke step must exist");
  assert.match(smokeStep.run, /rebuilt_sha=\$\(git rev-parse HEAD\)/);
  assert.match(smokeStep.run, /REBUILT_SHA="\$rebuilt_sha"[\s\S]*process\.env\.REBUILT_SHA\.slice\(0, 8\)/);
  assert.doesNotMatch(smokeStep.run, /process\.env\.GITHUB_SHA/);
  assert.match(smokeStep.run, /scripts\/build-binaries\.sh/);
  for (const argument of [
    "--skip-install",
    "--skip-deps",
    "--skip-build",
    "--platform linux-x64-gnu-modern",
    '--out "$release_dir"',
    '--distribution-version "$version"',
  ]) {
    assert.ok(smokeStep.run.includes(argument), `missing sync packaging argument: ${argument}`);
  }
  assert.equal((smokeStep.run.match(/--platform /g) ?? []).length, 1);
  assert.match(smokeStep.run, /test -s "\$archive"/);
  assert.match(
    smokeStep.run,
    /smoke-binary-release\.mjs[\s\S]*"\$archive"[\s\S]*linux-x64-gnu-modern[\s\S]*"\$version"/,
  );
  assert.doesNotMatch(smokeStep.run, /npm (ci|install)/);
  assert.doesNotMatch(syncWorkflowText, /prepare-github-release\.mjs/);
  assert.doesNotMatch(syncWorkflowText, /verify-github-release\.mjs local/);
});
