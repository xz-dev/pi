import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "rebuild-from-inputs.sh");

// Disposable fixture repo input vector (rebuilt per test run; SHAs are
// resolved dynamically, so the fixture never depends on recorded object ids).
// The new-model contract: independent patches squash-merge; chain descendants
// (seam → mte → esc here) apply as predecessor-relative range diffs and must
// keep the predecessor patch tip in their ancestry.
function buildFixture() {
	const dir = mkdtempSync(join(tmpdir(), "replay-fixture-"));
	const run = (cmd) =>
		execSync(cmd, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	run("git init -q -b upstream-main .");
	run("git config user.name t");
	run("git config user.email t@invalid");
	run("git config commit.gpgsign false");
	const commit = (msg) => {
		run(`git commit -q --allow-empty -m ${JSON.stringify(msg)}`);
		return run("git rev-parse HEAD").trim();
	};
	const file = (name, content, msg, branch, from = "upstream-main") => {
		if (branch) run(`git checkout -q -B ${branch} ${from}`);
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
		execFileSync("git", ["add", "--", name], { cwd: dir });
		return commit(msg);
	};
	execFileSync("bash", ["-c", "printf 'base\\n' > f.txt && git add f.txt"], { cwd: dir });
	const upstream = commit("base");
	// ci branch: the replay helpers plus ci.txt, and an f.txt edit so the
	// conflict fixture patch conflicts with it deterministically.
	run("git checkout -q -B ci upstream-main");
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "scripts", "rebuild-from-inputs.sh"), readFileSync(SCRIPT));
	writeFileSync(join(dir, "scripts", "union-contributor-approvals.py"), "fixture helper\n");
	execFileSync("bash", ["-c", "printf 'ci\\n' > ci.txt && printf 'ci-edited\\n' > f.txt && git add scripts ci.txt f.txt"], { cwd: dir });
	run("git commit -q -m ci-content");
	const ciSha = run("git rev-parse HEAD").trim();
	const approval = file("approval.txt", "approval\n", "approval", "patch/contributor-approval");
	const aaa = file("aaa.txt", "aaa\n", "aaa", "patch/model-startup-refresh-barrier");
	const seam = file("seam.txt", "seam\n", "seam", "patch/agent-run-failure-seam");
	const mte = file("mte.txt", "mte\n", "mte", "patch/managed-tool-executions", "patch/agent-run-failure-seam");
	const esc = file("esc.txt", "esc\n", "esc", "patch/esc-abort", "patch/managed-tool-executions");
	// Conflict fixture: touches f.txt which ci already edited.
	const conf = file("f.txt", "base\nconflict\n", "conf", "patch/bun-bytecode-entrypoint");
	// Changelog offender fixture.
	const offender = (() => {
		run("git checkout -q -B patch/vitest-audit-fix upstream-main");
		mkdirSync(join(dir, "packages", "coding-agent"), { recursive: true });
		writeFileSync(join(dir, "packages", "coding-agent", "CHANGELOG.md"), "offender\n");
		execFileSync("git", ["add", "--", "packages/coding-agent/CHANGELOG.md"], { cwd: dir });
		return commit("offender");
	})();
	run("git checkout -q upstream-main");
	return { dir, run, file, upstream, ci: ciSha, approval, aaa, seam, mte, esc, conf, offender };
}

const CHAIN = (fixture) => [
	"--patch", `agent-run-failure-seam=${fixture.seam}`,
	"--patch", `managed-tool-executions=${fixture.mte}`,
	"--patch", `esc-abort=${fixture.esc}`,
];

function replay(fixture, args, { expectFail = false, target, diagnostic = true } = {}) {
	const targetPath = target ?? `${mkdtempSync(join(tmpdir(), "replay-target-"))}-fresh`;
	const proc = spawnSync("bash", [SCRIPT, "--source", fixture.dir, "--target", targetPath, ...(diagnostic ? ["--diagnostic"] : []), ...args], {
		cwd: fixture.dir,
		encoding: "utf8",
	});
	const status = proc.status ?? 1;
	const out = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
	if (expectFail) {
		assert.notEqual(status, 0, `expected failure, got exit 0\n${out}`);
	} else {
		assert.equal(status, 0, `expected success, got exit ${status}\n${out}`);
	}
	return { status, out, target: targetPath };
}

// Chronological commit subjects (oldest first).
const log = (repo) =>
	execSync("git log --format=%s", { cwd: repo, encoding: "utf8" })
		.trim()
		.split("\n")
		.reverse();

const HEAD = (repo) => execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();

function cleanup(fixture, target) {
	rmSync(fixture.dir, { recursive: true, force: true });
	if (target) rmSync(target, { recursive: true, force: true });
}

