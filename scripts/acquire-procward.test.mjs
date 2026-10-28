import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateProcwardPin } from "./acquire-procward.mjs";
import { PROCWARD_PIN } from "./lib/procward-pin.mjs";

const hash = (data) => createHash("sha256").update(data).digest("hex");
test("development builds cannot pass the publication gate", () => {
	assert.throws(() => validateProcwardPin(), /publishing is forbidden/);
	assert.equal(validateProcwardPin(PROCWARD_PIN, { allowDev: true }), PROCWARD_PIN);
	const release = { ...PROCWARD_PIN, state: "release", tag: `v${PROCWARD_PIN.version}` };
	assert.throws(() => validateProcwardPin(release), /Missing procward digests/);
});

for (const fault of ["none", "zip-digest", "binary-digest", "traversal", "duplicate", "symlink"]) {
	test(`acquisition extracts only authenticated flat assets (${fault})`, () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-procward-zip-test-"));
		try {
			const archive = join(dir, "asset.zip");
			const output = join(dir, "output");
			const python = process.platform === "freebsd" ? "python3.11" : "python3";
			const create = spawnSync(python, ["-c", `
import sys, zipfile
archive, fault = sys.argv[1:]
with zipfile.ZipFile(archive, 'w') as z:
    for name in ['procward', 'LICENSE', 'README.md', 'third-party-licenses.md']:
        z.writestr(name, b'executable' if name == 'procward' else b'license')
    if fault == 'traversal': z.writestr('../escaped', b'bad')
    if fault == 'duplicate': z.writestr('procward', b'bad')
    if fault == 'symlink':
        entry = zipfile.ZipInfo('procward')
        entry.external_attr = 0o120777 << 16
        z.writestr(entry, b'/etc/passwd')
`, archive, fault], { encoding: "utf8", timeout: 10000 });
			assert.equal(create.status, 0, create.stderr);
			const extract = spawnSync(python, [join(import.meta.dirname, "lib/extract-procward.py"), archive, output, "procward", fault === "zip-digest" ? "0".repeat(64) : hash(readFileSync(archive)), fault === "binary-digest" ? "0".repeat(64) : hash("executable")], { encoding: "utf8", timeout: 10000 });
			assert.equal(extract.status === 0, fault === "none", extract.stderr);
			assert.equal(existsSync(output), fault === "none");
			assert.equal(existsSync(join(dir, "escaped")), false);
			if (fault === "none") assert.equal(readFileSync(join(output, "procward"), "utf8"), "executable");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
