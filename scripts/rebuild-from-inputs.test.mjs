import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "rebuild-from-inputs.sh");

// Disposable fixture repo input vector (rebuilt per test run; SHAs are resolved
// dynamically, so the fixture never depends on recorded object ids).
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
	// ci branch: scripts/ helpers (required for extraction) plus ci.txt and an
	// f.txt edit so patch/conf conflicts with it deterministically.
	run("git checkout -q -B ci upstream-main");
	execFileSync("bash", ["-c", "mkdir -p scripts"], { cwd: dir });
	for (const helper of [
		"rebuild-from-inputs.sh",
		"union-contributor-approvals.py",
		"resolve-model-catalog-squash-conflicts.py",
		"resolve-startup-benchmark-squash-conflicts.sh",
		"resolve-release-self-update-squash-conflicts.sh",
		"resolve-embedded-bun-squash-conflicts.py",
		"resolve-agent-run-failure-seam-squash-conflicts.py",
		"resolve-managed-tool-executions-squash-conflicts.py",
		"resolve-managed-tool-esc-conflicts.py",
		"resolve-manual-retry-conflicts.py",
		"resolve-session-tree-splice-conflicts.py",
	]) {
		writeFileSync(join(dir, "scripts", helper), helper === "rebuild-from-inputs.sh" ? readFileSync(SCRIPT) : `fixture helper ${helper}\n`);
	}
	execFileSync("bash", ["-c", "printf 'ci\\n' > ci.txt && printf 'ci-edited\\n' > f.txt && git add scripts ci.txt f.txt"], { cwd: dir });
	run("git commit -q -m ci-content");
	const ciSha = run("git rev-parse HEAD").trim();
	const aaa = file("aaa.txt", "aaa\n", "aaa", "patch/aaa");
	const empty = (() => {
		run("git checkout -q -B patch/empty upstream-main");
		return commit("emptytip");
	})();
	const conf = file("f.txt", "base\nconflict\n", "conf", "patch/conf");
	const seam = file("seam.txt", "seam\n", "seam", "patch/seam");
	const esc = file("esc.txt", "esc\n", "esc", "patch/esc", "patch/seam");
	const fixup = file("fixup.txt", "fixup\n", "fixup", "patch/fixup");
	// Leave the fixture HEAD deterministic: back on the last patch branch so
	// tests can compare HEAD before/after without depending on checkout order.
	run("git checkout -q patch/fixup");
	return { dir, run, file, upstream, ci: ciSha, aaa, empty, conf, seam, esc, fixup };
}

