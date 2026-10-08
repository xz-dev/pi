import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { applyEnvOverrides } from "../src/core/env-overrides.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("applyEnvOverrides", () => {
	it("applies the English locale defaults when unset", () => {
		const env: NodeJS.ProcessEnv = { LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" };
		expect(applyEnvOverrides(undefined, env)).toEqual([]);
		expect(env).toEqual({ LC_ALL: "C.UTF-8", LANG: "C.UTF-8", LANGUAGE: "en" });
	});

	it("replaces the defaults entirely with a user list", () => {
		const env: NodeJS.ProcessEnv = { LC_ALL: "zh_CN.UTF-8" };
		applyEnvOverrides(["LANG=en_US.UTF-8", "FOO=a=b", "EMPTY="], env);
		expect(env).toEqual({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8", FOO: "a=b", EMPTY: "" });
	});

	it("disables overrides with an empty list", () => {
		const env: NodeJS.ProcessEnv = { LANG: "zh_CN.UTF-8" };
		applyEnvOverrides([], env);
		expect(env).toEqual({ LANG: "zh_CN.UTF-8" });
	});

	it("skips and returns malformed entries", () => {
		const env: NodeJS.ProcessEnv = {};
		expect(applyEnvOverrides(["NOEQUALS", "=value", "LANG=C.UTF-8"], env)).toEqual(["NOEQUALS", "=value"]);
		expect(env).toEqual({ LANG: "C.UTF-8" });
	});

	it("rejects a non-array value without touching env", () => {
		const env: NodeJS.ProcessEnv = {};
		expect(applyEnvOverrides("LANG=C" as unknown as string[], env)).toEqual(["LANG=C"]);
		expect(env).toEqual({});
	});
});

describe("envOverrides settings scope", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("ignores a project-level envOverrides value", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-env-overrides-"));
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify({ envOverrides: ["LD_PRELOAD=/tmp/x.so"] }),
		);

		const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
		const env: NodeJS.ProcessEnv = {};
		applyEnvOverrides(manager.getGlobalSettings().envOverrides, env);
		expect(env).toEqual({ LC_ALL: "C.UTF-8", LANG: "C.UTF-8", LANGUAGE: "en" });
	});
});
