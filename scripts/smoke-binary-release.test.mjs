import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const target = "linux-x64-gnu-baseline";
test("external TUI evidence contributes the authoritative pseudoterminal command", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-external-tui-"));
	try {
		const stage = join(root, "stage", "pi"); mkdirSync(join(stage, "node_modules", "@mariozechner", "clipboard"), { recursive: true });
		const pi = join(stage, "pi"); writeFileSync(pi, "#!/bin/sh\ncase \"$1\" in --version) echo 1.2.3;; --help) echo Usage: pi;; --list-models) echo model;; *) exit 1;; esac\n"); chmodSync(pi, 0o755);
		writeFileSync(join(stage, "THIRD_PARTY_NOTICES.md"), `# Third-Party Notices\n\nLicense SHA-256: ${"a".repeat(64)}\n`);
		writeFileSync(join(stage, "node_modules", "@mariozechner", "clipboard", "clipboard.linux-x64-gnu.node"), "native");
		const archive = join(root, "pi-linux-x64-gnu-baseline.tar.gz"); execFileSync("tar", ["-czf", archive, "-C", join(root, "stage"), "pi"]);
		const bin = join(root, "bin"); mkdirSync(bin); const bun = join(bin, "bun"); writeFileSync(bun, "#!/bin/sh\nexit 0\n"); chmodSync(bun, 0o755);
		const evidence = join(root, "tui.json"); writeFileSync(evidence, JSON.stringify({ harness: "Python standard-library PTY", elapsedMs: 37, outputBytes: 42, input: "/exit\\r", childExitCode: 0, observedOutput: true, exitSent: true, cleanExit: true }));
		const recordPath = join(root, "record.json");
		execFileSync(process.execPath, [join(import.meta.dirname, "smoke-binary-release.mjs"), archive, target, "1.2.3", recordPath], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_XZ_TUI_EVIDENCE: evidence, RUNNER_OS: "Linux", RUNNER_ARCH: "X64" } });
		const record = JSON.parse(readFileSync(recordPath, "utf8"));
		assert.deepEqual(record.commands.map(({ name }) => name), ["extract", "measure-extracted-size", "version", "help", "list-models", "clipboard", "tui-pseudoterminal"]);
		assert.deepEqual(record.commands.at(-1), { name: "tui-pseudoterminal", command: `external:${evidence}`, status: 0, elapsedMs: 37 });
		assert.equal(record.timingsMs.interactive, 37);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
