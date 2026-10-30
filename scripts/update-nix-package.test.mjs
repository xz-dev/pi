import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hexToSri, patchPackageNix, updateNixPackage } from "./update-nix-package.mjs";

test("hexToSri converts 64-character hex to base64 SRI", () => {
	const hex = "06dcdf66d222cae5fe57736e6715b7830db183e93b73992b8f43e3d36bc3344d";
	assert.equal(hexToSri(hex), "sha256-BtzfZtIiyuX+V3NuZxW3gw2xg+k7c5krj0Pj02vDNE0=");
});

test("hexToSri throws on invalid hex", () => {
	assert.throws(() => hexToSri("invalid"), /Invalid sha256 hex digest/);
});

test("patchPackageNix updates version and platform hashes", () => {
	const original = `
{
  lib,
  stdenv,
  version ? "0.0.1",
}:
let
  hashes = {
    "darwin-arm64" = "sha256-old";
  };
in
stdenv.mkDerivation {
  # Pre-built release archive checksums for each platform from xz-dev/pi
  hashes = {
    "darwin-arm64" = "sha256-old1";
    "darwin-x64-baseline" = "sha256-old2";
    "linux-arm64-gnu" = "sha256-old3";
    "linux-x64-gnu-baseline" = "sha256-old4";
    "linux-arm64-musl" = "sha256-old5";
    "linux-x64-musl-baseline" = "sha256-old6";
    "freebsd-arm64" = "sha256-old7";
    "freebsd-x64" = "sha256-old8";
  };
}
`;

	const sriHashes = {
		"darwin-arm64": "sha256-new1",
		"darwin-x64-baseline": "sha256-new2",
		"linux-arm64-gnu": "sha256-new3",
		"linux-x64-gnu-baseline": "sha256-new4",
		"linux-arm64-musl": "sha256-new5",
		"linux-x64-musl-baseline": "sha256-new6",
		"freebsd-arm64": "sha256-new7",
		"freebsd-x64": "sha256-new8",
	};

	const updated = patchPackageNix(original, "1.2.3", sriHashes);
	assert.match(updated, /version \? "1\.2\.3",/);
	assert.match(updated, /"darwin-arm64" = "sha256-new1";/);
	assert.match(updated, /"freebsd-x64" = "sha256-new8";/);
});

test("updateNixPackage updates file when stale and leaves untouched when current", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-nix-test-"));
	try {
		const samplePackageNix = `
{
  version ? "1.0.0",
}:
let
  # Pre-built release archive checksums for each platform from xz-dev/pi
  hashes = {
    "darwin-arm64" = "sha256-old";
    "darwin-x64-baseline" = "sha256-old";
    "linux-arm64-gnu" = "sha256-old";
    "linux-x64-gnu-baseline" = "sha256-old";
    "linux-arm64-musl" = "sha256-old";
    "linux-x64-musl-baseline" = "sha256-old";
    "freebsd-arm64" = "sha256-old";
    "freebsd-x64" = "sha256-old";
  };
in {}
`;
		const packageNixPath = join(dir, "package.nix");
		writeFileSync(packageNixPath, samplePackageNix);

		const manifest = {
			distributionVersion: "2.0.0",
			bundles: {
				"darwin-arm64": { sha256: "06dcdf66d222cae5fe57736e6715b7830db183e93b73992b8f43e3d36bc3344d" },
				"darwin-x64-baseline": { sha256: "05daac17f6636b4cc1e011a59ff2bb9bff72c557a5b6dc2f436074f6bc847f9c" },
				"linux-arm64-gnu": { sha256: "778385780e1b5ca62124e72a6a5cfb38f1dad34ca6a7ea0a9adb19b689cbe578" },
				"linux-x64-gnu-baseline": { sha256: "95bf8072c24bd4c1e1b9c368960a9a58ce28adf53e87af94e9e04558165c9bd4" },
				"linux-arm64-musl": { sha256: "a71df178fd5ae1a9ad037b15445ad26db020fe12ed2620a139fc934a09ce2817" },
				"linux-x64-musl-baseline": { sha256: "b4ace8e284348aff7ffd21424ab5882b8a6aa5b5bf267745c3246373746adace" },
				"freebsd-arm64": { sha256: "599c6c682bb9cf23da723f4cbccb3ef73e2b3d3346d3f792a356e9825f322a1a" },
				"freebsd-x64": { sha256: "375ec48c74d6af51d62d5997fa2ff9eb4152db3db63ce2ec3d19b3717c82b636" },
			},
		};
		const manifestPath = join(dir, "manifest.json");
		writeFileSync(manifestPath, JSON.stringify(manifest));

		// First run: updates file
		const result1 = await updateNixPackage({
			manifestSource: manifestPath,
			packageNixPath,
		});
		assert.equal(result1.updated, true);
		assert.equal(result1.version, "2.0.0");

		const contentAfter = readFileSync(packageNixPath, "utf8");
		assert.match(contentAfter, /version \? "2\.0\.0",/);
		assert.match(contentAfter, /"darwin-arm64" = "sha256-BtzfZtIiyuX\+V3NuZxW3gw2xg\+k7c5krj0Pj02vDNE0=";/);

		// Second run: no change
		const result2 = await updateNixPackage({
			manifestSource: manifestPath,
			packageNixPath,
		});
		assert.equal(result2.updated, false);
		assert.equal(result2.version, "2.0.0");

		// Check mode passes when up to date
		await assert.doesNotReject(async () => {
			await updateNixPackage({
				manifestSource: manifestPath,
				packageNixPath,
				checkOnly: true,
			});
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
