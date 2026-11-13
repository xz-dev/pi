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
// (common → model, common → seam → mte → esc here) apply as predecessor-relative
// range diffs and must keep the predecessor patch tip in their ancestry.
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
	execFileSync("bash", ["-c", "printf 'ci\\n' > ci.txt && printf 'ci-edited\\n' > f.txt && git add scripts ci.txt f.txt"], { cwd: dir });
	run("git commit -q -m ci-content");
	const ciSha = run("git rev-parse HEAD").trim();
	const common = file("shutdown-contract.txt", "permanent admission\n", "shared shutdown contract", "patch/session-shutdown-contract");
	const aaa = file("aaa.txt", "aaa\n", "aaa", "patch/model-refresh", "patch/session-shutdown-contract");
	const seam = file("seam.txt", "seam\n", "seam", "patch/agent-run-failure-seam", "patch/session-shutdown-contract");
	const mte = file("mte.txt", "mte\n", "mte", "patch/managed-tool-executions", "patch/agent-run-failure-seam");
	const esc = file("esc.txt", "esc\n", "esc", "patch/esc-abort", "patch/managed-tool-executions");
	// Conflict fixture: touches f.txt which ci already edited.
	const conf = file("f.txt", "base\nconflict\n", "conf", "patch/ws-cached-empty-delta");
	// Changelog offender fixture.
	const offender = (() => {
		run("git checkout -q -B patch/quarantine-auth-storage-flake upstream-main");
		mkdirSync(join(dir, "packages", "coding-agent"), { recursive: true });
		writeFileSync(join(dir, "packages", "coding-agent", "CHANGELOG.md"), "offender\n");
		execFileSync("git", ["add", "--", "packages/coding-agent/CHANGELOG.md"], { cwd: dir });
		return commit("offender");
	})();
	run("git checkout -q upstream-main");
	return { dir, run, file, upstream, ci: ciSha, common, aaa, seam, mte, esc, conf, offender };
}

const CHAIN = (fixture) => [
	"--patch", `session-shutdown-contract=${fixture.common}`,
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
		"--patch", `model-refresh=${fixture.aaa}`,
		...CHAIN(fixture),
	]);
	try {
		const subjects = log(target);
		assert.equal(subjects[0], "base");
		assert.equal(subjects[1], "merge ci branch");
		assert.equal(subjects[2], "merge patch/session-shutdown-contract branch");
		assert.equal(subjects[3], "merge patch/model-refresh branch");
		assert.equal(subjects[4], "merge patch/agent-run-failure-seam branch");
		assert.equal(subjects[5], "merge patch/managed-tool-executions branch");
		assert.equal(subjects[6], "merge patch/esc-abort branch");
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

test("shared shutdown contract is integrated once before both real child ranges", () => {
	const fixture = buildFixture();
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream, "--ci", fixture.ci,
		"--patch", `agent-run-failure-seam=${fixture.seam}`,
		"--patch", `model-refresh=${fixture.aaa}`,
		"--patch", `session-shutdown-contract=${fixture.common}`,
	]);
	try {
		assert.deepEqual(log(target), [
			"base", "merge ci branch", "merge patch/session-shutdown-contract branch",
			"merge patch/model-refresh branch", "merge patch/agent-run-failure-seam branch",
			"record upstream sync inputs (diagnostic subset)",
		]);
		assert.equal(readFileSync(join(target, "shutdown-contract.txt"), "utf8"), "permanent admission\n");
		for (const [revision, path] of [["HEAD~3", "shutdown-contract.txt"], ["HEAD~2", "aaa.txt"], ["HEAD~1", "seam.txt"]]) {
			assert.equal(execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", revision], { cwd: target, encoding: "utf8" }).trim(), path);
		}
		for (const child of [fixture.aaa, fixture.seam]) {
			assert.ok(fixture.run(`git rev-list --first-parent ${child}`).trim().split("\n").includes(fixture.common));
			assert.equal(fixture.run(`git rev-list --count ${fixture.common}..${child}`).trim(), "1");
		}
	} finally {
		cleanup(fixture, target);
	}
});

for (const name of ["model-refresh", "agent-run-failure-seam"]) {
	test(`${name} rejects a stale shared shutdown predecessor`, () => {
		const fixture = buildFixture();
		const newerCommon = fixture.file("shutdown-contract.txt", "permanent admission\nindependent cancellation\n", "new shared contract", "patch/session-shutdown-contract", fixture.common);
		const child = name === "model-refresh" ? fixture.aaa : fixture.seam;
		const { target, out } = replay(fixture, [
			"--upstream", fixture.upstream, "--ci", fixture.ci,
			"--patch", `session-shutdown-contract=${newerCommon}`,
			"--patch", `${name}=${child}`,
		], { expectFail: true });
		try {
			assert.ok(out.includes(`patch/${name} must descend from patch/session-shutdown-contract`));
			assert.ok(!log(target).includes(`merge patch/${name} branch`));
		} finally {
			cleanup(fixture, target);
		}
	});

	test(`${name} rejects a shared shutdown ancestor outside its product first-parent chain`, () => {
		const fixture = buildFixture();
		const child = name === "model-refresh" ? fixture.aaa : fixture.seam;
		const merged = execFileSync("git", ["commit-tree", `${child}^{tree}`, "-p", fixture.upstream, "-p", child, "-m", "secondary-only shared contract"], { cwd: fixture.dir, encoding: "utf8" }).trim();
		fixture.run(`git update-ref refs/heads/patch/${name} ${merged}`);
		const { target, out } = replay(fixture, [
			"--upstream", fixture.upstream, "--ci", fixture.ci,
			"--patch", `session-shutdown-contract=${fixture.common}`,
			"--patch", `${name}=${merged}`,
		], { expectFail: true });
		try {
			assert.match(out, /predecessor must be on the product first-parent chain/);
			assert.ok(!log(target).includes(`merge patch/${name} branch`));
		} finally {
			cleanup(fixture, target);
		}
	});
}

