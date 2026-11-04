import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { encodeSessionTransaction, summarizeSession } from "../packages/coding-agent/src/core/session-storage.ts";
import { readSessionLines, readSessionText } from "./session-reader.ts";

const root = resolve(import.meta.dirname, "..");

// All session, config, browser-launcher and HOME paths belong to this synthetic fixture.
test("developer reports read plain and compressed sessions without changing source bytes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-report-reader-"));
	try {
		const home = join(dir, "home");
		const sessions = join(home, ".pi/agent/sessions/--synthetic--");
		const bin = join(dir, "bin");
		mkdirSync(sessions, { recursive: true });
		mkdirSync(bin);
		writeFileSync(join(bin, "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const timestamp = new Date().toISOString();
		const entries = [
			{ type: "session", version: 3, id: "synthetic", cwd: "/synthetic", timestamp },
			{ type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "synthetic question" } },
			{ type: "message", id: "assistant", parentId: "user", timestamp, message: {
				role: "assistant", provider: "synthetic", model: "synthetic", usage: { totalTokens: 10, cost: { total: 1 } },
				content: [
					{ type: "toolCall", id: "edit", name: "edit", arguments: { path: "file.ts", oldText: "before", newText: "after" } },
					{ type: "toolCall", id: "read", name: "read", arguments: { path: "file.ts", limit: 2 } },
				],
			} },
			{ type: "message", id: "result", parentId: "assistant", timestamp, message: { role: "toolResult", toolCallId: "edit", toolName: "edit", content: "changed", isError: false } },
		];
		const text = entries.map((entry) => JSON.stringify(entry)).join("\r\n") + "\r\nmalformed\r\n";
		const compressed = encodeSessionTransaction(text, summarizeSession(entries));
		const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", PATH: `${bin}:${process.env.PATH}` };
		const run = (script, args) => {
			const result = spawnSync(process.execPath, [join(root, "scripts", script), ...args], { cwd: root, env, encoding: "utf8", timeout: 20000 });
			assert.equal(result.status, 0, `${script}: ${result.error ?? result.stderr}`);
			return result.stdout;
		};
		for (const [index, bytes, extension] of [[0, Buffer.from(text), ".jsonl"], [1, compressed, ".jsonl"], [2, compressed, ".jsonl.zst"]]) {
			const file = join(sessions, `${timestamp.replace(/[:.]/g, "-")}_${index}${extension}`);
			writeFileSync(file, bytes);
			assert.equal(readSessionText(file), text);
			const lines = [];
			for await (const line of readSessionLines(file)) if (line.trim()) lines.push(line);
			assert.equal(lines.length, entries.length + 1);
			assert.equal(lines.at(-1), "malformed");
			const count = index + 1;
			const edits = JSON.parse(run("edit-tool-stats.mjs", ["--sessions-dir", sessions, "--all-sessions", "--json"]));
			assert.equal(edits.summary.counts.totalEditCalls, count);
			assert.equal(edits.summary.counts.success, count);
			assert.equal(edits.summary.scan.malformedLines, count);
			const reads = JSON.parse(run("read-tool-stats.mjs", ["--sessions-dir", sessions, "--all-sessions", "--json"]));
			assert.equal(reads.summary.counts.totalReadCalls, count);
			assert.equal(reads.summary.counts.partial, count);
			const context = JSON.parse(run("session-context-stats.mjs", ["--sessions-dir", sessions, "--all-cwds", "--json"]));
			assert.equal(context.totals.sessions, count);
			assert.equal(context.totals.assistantMessages, count);
			assert.equal(context.totals.avgMaxPromptTokens, 10);
			assert.match(run("cost.ts", ["--dir", "/synthetic", "--days", "1"]), new RegExp(`GRAND TOTAL: +\\$ +${count}\\.0000`));
			const output = join(dir, "tools.html");
			run("tool-stats.ts", ["--sessions-dir", sessions, "--output", output]);
			const html = readFileSync(output, "utf8");
			assert.match(html, new RegExp(`"files":${count},"parseErrors":${count}`));
			assert.match(html, new RegExp(`"name":"edit","calls":${count},"results":${count}`));
			assert.deepEqual(readFileSync(file), bytes);
		}
		const corrupt = join(dir, "corrupt.jsonl");
		const damaged = Buffer.from(compressed);
		damaged[damaged.length - 1] ^= 1;
		writeFileSync(corrupt, damaged);
		assert.throws(() => readSessionText(corrupt));
		await assert.rejects(async () => { for await (const _line of readSessionLines(corrupt)) { /* consume */ } });
		assert.deepEqual(readFileSync(corrupt), damaged);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
