import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as config from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface ManagerCommands {
	runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void>;
	runCommand(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<void>;
}

const commit = "0123456789abcdef0123456789abcdef01234567";
const gitEntry = {
	resolved: `git+https://github.com/third-party/helper.git#${commit}`,
	integrity: "sha512-old-git-pack",
};
const registryEntry = {
	resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
	integrity: "sha512-registry",
};

// Regression: https://github.com/xz-dev/pi/issues/6. Package names must not affect compatibility.
describe("embedded Bun Git integrity compatibility", () => {
	let dir: string;
	let commands: ManagerCommands;
	let lockPath: string;
	let original: string;

	beforeEach(() => {
		vi.spyOn(config, "isBunBinary", "get").mockReturnValue(true);
		vi.spyOn(config, "DISTRIBUTION", "get").mockReturnValue("xz-dev");
		dir = mkdtempSync(join(tmpdir(), "pi-bun-integrity-"));
		lockPath = join(dir, "package-lock.json");
		original = `${JSON.stringify(
			{
				lockfileVersion: 3,
				packages: {
					"": { name: "third-party-plugin" },
					"node_modules/helper": gitEntry,
					"node_modules/example": registryEntry,
					"node_modules/unpinned": { ...gitEntry, resolved: "git+https://github.com/third-party/helper.git#main" },
				},
			},
			null,
			2,
		)}\r\n`;
		writeFileSync(lockPath, original);
		commands = new DefaultPackageManager({
			cwd: dir,
			agentDir: dir,
			settingsManager: SettingsManager.inMemory(),
		}) as unknown as ManagerCommands;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([false, true])("normalizes only pinned Git integrity and restores bytes (failure=%s)", async (fails) => {
		vi.spyOn(commands, "runCommand").mockImplementation(async (_command, args) => {
			const lock = JSON.parse(readFileSync(lockPath, "utf8"));
			expect(lock.packages["node_modules/helper"]).toEqual({ resolved: gitEntry.resolved });
			expect(lock.packages["node_modules/example"]).toEqual(registryEntry);
			expect(lock.packages["node_modules/unpinned"].integrity).toBe(gitEntry.integrity);
			expect(args).not.toContain("--no-verify");
			if (fails) throw new Error("registry integrity failure");
		});
		const operation = commands.runNpmCommand(["install", "--omit=dev"], { cwd: dir });
		if (fails) await expect(operation).rejects.toThrow("registry integrity failure");
		else await operation;
		expect(readFileSync(lockPath, "utf8")).toBe(original);
	});

	it("uses the managed npm --cwd for updates", async () => {
		vi.spyOn(commands, "runCommand").mockImplementation(async () => {
			expect(JSON.parse(readFileSync(lockPath, "utf8")).packages["node_modules/helper"].integrity).toBeUndefined();
		});
		await commands.runNpmCommand(["update", "third-party-plugin", "--cwd", dir, "--omit=peer"]);
		expect(readFileSync(lockPath, "utf8")).toBe(original);
	});

	it.each(["bun.lock", "bun.lockb"])("does not alter npm locks when %s takes precedence", async (name) => {
		writeFileSync(join(dir, name), "native lock");
		vi.spyOn(commands, "runCommand").mockImplementation(async () => {
			expect(readFileSync(lockPath, "utf8")).toBe(original);
		});
		await commands.runNpmCommand(["install"], { cwd: dir });
	});

	it("serializes concurrent normalization and restores the true original", async () => {
		let finish: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let calls = 0;
		vi.spyOn(commands, "runCommand").mockImplementation(async () => {
			calls++;
			expect(JSON.parse(readFileSync(lockPath, "utf8")).packages["node_modules/helper"].integrity).toBeUndefined();
			if (calls === 1) await gate;
		});
		const first = commands.runNpmCommand(["install"], { cwd: dir });
		await vi.waitFor(() => expect(calls).toBe(1));
		const second = commands.runNpmCommand(["install"], { cwd: dir });
		finish?.();
		await Promise.all([first, second]);
		expect(calls).toBe(2);
		expect(readFileSync(lockPath, "utf8")).toBe(original);
	});

	it.each(["not json", "null", '{"lockfileVersion":1,"dependencies":{}}'])(
		"passes unsupported locks through unchanged: %s",
		async (text) => {
			writeFileSync(lockPath, text);
			vi.spyOn(commands, "runCommand").mockImplementation(async () => {
				expect(readFileSync(lockPath, "utf8")).toBe(text);
			});
			await commands.runNpmCommand(["install"], { cwd: dir });
		},
	);

	it("does not touch npm-shrinkwrap while normalizing Bun's package-lock input", async () => {
		const shrinkwrap = join(dir, "npm-shrinkwrap.json");
		writeFileSync(shrinkwrap, original);
		vi.spyOn(commands, "runCommand").mockImplementation(async () => {
			expect(readFileSync(shrinkwrap, "utf8")).toBe(original);
			expect(JSON.parse(readFileSync(lockPath, "utf8")).packages["node_modules/helper"].integrity).toBeUndefined();
		});
		await commands.runNpmCommand(["install"], { cwd: dir });
		expect(readFileSync(shrinkwrap, "utf8")).toBe(original);
	});

	it("leaves explicit npm overrides unchanged", async () => {
		commands = new DefaultPackageManager({
			cwd: dir,
			agentDir: dir,
			settingsManager: SettingsManager.inMemory({ npmCommand: ["npm"] }),
		}) as unknown as ManagerCommands;
		vi.spyOn(commands, "runCommand").mockImplementation(async (command, _args, options) => {
			expect(command).toBe("npm");
			expect(options?.env).toBeUndefined();
			expect(readFileSync(lockPath, "utf8")).toBe(original);
		});
		await commands.runNpmCommand(["install"], { cwd: dir });
	});
});