function replay(fixture, args, { expectFail = false, target, diagnostic = args.includes("--patch") } = {}) {
	// Invoke the script with --source <fixture> --target <fresh-path>; the
	// script clones the fixture itself, so the fixture is the read-only
	// source and the returned target is the owned scratch clone.
	const targetPath = target ?? mkdtempSync(join(tmpdir(), "replay-target-")).replace(/$/, "-fresh");
	let status, out;
	try {
		out = execFileSync("bash", [SCRIPT, "--source", fixture.dir, "--target", targetPath, ...(diagnostic ? ["--diagnostic"] : []), ...args], {
			cwd: fixture.dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		status = 0;
	} catch (error) {
		out = (error.stdout ?? "") + (error.stderr ?? "");
		status = error.status ?? 1;
	}
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

test("applies recorded inputs in the declared fixed order", () => {
	const fixture = buildFixture();
	const { target } = (() => {
		const r = replay(fixture, [
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `model-startup-refresh-barrier=${fixture.aaa}`,
			"--patch", `agent-run-failure-seam=${fixture.seam}`,
			"--patch", `esc-abort=${fixture.esc}`,
		]);
		return r;
	})();
	try {
		const subjects = log(target);
		assert.equal(subjects[0], "base");
		assert.equal(subjects[1], "merge ci branch");
		assert.equal(subjects[2], "merge patch/model-startup-refresh-barrier branch");
		assert.equal(subjects[3], "merge patch/agent-run-failure-seam branch");
		assert.equal(subjects[4], "merge patch/esc-abort branch");
		assert.equal(subjects[subjects.length - 1], "record upstream sync inputs (diagnostic subset)");
		// The final marker records the exact frozen input vector.
		const body = execSync("git show -s --format=%B HEAD", { cwd: target, encoding: "utf8" });
		assert.match(body, new RegExp(`origin/patch/esc-abort ${fixture.esc}`));
		assert.match(body, new RegExp(`origin/ci ${fixture.ci}`));
		// The marker commit is empty: the replay is content-stable.
		const diff = execSync("git show --stat --format= HEAD", { cwd: target, encoding: "utf8" });
		assert.equal(diff.trim(), "");
		// Esc content actually present (replay applied real patches, not no-ops).
		assert.ok(existsSync(join(target, "esc.txt")));
		assert.ok(existsSync(join(target, "seam.txt")));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("stop-before halts exactly before the named mutation and records a partial marker", () => {
	const fixture = buildFixture();
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `model-startup-refresh-barrier=${fixture.aaa}`,
		"--patch", `agent-run-failure-seam=${fixture.seam}`,
		"--patch", `esc-abort=${fixture.esc}`,
		"--stop-before", "agent-run-failure-seam",
	]);
	try {
		const subjects = log(target);
		assert.ok(subjects.includes("merge patch/model-startup-refresh-barrier branch"));
		assert.ok(!subjects.includes("merge patch/agent-run-failure-seam branch"));
		assert.ok(!subjects.includes("merge patch/esc-abort branch"));
		assert.ok(!existsSync(join(target, "seam.txt")));
		// The marker is prefixed: it can never equal the complete-vector key.
		assert.equal(
			subjects[subjects.length - 1],
			"record upstream sync inputs (partial through agent-run-failure-seam)",
		);
		const body = execSync("git show -s --format=%B HEAD", { cwd: target, encoding: "utf8" });
		assert.ok(!body.startsWith("record upstream sync inputs\n\n"), "partial marker must not match the complete key");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("rejects a target path that already exists before any mutation", () => {
	const fixture = buildFixture();
	const existing = mkdtempSync(join(tmpdir(), "replay-existing-"));
	try {
		const { out } = replay(fixture, ["--upstream", fixture.upstream, "--ci", fixture.ci], {
			expectFail: true,
			target: existing,
		});
		assert.match(out, /already exists/);
		// The fixture source is untouched.
		assert.equal(HEAD(fixture.dir), fixture.fixup);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(existing, { recursive: true, force: true });
	}
});

test("rejects source==target before any mutation", () => {
	const fixture = buildFixture();
	try {
		const { out, status } = replay(
			fixture,
			["--upstream", fixture.upstream, "--ci", fixture.ci],
			{ expectFail: true, target: fixture.dir },
		);
		assert.match(out, /already exists|must not equal/);
		// Source HEAD and refs are byte-for-byte intact.
		assert.equal(HEAD(fixture.dir), fixture.fixup);
		assert.equal(
			execSync("git rev-parse patch/esc", { cwd: fixture.dir, encoding: "utf8" }).trim(),
			fixture.esc,
		);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("fresh target succeeds and the source repository is fully untouched", () => {
	const fixture = buildFixture();
	const sourceHeadBefore = HEAD(fixture.dir);
	const refsBefore = execSync("git for-each-ref --format='%(refname) %(objectname)'", {
		cwd: fixture.dir, encoding: "utf8",
	});
	const statusBefore = execSync("git status --porcelain=v1 --untracked-files=all", {
		cwd: fixture.dir, encoding: "utf8",
	});
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `esc-abort=${fixture.esc}`,
		"--patch", `agent-run-failure-seam=${fixture.seam}`,
	]);
	try {
		assert.equal(HEAD(fixture.dir), sourceHeadBefore);
		assert.equal(
			execSync("git for-each-ref --format='%(refname) %(objectname)'", {
				cwd: fixture.dir, encoding: "utf8",
			}),
			refsBefore,
			"source refs must be byte-for-byte identical after a successful replay",
		);
		assert.equal(
			execSync("git status --porcelain=v1 --untracked-files=all", {
				cwd: fixture.dir, encoding: "utf8",
			}),
			statusBefore,
		);
		assert.ok(existsSync(join(target, "esc.txt")));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("linked-worktree source isolation: replay never moves the shared ref store", () => {
	const fixture = buildFixture();
	// Give the fixture a linked worktree on a source-only branch, mimicking an
	// operator checkout.
	fixture.run("git checkout -q -B source-branch upstream-main");
	writeFileSync(join(fixture.dir, "source-only.txt"), "source-only committed content\n");
	fixture.run("git add source-only.txt");
	fixture.run("git commit -q -m source-only");
	const sourceHead = HEAD(fixture.dir);
	const linked = mkdtempSync(join(tmpdir(), "replay-linked-"));
	fixture.run(`git worktree add -qb linked-branch ${linked} source-branch`);
	const originCiBefore = execSync("git rev-parse refs/remotes/origin/ci 2>/dev/null || true", {
		cwd: fixture.dir, encoding: "utf8",
	}).trim();
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `esc-abort=${fixture.esc}`,
		"--patch", `agent-run-failure-seam=${fixture.seam}`,
	]);
	try {
		// Shared object/ref store untouched: no origin/* refs created in source.
		assert.equal(
			execSync("git rev-parse refs/remotes/origin/ci 2>/dev/null || true", {
				cwd: fixture.dir, encoding: "utf8",
			}).trim(),
			originCiBefore,
			"source's refs/remotes/origin/ci must not be created or moved",
		);
		assert.equal(HEAD(fixture.dir), sourceHead);
		assert.equal(
			execSync("git -C " + linked + " rev-parse HEAD", { encoding: "utf8" }).trim(),
			sourceHead,
			"linked worktree HEAD must not move",
		);
		assert.ok(existsSync(join(linked, "source-only.txt")), "linked worktree files intact");
		assert.ok(existsSync(join(target, "esc.txt")));
	} finally {
		fixture.run(`git worktree remove --force ${linked}`);
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("explicitly-passed input SHA that does not resolve fails closed before mutation", () => {
	const fixture = buildFixture();
	const target = join(mkdtempSync(join(tmpdir(), "replay-target-")), "fresh");
	try {
		const { out } = replay(
			fixture,
			[
				"--upstream", fixture.upstream, "--ci", fixture.ci,
				"--patch", `bun-bytecode-entrypoint=${"0".repeat(40)}`,
			],
			{ expectFail: true, target },
		);
		assert.match(out, /patch\/bun-bytecode-entrypoint/);
		assert.match(out, /does not exist locally/);
		assert.equal(HEAD(fixture.dir), fixture.fixup);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("unknown patch input name fails closed before target creation", () => {
	const fixture = buildFixture();
	const target = join(mkdtempSync(join(tmpdir(), "replay-target-")), "fresh");
	try {
		const { out } = replay(
			fixture,
			[
				"--upstream", fixture.upstream,
				"--ci", fixture.ci,
				"--patch", `misspelled-valid-input=${fixture.upstream}`,
			],
			{ expectFail: true, target },
		);
		assert.match(out, /unknown patch input name/);
		assert.match(out, /misspelled-valid-input/);
		assert.ok(!existsSync(target), "target must not be created for an unknown input name");
		assert.equal(HEAD(fixture.dir), fixture.fixup);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("invalid --stop-before step name fails closed before mutation", () => {
	const fixture = buildFixture();
	const target = join(mkdtempSync(join(tmpdir(), "replay-target-")), "fresh");
	try {
		const { out } = replay(
			fixture,
			["--upstream", fixture.upstream, "--ci", fixture.ci, "--stop-before", "not-a-step"],
			{ expectFail: true, target },
		);
		assert.match(out, /unknown --stop-before step/);
		assert.ok(!existsSync(target));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("a run without explicit patches requires the full recorded vector", () => {
	const fixture = buildFixture();
	const target = join(mkdtempSync(join(tmpdir(), "replay-target-")), "fresh");
	try {
		// Fixture objects lack every recorded patch SHA; the full-vector run
		// must fail closed naming the first missing input instead of silently
		// shrinking the order.
		const { out } = replay(
			fixture,
			["--upstream", fixture.upstream, "--ci", fixture.ci],
			{ expectFail: true, target },
		);
		assert.match(out, /patch\/contributor-approval/);
		assert.match(out, /does not exist locally/);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("dirty source worktree is irrelevant: replay consumes only committed ci bytes", () => {
	const fixture = buildFixture();
	// Dirty the source worktree's helper file after checking out ci; the
	// recorded ci commit bytes are what run, not the worktree overlay.
	fixture.run("git checkout -q ci");
	writeFileSync(join(fixture.dir, "scripts", "rebuild-from-inputs.sh"), "malicious\n");
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `esc-abort=${fixture.esc}`,
		"--patch", `agent-run-failure-seam=${fixture.seam}`,
	]);
	try {
		assert.ok(existsSync(join(target, "esc.txt")));
		// Source worktree keeps its dirty bytes intact (never cleaned by the run).
		assert.equal(readFileSync(join(fixture.dir, "scripts", "rebuild-from-inputs.sh"), "utf8"), "malicious\n");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("empty patch integration fails closed", () => {
	const fixture = buildFixture();
	const { target, out } = replay(
		fixture,
		[
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `bun-bytecode-entrypoint=${fixture.empty}`,
		],
		{ expectFail: true },
	);
	try {
		assert.match(out, /Empty patch integration/);
		const subjects = log(target);
		assert.ok(subjects.includes("merge ci branch"));
		assert.ok(!subjects.includes("merge patch/bun-bytecode-entrypoint branch"));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("unexpected squash conflict fails closed without a resolver", () => {
	const fixture = buildFixture();
	const { target, out } = replay(
		fixture,
		[
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `bun-bytecode-entrypoint=${fixture.conf}`,
		],
		{ expectFail: true },
	);
	try {
		assert.match(out, /Unexpected .*squash conflict/);
		const subjects = log(target);
		assert.ok(!subjects.includes("merge patch/bun-bytecode-entrypoint branch"));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("seam-descendant guard fails closed when the child does not descend", () => {
	const fixture = buildFixture();
	const { target, out } = replay(
		fixture,
		[
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `agent-run-failure-seam=${fixture.seam}`,
			"--patch", `esc-abort=${fixture.aaa}`,
		],
		{ expectFail: true },
	);
	try {
		assert.match(out, /must descend from patch\/agent-run-failure-seam/);
		const subjects = log(target);
		assert.ok(subjects.includes("merge patch/agent-run-failure-seam branch"));
		assert.ok(!subjects.includes("merge patch/esc-abort branch"));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("full explicit compat range replays after a fixup lands on the tip", () => {
	const fixture = buildFixture();
	// Add one more commit on top of the recorded esc tip: the frozen input must
	// still replay exactly, proving explicit base..tip semantics instead of
	// assuming tip^ is a universal rule.
	fixture.run("git checkout -q patch/esc");
	writeFileSync(join(fixture.dir, "esc2.txt"), "esc2\n");
	fixture.run("git add esc2.txt");
	fixture.run("git commit -q -m esc-fixup");
	const escFixup = fixture.run("git rev-parse patch/esc").trim();
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `agent-run-failure-seam=${fixture.seam}`,
		"--patch", `esc-abort=${escFixup}`,
	]);
	try {
		const subjects = log(target);
		assert.ok(subjects.includes("merge patch/esc-abort branch"));
		assert.ok(existsSync(join(target, "esc.txt")));
		assert.ok(existsSync(join(target, "esc2.txt")), "fixup content must be replayed");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

for (const scenario of [
	{
		name: "model-refresh-session-rebind",
		ref: "model-refresh-session-rebind-on-accumulated",
		path: "packages/coding-agent/src/core/agent-session.ts",
		content: "private _cacheWarmer?: CacheWarmer;\nprivate _unsubscribeModelsChanged: () => void;\nthis._modelRuntime.onModelsChanged(() => this._refreshModelsFromRuntime())\n",
	},
	{
		name: "slow-hook-tui-only",
		ref: "slow-hook-on-accumulated",
		path: "packages/coding-agent/src/core/extensions/runner.ts",
		content: 'if (ext.uninterruptibleHandlers?.has(handler) === true) continue;\nthis.runHandler("message_end", ext, handlerIndex\n',
	},
]) {
	test(`${scenario.name} production call preserves the initial delta and a later fixup`, () => {
		const fixture = buildFixture();
		let target;
		try {
			// These fixture files satisfy the existing replay guards. The test
			// verifies Git range preservation, not TypeScript runtime behavior.
			const initial = fixture.file(scenario.path, scenario.content, "initial-delta", "compat");
			const tip = fixture.file("later-fixup.txt", "later repair\n", "fixup");
			const args = [
				"--upstream", fixture.upstream, "--ci", fixture.ci,
				"--patch", `${scenario.name}=${initial}`,
				"--patch", `${scenario.ref}=${tip}`,
				"--base", `${scenario.name}=${fixture.upstream}`,
			];
			let splice;
			if (scenario.name === "slow-hook-tui-only") {
				fixture.file("packages/coding-agent/src/core/session-manager.ts", "rmSync,\nunlinkSync,\n", "splice-source", "splice", initial);
				splice = fixture.file("packages/coding-agent/test/suite/harness.ts", "sessionManagerFactory?: (tempDir: string) => SessionManager;\npersist?: boolean;\n", "splice-harness");
				args.push("--patch", `session-tree-splice=${splice}`);
			}
			({ target } = replay(fixture, args));
			assert.equal(readFileSync(join(target, scenario.path), "utf8"), scenario.content);
			assert.equal(readFileSync(join(target, "later-fixup.txt"), "utf8"), "later repair\n");
			const actual = execFileSync("git", ["show", "-s", "--format=%B", "HEAD"], { cwd: target, encoding: "utf8" }).trim();
			const predicted = execFileSync("bash", [SCRIPT, "--diagnostic", "--print-marker", ...args], { encoding: "utf8" }).trim();
			assert.equal(actual, predicted, "preview and actual range provenance must agree");
			assert.ok(actual.includes(`range/patch/${scenario.name} ${fixture.upstream}..${tip}`));
			if (splice) assert.ok(actual.includes(`range/patch/session-tree-splice ${initial}..${splice}`));
		} finally {
			rmSync(fixture.dir, { recursive: true, force: true });
			if (target) rmSync(target, { recursive: true, force: true });
		}
	});
}

test("Esc marker preview equals the actual marker, including its seam range", () => {
	const fixture = buildFixture();
	const args = ["--upstream", fixture.upstream, "--ci", fixture.ci,
		"--patch", `agent-run-failure-seam=${fixture.seam}`, "--patch", `esc-abort=${fixture.esc}`];
	const { target } = replay(fixture, args);
	try {
		const actual = execFileSync("git", ["show", "-s", "--format=%B", "HEAD"], { cwd: target, encoding: "utf8" }).trim();
		const predicted = execFileSync("bash", [SCRIPT, "--diagnostic", "--print-marker", ...args], { encoding: "utf8" }).trim();
		assert.equal(actual, predicted);
		assert.ok(actual.includes(`range/patch/esc-abort ${fixture.seam}..${fixture.esc}`));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("descendant cherry-pick ranges appear identically in preview and actual provenance", () => {
	const fixture = buildFixture();
	const update = fixture.file("update.txt", "update\n", "update", "update", fixture.aaa);
	const bundle = fixture.file("bundle.txt", "bundle\n", "bundle", "bundle", update);
	const args = ["--upstream", fixture.upstream, "--ci", fixture.ci,
		"--patch", `native-wrapper-release=${fixture.aaa}`, "--patch", `update-clean=${update}`,
		"--patch", `bundle-usage-claims=${bundle}`];
	const { target } = replay(fixture, args);
	try {
		const actual = execFileSync("git", ["show", "-s", "--format=%B", "HEAD"], { cwd: target, encoding: "utf8" }).trim();
		const predicted = execFileSync("bash", [SCRIPT, "--diagnostic", "--print-marker", ...args], { encoding: "utf8" }).trim();
		assert.equal(actual, predicted);
		assert.ok(actual.includes(`range/patch/update-clean ${fixture.aaa}..${update}`));
		assert.ok(actual.includes(`range/patch/bundle-usage-claims ${update}..${bundle}`));
		assert.equal(readFileSync(join(target, "bundle.txt"), "utf8"), "bundle\n");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("stop-before ci has identical preview and actual empty-prefix markers", () => {
	const fixture = buildFixture();
	const args = ["--upstream", fixture.upstream, "--ci", fixture.ci,
		"--patch", `model-startup-refresh-barrier=${fixture.aaa}`, "--stop-before", "ci"];
	const { target } = replay(fixture, args);
	try {
		const actual = execFileSync("git", ["show", "-s", "--format=%B", "HEAD"], { cwd: target, encoding: "utf8" }).trim();
		const predicted = execFileSync("bash", [SCRIPT, "--diagnostic", "--print-marker", ...args], { encoding: "utf8" }).trim();
		assert.equal(actual, predicted);
		assert.ok(!actual.includes("origin/patch/"));
		assert.ok(!existsSync(join(target, "ci.txt")));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("an explicit but incomplete full vector fails before creating a target", () => {
	const fixture = buildFixture();
	const { target, out } = replay(fixture, ["--upstream", fixture.upstream, "--ci", fixture.ci,
		"--patch", `model-startup-refresh-barrier=${fixture.aaa}`], { expectFail: true, diagnostic: false });
	try {
		assert.match(out, /missing explicit input/);
		assert.ok(!existsSync(target));
		assert.equal(HEAD(fixture.dir), fixture.fixup);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("a compat carrier without its owning step cannot produce a success marker", () => {
	const fixture = buildFixture();
	const { target, out } = replay(fixture, ["--upstream", fixture.upstream, "--ci", fixture.ci,
		"--patch", `slow-hook-on-accumulated=${fixture.aaa}`], { expectFail: true });
	try {
		assert.match(out, /requires an explicit patch step|requires owning patch/);
		assert.ok(!existsSync(target));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("fresh targets inside the source or its git storage are refused", () => {
	const fixture = buildFixture();
	try {
		for (const target of [join(fixture.dir, "nested-replay"), join(fixture.dir, ".git", "nested-replay")]) {
			const { out } = replay(fixture, ["--upstream", fixture.upstream, "--ci", fixture.ci,
				"--patch", `model-startup-refresh-barrier=${fixture.aaa}`], { expectFail: true, target });
			assert.match(out, /must be outside/);
			assert.ok(!existsSync(target));
		}
		assert.equal(fixture.run("git status --porcelain"), "");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("inherited Git index overrides cannot redirect writes into the source", () => {
	const fixture = buildFixture();
	const target = join(tmpdir(), `${fixture.dir.split("/").pop()}-override-target`);
	const index = join(fixture.dir, ".git", "index");
	const before = readFileSync(index);
	try {
		assert.throws(() => execFileSync("bash", [SCRIPT, "--source", fixture.dir, "--target", target,
			"--diagnostic", "--upstream", fixture.upstream, "--ci", fixture.ci,
			"--patch", `model-startup-refresh-barrier=${fixture.aaa}`], {
			cwd: fixture.dir,
			env: { ...process.env, GIT_INDEX_FILE: index },
			stdio: ["ignore", "pipe", "pipe"],
		}), /repository override variable GIT_INDEX_FILE/);
		assert.deepEqual(readFileSync(index), before);
		assert.ok(!existsSync(target));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("the running driver must match the selected immutable CI commit", () => {
	const fixture = buildFixture();
	const wrongCi = fixture.file("scripts/rebuild-from-inputs.sh", "echo different driver\n", "different-driver", "different-ci", fixture.ci);
	const { target, out } = replay(fixture, ["--upstream", fixture.upstream, "--ci", wrongCi,
		"--patch", `model-startup-refresh-barrier=${fixture.aaa}`], { expectFail: true });
	try {
		assert.match(out, /running replay driver differs from frozen ci input/);
		assert.equal(HEAD(fixture.dir), wrongCi);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("a conflict executes the pinned helper, not newer committed or dirty source copies", () => {
	const fixture = buildFixture();
	fixture.file("packages/agent/src/agent.ts", "ci side\n", "ci-conflict", "ci-conflict", fixture.ci);
	const resolver = "resolve-agent-run-failure-seam-squash-conflicts.py";
	const helper = `from pathlib import Path\nimport subprocess\np = 'packages/agent/src/agent.ts'\nPath(p).write_text('frozen helper result\\n')\nsubprocess.run(['git', 'add', p], check=True)\n`;
	const ci = fixture.file(`scripts/${resolver}`, helper, "frozen-helper");
	const seam = fixture.file("packages/agent/src/agent.ts", "patch side\n", "seam-conflict", "conflicting-seam");
	const newer = fixture.file(`scripts/${resolver}`, "raise SystemExit('wrong newer helper')\n", "newer-helper", "newer-ci", ci);
	writeFileSync(join(fixture.dir, "scripts", resolver), "raise SystemExit('dirty helper')\n");
	const { target } = replay(fixture, ["--upstream", fixture.upstream, "--ci", ci,
		"--patch", `agent-run-failure-seam=${seam}`]);
	try {
		assert.equal(readFileSync(join(target, "packages/agent/src/agent.ts"), "utf8"), "frozen helper result\n");
		assert.equal(HEAD(fixture.dir), newer);
		assert.equal(readFileSync(join(fixture.dir, "scripts", resolver), "utf8"), "raise SystemExit('dirty helper')\n");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("recorded compat bases are explicit SHAs, never tip-derived", () => {
	const out = execFileSync("bash", [SCRIPT, "--print-inputs"], { encoding: "utf8" });
	const lines = out.trim().split("\n");
	const compatStart = lines.indexOf("# compat ranges (explicit base..tip)");
	assert.ok(compatStart >= 0, "print-inputs must expose the compat range block");
	const compat = lines.slice(compatStart + 1);
	assert.equal(compat.length, 3, "three accumulated compat pairs must be recorded");
	const byName = new Map();
	for (const line of compat) {
		const [name, base, ref, tip] = line.split(" ");
		assert.match(base, /^[0-9a-f]{40}$/, `${name} base must be a full SHA`);
		assert.match(tip, /^[0-9a-f]{40}$/, `${name} tip must be a full SHA`);
		assert.ok(ref.length > 0);
		byName.set(name, { base, tip });
	}
	// The recorded bases are the approved fixed inputs, never tip^ inference.
	assert.equal(byName.get("model-refresh-session-rebind").base, "4f2a4ff8d111697b22f4cb35519d1075fed432d5");
	assert.equal(byName.get("model-refresh-timeout").base, "a1d2c1054dc08007b16d40c8156250b2b7985c4e");
	assert.equal(byName.get("slow-hook-tui-only").base, "c50e19e8bc47a936db0a37cc3e46f86b754ea633");
	assert.ok(!byName.has("manual-retry"), "manual retry uses the selected seam, not a stale literal base");
});

test("recorded defaults: every entry is a full SHA and the names are unique", () => {
	const out = execFileSync("bash", [SCRIPT, "--print-inputs"], { encoding: "utf8" });
	const lines = out.trim().split("\n").filter((l) => !l.startsWith("#"));
	assert.ok(lines.length >= 30, `expected the full input vector, got ${lines.length}`);
	const names = new Set();
	for (const line of lines.slice(0, lines.indexOf(lines.find((l) => l.startsWith("model-refresh-session-rebind ") && l.split(" ").length === 4)) >= 0 ? lines.length : lines.length)) {
		const [name, sha] = line.split(" ");
		if (name === "model-refresh-session-rebind" && line.split(" ").length === 4) break;
		assert.match(sha, /^[0-9a-f]{40}$/, `${name} must record a full 40-hex SHA`);
		assert.ok(!names.has(name), `duplicate input name ${name}`);
		names.add(name);
	}
	assert.ok(names.has("upstream/main"));
	assert.ok(names.has("ci"));
	// Accumulated refs are no longer separate patch inputs; they are compat
	// range tips resolved through the recorded patch inputs.
	assert.ok(!names.has("patch/model-refresh-session-rebind-on-accumulated"));
	assert.ok(!names.has("patch/slow-hook-on-accumulated"));
});

test("print-inputs matches the recorded vector consumed by the replay", () => {
	const printed = execFileSync("bash", [SCRIPT, "--print-inputs"], { encoding: "utf8" });
	const source = readFileSync(SCRIPT, "utf8");
	for (const line of printed.trim().split("\n")) {
		if (line.startsWith("#")) continue;
		assert.ok(source.includes(`\n${line}\n`), `printed input not recorded in script: ${line}`);
	}
});

test("print-marker emits the exact record message with origin refs", () => {
	const fixture = buildFixture();
	try {
		const out = execFileSync(
			"bash",
			[
				SCRIPT,
				"--print-marker",
				"--diagnostic",
				"--upstream", fixture.upstream,
				"--ci", fixture.ci,
				"--patch", `esc-abort=${fixture.esc}`,
			],
			{ cwd: fixture.dir, encoding: "utf8" },
		);
		const lines = out.trim().split("\n");
		assert.equal(lines[0], "record upstream sync inputs (diagnostic subset)");
		assert.equal(lines[1], "");
		assert.equal(lines[2], `upstream/main ${fixture.upstream}`);
		assert.equal(lines[3], `origin/ci ${fixture.ci}`);
		assert.ok(lines.includes(`origin/patch/esc-abort ${fixture.esc}`));
		// A subset run records only the named subset, never recorded defaults.
		assert.ok(!lines.some((l) => l.includes("patch/managed-tool-executions")));
		assert.ok(!lines.some((l) => l.includes("patch/model-startup-refresh-barrier")));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("partial marker never collides with the complete-vector skip key", () => {
	const fixture = buildFixture();
	try {
		const full = execFileSync(
			"bash",
			[SCRIPT, "--print-marker", "--diagnostic", "--upstream", fixture.upstream, "--ci", fixture.ci, "--patch", `esc-abort=${fixture.esc}`],
			{ cwd: fixture.dir, encoding: "utf8" },
		);
		const partial = execFileSync(
			"bash",
			[SCRIPT, "--print-marker", "--diagnostic", "--upstream", fixture.upstream, "--ci", fixture.ci, "--patch", `esc-abort=${fixture.esc}`, "--stop-before", "esc-abort"],
			{ cwd: fixture.dir, encoding: "utf8" },
		);
		assert.notEqual(full.split("\n")[0], partial.split("\n")[0]);
		assert.equal(partial.split("\n")[0], "record upstream sync inputs (partial through esc-abort)");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});
