import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { NpmRuntimeDependency } from "../src/core/npm-dependency-updates.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface DependencyUpdateAdapters {
	getNpmCommand(): { command: string; args: string[]; embeddedBun?: boolean };
	getNpmDependencyUpdates(
		sources: Array<{ source: string; parsed: { name: string } }>,
		scope: "user" | "project",
	): Promise<Map<string, string[]>>;
	getDependencyUpdates(
		dependencies: Map<string, NpmRuntimeDependency[]>,
		sources: Map<string, string[]>,
		metadataCwd: string,
		installRoot: string,
	): Promise<Map<string, string[]>>;
	refreshRuntimeDependencies(names: string[], installRoot: string, preserveManifest: boolean): Promise<void>;
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
}

for (const scope of ["user", "project"] as const) {
	it.each([
		{ manager: "bun", embeddedBun: true, managedMetadata: true },
		{ manager: "pnpm", embeddedBun: false, managedMetadata: true },
		{ manager: "npm", embeddedBun: false, managedMetadata: false },
		{ manager: "bun", embeddedBun: false, managedMetadata: false },
	])(`${scope}: separates $manager metadata cwd from native install root (embedded=$embeddedBun)`, async (config) => {
		const root = mkdtempSync(join(tmpdir(), "dependency-update-adapters-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "work");
		const installRoot = scope === "user" ? join(agentDir, "npm") : join(cwd, ".pi", "npm");
		mkdirSync(installRoot, { recursive: true });
		const settings = SettingsManager.inMemory({ npmCommand: [config.manager] });
		settings.setProjectTrusted(true);
		const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
		const adapters = pm as unknown as DependencyUpdateAdapters;
		const command = vi.spyOn(adapters, "getNpmCommand").mockReturnValue({
			command: config.manager,
			args: [],
			embeddedBun: config.embeddedBun,
		});
		const dependencyCheck = vi.spyOn(adapters, "getDependencyUpdates").mockResolvedValue(new Map());
		try {
			await adapters.getNpmDependencyUpdates([{ source: "npm:plugin@1.0.0", parsed: { name: "plugin" } }], scope);
			expect(dependencyCheck).toHaveBeenCalledExactlyOnceWith(
				new Map(),
				new Map([["npm:plugin@1.0.0", ["plugin"]]]),
				config.managedMetadata ? installRoot : cwd,
				installRoot,
			);
		} finally {
			command.mockRestore();
			dependencyCheck.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

it.each([false, true])(
	"pnpm retries native failure only, not progress failure (progressFails=%s)",
	async (progressFails) => {
		const root = mkdtempSync(join(tmpdir(), "dependency-update-retry-"));
		const agentDir = join(root, "agent");
		const settings = SettingsManager.inMemory({ npmCommand: ["pnpm"] });
		const pm = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings });
		const adapters = pm as unknown as DependencyUpdateAdapters;
		const failure = new Error("Native dependency update failed");
		const progressFailure = new Error("Progress callback failed");
		const command = vi.spyOn(adapters, "runCommand").mockRejectedValueOnce(failure).mockResolvedValue(undefined);
		pm.setProgressCallback(() => {
			if (progressFails) throw progressFailure;
		});
		vi.useFakeTimers();
		try {
			const refresh = adapters.refreshRuntimeDependencies(["leaf"], root, true);
			if (progressFails) {
				await expect(refresh).rejects.toBe(progressFailure);
				expect(command).toHaveBeenCalledTimes(1);
			} else {
				await vi.advanceTimersByTimeAsync(3000);
				await refresh;
				expect(command).toHaveBeenCalledTimes(2);
				expect(command.mock.calls[1]).toEqual(command.mock.calls[0]);
			}
			const [manager, args, options] = command.mock.calls[0];
			expect(manager).toBe("pnpm");
			expect(args.slice(0, 2)).toEqual(["update", "leaf"]);
			expect(options).toEqual({ cwd: root });
			expect(existsSync(args[args.indexOf("--cache-dir") + 1])).toBe(false);
			expect(readdirSync(join(agentDir, "tmp", "extensions"))).toEqual([]);
		} finally {
			vi.useRealTimers();
			command.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
