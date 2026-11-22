import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinSkillsDir } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { formatSkillsForPrompt, loadSkillsFromDir } from "../src/core/skills.ts";

const name = "persistent-background-tasks";
const sourceDir = fileURLToPath(new URL("../.pi/skills", import.meta.url));
let root: string;
let cwd: string;
let agentDir: string;

function put(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-builtin-skills-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	mkdirSync(join(root, "home"));
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("USERPROFILE", join(root, "home"));
	// Resource loading does not require disabling process ownership or starting helpers.
	vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", undefined);
	vi.stubEnv("PI_PACKAGE_DIR", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("built-in persistent background skill", () => {
	it("loads valid model-invoked instructions with all handoff and non-escape requirements", () => {
		const { skills, diagnostics } = loadSkillsFromDir({ dir: sourceDir, source: "builtin" });
		expect(diagnostics).toEqual([]);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({ name, disableModelInvocation: false });
		expect(skills[0].description.length).toBeGreaterThan(0);
		expect(skills[0].description.length).toBeLessThanOrEqual(1024);
		const body = readFileSync(skills[0].filePath, "utf8");
		expect(body.split("\n").length).toBeLessThan(100);
		for (const text of [
			"must keep running after Pi exits",
			"process_list",
			"process_kill",
			"`unconfirmed` is not proof of cleanup",
			"`best-effort` scope is not a kernel guarantee",
			"`nohup`, `setsid`, and setting `PI_NO_PROCESS_OWNERSHIP=1` inside an owned child",
			"already-running external tmux server",
			"explicit socket",
			"do not create\nor restart it from an owned shell",
			"actual worker PID",
			"owner's parent chain",
			"cgroup",
			"Job membership",
			"task-specific readiness",
			"persistence as unverified",
			"systemctl --user status NAME",
			"journalctl --user -u NAME",
			"systemctl --user stop NAME",
		]) {
			expect(body).toContain(text);
		}
		const advertised = formatSkillsForPrompt(skills);
		expect(advertised).toContain(skills[0].description);
		expect(advertised).toContain(skills[0].filePath);
		expect(advertised).not.toContain("## Verify the handoff");
	});

	it.each([true, false])("discovers exactly once outside the checkout (project trusted: %s)", async (trusted) => {
		put(join(cwd, ".pi/skills/untrusted/SKILL.md"), "---\nname: untrusted\ndescription: Project skill\n---\nBody");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: trusted }),
		});
		for (let reload = 0; reload < 2; reload++) {
			await loader.reload();
			const { skills, diagnostics } = loader.getSkills();
			expect(diagnostics).toEqual([]);
			const builtin = skills.filter((skill) => skill.name === name);
			expect(builtin).toHaveLength(1);
			expect(builtin[0].sourceInfo?.source).toBe("builtin");
			expect(realpathSync(builtin[0].filePath)).toBe(join(sourceDir, name, "SKILL.md"));
			expect(readFileSync(builtin[0].filePath, "utf8")).toContain("# Persistent background tasks");
			expect(skills.map((skill) => skill.name).sort()).toEqual(trusted ? [name, "untrusted"] : [name]);
		}
	});

	it("suppresses default built-ins with noSkills while preserving explicit paths", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
		await loader.reload();
		expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
		const explicit = new DefaultResourceLoader({ cwd, agentDir, noSkills: true, additionalSkillPaths: [sourceDir] });
		await explicit.reload();
		expect(explicit.getSkills().skills.map((skill) => skill.name)).toEqual([name]);
	});

	it.each(["package", "user", "project"])(
		"keeps a same-name %s skill above the built-in with collision diagnostics",
		async (origin) => {
			const packageDir = join(root, "skill-package");
			const directory =
				origin === "package"
					? join(packageDir, "skills")
					: origin === "user"
						? join(agentDir, "skills")
						: join(cwd, ".pi/skills");
			const filePath = join(directory, name, "SKILL.md");
			put(filePath, `---\nname: ${name}\ndescription: Override from ${origin}\n---\nOverride instructions\n`);
			if (origin === "package")
				put(
					join(packageDir, "package.json"),
					JSON.stringify({ name: "test-skill-package", pi: { skills: ["./skills"] } }),
				);
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(origin === "package" ? { packages: [packageDir] } : {}),
			});
			await loader.reload();
			const { skills, diagnostics } = loader.getSkills();
			expect(skills).toHaveLength(1);
			expect(skills[0].filePath).toBe(filePath);
			expect(skills[0].sourceInfo?.source).not.toBe("builtin");
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].message).toContain("collision");
		},
	);
});

it("resolves source and installed package skill roots without changing the package override", () => {
	vi.stubEnv("PI_PACKAGE_DIR", root);
	expect(getBuiltinSkillsDir()).toBe(join(root, "dist/skills"));
	mkdirSync(join(root, "src"));
	expect(getBuiltinSkillsDir()).toBe(join(root, ".pi/skills"));
});

it("materializes virtual Bun skills to physical files and reuses the non-clobbering cache", () => {
	const assets = join(root, "embedded");
	put(join(assets, "skills", name, "SKILL.md"), "embedded skill body");
	const loader = join(root, "loader.mjs");
	put(
		loader,
		`
import { registerHooks } from "node:module";
registerHooks({load(url, context, next) {
 const result = next(url, context);
 if (!url.endsWith("/src/config.ts")) return result;
 let source = String(result.source);
 source = source.replace(/const EMBEDDED_ASSETS_ROOT = [^;]+;/, ${JSON.stringify(`const EMBEDDED_ASSETS_ROOT = ${JSON.stringify(assets)};`)});
 source = source.replace(/export const isBunBinary =[^;]+;/, "export const isBunBinary = true;");
 return { ...result, source };
}});
`,
	);
	const config = fileURLToPath(new URL("../src/config.ts", import.meta.url));
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--import",
			loader,
			"--input-type=module",
			"-e",
			`
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBuiltinSkillsDir } from ${JSON.stringify(config)};
const first = getBuiltinSkillsDir();
const path = join(first, ${JSON.stringify(name)}, "SKILL.md");
const body = readFileSync(path, "utf8");
writeFileSync(path, "cached edit");
console.log(JSON.stringify({ first, second: getBuiltinSkillsDir(), path: realpathSync(path), body, cached: readFileSync(path, "utf8") }));
`,
		],
		{ env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }, encoding: "utf8", timeout: 6000 },
	);
	expect(result.status, result.stderr).toBe(0);
	const actual = JSON.parse(result.stdout) as {
		first: string;
		second: string;
		path: string;
		body: string;
		cached: string;
	};
	expect(actual.first).toBe(actual.second);
	expect(actual.first.startsWith(root)).toBe(true);
	expect(actual.first).not.toBe(join(assets, "skills"));
	expect(actual.path).toBe(join(actual.first, name, "SKILL.md"));
	expect(actual.body).toBe("embedded skill body");
	expect(actual.cached).toBe("cached edit");
});
