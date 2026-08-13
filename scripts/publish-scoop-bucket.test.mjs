import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const VERSION = "0.84.1-xz.88.1.g9a4c0822";
const TAG = `xz-v${VERSION}`;

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("creates and updates isolated Scoop bucket branch without force push", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-scoop-publish-"));
	const remote = join(root, "remote.git");
	const fixture = join(root, "fixture");
	mkdirSync(fixture);
	git(root, "init", "--bare", remote);
	const manifestPath = join(fixture, "release-manifest.json");
	writeFileSync(
		manifestPath,
		`${JSON.stringify({
			distributionVersion: VERSION,
			tag: TAG,
			bundles: {
				"windows-x64-modern": { file: "pi-windows-x64-modern.zip", sha256: "a".repeat(64) },
				"windows-arm64": { file: "pi-windows-arm64.zip", sha256: "b".repeat(64) },
			},
		})}\n`,
	);
	const env = {
		...process.env,
		GITHUB_REPOSITORY: remote,
		GITHUB_TOKEN: "test",
		RUNNER_TEMP: root,
	};
	try {
		execFileSync("bash", [join(import.meta.dirname, "publish-scoop-bucket.sh"), manifestPath], { env });
		const first = git(root, `--git-dir=${remote}`, "rev-parse", "refs/heads/scoop");
		const manifest = JSON.parse(git(root, `--git-dir=${remote}`, "show", "scoop:bucket/pi.json"));
		assert.equal(manifest.version, VERSION);
		assert.match(manifest.architecture["64bit"].url, /windows-x64-modern\.zip$/);
		assert.match(manifest.architecture.arm64.url, /windows-arm64\.zip$/);

		execFileSync("bash", [join(import.meta.dirname, "publish-scoop-bucket.sh"), manifestPath], { env });
		assert.equal(git(root, `--git-dir=${remote}`, "rev-parse", "refs/heads/scoop"), first);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