test("complete vectors require the shared shutdown owner", () => {
	const fixture = buildFixture();
	const order = readFileSync(SCRIPT, "utf8").match(/^PATCH_ORDER=\(\n([\s\S]*?)^\)/m)[1].trim().split(/\s+/);
	try {
		const { out } = replay(fixture, [
			"--upstream", fixture.upstream, "--ci", fixture.ci,
			...order.filter(name => name !== "session-shutdown-contract").flatMap(name => ["--patch", `${name}=${fixture.upstream}`]),
		], { expectFail: true, diagnostic: false });
		assert.match(out, /missing explicit input patch\/session-shutdown-contract/);
	} finally {
		cleanup(fixture);
	}
});

test("complete marker and workflow declare exactly the common-first 43-owner vector", () => {
	const fixture = buildFixture();
	const order = readFileSync(SCRIPT, "utf8").match(/^PATCH_ORDER=\(\n([\s\S]*?)^\)/m)[1].trim().split(/\s+/);
	try {
		const marker = execFileSync("bash", [SCRIPT, "--print-marker", "--upstream", fixture.upstream, "--ci", fixture.ci,
			...order.flatMap(name => ["--patch", `${name}=${fixture.upstream}`]),
		], { encoding: "utf8" });
		const applied = marker.match(/^applied-order (.*)$/m)[1].split(" ");
		assert.deepEqual(applied, ["ci", ...order]);
		assert.equal(applied.filter(name => name === "session-shutdown-contract").length, 1);
		assert.equal((marker.match(/^origin\/patch\/session-shutdown-contract /gm) ?? []).length, 1);
		assert.equal(order.length, 43);
		assert.equal(new Set(order).size, 43);
		assert.equal(order[0], "session-shutdown-contract");
		assert.ok(!order.includes("chord-registry-gc-observation"));
		const workflow = readFileSync(join(ROOT, ".github/workflows/upstream-sync.yml"), "utf8");
		const fetched = [...workflow.matchAll(/\+refs\/heads\/patch\/([^:]+):refs\/remotes\/origin\/patch\/[^\s]+/g)].map(match => match[1]);
		const resolved = workflow.match(/          for ref in \\\n([\s\S]*?)          ; do/)[1].trim().split(/\s*\\\s*/).filter(Boolean);
		assert.equal(fetched.length, 43);
		assert.equal(resolved.length, 43);
		assert.equal(fetched[0], "session-shutdown-contract");
		assert.equal(resolved[0], "session-shutdown-contract");
		assert.deepEqual([...fetched].sort(), [...order].sort());
		assert.deepEqual([...resolved].sort(), [...order].sort());
	} finally {
		cleanup(fixture);
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
		"--patch", `model-refresh=${fixture.aaa}`,
		...CHAIN(fixture),
		"--stop-before", "managed-tool-executions",
	]);
	try {
		const subjects = log(target);
		assert.ok(subjects.includes("merge patch/model-refresh branch"));
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
		const { out } = replay(fixture, ["--upstream", fixture.upstream, "--ci", fixture.ci, "--patch", `model-refresh=${fixture.aaa}`], {
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
			["--upstream", fixture.upstream, "--ci", fixture.ci, "--patch", `model-refresh=${fixture.aaa}`],
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
		"--patch", `model-refresh=${fixture.aaa}`,
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
			"--patch", `model-refresh=${fixture.aaa}`,
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
		"--patch", `ws-cached-empty-delta=${fixture.conf}`,
	], { expectFail: true });
	try {
		assert.match(out, /merge patch\/ws-cached-empty-delta branch conflicts: f\.txt/);
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
			"--patch", `quarantine-auth-storage-flake=${fixture.offender}`,
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
		"--patch", `model-refresh=${fixture.aaa}`,
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

test("--print-inputs and --print-marker resolve current refs from a source repo", () => {
	// A fixture source with every PATCH_ORDER ref as a local branch, so the test
	// does not depend on the remote-tracking refs of whichever checkout runs it.
	const fixture = buildFixture();
	try {
		const order = readFileSync(SCRIPT, "utf8").match(/^PATCH_ORDER=\(\n([\s\S]*?)^\)/m)[1].trim().split(/\s+/);
		for (const name of order) fixture.run(`git branch -f patch/${name} upstream-main`);
		fixture.run(`git branch -f ci ${fixture.ci}`);
		const inputs = execFileSync("bash", [SCRIPT, "--print-inputs", "--source", fixture.dir], { encoding: "utf8" });
		assert.match(inputs, new RegExp(`^upstream/main ${fixture.upstream}$`, "m"));
		assert.match(inputs, new RegExp(`^ci ${fixture.ci}$`, "m"));
		assert.match(inputs, /^patch\/esc-abort [0-9a-f]{40}$/m);
		const marker = execFileSync("bash", [SCRIPT, "--print-marker", "--source", fixture.dir], { encoding: "utf8" });
		assert.ok(marker.startsWith(`record upstream sync inputs\n\nupstream/main ${fixture.upstream}`));
		assert.match(marker, /^applied-order ci session-shutdown-contract model-refresh /m);
	} finally {
		cleanup(fixture);
	}
});

test("model rebind applies only three own deltas after the shared model prefix without reverting upstream cache warming", () => {
	const fixture = buildFixture();
	const settings = "packages/coding-agent/src/core/settings-defaults.ts";
	const oldUpstream = fixture.file(settings, 'cacheWarming: "streaming"\n', "old cache warming", "upstream-main");
	const upstream = fixture.file(settings, 'cacheWarming: "idle"\n', "upstream idle warming", "upstream-main", oldUpstream);
	const model = fixture.file("aaa.txt", "catalog prefix\n", "model prefix", "patch/model-refresh", upstream);
	let rebind = fixture.file("aaa.txt", "catalog prefix\nsession rebind\n", "rebind metadata", "patch/model-refresh-session-rebind", model);
	rebind = fixture.file("stats.txt", "rebound stats\n", "rebind stats", "patch/model-refresh-session-rebind", rebind);
	rebind = fixture.file("extension.txt", "preserved input limits\n", "rebind extensions", "patch/model-refresh-session-rebind", rebind);
	const { target } = replay(fixture, [
		"--upstream", upstream, "--ci", fixture.ci,
		"--patch", `model-refresh=${model}`,
		"--patch", `model-refresh-session-rebind=${rebind}`,
	]);
	try {
		assert.equal(fixture.run(`git rev-list --count ${model}..${rebind}`).trim(), "3");
		assert.equal(readFileSync(join(target, "aaa.txt"), "utf8"), "catalog prefix\nsession rebind\n");
		assert.equal(readFileSync(join(target, "stats.txt"), "utf8"), "rebound stats\n");
		assert.equal(readFileSync(join(target, "extension.txt"), "utf8"), "preserved input limits\n");
		assert.equal(readFileSync(join(target, settings), "utf8"), 'cacheWarming: "idle"\n');
		assert.deepEqual(log(target), [
			"base", "old cache warming", "upstream idle warming", "merge ci branch",
			"merge patch/model-refresh branch", "merge patch/model-refresh-session-rebind branch",
			"record upstream sync inputs (diagnostic subset)",
		]);
		assert.equal(execFileSync("git", ["show", "HEAD~2:aaa.txt"], { cwd: target, encoding: "utf8" }), "catalog prefix\n");
		assert.deepEqual(execFileSync("git", ["diff", "--name-only", "HEAD~2", "HEAD~1"], { cwd: target, encoding: "utf8" }).trim().split("\n"), ["aaa.txt", "extension.txt", "stats.txt"]);
	} finally {
		cleanup(fixture, target);
	}
});

test("single-executable preserves its catalog settings predecessor range", () => {
	const fixture = buildFixture();
	const single = fixture.file("aaa.txt", "aaa\nupdate-retries\n", "retry", "patch/single-executable", "patch/model-refresh");
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `model-refresh=${fixture.aaa}`,
		"--patch", `single-executable=${single}`,
	]);
	try {
		assert.equal(readFileSync(join(target, "aaa.txt"), "utf8"), "aaa\nupdate-retries\n");
		assert.deepEqual(log(target), [
			"base", "merge ci branch", "merge patch/model-refresh branch",
			"merge patch/single-executable branch", "record upstream sync inputs (diagnostic subset)",
		]);
	} finally {
		cleanup(fixture, target);
	}
});

test("plugin dependency updates apply only their single-executable range after the last patch", () => {
	const fixture = buildFixture();
	// A squash merge would add/add-conflict on aaa.txt; only the declared
	// single-executable..plugin-dependency-updates range applies cleanly.
	const single = fixture.file("aaa.txt", "aaa\nembedded-bun\n", "single", "patch/single-executable", "patch/model-refresh");
	const cards = fixture.file("cards.txt", "prompt card\n", "cards", "patch/prompt-invocation-cards");
	const deps = fixture.file("aaa.txt", "aaa\nembedded-bun\ndependency-refresh\n", "deps", "patch/plugin-dependency-updates", "patch/single-executable");
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `model-refresh=${fixture.aaa}`,
		"--patch", `single-executable=${single}`,
		"--patch", `prompt-invocation-cards=${cards}`,
		"--patch", `plugin-dependency-updates=${deps}`,
	]);
	try {
		assert.equal(readFileSync(join(target, "aaa.txt"), "utf8"), "aaa\nembedded-bun\ndependency-refresh\n");
		assert.equal(readFileSync(join(target, "cards.txt"), "utf8"), "prompt card\n");
		assert.deepEqual(log(target), [
			"base", "merge ci branch", "merge patch/model-refresh branch",
			"merge patch/single-executable branch", "merge patch/prompt-invocation-cards branch",
			"merge patch/plugin-dependency-updates branch", "record upstream sync inputs (diagnostic subset)",
		]);
	} finally {
		cleanup(fixture, target);
	}
});

