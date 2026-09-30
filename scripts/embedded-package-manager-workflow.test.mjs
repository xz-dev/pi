import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(readFileSync(new URL("../.github/workflows/publish-github-release.yml", import.meta.url), "utf8"));

test("real package installation gates the final Linux release archive", () => {
  const steps = workflow.jobs["accept-release-candidate"].steps;
  const gate = steps.find(step => step.name === "Verify real installed extension packages without external runtimes");
  assert.equal(gate.if, "matrix.target == 'linux-x64-gnu-modern'");
  assert.match(gate.run, /release-manifest\.json/);
  assert.match(gate.run, /unzip -q "\$candidate\/\$archive"/);
  assert.match(gate.run, /e2e-embedded-package-manager\.mjs "\$extracted\/pi"/);
  assert.equal(gate["continue-on-error"], undefined);
  assert.ok(workflow.jobs["acceptance-record"].needs.includes("accept-release-candidate"));
});

test("installation receipts preserve exact pins and no external runtime PATH", () => {
  const source = readFileSync(new URL("./e2e-embedded-package-manager.mjs", import.meta.url), "utf8");
  assert.match(source, /2d69229acd3037c31d4e9d566d02f6c0b92f24b9/);
  assert.match(source, /88639462aae9ba97465b203a305f3abf66bd195c/);
  assert.match(source, /PATH: bin/);
  assert.match(source, /entrySha256: hash\(entry\)/);
  assert.match(source, /receipt\.complete = true/);
  assert.match(source, /post-update-rpc/);
});