test("applies recorded inputs in the declared fixed order", () => {
	const fixture = buildFixture();
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `model-startup-refresh-barrier=${fixture.aaa}`,
		...CHAIN(fixture),
	]);
	try {
		const subjects = log(target);
		assert.equal(subjects[0], "base");
		assert.equal(subjects[1], "merge ci branch");
		assert.equal(subjects[2], "merge patch/model-startup-refresh-barrier branch");
		assert.equal(subjects[3], "merge patch/agent-run-failure-seam branch");
		assert.equal(subjects[4], "merge patch/managed-tool-executions branch");
		assert.equal(subjects[5], "merge patch/esc-abort branch");
		assert.equal(subjects[subjects.length - 1], "record upstream sync inputs (diagnostic subset)");
		// The marker records the exact frozen input vector.
		const body = execSync("git show -s --format=%B HEAD", { cwd: target, encoding: "utf8" });
		assert.match(body, new RegExp(`origin/patch/esc-abort ${fixture.esc}`));
		assert.match(body, new RegExp(`origin/ci ${fixture.ci}`));
		// The marker commit is empty: the replay is content-stable.
		const diff = execSync("git show --stat --format= HEAD", { cwd: target, encoding: "utf8" });
		assert.equal(diff.trim(), "");
		// Content actually present: independent patch merged, chain applied.
		assert.ok(existsSync(join(target, "aaa.txt")));
		assert.ok(existsSync(join(target, "seam.txt")));
		assert.ok(existsSync(join(target, "mte.txt")));
		assert.ok(existsSync(join(target, "esc.txt")));
	} finally {
		cleanup(fixture, target);
	}
});

test("chain descendant integrates as a predecessor-relative range diff", () => {
	const fixture = buildFixture();
	// esc-abort edits mte.txt too; the range diff must carry the descendant's
	// change without resurrecting a conflict with mte's own squashed content.
	const esc2 = fixture.file("mte.txt", "mte\nesc-edit\n", "esc-edit", "patch/esc-abort", "patch/esc-abort");
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `agent-run-failure-seam=${fixture.seam}`,
		"--patch", `managed-tool-executions=${fixture.mte}`,
		"--patch", `esc-abort=${esc2}`,
	]);
	try {
		assert.equal(readFileSync(join(target, "mte.txt"), "utf8"), "mte\nesc-edit\n");
	} finally {
		cleanup(fixture, target);
	}
});

test("stop-before halts exactly before the named mutation and records a partial marker", () => {
	const fixture = buildFixture();
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `model-startup-refresh-barrier=${fixture.aaa}`,
		...CHAIN(fixture),
		"--stop-before", "managed-tool-executions",
	]);
	try {
		const subjects = log(target);
		assert.ok(subjects.includes("merge patch/model-startup-refresh-barrier branch"));
		assert.ok(subjects.includes("merge patch/agent-run-failure-seam branch"));
		assert.ok(!subjects.includes("merge patch/managed-tool-executions branch"));
		assert.ok(!existsSync(join(target, "mte.txt")));
		assert.equal(subjects[subjects.length - 1], "record upstream sync inputs (partial through managed-tool-executions)");
		const body = execSync("git show -s --format=%B HEAD", { cwd: target, encoding: "utf8" });
		assert.ok(!body.startsWith("record upstream sync inputs\n\n"), "partial marker must not match the complete key");
	} finally {
		cleanup(fixture, target);
	}
});

test("rejects a target path that already exists before any mutation", () => {
	const fixture = buildFixture();
	const existing = mkdtempSync(join(tmpdir(), "replay-existing-"));
	try {
		const { out } = replay(fixture, ["--upstream", fixture.upstream, "--ci", fixture.ci, "--patch", `model-startup-refresh-barrier=${fixture.aaa}`], {
			expectFail: true,
			target: existing,
		});
		assert.match(out, /already exists/);
		assert.equal(HEAD(fixture.dir), fixture.upstream);
	} finally {
		cleanup(fixture);
		rmSync(existing, { recursive: true, force: true });
	}
});

test("rejects source==target before any mutation", () => {
	const fixture = buildFixture();
	try {
		const { out } = replay(
			fixture,
			["--upstream", fixture.upstream, "--ci", fixture.ci, "--patch", `model-startup-refresh-barrier=${fixture.aaa}`],
			{ expectFail: true, target: fixture.dir },
		);
		assert.match(out, /already exists|must not equal/);
		assert.equal(HEAD(fixture.dir), fixture.upstream);
	} finally {
		cleanup(fixture);
	}
});

