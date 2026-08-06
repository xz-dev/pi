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

test("upstream sync preserves the ci-owned binary build script on squash conflict", () => {
  assert.match(
    syncWorkflowText,
    /README\.md\|scripts\/build-binaries\.sh\|packages\/coding-agent\/CHANGELOG\.md\|packages\/coding-agent\/test\/package-command-paths\.test\.ts\) ;;/,
  );
  assert.match(
    syncWorkflowText,
    /git restore --source=origin\/ci --staged --worktree -- README\.md scripts\/build-binaries\.sh/,
  );
  assert.match(
    syncWorkflowText,
    /git checkout --ours -- packages\/coding-agent\/test\/package-command-paths\.test\.ts/,
  );
  assert.match(
    syncWorkflowText,
    /git checkout --ours -- packages\/coding-agent\/CHANGELOG\.md/,
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
  assert.doesNotMatch(workflowText, /macos-13/);
  assert.match(workflowText, /macos-15-intel|bun-targets\.mjs --matrix/);
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
  assert.match(workflowText, /smoke-unix-tui\.py/);
  assert.doesNotMatch(workflowText, /AppActivate|SendKeys|Docker allocated TTY|fabricated/);
});

test("builds pinned downstream musl clipboard addons and uses optimized Bun 1.3.14", () => {
  assert.match(workflowText, /build-musl-clipboard\.sh/);
  assert.match(workflowText, /--clipboard-musl-dir/);
  assert.match(workflowText, /bun-version: ["']?1\.3\.14/);
  assert.match(workflowText, /NODE_ENV: production/);
  const builder = readFileSync(join(ROOT, "scripts", "build-musl-clipboard.sh"), "utf8");
  assert.doesNotMatch(builder, /curl|apk add --no-cache|apk update/);
  assert.match(builder, /--network none/);
  assert.match(builder, /tar -xzf \/inputs\/musl-dev\.apk/);
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

test("upstream sync gate verifies the binary Release candidate with Bun", () => {
  assert.match(syncWorkflowText, /oven-sh\/setup-bun@[0-9a-f]{40}/);
  assert.match(syncWorkflowText, /prepare-github-release\.mjs --out/);
  assert.match(syncWorkflowText, /verify-github-release\.mjs local/);
});
