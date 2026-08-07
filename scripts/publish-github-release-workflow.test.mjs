import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

function pinnedUses() {
  return Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : [])),
  );
}

test("upstream sync fetches and merges the persistent Release self-update patch", () => {
  assert.match(
    syncWorkflowText,
    /\+refs\/heads\/patch\/release-self-update:refs\/remotes\/origin\/patch\/release-self-update/,
  );
  assert.match(syncWorkflowText, /git merge --squash origin\/patch\/release-self-update/);
  assert.match(syncWorkflowText, /git commit -m "merge patch\/release-self-update branch"/);
});

test("upstream sync carries and tests the bounded startup benchmark patch", () => {
  assert.match(syncWorkflowText, /\+refs\/heads\/patch\/startup-benchmark-exit:refs\/remotes\/origin\/patch\/startup-benchmark-exit/);
  assert.match(syncWorkflowText, /git merge --squash origin\/patch\/startup-benchmark-exit/);
  assert.match(syncWorkflowText, /git commit -m "merge patch\/startup-benchmark-exit branch"/);
  assert.match(syncWorkflowText, /test\/startup-benchmark\.test\.ts/);
  assert.match(syncWorkflowText, /test\/tools-manager\.test\.ts/);
});

test("upstream sync retires the obsolete OpenCode completions fixture patch", () => {
  assert.doesNotMatch(syncWorkflowText, /patch\/opencode-completions-test-narrowing/);
});

test("upstream sync delegates ci squash conflict handling to the tested resolver", () => {
  assert.match(
    syncWorkflowText,
    /if ! git merge --squash origin\/ci; then\s+scripts\/resolve-ci-squash-conflicts\.sh\s+fi/,
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
  assert.deepEqual(workflow.jobs["publish-release"].permissions, {
    contents: "write",
    "id-token": "write",
    attestations: "write",
  });
  assert.match(workflowText, /github\.repository == 'xz-dev\/pi'/);
  assert.match(workflowText, /github\.ref == 'refs\/heads\/main'/);
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
  assert.match(workflowText, /github-release-target-\$\{\{ github\.sha \}\}-\$\{\{ matrix\.id \}\}/);
  assert.match(workflowText, /--prebuilt/);
  assert.match(workflowText, /-eq 12/);
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
});

test("Windows ConPTY uses Bun 1.3.14's native Terminal implementation", () => {
  const smoke = readFileSync(join(ROOT, "scripts", "smoke-binary-release.mjs"), "utf8");
  const harness = readFileSync(join(ROOT, "scripts", "smoke-bun-tui.mjs"), "utf8");
  assert.match(workflowText, /bun-version: ["']?1\.3\.14/);
  assert.match(smoke, /platform\(\) === "win32" \? "tui-pseudoconsole" : "tui-pseudoterminal"/);
  assert.match(smoke, /"bun", \[join\(process\.cwd\(\), "scripts", "smoke-bun-tui\.mjs"\), executable\]/);
  assert.doesNotMatch(smoke, /smoke-windows-tui\.ps1/);
  assert.match(harness, /process\.platform === "win32" \? "Bun\.Terminal ConPTY" : "Bun\.Terminal PTY"/);
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

test("builds pinned downstream musl clipboard addons and uses optimized Bun 1.3.14", () => {
  assert.match(workflowText, /build-musl-clipboard\.sh/);
  assert.match(workflowText, /--clipboard-musl-dir/);
  assert.match(workflowText, /bun-version: ["']?1\.3\.14/);
  assert.match(workflowText, /NODE_ENV: production/);
  const builder = readFileSync(join(ROOT, "scripts", "build-musl-clipboard.sh"), "utf8");
  assert.doesNotMatch(builder, /curl|apk add --no-cache|apk update/);
  assert.match(builder, /--network none/);
  assert.match(builder, /host_uid=\$\(id -u\)/);
  assert.match(builder, /host_gid=\$\(id -g\)/);
  assert.match(builder, /chown -R "\$HOST_UID:\$HOST_GID" \/work/);
  assert.match(builder, /trap cleanup EXIT/);
  assert.match(builder, /tar -xzf \/inputs\/musl-dev\.apk/);
  const packager = readFileSync(join(ROOT, "scripts", "build-binaries.sh"), "utf8");
  assert.match(packager, /--hydrate-target-deps/);
  assert.match(packager, /require\('\.\/package-lock\.json'\)\.packages/);
  assert.match(packager, /clipboard tarball integrity mismatch/);
  assert.match(packager, /tarball="\$\(pwd\)\/\$\(npm pack/);
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
    "*.tar.gz",
    "*.zip",
    "release-manifest.json",
    "install.sh",
    "install.ps1",
    "SHA256SUMS",
  ]) {
    assert.ok(
      workflowText.includes(subject),
      `missing attestation subject ${subject}`,
    );
  }
  const attestationBlock = workflowText.slice(attestIndex, verifyIndex);
  assert.doesNotMatch(attestationBlock, /attestation-subjects\.txt/);
  assert.match(workflowText, /steps\.attest\.outputs\.bundle-path/);
  assert.match(workflowText, /cp "\$BUNDLE_PATH" "\$bundle"/);
  assert.match(workflowText, /cp "\$bundle" "\$subjects"/);
  assert.match(workflowText, /GH_CONFIG_DIR="\$empty_gh_config" GH_TOKEN= GITHUB_TOKEN=/);
  assert.doesNotMatch(workflowText, /mapfile|readarray/);
  assert.match(workflowText, /while IFS= read -r subject/);
  assert.match(workflowText, /test "\$subject_count" -eq 17/);
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
