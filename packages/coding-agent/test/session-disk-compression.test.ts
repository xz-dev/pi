import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { takeSessionDiskCompressionHint } from "../src/main.ts";

describe("session disk compression guidance", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-disk-compression-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		chmodSync(agentDir, 0o700);
		rmSync(root, { recursive: true, force: true });
	});

	it("writes new sessions as plain JSONL", () => {
		const manager = SessionManager.create(cwd, join(root, "sessions"));
		manager.appendMessage({ role: "user", content: "plain text", timestamp: 1 });
		const text = readFileSync(manager.getSessionFile()!, "utf8");
		const records = text
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.map((record) => record.type)).toEqual(["session", "message"]);
		expect(records[1].message.content).toBe("plain text");
	});

	it("lists the built-in template through the normal loader", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		const { prompts, diagnostics } = loader.getPrompts();
		const prompt = prompts.find((candidate) => candidate.name === "session-disk-compression");
		expect(prompt).toMatchObject({
			description: "Inspect the Pi session folder and recommend transparent disk compression",
			argumentHint: "[session folder]",
			sourceInfo: { source: "builtin" },
		});
		expect(prompt!.content).toContain("Do not change anything until I explicitly approve each command.");
		expect(prompt!.content).toContain("${1:-the Pi sessions directory");
		expect(diagnostics).toEqual([]);
	});

	it("lets a same-named user template override the built-in one without a collision", async () => {
		mkdirSync(join(agentDir, "prompts"));
		writeFileSync(join(agentDir, "prompts", "session-disk-compression.md"), "My own procedure.");
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		const { prompts, diagnostics } = loader.getPrompts();
		const matches = prompts.filter((prompt) => prompt.name === "session-disk-compression");
		expect(matches).toHaveLength(1);
		expect(matches[0].content).toBe("My own procedure.");
		expect(diagnostics).toEqual([]);
	});

	it("returns the tip as one info diagnostic once and persists the setting as false", async () => {
		const settings = SettingsManager.create(cwd, agentDir);
		const first = takeSessionDiskCompressionHint(settings);
		expect(first).toEqual([{ type: "info", message: expect.stringContaining("/session-disk-compression") }]);
		expect(takeSessionDiskCompressionHint(settings)).toEqual([]);
		await settings.flush();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).sessionDiskCompressionHint).toBe(false);
		expect(takeSessionDiskCompressionHint(SettingsManager.create(cwd, agentDir))).toEqual([]);
	});

	it("returns nothing when the setting is false", () => {
		expect(takeSessionDiskCompressionHint(SettingsManager.inMemory({ sessionDiskCompressionHint: false }))).toEqual(
			[],
		);
	});

	// Directory permissions do not block writes on Windows or for root.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"does not throw when the settings write fails",
		async () => {
			const settings = SettingsManager.create(cwd, agentDir);
			chmodSync(agentDir, 0o500);
			expect(takeSessionDiskCompressionHint(settings)).toHaveLength(1);
			await settings.flush();
			expect(settings.drainErrors()).toEqual([expect.objectContaining({ scope: "global" })]);
		},
	);
});
