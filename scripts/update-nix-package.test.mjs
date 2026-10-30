import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { TARGETS, hexToSri } from "./update-nix-package.mjs";

const UPDATER = join(import.meta.dirname, "update-nix-package.mjs");
const TEMPLATE = join(import.meta.dirname, "..", "nix", "package.nix");
const VERSION = "1.4.0-xz.999.1.g0123abcd";
const COMMIT = `0123abcd${"ef".repeat(16)}`;
const IDENTITY = "https://github.com/xz-dev/pi/.github/workflows/publish-github-release.yml@refs/heads/main";
const SIGNED_BUNDLE = "fixture-signed-bundle\n";

// Command-boundary fake for `gh attestation verify`: it records argv and accepts
// only the fixture bundle text. It performs no Sigstore, certificate or digest
// verification, so these tests prove what the updater asks gh to enforce and
// that any gh rejection fails closed, not cryptographic acceptance.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$FAKE_GH_LOG"
bundle=
while (($#)); do if [[ $1 == --bundle ]]; then bundle=$2; fi; shift; done
[[ $(cat "$bundle") == fixture-signed-bundle ]] || { echo 'fake gh: bundle rejected' >&2; exit 1; }
`;

const digest = (target) => createHash("sha256").update(target).digest("hex");

function manifestFor(overrides = {}) {
	return {
		schemaVersion: 7,
		repository: "xz-dev/pi",
		tag: `xz-v${VERSION}`,
		distributionVersion: VERSION,
		apiVersion: "1.4.0",
		commit: COMMIT,
		packaging: "binary",
		bundles: Object.fromEntries(
			TARGETS.map((target, index) => [target, { file: `pi-${target}.zip`, bytes: 1000 + index, sha256: digest(target) }]),
		),
		...overrides,
	};
}

function withBundle(target, fields) {
	const manifest = manifestFor();
	manifest.bundles[target] = { ...manifest.bundles[target], ...fields };
	return manifest;
}

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-nix-update-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	const release = join(root, "release");
	mkdirSync(bin);
	mkdirSync(release);
	writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
	const packageNix = join(root, "package.nix");
	copyFileSync(TEMPLATE, packageNix);
	const log = join(root, "gh.log");
	const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GH_LOG: log };
	const manifestPath = join(release, "release-manifest.json");
	const bundlePath = join(release, "attestation-subjects.jsonl");
	return {
		packageNix,
		log,
		bundlePath,
		writeRelease(manifest, bundle = SIGNED_BUNDLE) {
			writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
			if (bundle === null) rmSync(bundlePath, { force: true });
			else writeFileSync(bundlePath, bundle);
			return manifestPath;
		},
		run: (...args) => spawnSync(process.execPath, [UPDATER, ...args], { env, encoding: "utf8" }),
	};
}

test("hexToSri converts 64-character hex to base64 SRI", () => {
	const hex = "06dcdf66d222cae5fe57736e6715b7830db183e93b73992b8f43e3d36bc3344d";
	assert.equal(hexToSri(hex), "sha256-BtzfZtIiyuX+V3NuZxW3gw2xg+k7c5krj0Pj02vDNE0=");
});

test("hexToSri throws on invalid hex", () => {
	assert.throws(() => hexToSri("invalid"), /Invalid sha256 hex digest/);
	assert.throws(() => hexToSri(digest("x").toUpperCase()), /Invalid sha256 hex digest/);
});

test("pins the real package template from an authenticated manifest, idempotently", (t) => {
	const f = fixture(t);
	const manifest = f.writeRelease(manifestFor());
	const template = readFileSync(TEMPLATE, "utf8");

	const first = f.run(manifest, f.packageNix);
	assert.equal(first.status, 0, first.stderr);
	const pinned = readFileSync(f.packageNix, "utf8");
	assert.match(pinned, new RegExp(`^[ \\t]*version \\? "${VERSION.replaceAll(".", "\\.")}",$`, "m"));
	for (const target of TARGETS) assert.ok(pinned.includes(`"${target}" = "${hexToSri(digest(target))}";`), target);
	// Only the version default and the eight hash lines change.
	const pinnedLines = pinned.split("\n");
	assert.equal(pinnedLines.length, template.split("\n").length);
	assert.equal(template.split("\n").filter((line, index) => line !== pinnedLines[index]).length, 1 + TARGETS.length);
	assert.deepEqual(readFileSync(f.log, "utf8").trim().split("\n"), [
		"attestation",
		"verify",
		manifest,
		"--bundle",
		f.bundlePath,
		"--repo",
		"xz-dev/pi",
		"--cert-identity",
		IDENTITY,
		"--source-ref",
		"refs/heads/main",
		"--source-digest",
		COMMIT,
		"--deny-self-hosted-runners",
	]);

	const again = f.run(manifest, f.packageNix);
	assert.equal(again.status, 0, again.stderr);
	assert.match(again.stdout, /already pinned to 1\.4\.0-xz\.999\.1\.g0123abcd/);
	assert.equal(readFileSync(f.packageNix, "utf8"), pinned);

	const check = f.run("--check", manifest, f.packageNix);
	assert.equal(check.status, 0, check.stderr);
	assert.equal(readFileSync(f.packageNix, "utf8"), pinned);
});

test("check mode rejects a stale pin and leaves the file unchanged", (t) => {
	const f = fixture(t);
	const before = readFileSync(f.packageNix);
	const result = f.run("--check", f.writeRelease(manifestFor()), f.packageNix);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /is not pinned to 1\.4\.0-xz\.999\.1\.g0123abcd/);
	assert.deepEqual(readFileSync(f.packageNix), before);
});

const injectedVersion = `${VERSION}\${builtins.abort "unverified version evaluated"}`;
const quotedVersion = `${VERSION}"; src = "`;
const withoutTarget = manifestFor();
delete withoutTarget.bundles["freebsd-x64"];
const rejectedManifests = {
	"a Nix interpolation in the version": manifestFor({ distributionVersion: injectedVersion, tag: `xz-v${injectedVersion}` }),
	"a quote in the version": manifestFor({ distributionVersion: quotedVersion, tag: `xz-v${quotedVersion}` }),
	"a non-downstream version": manifestFor({ distributionVersion: "2.0.0", tag: "xz-v2.0.0", apiVersion: "2.0.0" }),
	"a non-string version": manifestFor({ distributionVersion: [VERSION] }),
	"schema 6": manifestFor({ schemaVersion: 6 }),
	"a foreign repository": manifestFor({ repository: "attacker/pi" }),
	"raw executable packaging": manifestFor({ packaging: "raw-executable" }),
	"a mismatched tag": manifestFor({ tag: "xz-v1.4.0-xz.390.1.g29730c7e" }),
	"a mismatched API version": manifestFor({ apiVersion: "1.3.0" }),
	"a short commit": manifestFor({ commit: "0123abcd" }),
	"a commit outside the version prefix": manifestFor({ commit: "29730c7effbd29d1d83663e7df4a4c4728ab2caa" }),
	"a non-ZIP archive filename": withBundle("linux-x64-gnu-baseline", { file: "not-a-zip" }),
	"another target's archive filename": withBundle("linux-x64-gnu-baseline", { file: "pi-linux-x64-gnu-modern.zip" }),
	"a missing target": withoutTarget,
	"a missing hash": withBundle("darwin-arm64", { sha256: undefined }),
	"a Nix interpolation in a hash": withBundle("darwin-arm64", { sha256: '${builtins.abort "x"}' }),
	"an uppercase hash": withBundle("darwin-arm64", { sha256: digest("darwin-arm64").toUpperCase() }),
	"zero bytes": withBundle("linux-arm64-musl", { bytes: 0 }),
	"fractional bytes": withBundle("linux-arm64-musl", { bytes: 1.5 }),
	"string bytes": withBundle("linux-arm64-musl", { bytes: "1000" }),
};
for (const [name, manifest] of Object.entries(rejectedManifests)) {
	test(`rejects ${name} before verification and leaves package.nix unchanged`, (t) => {
		const f = fixture(t);
		const before = readFileSync(f.packageNix);
		const result = f.run(f.writeRelease(manifest), f.packageNix);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /^Invalid /);
		assert.deepEqual(readFileSync(f.packageNix), before);
		assert.equal(existsSync(f.log), false, "gh must never see unchecked manifest fields");
	});
}

test("a missing proof fails before gh and leaves package.nix unchanged", (t) => {
	const f = fixture(t);
	const before = readFileSync(f.packageNix);
	const result = f.run(f.writeRelease(manifestFor(), null), f.packageNix);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Missing Release attestation bundle/);
	assert.deepEqual(readFileSync(f.packageNix), before);
	assert.equal(existsSync(f.log), false);
});

// The fake rejects both bundles; real gh rejects them for a digest mismatch or
// a certificate identity other than the --cert-identity the updater passes.
for (const [name, bundle] of [
	["a tampered proof", "tampered-bundle\n"],
	["a proof from another signer identity", "bundle-signed-by-a-fork-workflow\n"],
]) {
	test(`${name} fails closed and leaves package.nix unchanged (fake gh)`, (t) => {
		const f = fixture(t);
		const before = readFileSync(f.packageNix);
		const result = f.run(f.writeRelease(manifestFor(), bundle), f.packageNix);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /gh attestation verify rejected/);
		assert.deepEqual(readFileSync(f.packageNix), before);
		assert.ok(readFileSync(f.log, "utf8").split("\n").includes(IDENTITY));
	});
}

test("accepts only [--check] <release-manifest.json> <package.nix>", (t) => {
	const f = fixture(t);
	const manifest = f.writeRelease(manifestFor());
	const before = readFileSync(f.packageNix);
	for (const args of [
		[],
		[manifest],
		[manifest, f.packageNix, "extra"],
		["--manifest", manifest, f.packageNix],
		[manifest, f.packageNix, "--check"],
		["--no-verify", manifest, f.packageNix],
		["--check", "--check", manifest, f.packageNix],
	]) {
		const result = f.run(...args);
		assert.equal(result.status, 1, args.join(" "));
		assert.match(result.stderr, /^Usage: /);
	}
	assert.deepEqual(readFileSync(f.packageNix), before);
	assert.equal(existsSync(f.log), false);
});

test("refuses templates without exactly one version line and one marked hashes block", (t) => {
	const f = fixture(t);
	const manifest = f.writeRelease(manifestFor());
	const template = readFileSync(TEMPLATE, "utf8");
	for (const content of [
		template.replace("# Pre-built release archive checksums", "# Release archive checksums"),
		template.replace(/^[ \t]*version \? .*$/m, (line) => `${line}\n${line}`),
	]) {
		writeFileSync(f.packageNix, content);
		const result = f.run(manifest, f.packageNix);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /package\.nix must contain exactly one/);
		assert.equal(readFileSync(f.packageNix, "utf8"), content);
	}
});
