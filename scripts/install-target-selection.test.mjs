import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ATTESTATION_BUNDLE_FILENAME, generateInstallPs1, generateInstallSh } from "./generate-install-bootstrap.mjs";
import { BUN_TARGETS, binaryArchiveName } from "./lib/bun-targets.mjs";

const bundles = Object.fromEntries(BUN_TARGETS.map((target) => [target.id, {
	file: binaryArchiveName(target.id), bytes: 1, sha256: "a".repeat(64),
}]));
const pins = {
	tag: "xz-v0.82.1-xz.1.1.gaaaaaaaa",
	baseUrl: "https://github.com/xz-dev/pi/releases/download/xz-v0.82.1-xz.1.1.gaaaaaaaa/",
	manifestSha256: "b".repeat(64), commit: "a".repeat(40), distributionVersion: "0.82.1-xz.1.1.gaaaaaaaa", bundles,
	attestation: { repository: "xz-dev/pi", signerWorkflow: "xz-dev/pi/.github/workflows/publish-github-release.yml", signerRef: "refs/heads/main", denySelfHostedRunners: true, subjectsFile: "attestation-subjects.jsonl" },
};

test("installers use a gh-compatible JSONL provenance bundle filename", () => {
	assert.equal(ATTESTATION_BUNDLE_FILENAME, "attestation-subjects.jsonl");
	assert.match(generateInstallSh(pins), /BUNDLE_NAME='attestation-subjects\.jsonl'/);
	assert.match(generateInstallPs1(pins), /\$BundleName = 'attestation-subjects\.jsonl'/);
});

test("current gh accepts the canonical provenance bundle extension", () => {
	if (spawnSync("gh", ["attestation", "verify", "--help"]).status !== 0) return;
	const root = mkdtempSync(join(tmpdir(), "pi-attestation-extension-"));
	try {
		const subject = join(root, "subject");
		const jsonl = join(root, ATTESTATION_BUNDLE_FILENAME);
		const text = join(root, "attestation-subjects.txt");
		writeFileSync(subject, "subject");
		writeFileSync(jsonl, "{}\n");
		writeFileSync(text, "{}\n");
		const args = (bundle) => ["attestation", "verify", subject, "--bundle", bundle, "--repo", "xz-dev/pi"];
		const jsonlResult = spawnSync("gh", args(jsonl), { encoding: "utf8" });
		const textResult = spawnSync("gh", args(text), { encoding: "utf8" });
		assert.doesNotMatch(`${jsonlResult.stdout}${jsonlResult.stderr}`, /bundle file extension not supported/);
		assert.match(`${textResult.stdout}${textResult.stderr}`, /bundle file extension not supported/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("POSIX installer selects libc and x64 CPU target with deterministic overrides", () => {
	const script = generateInstallSh(pins);
	assert.match(script, /PI_XZ_TARGET_CPU/);
	assert.match(script, /PI_XZ_TARGET_LIBC/);
	assert.match(script, /getconf GNU_LIBC_VERSION/);
	assert.match(script, /ld-musl-/);
	assert.match(script, /linux-x64-\$libc-modern/);
	assert.match(script, /darwin-x64-baseline/);
	for (const target of BUN_TARGETS.filter((entry) => entry.os !== "windows")) assert.ok(script.includes(binaryArchiveName(target.id)));
});

test("Windows installer uses reliable AVX2 API with baseline fallback and override", () => {
	const script = generateInstallPs1(pins);
	assert.match(script, /IsProcessorFeaturePresent\(40\)/);
	assert.match(script, /PI_XZ_TARGET_CPU/);
	assert.match(script, /PI_XZ_TARGET_ARCH/);
	assert.match(script, /return 'windows-x64-baseline'/);
	for (const target of BUN_TARGETS.filter((entry) => entry.os === "windows")) assert.ok(script.includes(binaryArchiveName(target.id)));
});