function buildOwnershipFixture(problem) {
	const fixture = buildFixture();
	const git = (args, input) => execFileSync("git", args, { cwd: fixture.dir, encoding: "utf8", input }).trim();
	const tree = (rows) => git(["mktree"], `${rows.join("\n")}\n`);
	const blob = (content) => git(["hash-object", "-w", "--stdin"], content);
	const commit = (root, parents, message) => git(["commit-tree", root, ...parents.flatMap(parent => ["-p", parent]), "-m", message]);
	const single = fixture.file("aaa.txt", "aaa\nembedded-bun\n", "single", "patch/single-executable", "patch/model-refresh");
	const deps = fixture.file("dependency.txt", "dependency-refresh\n", "deps", "patch/plugin-dependency-updates", "patch/single-executable");
	let ownership = fixture.file("aaa.txt", "aaa\nembedded-bun\nowner-hook\n", "ownership resources", "patch/process-ownership", single);
	ownership = fixture.file("ownership.txt", "owned child\n", "ownership", "patch/process-ownership", ownership);
	let previousSquash;
	const splits = [];
	const squashes = [];
	const nativeTrees = [];
	// Match git-subtree --squash: product merges a separate root-tree squash
	// lineage, while raw native split commits are not reachable from any ref.
	for (let i = 0; i < 3; i++) {
		const nativeTree = tree([`100644 blob ${blob(`native revision ${i}\n`)}\tCargo.toml`]);
		nativeTrees.push(nativeTree);
		const split = commit(nativeTree, splits.slice(-1), `native ${i}`);
		splits.push(split);
		let squashParents = previousSquash ? [previousSquash] : [];
		if (i === 0 && problem === "initial-parent") squashParents = [commit(nativeTree, [], `Prior squash\n\ngit-subtree-dir: vendor/procward\ngit-subtree-split: ${split}`)];
		if (i === 2 && problem === "update-root") squashParents = [];
		if (i === 2 && problem === "wrong-prior-tree") squashParents = [squashes[0]];
		if (i === 1 && problem === "merged-lineage") squashParents = [previousSquash, fixture.upstream];
		let trailers = `git-subtree-dir: vendor/procward\ngit-subtree-split: ${split}`;
		if (i === 2 && problem === "wrong-dir") trailers = trailers.replace("vendor/procward", "vendor/other");
		if (i === 2 && problem === "short-split") trailers = trailers.replace(split, split.slice(0, 12));
		if (i === 2 && problem === "missing-trailers") trailers = "";
		if (i === 2 && problem === "duplicate-trailers") trailers += `\ngit-subtree-split: ${split}`;
		if (i === 0 && problem === "bad-prior-trailers") trailers = "git-subtree-dir: vendor/procward";
		const squash = commit(nativeTree, squashParents, `Squashed vendor/procward changes\n\n${trailers}`);
		squashes.push(squash);
		const vendor = tree([`040000 tree ${nativeTree}\tprocward`]);
		const rows = git(["ls-tree", ownership]).split("\n").filter(row => !row.endsWith("\tvendor"));
		rows.push(`040000 tree ${vendor}\tvendor`);
		if (i === 2 && problem === "unrelated-path") rows.push(`100644 blob ${blob("leaked native root\n")}\tCargo.toml`);
		let root = tree(rows);
		if (i === 2 && problem === "wrong-tree") {
			const wrongVendor = tree([`040000 tree ${nativeTrees[0]}\tprocward`]);
			root = tree([...rows.filter(row => !row.endsWith("\tvendor")), `040000 tree ${wrongVendor}\tvendor`]);
		}
		const parents = [ownership, squash];
		if (i === 2 && problem === "octopus") parents.push(fixture.seam);
		ownership = commit(root, parents, `Merge vendor/procward revision ${i}`);
		previousSquash = squash;
	}
	if (problem === "empty-graft") ownership = commit(git(["rev-parse", `${ownership}^{tree}`]), [ownership, previousSquash], "empty graft");
	if (problem === "feature-merge") {
		const rows = git(["ls-tree", ownership]).split("\n");
		rows.push(`100644 blob ${blob("feature content\n")}\tfeature.txt`);
		ownership = commit(tree(rows), [ownership, fixture.seam], "ordinary feature merge");
	}
	if (problem === "secondary-predecessor") ownership = commit(git(["rev-parse", `${ownership}^{tree}`]), [fixture.upstream, ownership], "integrate ownership");
	git(["update-ref", "refs/heads/patch/process-ownership", ownership]);
	let predecessor = single;
	if (problem === "stale-predecessor") predecessor = fixture.file("new-resource.txt", "new single resource\n", "new single", "patch/single-executable", single);
	fixture.run("git checkout -q upstream-main");
	const args = [
		"--upstream", fixture.upstream, "--ci", fixture.ci,
		"--patch", `process-ownership=${ownership}`,
		"--patch", `plugin-dependency-updates=${deps}`,
		"--patch", `single-executable=${predecessor}`,
		"--patch", `model-refresh=${fixture.aaa}`,
	];
	return { ...fixture, ownership, single, deps, args, splits, nativeTrees };
}

