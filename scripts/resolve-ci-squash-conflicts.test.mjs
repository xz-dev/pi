import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const RESOLVER = join(ROOT, "scripts", "resolve-ci-squash-conflicts.sh");
const CONFLICTS = [
  ".github/workflows/build-binaries.yml",
  "README.md",
  "packages/coding-agent/CHANGELOG.md",
  "packages/coding-agent/test/package-command-paths.test.ts",
  "scripts/build-binaries.sh",
];

function git(repo, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    ...options,
  });
  if (options.allowFailure !== true && result.status !== 0) {
    assert.fail(`git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function write(repo, path, content) {
  const absolute = join(repo, path);
  const directory = absolute.slice(0, absolute.lastIndexOf("/"));
  spawnSync("mkdir", ["-p", directory], { encoding: "utf8" });
  writeFileSync(absolute, content);
}

function commitAll(repo, message) {
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "-m", message]);
}

function createConflictFixture() {
  const repo = mkdtempSync(join(tmpdir(), "pi-ci-conflicts-"));
  git(repo, ["init", "-q", "-b", "base"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);

  for (const path of CONFLICTS) write(repo, path, `base:${path}\n`);
  write(repo, ".github/workflows/publish-github-release.yml", "name: downstream release\n");
  commitAll(repo, "base");

  git(repo, ["switch", "-q", "-c", "upstream"]);
  for (const path of CONFLICTS.slice(1)) write(repo, path, `upstream:${path}\n`);
  write(repo, ".github/workflows/build-binaries.yml", "name: upstream tag release\n");
  commitAll(repo, "upstream");

  git(repo, ["switch", "-q", "base"]);
  git(repo, ["switch", "-q", "-c", "ci"]);
  git(repo, ["rm", "-q", ".github/workflows/build-binaries.yml"]);
  git(repo, ["rm", "-q", "packages/coding-agent/test/package-command-paths.test.ts"]);
  write(repo, "README.md", "ci:README.md\n");
  write(repo, "scripts/build-binaries.sh", "ci build bytes\nline two\n");
  write(repo, "packages/coding-agent/CHANGELOG.md", "ci changelog\n");
  commitAll(repo, "ci");

  git(repo, ["switch", "-q", "upstream"]);
  git(repo, ["remote", "add", "origin", repo]);
  git(repo, ["fetch", "-q", "origin", "ci:refs/remotes/origin/ci"]);
  const merge = git(repo, ["merge", "--squash", "origin/ci"], { allowFailure: true });
  assert.notEqual(merge.status, 0, "fixture must produce a conflicted squash merge");
  assert.deepEqual(
    git(repo, ["status", "--porcelain=v1"]).stdout
      .trim()
      .split("\n")
      .filter((line) => CONFLICTS.includes(line.slice(3))),
    [
      "UD .github/workflows/build-binaries.yml",
      "UU README.md",
      "UU packages/coding-agent/CHANGELOG.md",
      "UD packages/coding-agent/test/package-command-paths.test.ts",
      "UU scripts/build-binaries.sh",
    ],
  );
  return repo;
}

function mutationSnapshot(repo) {
  const index = git(repo, ["ls-files", "--stage"]).stdout;
  const status = git(repo, ["status", "--porcelain=v1", "-z"]).stdout;
  const files = CONFLICTS.map((path) => {
    const result = spawnSync("git", ["hash-object", "--", path], { cwd: repo, encoding: "utf8" });
    return `${path}\0${result.status}\0${result.stdout}`;
  }).join("");
  return { index, status, files };
}

function callResolverFunction(repo, conflicts) {
  const command = [
    "source \"$1\"",
    "shift",
    "resolve_ci_squash_conflicts \"$@\"",
  ].join("; ");
  return spawnSync("bash", ["-c", command, "resolver-test", RESOLVER, ...conflicts], {
    cwd: repo,
    encoding: "utf8",
  });
}

test("resolves only the exact five ci squash conflicts with downstream release files retained", () => {
  const repo = createConflictFixture();
  try {
    const expectedBuild = git(repo, ["show", "origin/ci:scripts/build-binaries.sh"]).stdout;
    const result = spawnSync(RESOLVER, [], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(git(repo, ["diff", "--name-only", "--diff-filter=U"]).stdout, "");
    assert.equal(git(repo, ["ls-files", ".github/workflows/build-binaries.yml"]).stdout, "");
    assert.equal(
      readFileSync(join(repo, ".github/workflows/publish-github-release.yml"), "utf8"),
      "name: downstream release\n",
    );
    assert.equal(readFileSync(join(repo, "scripts/build-binaries.sh"), "utf8"), expectedBuild);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

for (const [name, conflicts] of [
  ["empty", []],
  ["missing", CONFLICTS.slice(0, -1)],
  ["additional", [...CONFLICTS, "unexpected.txt"]],
  ["duplicate", [...CONFLICTS.slice(0, -1), CONFLICTS[0]]],
]) {
  test(`rejects ${name} conflict input before mutating the index or worktree`, () => {
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
