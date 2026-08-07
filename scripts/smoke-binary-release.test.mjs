import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const target = "linux-x64-gnu-baseline";

test("Unix TUI harness allows startup initialization to settle before sending exit", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tui-startup-settle-"));
	try {
		const executable = join(root, "pi");
		writeFileSync(executable, `#!/usr/bin/env python3
import os, select, sys, time, tty
tty.setraw(sys.stdin.fileno()); os.write(sys.stdout.fileno(), b"\\x1b[?2004h")
time.sleep(0.75)
settling, _, _ = select.select([sys.stdin], [], [], 0)
premature = os.read(sys.stdin.fileno(), 1024) if settling else b""
if b"\\x03" in premature or b"\\x04" in premature: raise SystemExit(2)
os.write(sys.stdout.fileno(), b"startup-settled")
deadline = time.monotonic() + 2; received = premature
while time.monotonic() < deadline and b"\\x04" not in received:
    readable, _, _ = select.select([sys.stdin], [], [], 0.1)
    if readable: received += os.read(sys.stdin.fileno(), 1024)
raise SystemExit(0 if b"\\x04" in received else 3)
`);
		chmodSync(executable, 0o755);
		const result = execFileSync("python3", [join(import.meta.dirname, "smoke-unix-tui.py"), executable], { encoding: "utf8" });
		const evidence = JSON.parse(result.trim());
		assert.equal(evidence.cleanExit, true);
		assert.equal(evidence.input, "ctrl-c,ctrl-d");
		assert.ok(evidence.elapsedMs >= 1000);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("external TUI evidence contributes the authoritative pseudoterminal command", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-external-tui-"));
	try {
		const stage = join(root, "stage", "pi"); mkdirSync(join(stage, "node_modules", "@mariozechner", "clipboard"), { recursive: true });
		const pi = join(stage, "pi"); writeFileSync(pi, "#!/bin/sh\ncase \"$1\" in --version) echo 1.2.3;; --help) echo Usage: pi;; --list-models) echo model;; *) exit 1;; esac\n"); chmodSync(pi, 0o755);
		writeFileSync(join(stage, "node_modules", "@mariozechner", "clipboard", "package.json"), JSON.stringify({ name: "@mariozechner/clipboard", version: "1.0.0", license: "MIT" }));
		writeFileSync(join(stage, "node_modules", "@mariozechner", "clipboard", "LICENSE"), "fixture clipboard license\n");
		writeFileSync(join(stage, "node_modules", "@mariozechner", "clipboard", "clipboard.linux-x64-gnu.node"), "native");
		const lockPath = join(root, "package-lock.json");
		writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages: { "packages/coding-agent": { name: "@earendil-works/pi-coding-agent", dependencies: { fixture: "1.0.0" } }, "node_modules/fixture": { version: "1.0.0", license: "MIT" } } }));
		execFileSync(process.execPath, [join(import.meta.dirname, "generate-third-party-notices.mjs"), stage, join(stage, "THIRD_PARTY_NOTICES.md"), lockPath]);
		const notices = readFileSync(join(stage, "THIRD_PARTY_NOTICES.md"), "utf8");
		assert.match(notices, /## node_modules\/@mariozechner\/clipboard@1\.0\.0/);
		assert.match(notices, /### LICENSE\nLicense SHA-256: [0-9a-f]{64}/);
		const archive = join(root, "pi-linux-x64-gnu-baseline.tar.gz"); execFileSync("tar", ["-czf", archive, "-C", join(root, "stage"), "pi"]);
		const bin = join(root, "bin"); mkdirSync(bin); const bun = join(bin, "bun"); writeFileSync(bun, "#!/bin/sh\nexit 0\n"); chmodSync(bun, 0o755);
		const evidence = join(root, "tui.json"); writeFileSync(evidence, JSON.stringify({ harness: "Python standard-library PTY", elapsedMs: 37, outputBytes: 42, input: "ctrl-c,ctrl-d", childExitCode: 0, observedOutput: true, exitSent: true, cleanExit: true }));
		const recordPath = join(root, "record.json");
		execFileSync(process.execPath, [join(import.meta.dirname, "smoke-binary-release.mjs"), archive, target, "1.2.3", recordPath], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_XZ_TUI_EVIDENCE: evidence, RUNNER_OS: "Linux", RUNNER_ARCH: "X64" } });
		const record = JSON.parse(readFileSync(recordPath, "utf8"));
		assert.deepEqual(record.commands.map(({ name }) => name), ["extract", "measure-extracted-size", "version", "help", "list-models", "clipboard", "tui-pseudoterminal"]);
		assert.deepEqual(record.commands.at(-1), { name: "tui-pseudoterminal", command: `external:${evidence}`, status: 0, elapsedMs: 37 });
		assert.equal(record.timingsMs.interactive, 37);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
