import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUN_TARGETS } from "./lib/bun-targets.mjs";
import { muslSmokeLibraries, verifyMuslSmokeLibraries } from "./prepare-musl-smoke.mjs";

test("all twelve targets package an existing upstream native clipboard helper", () => {
	assert.equal(BUN_TARGETS.length, 12);
	for (const target of BUN_TARGETS) {
		assert.ok(target.nativeHelperDir && target.nativeHelperFile);
		assert.ok(existsSync(join(import.meta.dirname, "../packages/tui", target.nativeHelperDir, target.nativeHelperFile)), target.id);
	}
});

for (const arch of ["x64", "arm64"]) test(`musl ${arch} library verification rejects missing or corrupt fixed inputs`, () => {
	assert.equal(Object.keys(muslSmokeLibraries(arch)).length, 5);
	assert.throws(() => verifyMuslSmokeLibraries(undefined, arch), /requires PI_XZ_MUSL_LIBRARIES/);
	const root = mkdtempSync(join(tmpdir(), "pi-musl-libraries-"));
	try {
		mkdirSync(join(root, "usr/lib"), { recursive: true });
		writeFileSync(join(root, "usr/lib/libxcb.so.1"), "corrupt");
		assert.throws(() => verifyMuslSmokeLibraries(root, arch), /musl library digest mismatch/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});


// Unit fixtures exercise the acceptance protocol; CI loads the actual .node.
for (const [name, exports, accepted] of [
	["empty clipboard", "getText: async () => null, getImage: async () => null", true],
	["text and image", "getText: async () => 'private', getImage: async () => new Uint8Array([1])", true],
	["unavailable text", "getText: async () => undefined, getImage: async () => null", false],
	["unavailable image", "getText: async () => null, getImage: async () => undefined", false],
	["missing exports", "", false],
	["malformed text", "getText: async () => 1, getImage: async () => null", false],
	["malformed image", "getText: async () => null, getImage: async () => 'invalid'", false],
	["native exception", "getText: async () => { throw Error('read failed'); }, getImage: async () => null", false],
]) {
	test(`native clipboard smoke ${accepted ? "accepts" : "rejects"} ${name}`, () => {
		const root = mkdtempSync(join(tmpdir(), "pi-native-clipboard-"));
		try {
			const helper = join(root, "fixture.cjs");
			writeFileSync(helper, `module.exports = { ${exports} };\n`);
			const result = spawnSync(process.execPath, [join(import.meta.dirname, "test-native-clipboard.mjs"), helper], { encoding: "utf8", timeout: 5000 });
			assert.equal(result.status === 0, accepted, result.stderr);
			if (accepted) assert.deepEqual(JSON.parse(result.stdout), { textRead: true, imageRead: true });
			assert.doesNotMatch(result.stdout, /private/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
