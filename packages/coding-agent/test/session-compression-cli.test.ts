import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { isCompressedSession } from "../src/core/session-storage.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const resolver = new URL("../src/experimental/source-resolver.ts", import.meta.url).href;

describe("offline session compression CLI acceptance", () => {
	let root: string;
	let agent: string;
	let project: string;
	let sessions: string;
	let sentinel: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-compression-cli-"));
		agent = join(root, "agent");
		project = join(root, "project");
		sessions = join(agent, "sessions", "--project--");
		mkdirSync(sessions, { recursive: true });
		mkdirSync(project);
		sentinel = join(root, "extension-loaded");
		const extension = join(root, "poison.ts");
		writeFileSync(
			extension,
			`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'loaded'); export default function() { throw new Error('Extension must not load'); }`,
		);
		writeFileSync(
			join(agent, "settings.json"),
			JSON.stringify({
				enableCompressSessions: false,
				extensions: [extension],
				defaultProvider: "missing",
				defaultModel: "missing",
			}),
		);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});
	function run(args: string[]) {
		return spawnSync(process.execPath, ["--import", resolver, cli, ...args], {
			cwd: project,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agent,
				[ENV_SESSION_DIR]: join(root, "ignored-env-dir"),
				PI_OFFLINE: "1",
			},
			encoding: "utf8",
			timeout: 20_000,
		});
	}
	function plain(dir = sessions) {
		const session = SessionManager.create(project, dir, { compressSessions: false });
		session.appendMessage({ role: "user", content: "exact offline history", timestamp: 1 });
		return session.getSessionFile()!;
	}

	it("explicit true/false converts all projects, saves global default, and exits before extensions/models", () => {
		const path = plain();
		const original = readFileSync(path);
		const otherPath = plain(join(agent, "sessions", "--other--"));
		let result = run(["--enable-compress-sessions=true"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain("Offline-only");
		expect(result.stdout).toContain("2 converted");
		expect(isCompressedSession(path)).toBe(true);
		expect(isCompressedSession(otherPath)).toBe(true);
		expect(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).enableCompressSessions).toBe(true);
		expect(existsSync(sentinel)).toBe(false);
		result = run(["--enable-compress-sessions=false"]);
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(path)).toEqual(original);
		expect(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).enableCompressSessions).toBe(false);
		expect(existsSync(sentinel)).toBe(false);
	});

	it("custom directory only, corrupt input and invalid booleans preserve old preference", () => {
		const other = plain();
		const custom = join(root, "custom");
		const target = plain(custom);
		let result = run(["--session-dir", custom, "--enable-compress-sessions=true"]);
		expect(result.status, result.stderr).toBe(0);
		expect(isCompressedSession(target)).toBe(true);
		expect(isCompressedSession(other)).toBe(false);
		const before = readFileSync(join(agent, "settings.json"));
		const bad = join(custom, "bad.jsonl");
		writeFileSync(bad, Buffer.from([0x50, 0x2a, 0x4d, 0x18]));
		result = run(["--session-dir", custom, "--enable-compress-sessions=false"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Partial migration");
		expect(readFileSync(join(agent, "settings.json"))).toEqual(before);
		expect(readFileSync(bad)).toEqual(Buffer.from([0x50, 0x2a, 0x4d, 0x18]));
		result = run(["--enable-compress-sessions=maybe"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("requires true or false");
		expect(readFileSync(join(agent, "settings.json"))).toEqual(before);
		expect(existsSync(sentinel)).toBe(false);
	});

	it("preserves source and preference when metadata cannot produce a readable archive", () => {
		const path = join(sessions, "invalid-metadata.jsonl");
		const original = `${JSON.stringify({ type: "session", version: 3, id: "invalid-metadata", cwd: project, timestamp: "not-a-date" })}\n`;
		writeFileSync(path, original);
		const settings = readFileSync(join(agent, "settings.json"));
		const result = run(["--enable-compress-sessions=true"]);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stdout).toContain("0 converted");
		expect(result.stderr).toContain("Partial migration");
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(readFileSync(join(agent, "settings.json"))).toEqual(settings);
		expect(existsSync(sentinel)).toBe(false);
	});

	it("does not migrate any files when global settings cannot be read safely", () => {
		const path = plain();
		const before = readFileSync(path);
		writeFileSync(join(agent, "settings.json"), "{invalid");
		const result = run(["--enable-compress-sessions=true"]);
		expect(result.status).toBe(1);
		expect(readFileSync(path)).toEqual(before);
		expect(readFileSync(join(agent, "settings.json"), "utf8")).toBe("{invalid");
		expect(existsSync(sentinel)).toBe(false);
	});

	it.each(["missing", "equal-form", "empty", "whitespace", "unknown", "missing-before-flag"] as const)(
		"rejects %s maintenance scope before changing sessions or settings",
		(form) => {
			const defaultPath = plain();
			const custom = join(root, "custom");
			const customPath = plain(custom);
			const defaultBytes = readFileSync(defaultPath);
			const customBytes = readFileSync(customPath);
			const settings = readFileSync(join(agent, "settings.json"));
			const argumentsByCase = {
				missing: ["--enable-compress-sessions=true", "--session-dir"],
				"equal-form": ["--enable-compress-sessions=true", `--session-dir=${custom}`],
				empty: ["--enable-compress-sessions=true", "--session-dir", ""],
				whitespace: ["--enable-compress-sessions=true", "--session-dir", "   "],
				unknown: ["--enable-compress-sessions=true", "--unknown-maintenance-flag"],
				"missing-before-flag": ["--session-dir", "--enable-compress-sessions=true"],
			};
			const result = run(argumentsByCase[form]);
			expect(result.status, result.stderr).toBe(1);
			expect(result.stderr).toContain("Error:");
			expect(result.stdout).not.toContain("Session compression:");
			expect(readFileSync(defaultPath)).toEqual(defaultBytes);
			expect(readFileSync(customPath)).toEqual(customBytes);
			expect(readFileSync(join(agent, "settings.json"))).toEqual(settings);
			expect(existsSync(sentinel)).toBe(false);
		},
	);

	it("ordinary mixed startup warns on stderr but never migrates files or preference", () => {
		const path = plain();
		const before = readFileSync(path);
		const compressed = SessionManager.create(project, sessions);
		compressed.appendMessage({ role: "user", content: "compressed", timestamp: 1 });
		const archived = readFileSync(compressed.getSessionFile()!);
		const settings = readFileSync(join(agent, "settings.json"));
		const result = run([
			"--session-dir",
			sessions,
			"--mode",
			"json",
			"--no-extensions",
			"-p",
			"hello",
			"--model",
			"missing",
		]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("pi --enable-compress-sessions=true");
		expect(result.stderr).toContain("pi --enable-compress-sessions=false");
		expect(result.stdout).not.toContain("Mixed plain/compressed");
		expect(readFileSync(path)).toEqual(before);
		expect(readFileSync(compressed.getSessionFile()!)).toEqual(archived);
		expect(readFileSync(join(agent, "settings.json"))).toEqual(settings);
	});
});