// Capture dirty worktree bytes as well as refs/index: replay only reads source.
function ownershipSourceSnapshot(fixture) {
	return {
		head: HEAD(fixture.dir),
		refs: fixture.run("git for-each-ref"),
		status: fixture.run("git status --porcelain=v2"),
		index: readFileSync(join(fixture.dir, ".git/index")),
		file: readFileSync(join(fixture.dir, "f.txt")),
	};
}

test("process ownership applies only its SingleExe-relative resource and verified native-graft delta last", () => {
	const fixture = buildOwnershipFixture();
	writeFileSync(join(fixture.dir, "f.txt"), "dirty source must survive\n");
	const before = ownershipSourceSnapshot(fixture);
	const { target } = replay(fixture, fixture.args);
	try {
		assert.deepEqual(ownershipSourceSnapshot(fixture), before);
		assert.equal(readFileSync(join(target, "ownership.txt"), "utf8"), "owned child\n");
		assert.equal(readFileSync(join(target, "aaa.txt"), "utf8"), "aaa\nembedded-bun\nowner-hook\n");
		assert.equal(readFileSync(join(target, "dependency.txt"), "utf8"), "dependency-refresh\n");
		assert.deepEqual(log(target), [
			"base", "merge ci branch", "merge patch/model-refresh branch",
			"merge patch/single-executable branch", "merge patch/plugin-dependency-updates branch",
			"merge patch/process-ownership branch", "record upstream sync inputs (diagnostic subset)",
		]);
		assert.equal(execFileSync("git", ["rev-parse", "HEAD:vendor/procward"], { cwd: target, encoding: "utf8" }).trim(), fixture.nativeTrees.at(-1));
		assert.ok(!existsSync(join(target, "Cargo.toml")), "native root files must stay below vendor/procward");
		for (const split of fixture.splits) {
			assert.notEqual(spawnSync("git", ["cat-file", "-e", `${split}^{commit}`], { cwd: target }).status, 0, "raw split objects must not be needed in the fresh squash clone");
		}
		const body = execSync("git show -s --format=%B HEAD", { cwd: target, encoding: "utf8" });
		assert.match(body, new RegExp(`^origin/patch/process-ownership ${fixture.ownership}$`, "m"));
		assert.match(body, /^applied-order ci model-refresh single-executable plugin-dependency-updates process-ownership$/m);
	} finally {
		cleanup(fixture, target);
	}
});

