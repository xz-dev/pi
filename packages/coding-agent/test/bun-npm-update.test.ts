import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as config from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface Commands {
	runCommand(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<void>;
	getLatestNpmVersion(spec: string, range?: string): Promise<string>;
}

// Regression: https://github.com/xz-dev/pi/issues/6 (151): Bun cannot update undeclared packages.
describe("embedded Bun updates registered npm packages", () => {
	let dir: string;
	let npmDir: string;
	let settings: SettingsManager;
	let manager: DefaultPackageManager;
	let commands: Commands;

	beforeEach(() => {
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.spyOn(config, "isBunBinary", "get").mockReturnValue(true);
		vi.spyOn(config, "DISTRIBUTION", "get").mockReturnValue("xz-dev");
		dir = mkdtempSync(join(tmpdir(), "pi-bun-update-"));
		npmDir = join(dir, "npm");
		mkdirSync(npmDir);
		settings = SettingsManager.inMemory({ packages: ["npm:third-party-plugin", "npm:@example/plugin@^2.0.0"] });
		manager = new DefaultPackageManager({ cwd: dir, agentDir: dir, settingsManager: settings });
		commands = manager as unknown as Commands;
		vi.spyOn(commands, "getLatestNpmVersion").mockResolvedValue("2.5.0");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([false, true])(
		"installs undeclared registered packages before updating (manifest=%s)",
		async (hasManifest) => {
			if (hasManifest) writeFileSync(join(npmDir, "package.json"), '{"name":"pi-extensions","private":true}');
			// Installed files do not make a package declared in Bun's manifest.
			mkdirSync(join(npmDir, "node_modules", "third-party-plugin"), { recursive: true });
			writeFileSync(join(npmDir, "node_modules", "third-party-plugin", "package.json"), '{"version":"1.0.0"}');
			const run = vi.spyOn(commands, "runCommand").mockResolvedValue();
			await manager.update();
			expect(run.mock.calls.map((call) => call[1])).toEqual([
				["install", "third-party-plugin@latest", "@example/plugin@^2.0.0", "--cwd", npmDir, "--omit=peer"],
				["update", "third-party-plugin@latest", "@example/plugin@^2.0.0", "--cwd", npmDir, "--omit=peer"],
			]);
			expect(settings.getGlobalSettings().packages).toEqual([
				"npm:third-party-plugin",
				"npm:@example/plugin@^2.0.0",
			]);
		},
	);

	it("only installs missing declarations in a mixed batch", async () => {
		writeFileSync(join(npmDir, "package.json"), JSON.stringify({ dependencies: { "third-party-plugin": "^1.0.0" } }));
		const run = vi.spyOn(commands, "runCommand").mockResolvedValue();
		await manager.update();
		expect(run.mock.calls.map((call) => call[1][0])).toEqual(["install", "update"]);
		expect(run.mock.calls[0][1]).toEqual(["install", "@example/plugin@^2.0.0", "--cwd", npmDir, "--omit=peer"]);
	});

	it("keeps normal updates when all packages are declared", async () => {
		writeFileSync(
			join(npmDir, "package.json"),
			JSON.stringify({ dependencies: { "third-party-plugin": "latest", "@example/plugin": "^2.0.0" } }),
		);
		const run = vi.spyOn(commands, "runCommand").mockResolvedValue();
		await manager.update();
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][1][0]).toBe("update");
	});

	it("does not retry or continue after dependency installation fails", async () => {
		const run = vi.spyOn(commands, "runCommand").mockRejectedValue(new Error("integrity failure"));
		await expect(manager.update()).rejects.toThrow("integrity failure");
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][1][0]).toBe("install");
	});

	it("does not rewrite invalid manifests", async () => {
		writeFileSync(join(npmDir, "package.json"), "invalid");
		vi.spyOn(commands, "runCommand").mockResolvedValue();
		await expect(manager.update()).rejects.toThrow();
		expect(readFileSync(join(npmDir, "package.json"), "utf8")).toBe("invalid");
	});
});
