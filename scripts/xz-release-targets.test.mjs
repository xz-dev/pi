#!/usr/bin/env node

/**
 * CI-side parity test: asserts that the runtime's generated 12-target release
 * contract (packages/coding-agent/src/utils/xz-release-targets.generated.ts)
 * exactly matches the authoritative Bun release descriptor
 * (scripts/lib/bun-targets.mjs + binaryRequiredPaths() from github-release.mjs).
 *
 * The CI lib only exists in the release distribution branch, so this test is
 * exercised after the CI descriptor is integrated. When the lib is absent this
 * script exits 0 with a notice so the runtime worktree stays green while the
 * branches are still separated. An explicit descriptor path may be supplied via
 * the --ci-lib <path> argument or the PI_XZ_CI_LIB env var (the directory
 * containing bun-targets.mjs and github-release.mjs); when supplied, absence of
 * the descriptor is a hard failure, never a silent skip.
 *
 * Usage:
 *   node scripts/xz-release-targets.test.mjs
 *   node scripts/xz-release-targets.test.mjs --ci-lib <dir-with-lib>
 *   PI_XZ_CI_LIB=<dir-with-lib> node scripts/xz-release-targets.test.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const argvIndex = process.argv.indexOf("--ci-lib");
const argLibDir = argvIndex !== -1 ? process.argv[argvIndex + 1] : undefined;
if (argvIndex !== -1 && !argLibDir) {
	console.error("FAIL: --ci-lib requires a path to the CI scripts/lib directory.");
	process.exit(1);
}
const explicitLibDir = argLibDir ?? process.env.PI_XZ_CI_LIB;
const LIB_DIR = explicitLibDir ? resolve(explicitLibDir) : join(REPO_ROOT, "scripts", "lib");
const GENERATED = join(REPO_ROOT, "packages", "coding-agent", "src", "utils", "xz-release-targets.generated.ts");

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exitCode = 1;
}

// The CI descriptor is not present in the separated runtime branch.
if (!existsSync(join(LIB_DIR, "bun-targets.mjs"))) {
	if (explicitLibDir) {
		console.error(`FAIL: scripts/lib/bun-targets.mjs not present at explicit path ${LIB_DIR}.`);
		process.exit(1);
	}
	console.log("SKIP: scripts/lib/bun-targets.mjs not present (run after CI descriptor integration).");
	process.exit(0);
}

const { binaryArchiveName, bunTarget } = await import(join(LIB_DIR, "bun-targets.mjs"));
const { binaryRequiredPaths, BINARY_PLATFORMS } = await import(join(LIB_DIR, "github-release.mjs"));

if (!Array.isArray(BINARY_PLATFORMS) || BINARY_PLATFORMS.length !== 12) {
	fail(`Expected exactly 12 canonical Bun targets, got ${BINARY_PLATFORMS?.length ?? "none"}.`);
}
if (BINARY_PLATFORMS.some((id) => !bunTarget(id))) {
	fail("BINARY_PLATFORMS contains an unknown Bun target.");
}

const expected = BINARY_PLATFORMS.map((platform) => ({
	platform,
	archive: binaryArchiveName(platform),
	requiredPaths: binaryRequiredPaths(platform),
}));

// Parse the generated module's contract literal.
const generatedText = readFileSync(GENERATED, "utf8");
const contractMatch = generatedText.match(/XZ_RELEASE_BINARY_CONTRACT[^=]*=\s*(\{[\s\S]*?\n\};)/);
if (!contractMatch) fail(`Could not parse contract from ${GENERATED}`);
const contract = Function(`return (${contractMatch[1].replace(/;\s*$/, "")})`)();
if (contract.schemaVersion !== 5) fail(`Expected generated contract schemaVersion 5, got ${contract.schemaVersion}`);

if (contract.targets.length !== expected.length) {
	fail(`Target count mismatch: generated ${contract.targets.length} vs CI ${expected.length}.`);
}
for (let i = 0; i < expected.length; i += 1) {
	const got = contract.targets[i];
	const want = expected[i];
	if (got.platform !== want.platform || got.archive !== want.archive) {
		fail(`Target mismatch at index ${i}: got ${got.platform}/${got.archive}, want ${want.platform}/${want.archive}.`);
		process.exit(1);
	}
	// Compare requiredPaths in exact order: the runtime inventory is order-
	// sensitive and must match the CI descriptor byte-for-byte, not as a set.
	if (JSON.stringify(got.requiredPaths) !== JSON.stringify(want.requiredPaths)) {
		const gotPaths = [...got.requiredPaths];
		const wantPaths = [...want.requiredPaths];
		console.error(`Required-path mismatch for ${got.platform}:`);
		console.error(`  CI only:   ${wantPaths.filter((p) => !gotPaths.includes(p)).join(", ")}`);
		console.error(`  gen only:  ${gotPaths.filter((p) => !wantPaths.includes(p)).join(", ")}`);
		if (gotPaths.length !== wantPaths.length) {
			console.error(`  (count: gen ${gotPaths.length} vs CI ${wantPaths.length})`);
		}
		process.exitCode = 1;
	}
}

if (process.exitCode === undefined) {
	console.log(`OK: generated runtime contract matches CI descriptor (${expected.length} targets, schema v5).`);
}