test("process ownership requires an explicit SingleExe predecessor even in diagnostic mode", () => {
	const fixture = buildOwnershipFixture();
	const { target, out } = replay(fixture, [
		"--upstream", fixture.upstream, "--ci", fixture.ci,
		"--patch", `process-ownership=${fixture.ownership}`,
	], { expectFail: true });
	try {
		assert.match(out, /patch\/process-ownership guard requires patch\/single-executable input/);
		assert.ok(!log(target).includes("merge patch/process-ownership branch"));
	} finally {
		cleanup(fixture, target);
	}
});

for (const [problem, diagnostic] of [
	["stale-predecessor", /must descend from patch\/single-executable/],
	["secondary-predecessor", /predecessor must be on the product first-parent chain/],
	["feature-merge", /outside vendor\/procward/],
	["unrelated-path", /outside vendor\/procward/],
	["wrong-tree", /tree must equal the secondary squash root tree/],
	["wrong-dir", /directory and full split trailers/],
	["short-split", /directory and full split trailers/],
	["missing-trailers", /directory and full split trailers/],
	["duplicate-trailers", /directory and full split trailers/],
	["bad-prior-trailers", /directory and full split trailers/],
	["initial-parent", /initial vendor graft requires a root squash/],
	["update-root", /vendor update requires a single-parent squash/],
	["wrong-prior-tree", /lineage must match the preceding vendor\/procward tree/],
	["merged-lineage", /range merge is not on the product first-parent chain|lineage must have zero or one parent|vendor update requires a single-parent squash/],
	["octopus", /only permits two-parent/],
	["empty-graft", /nonempty first-parent diff/],
]) {
	test(`ownership range rejects ${problem} without mutating source`, () => {
		const fixture = buildOwnershipFixture(problem);
		const before = ownershipSourceSnapshot(fixture);
		const { target, out } = replay(fixture, fixture.args, { expectFail: true });
		try {
			assert.match(out, diagnostic);
			assert.deepEqual(ownershipSourceSnapshot(fixture), before);
			assert.ok(!log(target).includes("merge patch/process-ownership branch"));
			assert.ok(!execSync("git show -s --format=%B HEAD", { cwd: target, encoding: "utf8" }).startsWith("record upstream sync inputs"));
		} finally {
			cleanup(fixture, target);
		}
	});
}

test("Codex recovery applies only its delta after retry and cache prerequisites", () => {
	const fixture = buildFixture();
	const patterns = fixture.file("retry-policy.txt", "terminal-patterns\n", "patterns", "patch/retry-non-retryable-patterns");
	const cached = fixture.file("retry-policy.txt", "terminal-patterns\nempty-delta\n", "cached", "patch/ws-cached-empty-delta", "patch/retry-non-retryable-patterns");
	const codex = fixture.file("retry-policy.txt", "terminal-patterns\nempty-delta\ncodex-recovery\n", "codex", "patch/codex-websocket-recovery", "patch/ws-cached-empty-delta");
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `retry-non-retryable-patterns=${patterns}`,
		"--patch", `ws-cached-empty-delta=${cached}`,
		"--patch", `codex-websocket-recovery=${codex}`,
	]);
	try {
		assert.equal(readFileSync(join(target, "retry-policy.txt"), "utf8"), "terminal-patterns\nempty-delta\ncodex-recovery\n");
		const subjects = log(target);
		assert.ok(subjects.indexOf("merge patch/retry-non-retryable-patterns branch") < subjects.indexOf("merge patch/ws-cached-empty-delta branch"));
		assert.ok(subjects.indexOf("merge patch/ws-cached-empty-delta branch") < subjects.indexOf("merge patch/codex-websocket-recovery branch"));
	} finally {
		cleanup(fixture, target);
	}
});

test("Codex recovery rejects a tip that skips its cache predecessor", () => {
	const fixture = buildFixture();
	const patterns = fixture.file("retry-policy.txt", "terminal-patterns\n", "patterns", "patch/retry-non-retryable-patterns");
	const cached = fixture.file("cached.txt", "empty-delta\n", "cached", "patch/ws-cached-empty-delta", "patch/retry-non-retryable-patterns");
	const codex = fixture.file("codex.txt", "codex\n", "codex", "patch/codex-websocket-recovery", "patch/retry-non-retryable-patterns");
	const { target, out } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `retry-non-retryable-patterns=${patterns}`,
		"--patch", `ws-cached-empty-delta=${cached}`,
		"--patch", `codex-websocket-recovery=${codex}`,
	], { expectFail: true });
	try {
		assert.match(out, /patch\/codex-websocket-recovery must descend from patch\/ws-cached-empty-delta/);
	} finally {
		cleanup(fixture, target);
	}
});

