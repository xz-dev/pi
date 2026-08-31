import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const RESOLVER_PATH = "scripts/resolve-startup-benchmark-squash-conflicts.sh";
const INTERACTIVE_MODE = "packages/coding-agent/src/modes/interactive/interactive-mode.ts";
const TOOL_TEST = "packages/coding-agent/test/tools-manager.test.ts";
const TIMEOUT_TEST = "packages/coding-agent/test/tools-manager-timeout.test.ts";
const CONFLICTS = [INTERACTIVE_MODE, TOOL_TEST];

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

function interactiveText({ managed, benchmark }) {
	return [
		'import { killTrackedDetachedChildren } from "../../utils/shell.ts";',
		...(benchmark ? ['import { markStartupBenchmarkStage } from "../../utils/startup-benchmark.ts";'] : []),
		managed ? 'import { ensureTool, type ToolStatus } from "../../utils/tools-manager.ts";' : 'import { ensureTool } from "../../utils/tools-manager.ts";',
		"async init(): Promise<void> {",
		"\t\tif (this.isInitialized) return;",
		...(benchmark ? ['\t\tmarkStartupBenchmarkStage("init-entered");'] : []),
		"\t\t// Start the UI before initializing extensions so session_start handlers can use interactive dialogs",
		"\t\tthis.ui.start();",
		"\t\tthis.isInitialized = true;",
		...(benchmark ? ['\t\tmarkStartupBenchmarkStage("tui-started");'] : []),
		"\t\tawait this.themeController.applyFromSettings();",
		...(benchmark ? ['\t\tmarkStartupBenchmarkStage("theme-applied");'] : []),
		"",
		"\t\t// Add header with keybindings from config (unless silenced)",
		...(managed ? ["\t\tconst [fdPath] = await Promise.all([ensureTool(\"fd\", report), ensureTool(\"rg\", report)]);"] : ["\t\tconst [fdPath] = await Promise.all([ensureTool(\"fd\"), ensureTool(\"rg\")]);"]),
		"\t\tthis.fdPath = fdPath;",
		...(benchmark ? ['\t\tmarkStartupBenchmarkStage("tools-ready");'] : []),
		"",
		"\t\t// Enable the remaining input handlers only after managed-tool setup completes.",
		"\t\t// Initialize extensions first so resources are shown before messages",
		"\t\tawait this.rebindCurrentSession();",
		...(benchmark ? ['\t\tmarkStartupBenchmarkStage("session-rebound");'] : []),
		"",
		"\t\t// Render initial messages AFTER showing loaded resources",
		"\t\t// Initialize available provider count for footer display",
		"\t\tawait this.updateAvailableProviderCount();",
		...(benchmark ? ['\t\tmarkStartupBenchmarkStage("providers-counted");'] : []),
		"\t}",
	].join("\n") + "\n";
}

function createConflictFixture() {
	const repo = mkdtempSync(join(tmpdir(), "pi-startup-benchmark-conflicts-"));
	git(repo, ["init", "-q", "-b", "base"]);
	git(repo, ["config", "user.name", "test"]);
	git(repo, ["config", "user.email", "test@example.invalid"]);
	write(repo, INTERACTIVE_MODE, interactiveText({ managed: false, benchmark: false }));
	write(repo, TOOL_TEST, "base tool test\n");
	commitAll(repo, "base");

	git(repo, ["switch", "-q", "-c", "integrated"]);
	write(repo, INTERACTIVE_MODE, interactiveText({ managed: true, benchmark: false }));
	write(repo, TOOL_TEST, "managed status test\n");
	commitAll(repo, "integrated");

	git(repo, ["switch", "-q", "base"]);
	git(repo, ["switch", "-q", "-c", "patch"]);
	write(repo, INTERACTIVE_MODE, interactiveText({ managed: false, benchmark: true }));
	write(repo, TOOL_TEST, "bounded probe test\n");
	commitAll(repo, "patch");

	git(repo, ["switch", "-q", "integrated"]);
	const merge = git(repo, ["merge", "--squash", "patch"], { allowFailure: true });
	assert.notEqual(merge.status, 0, "fixture must produce a conflicted squash merge");
	assert.deepEqual(git(repo, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim().split("\n"), CONFLICTS);
	write(repo, RESOLVER_PATH, readFileSync(join(ROOT, RESOLVER_PATH), "utf8"));
	return repo;
}

function removeFixture(repo) {
	rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function mutationSnapshot(repo) {
	return {
		index: git(repo, ["ls-files", "--stage"]).stdout,
		status: git(repo, ["status", "--porcelain=v1", "-z"]).stdout,
		files: CONFLICTS.map((path) => readFileSync(join(repo, path), "utf8")),
	};
}

function callResolver(repo, conflicts) {
	const command = 'source "$1"; shift; resolve_startup_benchmark_squash_conflicts "$@"';
	return spawnSync("bash", ["-c", command, "resolver-test", RESOLVER_PATH, ...conflicts], { cwd: repo, encoding: "utf8" });
}

test("preserves managed-tool status and adds benchmark stages with isolated timeout test", () => {
	const repo = createConflictFixture();
	try {
		const result = spawnSync("bash", [RESOLVER_PATH], { cwd: repo, encoding: "utf8" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(git(repo, ["diff", "--name-only", "--diff-filter=U"]).stdout, "");
		const interactive = readFileSync(join(repo, INTERACTIVE_MODE), "utf8");
		assert.match(interactive, /type ToolStatus/);
		assert.match(interactive, /ensureTool\("fd", report\)/);
		for (const stage of ["init-entered", "tui-started", "theme-applied", "tools-ready", "session-rebound", "providers-counted"]) {
			assert.equal(interactive.match(new RegExp(`markStartupBenchmarkStage\\("${stage}"\\)`, "g"))?.length, 1);
		}
		assert.equal(readFileSync(join(repo, TOOL_TEST), "utf8"), "managed status test\n");
		assert.equal(readFileSync(join(repo, TIMEOUT_TEST), "utf8"), "bounded probe test\n");
	} finally {
		removeFixture(repo);
	}
});

for (const [name, conflicts] of [
	["empty", []],
	["missing", CONFLICTS.slice(0, -1)],
	["additional", [...CONFLICTS, "unexpected.txt"]],
	["reordered", [...CONFLICTS].reverse()],
]) {
	test(`rejects ${name} conflict input without mutation`, () => {
		const repo = createConflictFixture();
		try {
			const before = mutationSnapshot(repo);
			const result = callResolver(repo, conflicts);
			assert.notEqual(result.status, 0, `${name} input must fail`);
			assert.deepEqual(mutationSnapshot(repo), before);
		} finally {
			removeFixture(repo);
		}
	});
}
