import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const RESOLVER_PATH = "scripts/resolve-release-self-update-squash-conflicts.sh";
const HELPER_PATH = "scripts/apply-xz-release-contract-to-package.mjs";
const CONFLICTS = ["package.json", "packages/coding-agent/CHANGELOG.md"];
const CONTRACT_COMMAND =
	"node scripts/generate-xz-release-binary-contract.mjs --check && node scripts/xz-release-targets.test.mjs";

function git(repo, args, options = {}) {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", ...options });
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

function packageText({ check, build, workspace, contract }) {
	return `${JSON.stringify(
		{
			name: "fixture",
			workspaces: [workspace],
			scripts: {
				build,
				check,
				...(contract === undefined ? {} : { "check:xz-release-contract": contract }),
				prepare: "fixture-prepare",
			},
		},
		null,
		"\t",
	)}\n`;
}

function createConflictFixture({ packageConflict = true } = {}) {
	const repo = mkdtempSync(join(tmpdir(), "pi-release-self-update-conflicts-"));
	git(repo, ["init", "-q", "-b", "base"]);
	git(repo, ["config", "user.name", "test"]);
	git(repo, ["config", "user.email", "test@example.invalid"]);
	write(
		repo,
		"package.json",
		packageText({
			check: "format && npm run check:shrinkwrap && npm run check:install-lock:coding-agent && types",
			build: "base-build",
			workspace: "packages/old/*",
		}),
	);
	write(repo, "packages/coding-agent/CHANGELOG.md", "base changelog\n");
	commitAll(repo, "base");

	git(repo, ["switch", "-q", "-c", "integrated"]);
	write(
		repo,
		"package.json",
		packageConflict
			? packageText({
					check: "format && npm run check:shrinkwrap && npm run check:install-lock:coding-agent && types",
					build: "current-upstream-build-with-new-workspaces",
					workspace: "packages/session-backends/*",
				})
			: packageText({
					check: "format && npm run check:shrinkwrap && npm run check:install-lock:coding-agent && types",
					build: "base-build",
					workspace: "packages/old/*",
				}),
	);
	write(repo, "packages/coding-agent/CHANGELOG.md", "current integrated changelog\n");
	commitAll(repo, "integrated");

	git(repo, ["switch", "-q", "base"]);
	git(repo, ["switch", "-q", "-c", "patch"]);
	write(
		repo,
		"package.json",
		packageText({
			check:
				"format && npm run check:shrinkwrap && npm run check:xz-release-contract && npm run check:install-lock:coding-agent && types",
			build: "stale-patch-build",
			workspace: "packages/old/*",
			contract: CONTRACT_COMMAND,
		}),
	);
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
	write(repo, HELPER_PATH, readFileSync(join(ROOT, HELPER_PATH), "utf8"));
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

test("resolves the exact conflicts while preserving integrated package structure", () => {
	const repo = createConflictFixture();
	try {
		const result = spawnSync("bash", [RESOLVER_PATH], { cwd: repo, encoding: "utf8" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(git(repo, ["diff", "--name-only", "--diff-filter=U"]).stdout, "");
		const packageJson = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
		assert.deepEqual(packageJson.workspaces, ["packages/session-backends/*"]);
		assert.equal(packageJson.scripts.build, "current-upstream-build-with-new-workspaces");
		assert.equal(packageJson.scripts["check:xz-release-contract"], CONTRACT_COMMAND);
		assert.equal(
			packageJson.scripts.check,
			"format && npm run check:shrinkwrap && npm run check:xz-release-contract && npm run check:install-lock:coding-agent && types",
		);
		assert.equal(
			readFileSync(join(repo, "packages/coding-agent/CHANGELOG.md"), "utf8"),
			"current integrated changelog\n",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("resolves a changelog-only conflict after package metadata merges cleanly", () => {
	const repo = createConflictFixture({ packageConflict: false });
	try {
		const result = spawnSync("bash", [RESOLVER_PATH], { cwd: repo, encoding: "utf8" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(git(repo, ["diff", "--name-only", "--diff-filter=U"]).stdout, "");
		const packageJson = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
		assert.equal(packageJson.scripts["check:xz-release-contract"], CONTRACT_COMMAND);
		assert.equal(
			readFileSync(join(repo, "packages/coding-agent/CHANGELOG.md"), "utf8"),
			"current integrated changelog\n",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

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