test("Responses transport, compression and indicator preserve their predecessor deltas", () => {
	const fixture = buildFixture();
	// Compression integrates its transport-relative range immediately after
	// transport; indicator remains a sibling descendant of transport and its
	// ancestry edge stays responses-websocket-transport, not compression.
	const names = ["retry-non-retryable-patterns", "ws-cached-empty-delta", "codex-websocket-recovery", "responses-websocket-transport", "request-compression", "provider-transport-indicator"];
	const chain = names.slice(0, 5);
	let predecessor = "upstream-main";
	let content = "";
	const args = ["--upstream", fixture.upstream, "--ci", fixture.ci];
	for (const name of chain) {
		content += `${name}\n`;
		const branch = `patch/${name}`;
		const tip = fixture.file("transport.txt", content, name, branch, predecessor);
		args.push("--patch", `${name}=${tip}`);
		predecessor = branch;
	}
	// Indicator is based on the transport tip (its declared predecessor), so
	// its delta carries no compression content and applies as a clean sibling
	// range on top of the already-integrated compression step.
	const indicator = fixture.file("indicator.txt", "provider-transport-indicator\n", "indicator", "patch/provider-transport-indicator", "patch/responses-websocket-transport");
	args.push("--patch", `provider-transport-indicator=${indicator}`);
	const { target } = replay(fixture, args);
	try {
		assert.equal(readFileSync(join(target, "transport.txt"), "utf8"), content);
		assert.equal(readFileSync(join(target, "indicator.txt"), "utf8"), "provider-transport-indicator\n");
		assert.deepEqual(log(target), [
			"base", "merge ci branch",
			...names.map((name) => `merge patch/${name} branch`),
			"record upstream sync inputs (diagnostic subset)",
		]);
	} finally {
		cleanup(fixture, target);
	}
});

test("recovery prerequisites replay as ordered ranges while presentation remains independent", () => {
	const fixture = buildFixture();
	const names = [
		"slow-hook-tui-only",
		"defer-threshold-compaction",
		"startup-submit-readiness",
		"cold-start-retry",
		"compaction-boundary-insert",
		"async-compaction",
		"session-compression",
		"message-origin",
	];
	let predecessor = "upstream-main";
	let content = "";
	const args = ["--upstream", fixture.upstream, "--ci", fixture.ci];
	for (const name of names) {
		content += `${name}\n`;
		const branch = `patch/${name}`;
		const tip = fixture.file("recovery.txt", content, name, branch, predecessor);
		args.push("--patch", `${name}=${tip}`);
		predecessor = branch;
	}
	const presentation = fixture.file("presentation.txt", "visible errors\n", "presentation", "patch/retry-error-presentation");
	args.push("--patch", `retry-error-presentation=${presentation}`);
	const { target } = replay(fixture, args);
	try {
		assert.equal(readFileSync(join(target, "recovery.txt"), "utf8"), content);
		assert.equal(readFileSync(join(target, "presentation.txt"), "utf8"), "visible errors\n");
		assert.deepEqual(log(target), [
			"base", "merge ci branch",
			...names.slice(0, -1).map((name) => `merge patch/${name} branch`),
			"merge patch/retry-error-presentation branch",
			"merge patch/message-origin branch",
			"record upstream sync inputs (diagnostic subset)",
		]);
	} finally {
		cleanup(fixture, target);
	}
});

test("session compression applies only its async-compaction range in the next step", () => {
	const fixture = buildFixture();
	const background = fixture.file("storage.txt", "usage-aware publication\n", "background", "patch/async-compaction");
	const compression = fixture.file("storage.txt", "usage-aware publication\ncompressed publication\n", "compression", "patch/session-compression", "patch/async-compaction");
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream, "--ci", fixture.ci,
		"--patch", `async-compaction=${background}`,
		"--patch", `session-compression=${compression}`,
	]);
	try {
		assert.equal(readFileSync(join(target, "storage.txt"), "utf8"), "usage-aware publication\ncompressed publication\n");
		assert.deepEqual(log(target), [
			"base", "merge ci branch", "merge patch/async-compaction branch",
			"merge patch/session-compression branch", "record upstream sync inputs (diagnostic subset)",
		]);
	} finally {
		cleanup(fixture, target);
	}
});

test("upstream websocket declarations support independent consumers without duplicate repair input", () => {
	const fixture = buildFixture();
	const deps = JSON.stringify({ devDependencies: { "@types/ws": "8.18.2", ws: "8.21.0" } });
	const upstream = fixture.file("packages/chord/package.json", deps, "upstream websocket declarations", "upstream-main");
	const single = fixture.file("binary.txt", "portable entry\n", "single", "patch/single-executable");
	const thinking = fixture.file("thinking.txt", "thinking preview\n", "thinking", "patch/thinking-preview");
	const { target } = replay(fixture, [
		"--upstream", upstream, "--ci", fixture.ci,
		"--patch", `thinking-preview=${thinking}`, "--patch", `single-executable=${single}`,
	]);
	try {
		assert.equal(readFileSync(join(target, "packages/chord/package.json"), "utf8"), deps);
		assert.equal(readFileSync(join(target, "binary.txt"), "utf8"), "portable entry\n");
		assert.equal(readFileSync(join(target, "thinking.txt"), "utf8"), "thinking preview\n");
		assert.deepEqual(log(target), [
			"base", "upstream websocket declarations", "merge ci branch",
			"merge patch/single-executable branch", "merge patch/thinking-preview branch",
			"record upstream sync inputs (diagnostic subset)",
		]);
	} finally {
		cleanup(fixture, target);
	}
});

