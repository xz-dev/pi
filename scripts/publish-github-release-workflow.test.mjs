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
const OLD_WORKFLOW_PATH = join(
  ROOT,
  ".github",
  "workflows",
  "publish-github-packages.yml",
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

test("Release publication workflow has trusted triggers, exact checkout, and least-privilege jobs", () => {
  assert.ok(workflow.on.push.branches.includes("main"));
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs["build-release-candidate"].permissions, {
    contents: "read",
  });
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
  assert.throws(() => readFileSync(OLD_WORKFLOW_PATH, "utf8"), /ENOENT/);
});

test("acceptance matrix verifies the one candidate with Node 22 and Bun 1.3.14 on all target OSes", () => {
  const job = workflow.jobs["accept-release-candidate"];
  assert.deepEqual(job.strategy.matrix.os, [
    "ubuntu-latest",
    "macos-latest",
    "windows-latest",
  ]);
  assert.match(workflowText, /node-version: ["']22["']/);
  assert.match(workflowText, /bun-version: 1\.3\.14/);
  assert.match(workflowText, /verify-github-release\.mjs all/);
  assert.match(
    workflowText,
    /github-release-candidate-\$\{\{ github\.sha \}\}/,
  );
});

test("publication attests final subjects before draft publication and keeps audit list separate", () => {
  const publisher = readFileSync(
    join(ROOT, "scripts", "publish-github-release.mjs"),
    "utf8",
  );
  const attestIndex = workflowText.indexOf("Attest exact Release subjects");
  const verifyIndex = workflowText.indexOf(
    "Verify stored artifact attestations before publication",
  );
  const publishIndex = workflowText.indexOf("Publish immutable GitHub Release");
  assert.ok(
    attestIndex >= 0 && attestIndex < verifyIndex && verifyIndex < publishIndex,
  );
  assert.match(workflowText, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  for (const subject of [
    "*.tgz",
    "release-manifest.json",
    "install.ts",
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
  assert.match(workflowText, /gh attestation verify/);
  assert.match(workflowText, /--source-digest "\$GITHUB_SHA"/);
  assert.match(publisher, /\.\.\.subjectPaths, subjectsPath/);
});

test("publication requires repository Release immutability", () => {
  assert.match(workflowText, /repos\/\$GITHUB_REPOSITORY\/immutable-releases/);
  assert.match(workflowText, /Repository Release immutability must be enabled before publication/);
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
