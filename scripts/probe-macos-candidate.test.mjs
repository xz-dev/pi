import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { validateCandidateRun, verifyOriginalBinary } from "./probe-macos-candidate.mjs";

const run = {
	id: 318, workflow_id: 42, head_repository: { full_name: "xz-dev/pi" },
	head_branch: "main", event: "push", status: "completed", conclusion: "failure",
	head_sha: "b90f329e9534bdf8650faed50596cd4374dbe559", run_number: 318, run_attempt: 1,
};

test("diagnostic source must be the failed main publication from this repository", () => {
	assert.doesNotThrow(() => validateCandidateRun(run, 42, 318));
	for (const change of [
		{ id: 319 }, { workflow_id: 43 }, { head_repository: { full_name: "other/pi" } },
		{ head_branch: "ci" }, { event: "pull_request" }, { status: "in_progress" },
		{ conclusion: "success" }, { head_sha: "short" }, { run_number: 0 }, { run_attempt: 0 },
	]) assert.throws(() => validateCandidateRun({ ...run, ...change }, 42, 318));
	assert.throws(() => validateCandidateRun(run, undefined, 318));
});

test("diagnostic execution requires the exact retained original binary bytes", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-macos-probe-identity-"));
	try {
		const content = Buffer.from("original-candidate");
		const hash = createHash("sha256").update(content).digest("hex");
		const asset = join(root, "pi-darwin-x64-modern");
		writeFileSync(asset, content);
		assert.deepEqual(verifyOriginalBinary(root, hash), { asset, hash, bytes: content.length });
		assert.throws(() => verifyOriginalBinary(root, "0".repeat(64)), /Candidate bytes differ/);
		assert.throws(() => verifyOriginalBinary(root, "invalid"), /original binary SHA-256/);
		writeFileSync(join(root, "extra"), "unexpected");
		assert.throws(() => verifyOriginalBinary(root, hash), /Unexpected candidate artifact/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("manual diagnostics preserve the default Windows probe and cannot publish", () => {
	const workflow = parse(readFileSync(new URL("../.github/workflows/probe-windows-rename.yml", import.meta.url), "utf8"));
	assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
	assert.equal(workflow.on.workflow_dispatch.inputs.macos_candidate_run.default, "");
	assert.equal(workflow.jobs["probe-windows-rename"].if, "inputs.macos_candidate_run == ''");
	const job = workflow.jobs["diagnose-macos-candidate"];
	assert.equal(job.if, "inputs.macos_candidate_run != ''");
	assert.equal(job["runs-on"], "macos-15-intel");
	assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
	const upload = job.steps.at(-1);
	assert.equal(upload.if, "always()");
	assert.match(upload.with.name, /^native-candidate-diagnostics-/);
	assert.ok(!job.steps.some((step) => /publish-release|attest-release|gh release/.test(step.run ?? "")));
});

test("diagnostic execution rejects a symlink instead of a downloaded regular file", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-macos-probe-link-"));
	const source = `${root}-source`;
	try {
		writeFileSync(source, "original-candidate");
		symlinkSync(source, join(root, "pi-darwin-x64-modern"));
		assert.throws(() => verifyOriginalBinary(root, "0".repeat(64)), /not a regular file/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(source, { force: true });
	}
});
