/**
 * Tests for git-based extension updates, specifically handling force-push scenarios.
 *
 * These tests verify that DefaultPackageManager.update() handles:
 * - Normal git updates (no force-push)
 * - Force-pushed remotes after a complete history rewrite
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import * as sleepModule from "../src/utils/sleep.ts";
import { allowNetwork } from "./test-network-env.ts";

// Helper to run git commands in a directory
function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: git ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout.trim();
}

function initGitRepo(repoDir: string): void {
	git(["init", "--initial-branch=main"], repoDir);
	git(["config", "--local", "user.email", "test@test.com"], repoDir);
	git(["config", "--local", "user.name", "Test"], repoDir);
}

// Helper to create a commit with a file
function createCommit(repoDir: string, filename: string, content: string, message: string): string {
	writeFileSync(join(repoDir, filename), content);
	git(["add", filename], repoDir);
	git(["commit", "-m", message], repoDir);
	return git(["rev-parse", "HEAD"], repoDir);
}

// Helper to get current commit hash
function getCurrentCommit(repoDir: string): string {
	return git(["rev-parse", "HEAD"], repoDir);
}

// Helper to get file content
function getFileContent(repoDir: string, filename: string): string {
	return readFileSync(join(repoDir, filename), "utf-8");
}

type GitSourceForTest = {
	type: "git";
	repo: string;
	host: string;
	path: string;
	pinned: boolean;
	ref?: string;
};

interface PackageManagerPathInternals {
	parseSource(source: string): GitSourceForTest;
	getGitInstallPath(source: GitSourceForTest, scope: "temporary"): string;
}

describe("DefaultPackageManager git update", () => {
	let tempDir: string;
	let remoteDir: string; // Simulates the "remote" repository
	let agentDir: string; // The agent directory where extensions are installed
	let installedDir: string; // The installed extension directory
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	// Git source that maps to our installed directory structure.
	// Must use "git:" prefix so parseSource() treats it as a git source
	// (bare "github.com/..." is not recognized as a git URL).
	const gitSource = "git:github.com/test/extension";

	beforeEach(() => {
		allowNetwork();
		tempDir = join(tmpdir(), `git-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		remoteDir = join(tempDir, "remote");
		agentDir = join(tempDir, "agent");

		// This matches the path structure: agentDir/git/<host>/<path>
		installedDir = join(agentDir, "git", "github.com", "test", "extension");

		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/** Sets up a "remote" repository and clones it to the installed directory. */
	function setupRemoteAndInstall(): void {
		// Create "remote" repository
		mkdirSync(remoteDir, { recursive: true });
		initGitRepo(remoteDir);
		createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

		// Clone to installed directory (simulating what install() does)
		mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
		git(["clone", remoteDir, installedDir], tempDir);
		git(["config", "--local", "user.email", "test@test.com"], installedDir);
		git(["config", "--local", "user.name", "Test"], installedDir);

		// Add to global packages so update() processes this source
		settingsManager.setPackages([gitSource]);
	}

	describe("normal updates (no force-push)", () => {
		it("should skip reset, clean, and install when already up to date", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			writeFileSync(join(remoteDir, "package.json"), JSON.stringify({ name: "test-extension", version: "1.0.0" }));
			createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			settingsManager.setPackages([gitSource]);

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "npm") {
					return;
				}
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			await packageManager.update();

			expect(executedCommands).toContain(
				"git fetch --depth=1 --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(executedCommands).not.toContain("git fetch --prune origin");
			expect(executedCommands).not.toContain("git reset --hard @{upstream}");
			expect(executedCommands).not.toContain("git reset --hard origin/HEAD");
			expect(executedCommands).not.toContain("git clean -fdx");
			expect(executedCommands).not.toContain("npm install");
		});

		it("should update to latest commit when remote has new commits", async () => {
			setupRemoteAndInstall();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");

			// Add a new commit to remote
			const newCommit = createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			// Update via package manager (no args = uses settings)
			await packageManager.update();

			// Verify update succeeded
			expect(getCurrentCommit(installedDir)).toBe(newCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		});
	});

	describe("force-push scenarios", () => {
		it("should handle complete history rewrite", async () => {
			setupRemoteAndInstall();

			// Remote gets several commits
			createCommit(remoteDir, "extension.ts", "// v2", "v2");
			createCommit(remoteDir, "extension.ts", "// v3", "v3");

			await packageManager.update();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v3");

			// Maintainer force-pushes completely different history
			git(["reset", "--hard", "HEAD~2"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// rewrite-a", "Rewrite A");
			const finalCommit = createCommit(remoteDir, "extension.ts", "// rewrite-b", "Rewrite B");

			// Should handle this gracefully
			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(finalCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// rewrite-b");
		});
	});

	describe("pinned sources", () => {
		it("should checkout the configured pinned git ref during full and targeted updates", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			const v1Commit = createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
			git(["tag", "v1"], remoteDir);
			const v2Commit = createCommit(remoteDir, "extension.ts", "// v2", "Second commit");
			git(["tag", "v2"], remoteDir);

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["checkout", "v1"], installedDir);
			expect(getCurrentCommit(installedDir)).toBe(v1Commit);

			const pinnedSource = `${gitSource}@v2`;
			settingsManager.setPackages([pinnedSource]);

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(v2Commit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");

			git(["checkout", "v1"], installedDir);

			await packageManager.update(pinnedSource);

			expect(getCurrentCommit(installedDir)).toBe(v2Commit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		});
	});

	describe("temporary git sources", () => {
		it("should refresh cached temporary git sources when resolving", async () => {
			const managerWithPaths = packageManager as unknown as PackageManagerPathInternals;
			const cachedDir = managerWithPaths.getGitInstallPath(managerWithPaths.parseSource(gitSource), "temporary");
			const extensionFile = join(cachedDir, "pi-extensions", "session-breakdown.ts");

			rmSync(cachedDir, { recursive: true, force: true });
			mkdirSync(join(cachedDir, "pi-extensions"), { recursive: true });
			writeFileSync(
				join(cachedDir, "package.json"),
				JSON.stringify({ pi: { extensions: ["./pi-extensions"] } }, null, 2),
			);
			writeFileSync(extensionFile, "// stale");

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture: (command: string, args: string[], options?: { cwd?: string }) => Promise<string>;
			};
			managerWithInternals.runCommand = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "git" && args[0] === "reset") {
					writeFileSync(extensionFile, "// fresh");
				}
			};
			managerWithInternals.runCommandCapture = async (_command, args) => {
				if (args[0] === "rev-parse" && args[1] === "HEAD") {
					return "local-head";
				}
				if (args[0] === "rev-parse" && args[1] === "@{upstream}") {
					return "remote-head";
				}
				if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
					return "origin/main";
				}
				return "";
			};

			await packageManager.resolveExtensionSources([gitSource], { temporary: true });

			expect(executedCommands).toContain(
				"git fetch --depth=1 --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(getFileContent(cachedDir, "pi-extensions/session-breakdown.ts")).toBe("// fresh");
		});

		it("should not apply update retries to temporary startup refresh", async () => {
			// Regression: temporary startup refresh keeps one fetch and no update
			// sleeps; a failed refresh falls back to the cached extension.
			const managerWithPaths = packageManager as unknown as PackageManagerPathInternals;
			const cachedDir = managerWithPaths.getGitInstallPath(managerWithPaths.parseSource(gitSource), "temporary");
			mkdirSync(join(cachedDir, "pi-extensions"), { recursive: true });
			writeFileSync(
				join(cachedDir, "package.json"),
				JSON.stringify({ pi: { extensions: ["./pi-extensions"] } }, null, 2),
			);
			writeFileSync(join(cachedDir, "pi-extensions", "session-breakdown.ts"), "// cached");

			const runCommand = vi.fn(async (_command: string, _args: string[]) => {
				throw new Error("TLS EOF");
			});
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture: (command: string, args: string[], options?: { cwd?: string }) => Promise<string>;
			};
			managerWithInternals.runCommand = runCommand;
			managerWithInternals.runCommandCapture = async () => "origin/main";
			const delays: number[] = [];
			vi.spyOn(sleepModule, "sleep").mockImplementation(async (ms) => {
				delays.push(ms);
			});

			const result = await packageManager.resolveExtensionSources([gitSource], { temporary: true });

			expect(result.extensions).toHaveLength(1);
			expect(runCommand).toHaveBeenCalledTimes(1);
			expect(delays).toEqual([]);
		});
	});

	describe("update retries", () => {
		interface RunCommandInternals {
			runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
		}

		function realRunCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
			const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf-8" });
			if (result.status !== 0) {
				return Promise.reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`));
			}
			return Promise.resolve();
		}

		function recordSleeps(): number[] {
			const delays: number[] = [];
			vi.spyOn(sleepModule, "sleep").mockImplementation(async (ms) => {
				delays.push(ms);
			});
			return delays;
		}

		it("recovers a transient git fetch failure without rerunning successful siblings", async () => {
			// Transient TLS EOF on the first fetch; the update finishes on attempt two.
			setupRemoteAndInstall();
			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			const delays = recordSleeps();
			const internals = packageManager as unknown as RunCommandInternals;
			const original = internals.runCommand.bind(packageManager);
			let fetches = 0;
			const progress: string[] = [];
			packageManager.setProgressCallback((event) => {
				if (event.type === "progress" && event.message) progress.push(event.message);
			});
			vi.spyOn(internals, "runCommand").mockImplementation((command, args, options) => {
				if (command === "git" && args[0] === "fetch" && fetches++ === 0) {
					return Promise.reject(new Error("git fetch failed with code 128: TLS EOF"));
				}
				return original(command, args, options);
			});

			await packageManager.update();

			expect(fetches).toBe(2);
			expect(delays).toEqual([3000]);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
			expect(progress.some((m) => m.includes("retrying in 3s (1/3)"))).toBe(true);
		});

		it("makes four attempts with 3s/6s/12s waits, then surfaces the original error", async () => {
			setupRemoteAndInstall();

			const delays = recordSleeps();
			const internals = packageManager as unknown as RunCommandInternals;
			let fetches = 0;
			vi.spyOn(internals, "runCommand").mockImplementation((command, args) => {
				if (command === "git" && args[0] === "fetch") {
					fetches++;
					return Promise.reject(new Error(`git fetch failed with code 128: TLS EOF #${fetches}`));
				}
				return realRunCommand(command, args);
			});

			await expect(packageManager.update()).rejects.toThrow("TLS EOF #4");
			expect(fetches).toBe(4);
			expect(delays).toEqual([3000, 6000, 12000]);
		});

		it("keeps a successful sibling update while another git source fails four times", async () => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			// A second git source maps to a sibling install directory that updates cleanly.
			const otherSource = "git:github.com/test/other";
			const otherRemote = join(tempDir, "other-remote");
			mkdirSync(otherRemote, { recursive: true });
			initGitRepo(otherRemote);
			createCommit(otherRemote, "extension.ts", "// other", "other commit");
			const otherDir = join(agentDir, "git", "github.com", "test", "other");
			git(["clone", otherRemote, otherDir], tempDir);
			// Advance after cloning so an unfinished update cannot pass as already up to date.
			const otherHead = createCommit(otherRemote, "extension.ts", "// other v2", "other second commit");
			settingsManager.setPackages([gitSource, otherSource]);

			recordSleeps();
			const internals = packageManager as unknown as RunCommandInternals;
			const original = internals.runCommand.bind(packageManager);
			const fetchesByDir = new Map<string, number>();
			const otherUpdateCompleted = new Promise<boolean>((resolve) => {
				packageManager.setProgressCallback((event) => {
					if (
						event.action === "update" &&
						event.source === otherSource &&
						(event.type === "complete" || event.type === "error")
					) {
						resolve(event.type === "complete");
					}
				});
			});
			vi.spyOn(internals, "runCommand").mockImplementation((command, args, options) => {
				if (command === "git" && args[0] === "fetch" && options?.cwd) {
					const count = (fetchesByDir.get(options.cwd) ?? 0) + 1;
					fetchesByDir.set(options.cwd, count);
					if (options.cwd === installedDir) {
						return Promise.reject(new Error("git fetch failed with code 128: TLS EOF"));
					}
				}
				return original(command, args, options);
			});

			await expect(packageManager.update()).rejects.toThrow("TLS EOF");

			expect(fetchesByDir.get(installedDir)).toBe(4);
			// Rejection does not cancel the sibling; drain its terminal event before cleanup.
			expect(await otherUpdateCompleted).toBe(true);
			expect(fetchesByDir.get(otherDir)).toBe(1);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
			expect(getCurrentCommit(otherDir)).toBe(otherHead);
			expect(getFileContent(otherDir, "extension.ts")).toBe("// other v2");
		});
	});
});