for (const diagnostic of [false, true]) {
	test(`retired test-dependency input is rejected (diagnostic=${diagnostic})`, () => {
		const fixture = buildFixture();
		try {
			const { out } = replay(fixture, [
				"--upstream", fixture.upstream, "--ci", fixture.ci,
				"--patch", `chord-websocket-test-deps=${fixture.upstream}`,
			], { expectFail: true, diagnostic });
			assert.match(out, /unknown patch input name: chord-websocket-test-deps/);
		} finally {
			cleanup(fixture);
		}
	});
}

for (const consumer of ["single-executable", "thinking-preview", "env-native-test-fixtures"]) {
	test(`${consumer} still rejects an empty integration`, () => {
		const fixture = buildFixture();
		const { target, out } = replay(fixture, [
			"--upstream", fixture.upstream, "--ci", fixture.ci,
			"--patch", `${consumer}=${fixture.upstream}`,
		], { expectFail: true });
		try {
			assert.ok(out.includes(`Empty patch integration for merge patch/${consumer} branch`));
		} finally {
			cleanup(fixture, target);
		}
	});
}

for (const [ancestor, descendant] of [
	["session-shutdown-contract", "model-refresh"],
	["session-shutdown-contract", "agent-run-failure-seam"],
	["model-refresh", "model-refresh-session-rebind"],
	["model-refresh", "single-executable"],
	["single-executable", "plugin-dependency-updates"],
	["slow-hook-tui-only", "defer-threshold-compaction"],
	["defer-threshold-compaction", "startup-submit-readiness"],
	["startup-submit-readiness", "cold-start-retry"],
	["cold-start-retry", "compaction-boundary-insert"],
	["session-compression", "message-origin"],
	["compaction-boundary-insert", "async-compaction"],
	["async-compaction", "session-compression"],
	["message-origin", "collapse-expanded-input"],
	["collapse-expanded-input", "prompt-invocation-cards"],
	["retry-non-retryable-patterns", "ws-cached-empty-delta"],
	["codex-websocket-recovery", "responses-websocket-transport"],
	["responses-websocket-transport", "request-compression"],
	["responses-websocket-transport", "provider-transport-indicator"],
]) {
	test(`${descendant} rejects a tip missing ${ancestor}`, () => {
		const fixture = buildFixture();
		const predecessor = fixture.file("predecessor.txt", "prerequisite\n", ancestor, `patch/${ancestor}`);
		const bad = fixture.file("descendant.txt", "missing prerequisite\n", descendant, `patch/${descendant}`);
		const { target, out } = replay(fixture, [
			"--upstream", fixture.upstream, "--ci", fixture.ci,
			"--patch", `${ancestor}=${predecessor}`,
			"--patch", `${descendant}=${bad}`,
		], { expectFail: true });
		try {
			assert.ok(out.includes(`patch/${descendant} must descend from patch/${ancestor}`));
		} finally {
			cleanup(fixture, target);
		}
	});
}

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

test("native fixture owner is independent, countable and last without changing unrelated owners", () => {
	const fixture = buildFixture();
	const overrides = fixture.file("locale.txt", "locale\n", "locale", "patch/env-overrides");
	const freebsd = fixture.file("freebsd.txt", "freebsd\n", "freebsd", "patch/freebsd-support");
	fixture.file("packages/env/test/daemon.ts", "target oracle\n", "oracle", "patch/env-native-test-fixtures");
	const native = fixture.file("packages/env/test/remote.test.ts", "native observations\n", "observations", "patch/env-native-test-fixtures", "patch/env-native-test-fixtures");
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream, "--ci", fixture.ci,
		"--patch", `env-native-test-fixtures=${native}`,
		"--patch", `freebsd-support=${freebsd}`,
		"--patch", `env-overrides=${overrides}`,
	]);
	try {
		assert.deepEqual(log(target), ["base", "merge ci branch", "merge patch/env-overrides branch", "merge patch/freebsd-support branch", "merge patch/env-native-test-fixtures branch", "record upstream sync inputs (diagnostic subset)"]);
		assert.equal(readFileSync(join(target, "locale.txt"), "utf8"), "locale\n");
		assert.equal(readFileSync(join(target, "freebsd.txt"), "utf8"), "freebsd\n");
		assert.equal(fixture.run(`git merge-base ${native} ${fixture.upstream}`).trim(), fixture.upstream);
		assert.deepEqual(execSync('git diff --name-only HEAD~2 HEAD~1', { cwd: target, encoding: "utf8" }).trim().split("\n"), ["packages/env/test/daemon.ts", "packages/env/test/remote.test.ts"]);
	} finally {
		cleanup(fixture, target);
	}
});

test("complete vectors require the native fixture owner", () => {
	const fixture = buildFixture();
	const order = readFileSync(SCRIPT, "utf8").match(/^PATCH_ORDER=\(\n([\s\S]*?)^\)/m)[1].trim().split(/\s+/);
	try {
		const { out } = replay(fixture, [
			"--upstream", fixture.upstream, "--ci", fixture.ci,
			...order.filter(name => name !== "env-native-test-fixtures").flatMap(name => ["--patch", `${name}=${fixture.upstream}`]),
		], { expectFail: true, diagnostic: false });
		assert.match(out, /missing explicit input patch\/env-native-test-fixtures/);
	} finally {
		cleanup(fixture);
	}
});

test("complete vectors require the process ownership owner", () => {
	const fixture = buildFixture();
	const order = readFileSync(SCRIPT, "utf8").match(/^PATCH_ORDER=\(\n([\s\S]*?)^\)/m)[1].trim().split(/\s+/);
	try {
		const { out } = replay(fixture, [
			"--upstream", fixture.upstream, "--ci", fixture.ci,
			...order.filter(name => name !== "process-ownership").flatMap(name => ["--patch", `${name}=${fixture.upstream}`]),
		], { expectFail: true, diagnostic: false });
		assert.match(out, /missing explicit input patch\/process-ownership/);
	} finally {
		cleanup(fixture);
	}
});