test("the source repository is fully untouched by a replay", () => {
	const fixture = buildFixture();
	const before = execSync("git for-each-ref", { cwd: fixture.dir, encoding: "utf8" });
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `model-startup-refresh-barrier=${fixture.aaa}`,
	]);
	try {
		assert.equal(HEAD(fixture.dir), fixture.upstream);
		assert.equal(execSync("git for-each-ref", { cwd: fixture.dir, encoding: "utf8" }), before);
		assert.equal(execSync("git status --porcelain", { cwd: fixture.dir, encoding: "utf8" }), "");
	} finally {
		cleanup(fixture, target);
	}
});

test("rejects an unknown patch name", () => {
	const fixture = buildFixture();
	try {
		const { out } = replay(fixture, [
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `not-a-real-patch=${fixture.aaa}`,
		], { expectFail: true });
		assert.match(out, /unknown patch input name/);
	} finally {
		cleanup(fixture);
	}
});

test("rejects an explicit subset without --diagnostic", () => {
	const fixture = buildFixture();
	try {
		const { out } = replay(fixture, [
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `model-startup-refresh-barrier=${fixture.aaa}`,
		], { expectFail: true, diagnostic: false });
		assert.match(out, /missing explicit input/);
	} finally {
		cleanup(fixture);
	}
});

test("chain ancestry guard: descendant must contain the predecessor patch tip", () => {
	const fixture = buildFixture();
	try {
		// esc-abort built straight off seam, skipping the mte ancestor.
		const bad = fixture.file("esc.txt", "esc\n", "esc", "patch/esc-abort", "patch/agent-run-failure-seam");
		const { out } = replay(fixture, [
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `agent-run-failure-seam=${fixture.seam}`,
			"--patch", `managed-tool-executions=${fixture.mte}`,
			"--patch", `esc-abort=${bad}`,
		], { expectFail: true });
		assert.match(out, /must descend from patch\/managed-tool-executions/);
	} finally {
		cleanup(fixture);
	}
});

test("a squash conflict fails closed and names the patch", () => {
	const fixture = buildFixture();
	const { out, target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `bun-bytecode-entrypoint=${fixture.conf}`,
	], { expectFail: true });
	try {
		assert.match(out, /merge patch\/bun-bytecode-entrypoint branch conflicts: f\.txt/);
		// No fixup machinery: the conflict stays exactly where git put it.
		const status = execSync("git status --porcelain", { cwd: target, encoding: "utf8" });
		assert.match(status, /UU f\.txt/);
	} finally {
		cleanup(fixture, target);
	}
});

test("rejects a patch that carries a packages/*/CHANGELOG.md hunk", () => {
	const fixture = buildFixture();
	try {
		const { out } = replay(fixture, [
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `vitest-audit-fix=${fixture.offender}`,
		], { expectFail: true });
		assert.match(out, /modifies an upstream-maintained packages\/\*\/CHANGELOG\.md/);
	} finally {
		cleanup(fixture);
	}
});

test("a second replay of the same vector reports the marker already recorded", () => {
	const fixture = buildFixture();
	const args = [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `model-startup-refresh-barrier=${fixture.aaa}`,
	];
	const first = replay(fixture, args);
	try {
		// Point the fixture's main at the recorded marker (as origin/main would
		// look after a published sync) and replay again into a fresh target.
		const marker = execSync("git rev-parse HEAD", { cwd: first.target, encoding: "utf8" }).trim();
		fixture.run(`git fetch -q --no-tags ${first.target} ${marker} && git branch -f main FETCH_HEAD`);
		const { out } = replay(fixture, args);
		assert.match(out, /skipping rebuild/);
	} finally {
		cleanup(fixture, first.target);
	}
});

test("--print-inputs and --print-marker expose the recorded vector without a repo", () => {
	const inputs = execFileSync("bash", [SCRIPT, "--print-inputs"], { encoding: "utf8" });
	assert.match(inputs, /^upstream\/main [0-9a-f]{40}$/m);
	assert.match(inputs, /^patch\/esc-abort [0-9a-f]{40}$/m);
	const marker = execFileSync("bash", [SCRIPT, "--print-marker"], { encoding: "utf8" });
	assert.ok(marker.startsWith("record upstream sync inputs\n\nupstream/main "));
	assert.match(marker, /^applied-order ci contributor-approval /m);
});

test("--check passes when the workflow fetch list matches the recorded inputs", () => {
	let status = 0;
	let err = "";
	try {
		execFileSync("bash", [SCRIPT, "--check"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		status = error.status ?? 1;
		err = String(error.stderr ?? "");
	}
	assert.equal(status, 0, err);
});
