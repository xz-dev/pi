// Exercise offline session migration in the exact Release executable without model calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionJsonlBytes } from "./session-jsonl.mjs";

export const SESSION_COMPRESSION_CHECKS = ["roundtrip", "global-defaults", "scope", "invalid-input", "failure-preserves-source", "no-runtime-startup"];
const COMMANDS = ["compress-default-root", "decompress-custom-dir", "decompress-default-root", "invalid-boolean", "invalid-source"];

export function assertSessionCompressionEvidence(evidence) {
	if (evidence?.status !== "passed" || JSON.stringify(evidence.checks) !== JSON.stringify(SESSION_COMPRESSION_CHECKS)
		|| JSON.stringify(evidence.commands?.map(({ name, status }) => [name, status])) !== JSON.stringify(COMMANDS.map((name, index) => [name, index < 3 ? 0 : 1]))) {
		throw new Error("missing offline session compression acceptance");
	}
}

/** Validate migration, scope, rollback and early exit using only owned synthetic files. */
export function smokeSessionCompression(command, { env = process.env, timeoutMs = 30_000 } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-offline-session-smoke-"));
	try {
		const agent = join(root, "agent");
		const project = join(root, "project");
		const firstDir = join(agent, "sessions", "--first--");
		const secondDir = join(agent, "sessions", "--second--");
		const ignored = join(root, "ignored-session-dir");
		for (const dir of [agent, project, firstDir, secondDir, ignored]) mkdirSync(dir, { recursive: true });
		const marker = join(root, "extension-loaded");
		const extension = join(root, "poison.mjs");
		writeFileSync(extension, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); export default function() { throw new Error("runtime must not start"); }`);
		const settingsPath = join(agent, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ enableCompressSessions: false, sessionDir: ignored, extensions: [extension], defaultProvider: "missing-smoke-provider", defaultModel: "missing-smoke-model" }));
		const original = Buffer.from([
			JSON.stringify({ type: "session", version: 3, id: "compression-smoke", cwd: project, timestamp: "2026-01-01T00:00:00Z" }),
			JSON.stringify({ type: "message", id: "first", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Synthetic 漢字 history", timestamp: 1 } }),
		].join("\r\n") + "\n");
		const first = join(firstDir, "history.jsonl");
		const second = join(secondDir, "history.jsonl");
		const outside = join(ignored, "history.jsonl");
		for (const path of [first, second, outside]) writeFileSync(path, original);
		const launch = typeof command === "string" ? [command] : command;
		const commands = [];
		const run = (name, args, expectedStatus) => {
			const result = spawnSync(launch[0], [...launch.slice(1), ...args], {
				cwd: project, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024,
				env: { ...env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: ignored, HOME: root, USERPROFILE: root },
			});
			assert.equal(result.status, expectedStatus, `${name}: ${result.error?.message ?? result.stderr ?? result.signal}`);
			assert.equal(existsSync(marker), false, `${name}: extension runtime started`);
			commands.push({ name, status: result.status });
			return result;
		};
		run(COMMANDS[0], ["--enable-compress-sessions=true"], 0);
		for (const path of [first, second]) {
			assert.notDeepEqual(readFileSync(path), original, "compression did not change storage encoding");
			assert.deepEqual(readSessionJsonlBytes(path), original, "compressed transcript bytes changed");
		}
		assert.deepEqual(readFileSync(outside), original, "default migration used a configured directory override");
		assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).enableCompressSessions, true, "global preference was not enabled");
		run(COMMANDS[1], ["--session-dir", firstDir, "--enable-compress-sessions=false"], 0);
		assert.deepEqual(readFileSync(first), original, "custom migration did not restore original bytes");
		assert.notDeepEqual(readFileSync(second), original, "custom migration escaped its target");
		assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).enableCompressSessions, false, "custom migration did not save the global preference");
		run(COMMANDS[2], ["--enable-compress-sessions=false"], 0);
		assert.deepEqual(readFileSync(first), original);
		assert.deepEqual(readFileSync(second), original);
		const settingsBefore = readFileSync(settingsPath);
		const invalid = run(COMMANDS[3], ["--enable-compress-sessions=invalid"], 1);
		assert.match(invalid.stderr, /true or false/);
		assert.deepEqual(readFileSync(first), original);
		assert.deepEqual(readFileSync(second), original);
		assert.deepEqual(readFileSync(settingsPath), settingsBefore);
		const broken = join(firstDir, "broken.jsonl");
		const corrupt = Buffer.from([0x50, 0x2a, 0x4d, 0x18]);
		writeFileSync(broken, corrupt);
		const failed = run(COMMANDS[4], ["--enable-compress-sessions=true"], 1);
		assert.match(failed.stderr, /Partial migration/);
		assert.deepEqual(readFileSync(broken), corrupt, "failed migration changed corrupt source");
		assert.deepEqual(readFileSync(settingsPath), settingsBefore, "failed batch changed global preference");
		const evidence = { status: "passed", checks: [...SESSION_COMPRESSION_CHECKS], commands };
		assertSessionCompressionEvidence(evidence);
		return evidence;
	} finally { rmSync(root, { recursive: true, force: true }); }
}