test("native workflow gate binds daemon metadata to build targets and keeps Darwin red control", () => {
	const workflow = readFileSync(join(ROOT, ".github/workflows/env.yml"), "utf8");
	const builds = readFileSync(join(ROOT, ".github/workflows/env-daemons.yml"), "utf8");
	for (const [name, target] of [
		["linux-x64", "x86_64-unknown-linux-musl"], ["linux-arm64", "aarch64-unknown-linux-musl"],
		["darwin-x64", "x86_64-apple-darwin"], ["darwin-arm64", "aarch64-apple-darwin"],
		["windows-x64", "x86_64-pc-windows-msvc"], ["windows-arm64", "aarch64-pc-windows-msvc"],
	]) {
		assert.ok(builds.includes(`target: ${target}, name: ${name}`));
		assert.ok(workflow.includes(`name: ${name} }`));
	}
	assert.ok(workflow.includes("PI_ENV_DAEMON_TARGET: ${{ matrix.name }}"));
	assert.ok(workflow.includes("PI_ENV_DAEMON_TARGET: darwin-arm64"));
	assert.ok(workflow.includes("run: softwareupdate --install-rosetta --agree-to-license"));
	assert.ok(workflow.indexOf('PI_ENV_DAEMON="$daemon" npx vitest --run') < workflow.indexOf("Reject a wrong Darwin daemon target oracle"));
	assert.equal((workflow.match(/--reporter=verbose --disableConsoleIntercept/g) ?? []).length, 2);
	assert.ok(workflow.includes("assert.equal(run.status, 1);"));
	assert.ok(workflow.includes("assert.equal(oracle[0].status, 'failed');"));
	const sync = readFileSync(join(ROOT, ".github/workflows/upstream-sync.yml"), "utf8");
	assert.ok(sync.includes("refs/heads/patch/env-native-test-fixtures:refs/remotes/origin/patch/env-native-test-fixtures"));
	assert.ok(sync.includes("            env-native-test-fixtures \\\n"));
	const order = readFileSync(SCRIPT, "utf8").match(/^PATCH_ORDER=\(\n([\s\S]*?)^\)/m)[1].trim().split(/\s+/);
	assert.equal(order.length, 43);
	assert.equal(order[0], "session-shutdown-contract");
	assert.equal(order.filter(name => name === "session-shutdown-contract").length, 1);
	assert.equal(order[order.indexOf("async-compaction") + 1], "session-compression");
	assert.ok(sync.includes("refs/heads/patch/session-compression:refs/remotes/origin/patch/session-compression"));
	assert.ok(sync.includes("            session-compression \\\n"));
	for (const file of ["session-disk-compression.test.ts", "agent-session-runtime-events.test.ts"]) {
		assert.ok(sync.includes(`test/${file}`));
	}
	for (const file of ["session-compression.test.ts", "session-compression-cli.test.ts", "session-compression-integration.test.ts"]) {
		assert.ok(!sync.includes(`test/${file}`));
	}
	const downstreamChanges = readFileSync(join(ROOT, "docs/downstream-changes.md"), "utf8");
	assert.equal(order.at(-1), "process-ownership");
	assert.ok(sync.includes("refs/heads/patch/process-ownership:refs/remotes/origin/patch/process-ownership"));
	assert.ok(sync.includes("            process-ownership \\\n"));
	assert.equal(order[order.indexOf("single-executable") + 1], "env-process-output-drain");
	assert.equal(order[order.indexOf("env-process-output-drain") + 1], "agent-run-failure-seam");
	assert.ok(!order.includes("chord-registry-gc-observation"));
	assert.ok(!sync.includes("refs/heads/patch/chord-registry-gc-observation"));
	assert.ok(!sync.includes("            chord-registry-gc-observation \\\n"));
	assert.ok(!order.includes("mimo-thinking-toggle-test"));
	assert.ok(!sync.includes("refs/heads/patch/mimo-thinking-toggle-test"));
	assert.equal(order.at(-8), "env-native-test-fixtures");
	assert.equal(order.at(-7), "preserve-tool-arguments-json");
	assert.equal(order.at(-6), "responses-background-replay");
	assert.equal(order.at(-5), "ws-retry-jitter");
	assert.equal(order.at(-4), "collapse-expanded-input");
	assert.equal(order.at(-3), "prompt-invocation-cards");
	assert.equal(order.at(-2), "plugin-dependency-updates");
	for (const name of ["env-process-output-drain", "collapse-expanded-input", "prompt-invocation-cards", "plugin-dependency-updates"]) {
		assert.ok(sync.includes(`refs/heads/patch/${name}:refs/remotes/origin/patch/${name}`));
		assert.ok(sync.includes(`            ${name} \\\n`));
		assert.ok(downstreamChanges.includes(`patch/${name}`));
	}
	assert.ok(sync.includes("refs/heads/patch/preserve-tool-arguments-json:refs/remotes/origin/patch/preserve-tool-arguments-json"));
	assert.ok(sync.includes("            preserve-tool-arguments-json \\\n"));
	assert.ok(!order.includes("model-catalog-test-fixtures"));
	assert.ok(!sync.includes("refs/heads/patch/model-catalog-test-fixtures"));
	assert.ok(!sync.includes("            model-catalog-test-fixtures \\\n"));
	assert.ok(downstreamChanges.includes("patch/env-native-test-fixtures"));
	assert.ok(downstreamChanges.includes("patch/model-catalog-test-fixtures"));
	assert.ok(downstreamChanges.includes("Tests and assertions remain upstream; no skip is added."));
});
