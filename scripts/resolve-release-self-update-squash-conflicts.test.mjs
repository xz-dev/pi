import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const RESOLVER_PATH = "scripts/resolve-release-self-update-squash-conflicts.sh";
const CONFLICTS = ["package.json", "packages/coding-agent/CHANGELOG.md"];

function git(repo, args, options = {}) {
	const result = spawnSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" },
		...options,
	});
	if (options.allowFailure !== true && result.status !== 0) {
		assert.fail(`git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
	}
	return result;
}

function write(repo, path, content) {
	const absolute = join(repo, path);
	spawnSync("mkdir", ["-p", dirname(absolute)], { encoding: "utf8" });
	writeFileSync(absolute, content);
}

function commitAll(repo, message) {
	git(repo, ["add", "--all"]);
	git(repo, ["commit", "-m", message]);
}

function packageText({ build, workspace }) {
	return `${JSON.stringify(
		{
			name: "fixture",
			workspaces: [workspace],
			scripts: { build, check: "format && types", prepare: "fixture-prepare" },
		},
		null,
		"\t",
	)}\n`;
}

function createConflictFixture({ packageConflict = true } = {}) {
	const repo = mkdtempSync(join(tmpdir(), "pi-native-release-conflicts-"));
	git(repo, ["init", "-q", "-b", "base"]);
	git(repo, ["config", "user.name", "test"]);
	git(repo, ["config", "user.email", "test@example.invalid"]);
	write(repo, "package.json", packageText({ build: "base-build", workspace: "packages/old/*" }));
	write(repo, "packages/coding-agent/CHANGELOG.md", "base changelog\n");
	commitAll(repo, "base");

	git(repo, ["switch", "-q", "-c", "integrated"]);
	write(
		repo,
		"package.json",
		packageConflict
			? packageText({ build: "current-upstream-build", workspace: "packages/session-backends/*" })
			: packageText({ build: "base-build", workspace: "packages/old/*" }),
	);
	write(repo, "packages/coding-agent/CHANGELOG.md", "current integrated changelog\n");
	commitAll(repo, "integrated");

	git(repo, ["switch", "-q", "base"]);
	git(repo, ["switch", "-q", "-c", "patch"]);
	write(repo, "package.json", packageText({ build: "stale-patch-build", workspace: "packages/old/*" }));
	write(repo, "packages/coding-agent/CHANGELOG.md", "patch changelog\n");
	commitAll(repo, "patch");

	git(repo, ["switch", "-q", "integrated"]);
	const merge = git(repo, ["merge", "--squash", "patch"], { allowFailure: true });
	assert.notEqual(merge.status, 0, "fixture must produce a conflicted squash merge");
	assert.deepEqual(
		git(repo, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim().split("\n"),
		packageConflict ? CONFLICTS : [CONFLICTS[1]],
	);
	write(repo, RESOLVER_PATH, readFileSync(join(ROOT, RESOLVER_PATH), "utf8"));
	return repo;
}

function mutationSnapshot(repo) {
	return {
		index: git(repo, ["ls-files", "--stage"]).stdout,
		status: git(repo, ["status", "--porcelain=v1", "-z"]).stdout,
		files: CONFLICTS.map((path) => readFileSync(join(repo, path), "utf8")),
	};
}

function callResolverFunction(repo, conflicts) {
	const command = 'source "$1"; shift; resolve_release_self_update_squash_conflicts "$@"';
	return spawnSync("bash", ["-c", command, "resolver-test", RESOLVER_PATH, ...conflicts], {
		cwd: repo,
		encoding: "utf8",
	});
}

for (const packageConflict of [true, false]) {
	test(`preserves integrated metadata with ${packageConflict ? "package and changelog" : "changelog-only"} conflicts`, () => {
		const repo = createConflictFixture({ packageConflict });
		try {
			const result = spawnSync("bash", [RESOLVER_PATH], { cwd: repo, encoding: "utf8" });
			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.equal(git(repo, ["diff", "--name-only", "--diff-filter=U"]).stdout, "");
			const packageJson = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
			assert.equal(packageJson.scripts["check:xz-release-contract"], undefined);
			assert.equal(packageJson.scripts.check, "format && types");
			assert.equal(
				readFileSync(join(repo, "packages/coding-agent/CHANGELOG.md"), "utf8"),
				"current integrated changelog\n",
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
}

for (const [name, conflicts] of [
	["empty", []],
	["missing", CONFLICTS.slice(0, -1)],
	["additional", [...CONFLICTS, "unexpected.txt"]],
	["duplicate", [CONFLICTS[0], CONFLICTS[0]]],
]) {
	test(`rejects ${name} conflict input without mutation`, () => {
		const repo = createConflictFixture();
		try {
			const before = mutationSnapshot(repo);
			const result = callResolverFunction(repo, conflicts);
			assert.notEqual(result.status, 0, `${name} input must fail`);
			assert.deepEqual(mutationSnapshot(repo), before);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
}
