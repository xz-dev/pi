import assert from "node:assert/strict";
import test from "node:test";
import { forkDistributionVersion } from "./lib/github-release.mjs";

const SHA = "7a97185e995686f776ae6c6a383a49c51e6df904";

test("distribution version ignores the run attempt so failed-job reruns match", () => {
	const first = forkDistributionVersion("1.3.0", { GITHUB_RUN_NUMBER: "352", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: SHA });
	const rerun = forkDistributionVersion("1.3.0", { GITHUB_RUN_NUMBER: "352", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: SHA });
	assert.equal(first, "1.3.0-xz.352.1.g7a97185e");
	assert.equal(rerun, first);
	assert.notEqual(forkDistributionVersion("1.3.0", { GITHUB_RUN_NUMBER: "353", GITHUB_SHA: SHA }), first);
	assert.throws(() => forkDistributionVersion("1.3.0", { GITHUB_RUN_NUMBER: "x", GITHUB_SHA: SHA }), /GITHUB_RUN_NUMBER/);
});
