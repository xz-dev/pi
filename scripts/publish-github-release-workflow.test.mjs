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
const escWorkflow = parse(
  readFileSync(join(ROOT, ".github", "workflows", "esc-abort-integration.yml"), "utf8"),
);

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
	assert.match(syncWorkflowText, /git merge --squash origin\/patch\/native-wrapper-release/);
	assert.match(syncWorkflowText, /git commit -m "merge patch\/native-wrapper-release branch"/);
});

test("upstream sync keeps the unsafe synchronized-cursor patch retired", () => {
  assert.doesNotMatch(syncWorkflowText, /patch\/tui-synchronized-cursor-fleet/);
  assert.match(readFileSync(join(ROOT, "README.md"), "utf8"), /`patch\/tui-synchronized-cursor-fleet` is temporarily retired/);
  assert.match(readFileSync(join(ROOT, "MAINTAIN.md"), "utf8"), /can emit excessive terminal data/);
  assert.match(readFileSync(join(ROOT, "MAINTAIN.md"), "utf8"), /do not fetch, merge, or add a CI conflict resolver/);
});

test("upstream sync rejects patch branches that touch upstream changelogs", () => {
  assert.match(syncWorkflowText, /changelog_offenders=\(\)/);
  assert.match(syncWorkflowText, /git diff --name-only "\$base\.\./);  assert.match(syncWorkflowText, /\^packages\/\.\*\/CHANGELOG\.md\$/);
  assert.match(syncWorkflowText, /modifies an upstream-maintained packages\/\*\/CHANGELOG\.md/);
  assert.ok(
    syncWorkflowText.indexOf("changelog_offenders") < syncWorkflowText.indexOf('git merge --squash origin/ci'),
    "changelog guard must run before any squash merge",
  );
  assert.match(readFileSync(join(ROOT, "MAINTAIN.md"), "utf8"), /never carry `packages\/\*\/CHANGELOG\.md` hunks/);
});

test("upstream sync carries and tests the model catalog list refresh patch", () => {
  assert.match(
    syncWorkflowText,
    /\+refs\/heads\/patch\/model-catalog-extension-refresh:refs\/remotes\/origin\/patch\/model-catalog-extension-refresh/,
  );
  assert.match(syncWorkflowText, /git merge --squash origin\/patch\/model-catalog-extension-refresh/);
  assert.match(syncWorkflowText, /python3 scripts\/resolve-model-catalog-squash-conflicts\.py/);
  assert.match(syncWorkflowText, /Unresolved conflicts remain after applying model-catalog extension refresh/);
  const resolver = readFileSync(join(ROOT, "scripts", "resolve-model-catalog-squash-conflicts.py"), "utf8");
  assert.match(resolver, /packages\/coding-agent\/README\.md/);
  assert.match(resolver, /unexpected model-catalog README conflict shape/);
  assert.match(resolver, /Press Ctrl\+S in the model picker to save the highlighted model as the startup default/);
  assert.match(resolver, /pi --list-models --refresh/);
  assert.match(syncWorkflowText, /test\/list-models-refresh\.test\.ts/);
  assert.match(syncWorkflowText, /test\/args\.test\.ts/);
  assert.match(readFileSync(join(ROOT, "README.md"), "utf8"), /`pi --list-models`/);
  assert.match(readFileSync(join(ROOT, "README.md"), "utf8"), /`pi update --models` extension-free/);
});

test("upstream sync carries the Bun bytecode entrypoint patch", () => {
  assert.match(
    syncWorkflowText,
    /\+refs\/heads\/patch\/bun-bytecode-entrypoint:refs\/remotes\/origin\/patch\/bun-bytecode-entrypoint/,
  );
  assert.match(syncWorkflowText, /git merge --squash origin\/patch\/bun-bytecode-entrypoint/);
  assert.match(syncWorkflowText, /git commit -m "merge patch\/bun-bytecode-entrypoint branch"/);
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

test("upstream sync requires ci to merge cleanly without source rewriting", () => {
  assert.match(
    syncWorkflowText,
    /if ! git merge --squash origin\/ci; then\s+echo '::error::Unexpected ci squash conflict; ci must merge cleanly onto current upstream'\s+exit 1\s+fi/,
  );
  assert.doesNotMatch(syncWorkflowText, /resolve-ci-squash-conflicts/);
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
  assert.match(syncWorkflowText, /git merge --squash origin\/patch\/slow-hook-tui-only/);
  assert.doesNotMatch(syncWorkflowText, /patch\/(?:shutdown-lifecycle-log|slow-hook-execution-kind|shutdown-screen-log)/);
  assert.doesNotMatch(syncWorkflowText, /test\/slow-extension-hook-entry\.test\.ts/);
});

test("upstream sync preserves bounded slow-hook and session-tree compatibility", () => {
  assert.match(
    syncWorkflowText,
    /python3 scripts\/resolve-slow-hook-squash-conflicts\.py/,
  );
  assert.match(
    syncWorkflowText,
    /git cherry-pick --no-commit origin\/patch\/slow-hook-tui-only\.\.origin\/patch\/session-tree-splice/,
  );
  assert.match(
    syncWorkflowText,
    /python3 scripts\/resolve-session-tree-splice-conflicts\.py\s+git cherry-pick --quit/,
  );
  assert.match(
    syncWorkflowText,
    /patch\/session-tree-splice must descend from patch\/slow-hook-tui-only/,
  );
  assert.ok(
    syncWorkflowText.indexOf('git commit -m "merge patch/slow-hook-tui-only branch"') <
      syncWorkflowText.indexOf('git commit -m "merge patch/session-tree-splice branch"'),
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
    /github-release-target-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.id \}\}/,
  );
  const releaseArtifactReferences = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? [])
      .flatMap((step) => [step.with?.name, step.with?.pattern])
      .filter((value) => typeof value === "string" && value.startsWith("github-release-")),
  );
  assert.ok(releaseArtifactReferences.length > 0);
  for (const reference of releaseArtifactReferences) {
    assert.match(reference, /\$\{\{ github\.run_attempt \}\}/);
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
  assert.match(syncWorkflowText, /test\/xz-release-update\.test\.ts/);
  assert.match(syncWorkflowText, /test\/xz-release-update-safety\.test\.ts/);
  assert.match(syncWorkflowText, /test\/win32-filesystem-snapshot\.test\.ts/);
  assert.match(syncWorkflowText, /test\/package-command-paths\.test\.ts/);
  assert.match(updateHarness, /PI_XZ_LATEST_RELEASE_URL: `\$\{releaseBase\}latest-release\.json`/);
  assert.match(updateHarness, /digest: `sha256:\$\{servedBundle\.sha256\}`/);
  assert.match(updateHarness, /First flat-to-managed update published previous/);
  assert.match(updateHarness, /Managed update did not publish its validated previous bundle/);
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
  assert.match(updateHarness, /rmSync\(work, \{ recursive: true, force: true, maxRetries: 10, retryDelay: 100 \}\)/);
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
  assert.match(smoke, /typeof c\.hasImage!==['"]function['"]/);
  assert.doesNotMatch(`${syncWorkflowText}\n${workflowText}\n${smoke}`, /skip[-_]clipboard|PI_XZ_SKIP_CLIPBOARD/i);
});

test("final native smoke proves every executable contains bytecode", () => {
  const smoke = readFileSync(join(ROOT, "scripts", "smoke-binary-release.mjs"), "utf8");
  assert.match(smoke, /run\("bytecode", nativeExecutable/);
  assert.match(smoke, /BUN_JSC_verboseDiskCache: "1"/);
  assert.match(smoke, /\[Disk Cache\] Cache hit for sourceCode/);
  assert.match(smoke, /did not load its entrypoint from embedded bytecode/);
});
test("Windows ConPTY uses Bun 1.4.0's native Terminal implementation", () => {
  const smoke = readFileSync(join(ROOT, "scripts", "smoke-binary-release.mjs"), "utf8");
  const harness = readFileSync(join(ROOT, "scripts", "smoke-bun-tui.mjs"), "utf8");
  assert.match(workflowText, /bun-version: ["']?1\.4\.0/);
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

test("builds pinned downstream musl clipboard addons and uses optimized Bun 1.4.0", () => {
  assert.match(workflowText, /build-musl-clipboard\.sh/);
  assert.match(workflowText, /--clipboard-musl-dir/);
  assert.match(workflowText, /bun-version: ["']?1\.4\.0/);
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
