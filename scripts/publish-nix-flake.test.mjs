import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { hexToSri, patchPackageNix, TARGETS } from "./update-nix-package.mjs";

const ROOT = join(import.meta.dirname, "..");
const PUBLISHER = join(import.meta.dirname, "publish-nix-flake.sh");
const FLAKE_FILES = ["flake.lock", "flake.nix", "nix/package.nix"];
const SIGNED_BUNDLE = "fixture-signed-bundle\n";

// Command-boundary fake for `gh attestation verify`: it records argv and accepts
// only the fixture bundle text; it performs no Sigstore or certificate checks.
// FAKE_GH_MOVE_MAIN simulates main advancing while verification runs.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$FAKE_GH_LOG"
if [[ -n \${FAKE_GH_MOVE_MAIN:-} ]]; then git --git-dir="$FAKE_GH_REMOTE" update-ref refs/heads/main "$FAKE_GH_MOVE_MAIN"; fi
bundle=
while (($#)); do if [[ $1 == --bundle ]]; then bundle=$2; fi; shift; done
[[ $(cat "$bundle") == fixture-signed-bundle ]] || { echo 'fake gh: bundle rejected' >&2; exit 1; }
`;

function setup(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-nix-publish-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const remote = join(root, "remote.git");
	const main = join(root, "main");
	const bin = join(root, "bin");
	mkdirSync(main);
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
	const env = {
		...process.env,
		PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
		GITHUB_REPOSITORY: remote,
		GITHUB_TOKEN: "unused-for-local-remotes",
		RUNNER_TEMP: root,
		FAKE_GH_LOG: join(root, "gh.log"),
		FAKE_GH_REMOTE: remote,
	};
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) delete env[key];
	const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
	const remoteGit = (...args) => spawnSync("git", [`--git-dir=${remote}`, ...args], { env, encoding: "utf8" });
	git(root, "init", "-q", "--bare", remote);
	// Any non-fast-forward update of the remote is rejected, not merely unused.
	git(root, `--git-dir=${remote}`, "config", "receive.denyNonFastForwards", "true");
	git(main, "init", "-q");
	git(main, "config", "user.name", "fixture");
	git(main, "config", "user.email", "fixture@example.invalid");
	git(main, "config", "commit.gpgsign", "false");
	let commits = 0;
	return {
		root,
		remote,
		git,
		/** Commit to the fixture main repository and push it to `ref` of the remote. */
		commit(ref = "refs/heads/main") {
			commits += 1;
			writeFileSync(join(main, "main.txt"), `${commits}\n`);
			git(main, "add", "main.txt");
			git(main, "commit", "-qm", `main ${commits}`);
			git(main, "push", "-q", remote, `HEAD:${ref}`);
			return git(main, "rev-parse", "HEAD");
		},
		/** Write a Release manifest, its proof and the flake the native builds accepted for it. */
		release(commit, { bundle = SIGNED_BUNDLE, manifest: overrides = {} } = {}) {
			const dir = mkdtempSync(join(root, "release-"));
			const version = `1.4.0-xz.${commits}.1.g${commit.slice(0, 8)}`;
			const digests = Object.fromEntries(
				TARGETS.map((target) => [target, createHash("sha256").update(`${version}:${target}`).digest("hex")]),
			);
			const manifest = {
				schemaVersion: 7,
				repository: "xz-dev/pi",
				tag: `xz-v${version}`,
				distributionVersion: version,
				apiVersion: "1.4.0",
				commit,
				packaging: "binary",
				bundles: Object.fromEntries(
					TARGETS.map((target) => [target, { file: `pi-${target}.zip`, bytes: 4096, sha256: digests[target] }]),
				),
				...overrides,
			};
			writeFileSync(join(dir, "release-manifest.json"), `${JSON.stringify(manifest)}\n`);
			if (bundle !== null) writeFileSync(join(dir, "attestation-subjects.jsonl"), bundle);
			const flake = join(dir, "flake");
			mkdirSync(join(flake, "nix"), { recursive: true });
			copyFileSync(join(ROOT, "flake.nix"), join(flake, "flake.nix"));
			copyFileSync(join(ROOT, "flake.lock"), join(flake, "flake.lock"));
			const sri = Object.fromEntries(TARGETS.map((target) => [target, hexToSri(digests[target])]));
			const packageNix = patchPackageNix(readFileSync(join(ROOT, "nix", "package.nix"), "utf8"), version, sri);
			writeFileSync(join(flake, "nix", "package.nix"), packageNix);
			return { manifest: join(dir, "release-manifest.json"), flake, version, packageNix };
		},
		publish: (release, extraEnv = {}) =>
			spawnSync("bash", [PUBLISHER, release.manifest, release.flake], {
				env: { ...env, ...extraEnv },
				encoding: "utf8",
			}),
		ref: (name) => remoteGit("rev-parse", "--verify", "-q", name).stdout.trim(),
		files: (rev) => remoteGit("ls-tree", "-r", "--name-only", rev).stdout.trim().split("\n"),
		show: (...args) => remoteGit("show", ...args).stdout,
		remoteGit,
	};
}

function snapshotTemplates() {
	return FLAKE_FILES.map((file) => readFileSync(join(ROOT, file)));
}

test("creates, keeps and fast-forwards the unrelated-root nix branch", (t) => {
	const s = setup(t);
	const templates = snapshotTemplates();
	const main1 = s.commit();
	const first = s.release(main1);

	const created = s.publish(first);
	assert.equal(created.status, 0, created.stderr);
	assert.match(created.stdout, new RegExp(`Nix flake branch updated to ${first.version}`));
	const nix1 = s.ref("refs/heads/nix");
	assert.match(nix1, /^[0-9a-f]{40}$/);
	assert.deepEqual(s.files("refs/heads/nix"), FLAKE_FILES);
	assert.equal(s.show("refs/heads/nix:flake.nix"), readFileSync(join(ROOT, "flake.nix"), "utf8"));
	assert.equal(s.show("refs/heads/nix:flake.lock"), readFileSync(join(ROOT, "flake.lock"), "utf8"));
	assert.equal(s.show("refs/heads/nix:nix/package.nix"), first.packageNix);
	assert.equal(s.remoteGit("rev-list", "--max-parents=0", "refs/heads/nix").stdout.trim(), nix1);
	assert.equal(s.remoteGit("merge-base", "refs/heads/main", "refs/heads/nix").status, 1, "nix must be unrelated to main");
	assert.equal(s.ref("refs/heads/main"), main1);

	const repeated = s.publish(first);
	assert.equal(repeated.status, 0, repeated.stderr);
	assert.match(repeated.stdout, /Nix flake branch already current/);
	assert.equal(s.ref("refs/heads/nix"), nix1);

	const main2 = s.commit();
	const second = s.release(main2);
	const updated = s.publish(second);
	assert.equal(updated.status, 0, updated.stderr);
	const nix2 = s.ref("refs/heads/nix");
	assert.notEqual(nix2, nix1);
	assert.equal(s.ref("refs/heads/nix^"), nix1, "the update must fast-forward the previous tip");
	assert.deepEqual(s.files("refs/heads/nix"), FLAKE_FILES);
	assert.equal(s.show("refs/heads/nix:nix/package.nix"), second.packageNix);
	assert.equal(s.show("-s", "--format=%s", "refs/heads/nix"), `Update pi to ${second.version}\n`);

	// A delayed run for the older Release must not downgrade the branch.
	const historical = s.publish(first);
	assert.equal(historical.status, 0, historical.stderr);
	assert.match(historical.stdout, /skipped for historical Release/);
	assert.equal(s.ref("refs/heads/nix"), nix2);
	assert.equal(s.ref("refs/heads/main"), main2);
	assert.deepEqual(snapshotTemplates(), templates, "templates in the source checkout must stay untouched");
});

test("replaces stale content of an existing nix branch with the exact three-file tree", (t) => {
	const s = setup(t);
	const stale = join(s.root, "stale");
	mkdirSync(join(stale, "nix"), { recursive: true });
	s.git(stale, "init", "-q");
	writeFileSync(join(stale, "README.md"), "stale\n");
	writeFileSync(join(stale, "nix", "old.nix"), "{ }\n");
	s.git(stale, "add", "-A");
	s.git(stale, "-c", "user.name=f", "-c", "user.email=f@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "stale");
	s.git(stale, "push", "-q", s.remote, "HEAD:refs/heads/nix");
	const staleTip = s.ref("refs/heads/nix");

	const result = s.publish(s.release(s.commit()));
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(s.files("refs/heads/nix"), FLAKE_FILES);
	assert.equal(s.ref("refs/heads/nix^"), staleTip);
});

test("rechecks main before pushing and skips when it moved during verification", (t) => {
	const s = setup(t);
	const main1 = s.commit();
	const next = s.commit("refs/heads/next");
	const result = s.publish(s.release(main1), { FAKE_GH_MOVE_MAIN: next });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /skipped: main moved before push/);
	assert.equal(s.ref("refs/heads/nix"), "");
	assert.equal(s.ref("refs/heads/main"), next);
});

test("fails closed on missing or rejected proof, invalid manifests and unbuilt flakes", (t) => {
	const s = setup(t);
	const published = s.release(s.commit());
	assert.equal(s.publish(published).status, 0);
	const tip = s.ref("refs/heads/nix");
	const current = s.commit();
	const tampered = s.release(current);
	writeFileSync(join(tampered.flake, "nix", "package.nix"), `${tampered.packageNix}# unbuilt edit\n`);
	const extraFile = s.release(current);
	writeFileSync(join(extraFile.flake, "README.md"), "not built\n");
	const notACommit = s.release(current, { manifest: { commit: "main" } });
	for (const [name, release, message] of [
		["missing proof", s.release(current, { bundle: null }), /Missing Release attestation bundle/],
		["rejected proof", s.release(current, { bundle: "tampered-bundle\n" }), /gh attestation verify rejected/],
		["invalid manifest", s.release(current, { manifest: { schemaVersion: 6 } }), /Invalid GitHub Release manifest/],
		["unknown source commit", notACommit, /Invalid Nix release manifest commit/],
		["edited built flake", tampered, /Built Nix flake differs/],
		["extra built file", extraFile, /Built Nix flake differs/],
	]) {
		const result = s.publish(release);
		assert.notEqual(result.status, 0, name);
		assert.match(result.stderr, message, name);
		assert.equal(s.ref("refs/heads/nix"), tip, name);
	}
	assert.equal(s.ref("refs/heads/main"), current);
});

test("requires exactly a manifest and a built flake and never force-pushes", () => {
	const result = spawnSync("bash", [PUBLISHER, "release-manifest.json"], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^Usage: /);
	const publisher = readFileSync(PUBLISHER, "utf8");
	assert.doesNotMatch(publisher, /--force|\+HEAD|\+refs/);
	assert.match(publisher, /push -q origin HEAD:refs\/heads\/nix\n/);
});
