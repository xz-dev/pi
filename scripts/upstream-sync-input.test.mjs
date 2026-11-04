import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/upstream-sync.yml", import.meta.url), "utf8");
const start = workflow.indexOf('          upstream_sha="$(git rev-parse upstream/main)"');
const end = workflow.indexOf("          git fetch origin", start);
assert(start >= 0 && end > start);
const selection = workflow.slice(start, end).replace(/^ {10}/gm, "");
const cwd = mkdtempSync("/var/tmp/pi-sync-input-test-");
const env = {
	PATH: process.env.PATH,
	HOME: cwd,
	USERPROFILE: cwd,
	PI_CODING_AGENT_DIR: cwd,
	PI_OFFLINE: "1",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const git = (args, input) => execFileSync("git", args, { cwd, env, encoding: "utf8", input }).trim();
git(["init", "--quiet"]);
const tree = git(["mktree"], "");
const first = git(["-c", "commit.gpgsign=false", "commit-tree", tree, "-m", "first"]);
const latest = git(["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", first, "-m", "latest"]);
const unrelated = git(["-c", "commit.gpgsign=false", "commit-tree", tree, "-m", "unrelated"]);
git(["update-ref", "refs/remotes/upstream/main", latest]);
const select = (requested) => spawnSync("bash", ["-ceu", `${selection}\nprintf '%s\\n' "$upstream_sha"`], {
	cwd,
	env: { ...env, REQUESTED_UPSTREAM_SHA: requested },
	encoding: "utf8",
});

test("scheduled/default sync selects fetched latest", () => {
	const result = select("");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), latest);
});

test("manual sync can replay an exact verified upstream ancestor", () => {
	const result = select(first);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), first);
});

test("manual sync rejects malformed, unknown and unrelated commits", () => {
	for (const requested of ["main", first.slice(0, 8), first.toUpperCase(), "$(exit 0)", "f".repeat(40), unrelated]) {
		assert.notEqual(select(requested).status, 0, requested);
	}
});

test("manual input is environment data and Chord gate uses relocated legacy test", () => {
	assert.match(workflow, /REQUESTED_UPSTREAM_SHA: \$\{\{ inputs\.upstream_sha \}\}/);
	assert.match(workflow, /--run test\/old\/websocket\.test\.ts/);
});
