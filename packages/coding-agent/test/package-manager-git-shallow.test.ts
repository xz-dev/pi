import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const source = "https://fixture.invalid/owner/repo";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("shallow git package storage", () => {
	let root: string;
	let remote: string;
	let target: string;
	let commits: string[];
	let manager: DefaultPackageManager;
	let settings: SettingsManager;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-git-shallow-"));
		const config = join(root, "gitconfig");
		const hooks = join(root, "hooks");
		mkdirSync(hooks);
		writeFileSync(config, "");
		vi.stubEnv("GIT_CONFIG_GLOBAL", config);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
		vi.stubEnv("PI_OFFLINE", "0");
		git(root, "config", "--global", "user.name", "Pi test");
		git(root, "config", "--global", "user.email", "pi-test@example.invalid");
		git(root, "config", "--global", "commit.gpgSign", "false");
		git(root, "config", "--global", "tag.gpgSign", "false");
		git(root, "config", "--global", "core.hooksPath", hooks);
		remote = join(root, "remote");
		git(root, "init", "--initial-branch=main", remote);
		mkdirSync(join(remote, "skills"));
		commits = [];
		for (let i = 0; i < 3; i++) {
			writeFileSync(join(remote, "skills", "fixture.md"), `revision ${i}\n`);
			git(remote, "add", "skills/fixture.md");
			git(remote, "commit", "-m", `revision ${i}`);
			commits.push(git(remote, "rev-parse", "HEAD"));
		}
		git(remote, "branch", "feature/pinned", commits[1]);
		git(remote, "tag", "-a", "v1", commits[0], "-m", "old release");
		git(remote, "tag", "v2", commits[1]);
		// file:// exercises real upload-pack depth handling, without contacting a network service.
		git(root, "config", "--global", `url.${pathToFileURL(remote).href}.insteadOf`, source);
		const agentDir = join(root, "agent");
		target = join(agentDir, "git", "fixture.invalid", "owner", "repo");
		settings = SettingsManager.inMemory();
		manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it.each(["user", "project", "temporary"] as const)(
		"shallow-clones the default branch for %s installs",
		async (scope) => {
			if (scope === "temporary") {
				const resources = await manager.resolveExtensionSources([source], { temporary: true });
				target = resources.skills.find((skill) => skill.metadata.source === source)!.metadata.baseDir!;
			} else {
				await manager.install(source, { local: scope === "project" });
				target = manager.getInstalledPath(source, scope)!;
			}
			expect(git(target, "rev-parse", "HEAD")).toBe(commits[2]);
			expect(git(target, "rev-parse", "--is-shallow-repository")).toBe("true");
			expect(git(target, "rev-list", "--all", "--count")).toBe("1");
			expect(git(target, "tag", "--list")).toBe("");
			expect(git(target, "config", "--get", "remote.origin.fetch")).toBe(
				"+refs/heads/main:refs/remotes/origin/main",
			);
		},
	);

	it.each([
		["feature/pinned", 1],
		["v1", 0],
		["v2", 1],
	] as const)("clones only the selected branch/tag %s", async (ref, index) => {
		await manager.install(`${source}@${ref}`);
		expect(git(target, "rev-parse", "HEAD")).toBe(commits[index]);
		expect(git(target, "rev-list", "--all", "--count")).toBe("1");
		expect(git(target, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/main")).toBe("");
	});

	it("fetches a full commit ID without cloning the default branch", async () => {
		await manager.install(`${source}@${commits[1]}`);
		expect(git(target, "rev-parse", "HEAD")).toBe(commits[1]);
		expect(git(target, "rev-list", "--all", "HEAD", "--count")).toBe("1");
		expect(git(target, "for-each-ref", "--format=%(refname)", "refs/remotes", "refs/tags")).toBe("");
		await manager.install(source);
		expect(git(target, "rev-parse", "HEAD")).toBe(commits[2]);
		expect(git(target, "rev-list", "HEAD", "--count")).toBe("1");
	});

	it("retains abbreviated commit installs through local history resolution", async () => {
		await manager.install(`${source}@${commits[1].slice(0, 8)}`);
		expect(git(target, "rev-parse", "HEAD")).toBe(commits[1]);
	});

	it("reconciles a shallow checkout across tags, commits, and the default branch", async () => {
		await manager.install(source);
		for (const [ref, index] of [
			["v1", 0],
			[commits[1], 1],
			["v2", 1],
		] as const) {
			settings.setPackages([`${source}@${ref}`]);
			await manager.update(source);
			expect(git(target, "rev-parse", "HEAD")).toBe(commits[index]);
			expect(git(target, "rev-list", "HEAD", "--count")).toBe("1");
		}
		await manager.install(source);
		expect(git(target, "rev-parse", "HEAD")).toBe(commits[2]);
	});

	it.each([false, true])("updates across omitted commits (temporary=%s)", async (temporary) => {
		if (temporary) {
			const resources = await manager.resolveExtensionSources([source], { temporary: true });
			target = resources.skills.find((skill) => skill.metadata.source === source)!.metadata.baseDir!;
		} else {
			await manager.installAndPersist(source);
		}
		git(remote, "commit", "--allow-empty", "-m", "intermediate");
		writeFileSync(join(remote, "skills", "fixture.md"), "updated\n");
		git(remote, "add", "skills/fixture.md");
		git(remote, "commit", "-m", "new tip");
		if (temporary) await manager.resolveExtensionSources([source], { temporary: true });
		else await manager.update(source);
		expect(git(target, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "HEAD"));
		expect(git(target, "rev-list", "HEAD", "--count")).toBe("1");
		expect(readFileSync(join(target, "skills", "fixture.md"), "utf8")).toBe("updated\n");
	});

	it.each([false, true])("reconciles a full clone without deleting its refs (split=%s)", async (split) => {
		mkdirSync(join(target, ".."), { recursive: true });
		git(root, "clone", source, target);
		git(target, "branch", "local-work", commits[0]);
		git(target, "commit-graph", "write", "--reachable", ...(split ? ["--split"] : []));
		const graphPath = join(target, ".git", "objects", "info", split ? "commit-graphs" : "commit-graph");
		expect(existsSync(graphPath)).toBe(true);
		const oldTag = git(target, "rev-parse", "refs/tags/v1");

		await manager.install(`${source}@v2`);

		expect(git(target, "rev-parse", "HEAD")).toBe(commits[1]);
		expect(git(target, "rev-list", "HEAD", "--count")).toBe("1");
		expect(git(target, "rev-parse", "refs/heads/local-work")).toBe(commits[0]);
		expect(git(target, "rev-parse", "refs/tags/v1")).toBe(oldTag);
		expect(existsSync(graphPath)).toBe(false);
		git(target, "fsck", "--full");
	});

	it("leaves an existing checkout unchanged when a ref cannot be fetched", async () => {
		await manager.install(source);
		await expect(manager.install(`${source}@missing-ref`)).rejects.toThrow();
		expect(git(target, "rev-parse", "HEAD")).toBe(commits[2]);
		expect(git(target, "status", "--porcelain")).toBe("");
	});

	it.each(["missing-ref", "0".repeat(40)])("removes a failed new install for %s", async (ref) => {
		await expect(manager.install(`${source}@${ref}`)).rejects.toThrow();
		expect(existsSync(target)).toBe(false);
	});
});
