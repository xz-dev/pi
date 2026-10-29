import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { passedProcwardContract } from "./fixtures/procward-contract.mjs";
import { BUN_TARGETS } from "./lib/bun-targets.mjs";
import { assertProcwardContract } from "./smoke-procward-contract.mjs";

for (const target of BUN_TARGETS) test(`contract validator binds ${target.id} to exact pin and Pi bytes`, () => {
	const sha = "a".repeat(64);
	const record = passedProcwardContract(target.id, sha);
	assertProcwardContract(record, target.id, sha);
	for (const mutate of [
		(value) => { value.procward.sourceCommit = "b".repeat(40); },
		(value) => { value.procward.zipSha256 = "b".repeat(64); },
		(value) => { value.procward.version = "99.0.0"; },
		(value) => { value.procward.target = "wrong-target"; },
		(value) => { value.piSha256 = "b".repeat(64); },
		(value) => { value.cases.pop(); },
		(value) => { value.access.piStatus = 125; },
		(value) => { value.access.lingerReaped = false; },
		(value) => { value.access.commandStatus = 0; value.access.piStatus = 0; },
		...(target.os === "windows" ? [(value) => { value.access.denied = false; }] : []),
		(value) => { value.notice.terminalAfter = [0]; },
		(value) => { value.notice.parentAlive = false; },
		(value) => { value.blocked.elapsedMs = 8000 * (target.emulated ? 15 : 1); },
	]) {
		const changed = structuredClone(record); mutate(changed);
		assert.throws(() => assertProcwardContract(changed, target.id, sha), /procward|hook bound/);
	}
});

for (const restore of [true, false]) test(`PTY contract observes actual full terminal restoration (${restore})`, { skip: process.platform === "win32" && "Windows uses the retained ConPTY contract" }, () => {
	const root = mkdtempSync(join(tmpdir(), "pi-pty-contract-test-"));
	try {
		const fixture = join(root, "primary.py");
		writeFileSync(fixture, `import json, os, pathlib, sys, termios, tty
root=pathlib.Path(os.environ['PI_PROCWARD_CONTRACT_DIRECTORY'])
fd=int(os.environ['PROCWARD_LIFECYCLE_FD'])
pipe=os.fdopen(fd,'rb',buffering=0)
assert pipe.readline().startswith(b'PROCWARD/1 READY ')
before=termios.tcgetattr(0)
tty.setraw(0)
(root/'ready.json').write_text('{}\\n')
assert pipe.readline().startswith(b'PROCWARD/1 OWNER-LOSS ')
(root/'hook.json').write_text('{}\\n')
${restore ? "termios.tcsetattr(0,termios.TCSANOW,before)" : "# Intentional fault: leave raw mode active."}
`);
		const python = process.platform === "freebsd" ? "python3.11" : "python3";
		const result = spawnSync(python, [join(import.meta.dirname, "fixtures/procward/pty-contract.py"), JSON.stringify([python, fixture]), "unused-extension", join(root, "run"), "0", "1"], { encoding: "utf8", timeout: 10000 });
		assert.equal(result.status === 0, restore, result.stderr);
		if (restore) {
			const evidence = JSON.parse(result.stdout);
			assert.equal(evidence.noticeOnly, true);
			assert.equal(evidence.hookRan, true);
			assert.deepEqual(evidence.terminalAfter, evidence.terminalBefore);
		} else assert.match(result.stderr, /full terminal settings not restored/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

for (const restore of [true, false]) test(`Linux C PTY glue checks saved state without Python in the target (${restore})`, { skip: process.platform !== "linux" && "static PTY glue is Linux/musl only" }, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-c-pty-contract-test-"));
    try {
        const binary = join(root, "pty-contract");
        const build = spawnSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", join(import.meta.dirname, "fixtures/procward/pty-contract.c"), "-lutil", "-o", binary], { encoding: "utf8", timeout: 30000 });
        assert.equal(build.status, 0, build.stderr);
        const fixture = join(root, "pi-fixture");
        writeFileSync(fixture, `#!/usr/bin/env python3
import os, pathlib, termios, tty
root=pathlib.Path(os.environ['PI_PROCWARD_CONTRACT_DIRECTORY'])
pipe=os.fdopen(int(os.environ['PROCWARD_LIFECYCLE_FD']),'rb',buffering=0)
assert pipe.readline().startswith(b'PROCWARD/1 READY ')
before=termios.tcgetattr(0)
tty.setraw(0)
(root/'ready.json').write_text('{}\\n')
assert pipe.readline().startswith(b'PROCWARD/1 OWNER-LOSS ')
(root/'hook.json').write_text('{}\\n')
${restore ? "termios.tcsetattr(0,termios.TCSANOW,before)" : "# Fault: raw mode remains."}
`);
        chmodSync(fixture, 0o700);
        const result = spawnSync(binary, [fixture, "unused-extension", join(root, "run"), "0", "1"], { encoding: "utf8", timeout: 10000 });
        assert.equal(result.status === 0, restore, result.stderr);
        if (restore) {
            const evidence = JSON.parse(result.stdout);
            assert.equal(evidence.hookRan, true);
            assert.equal(evidence.terminalAfter, evidence.terminalBefore);
        } else assert.match(result.stderr, /full terminal settings not restored/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
