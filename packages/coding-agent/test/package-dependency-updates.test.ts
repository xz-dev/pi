import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { getGitDependencyTarget } from "../src/core/git-dependency-updates.ts";
import { getNpmRuntimeDependencies, type NpmRuntimeDependency } from "../src/core/npm-dependency-updates.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { stripJsonComments } from "../src/utils/json.ts";

interface FixturePackage {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	os?: string[];
	cpu?: string[];
	engines?: { node: string };
}

interface Scenario {
	name: string;
	initialA?: string;
	initialB?: string;
	rangeA?: string;
	rangeB?: string;
	versions?: string[];
	latest?: string;
	optional?: boolean;
	rejected?: Pick<FixturePackage, "os" | "cpu" | "engines">;
	rejectedVersion?: string;
	updatedVersion?: string;
	ownUpdate?: boolean;
	rootRegistry?: boolean;
	workspace?: "root" | "ancestor";
	workspaceEnv?: "NPM_CONFIG_WORKSPACE_DIR" | "npm_config_workspace_dir";
	updateFailure?: boolean;
	unrelated?: boolean;
	gitDependency?:
		| "head"
		| "branch"
		| "sha"
		| "tag"
		| "ambiguous"
		| "semver"
		| "mixed-registry"
		| "mixed-ref"
		| "mixed-repo";
	gitIndirect?: boolean;
	gitUpdate?: boolean;
	gitUnselected?: boolean;
	gitLifecycle?: boolean;
	gitExoticTarget?: boolean;
	gitPeerTarget?: boolean;
	gitTargetVersion?: string;
	gitAlias?: boolean;
	gitAuthFailure?: boolean;
	gitMetadataFailure?: boolean;
	gitUnknownInstance?: boolean;
	gitEscapedInstance?: boolean;
	gitRepositoryEnv?: boolean;
	gitTemplate?: boolean;
	gitOptionName?: "--latest" | "--force";
	offline?: boolean;
	untrusted?: boolean;
	authorLock?: "package-lock.json" | "npm-shrinkwrap.json" | "bun.lock" | "bun.lockb" | "pnpm-lock.yaml" | "yarn.lock";
	git?: "floating" | "sha" | "tag" | "tracked-lock" | "tracked-shrinkwrap" | "both";
}

async function runFixtureCommand(command: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => child.kill(), 30000);
		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) resolve(stdout.trim());
			else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`));
		});
	});
}

const scenarios: Scenario[] = [
	...(["--latest", "--force"] as const).map((gitOptionName) => ({
		name: `rejects option-shaped Git target ${gitOptionName} without moving source pins or unselected Git payloads`,
		gitDependency: "head" as const,
		gitUnselected: true,
		gitOptionName,
		versions: ["2.0.0"],
	})),
	{
		name: "does not query Git targets with repository-directed Git environment",
		gitDependency: "head",
		git: "sha",
		gitRepositoryEnv: true,
		versions: ["2.0.0"],
	},
	{
		name: "keeps metadata isolated from configured Git templates",
		gitDependency: "head",
		git: "sha",
		gitTemplate: true,
		gitUpdate: true,
		versions: ["2.0.0"],
	},
	{
		name: "blocks a name-wide Git update when another instance has unknown version",
		gitDependency: "mixed-repo",
		git: "sha",
		gitIndirect: true,
		gitUnknownInstance: true,
		versions: ["2.0.0"],
	},
	{
		name: "blocks Git updates with an escaped installed instance",
		gitDependency: "mixed-repo",
		git: "sha",
		gitIndirect: true,
		gitEscapedInstance: true,
		versions: ["2.0.0"],
	},
	{
		name: "skips a direct pnpm Git target introducing unproved peer locators",
		gitDependency: "head",
		git: "sha",
		gitPeerTarget: true,
		versions: ["2.0.0"],
	},
	{
		name: "does not advertise an aliased Git dependency",
		gitDependency: "head",
		git: "sha",
		gitAlias: true,
		versions: ["2.0.0"],
	},
	{
		name: "does not downgrade a Git package version while following its branch",
		gitDependency: "head",
		git: "sha",
		gitTargetVersion: "0.9.0",
		versions: ["2.0.0"],
	},
	...(["head", "branch"] as const).map((gitDependency) => ({
		name: `refreshes indirect ${gitDependency} Git dependencies at unchanged version`,
		gitDependency,
		gitIndirect: true,
		gitUpdate: true,
		git: "sha" as const,
		versions: ["2.0.0"],
	})),
	...(["head", "branch"] as const).map((gitDependency) => ({
		name: `refreshes direct ${gitDependency} Git dependencies at unchanged version`,
		gitDependency,
		gitUpdate: true,
		git: "sha" as const,
		versions: ["2.0.0"],
	})),
	...(["head", "branch"] as const).flatMap((gitDependency) =>
		[false, true].map((gitIndirect) => ({
			name: `refreshes managed ${gitIndirect ? "indirect" : "direct"} ${gitDependency} Git dependencies without moving an unselected Git subtree`,
			gitDependency,
			gitIndirect,
			gitUpdate: true,
			gitUnselected: true,
			versions: ["2.0.0"],
		})),
	),
	...(["sha", "tag", "ambiguous", "semver", "mixed-registry", "mixed-ref", "mixed-repo"] as const).map(
		(gitDependency) => ({
			name: `preserves unsafe or pinned ${gitDependency} Git constraints`,
			gitDependency,
			gitIndirect: gitDependency.startsWith("mixed"),
			git: "sha" as const,
			versions: ["2.0.0"],
		}),
	),
	{
		name: "skips a Git target rejected by Node eligibility",
		gitDependency: "head",
		git: "sha",
		rejected: { engines: { node: "<1.0.0" } },
		versions: ["2.0.0"],
	},
	{
		name: "skips a Git target rejected by OS eligibility",
		gitDependency: "head",
		git: "sha",
		rejected: { os: ["not-an-os"] },
		versions: ["2.0.0"],
	},
	{
		name: "inspects Git targets without changing installed state or running prepare",
		gitDependency: "head",
		git: "sha",
		gitUpdate: true,
		gitLifecycle: true,
		versions: ["2.0.0"],
	},
	{
		name: "skips a direct pnpm Git target introducing exotic subdependencies",
		gitDependency: "head",
		git: "sha",
		gitExoticTarget: true,
		versions: ["2.0.0"],
	},
	{
		name: "does not inspect Git dependencies after project trust is removed",
		gitDependency: "head",
		git: "sha",
		untrusted: true,
		versions: ["2.0.0"],
	},
	{
		name: "does not query or refresh Git dependencies offline",
		gitDependency: "head",
		git: "sha",
		offline: true,
		versions: ["2.0.0"],
	},
	{
		name: "cleans owned Git metadata when a target manifest is missing",
		gitDependency: "head",
		git: "sha",
		gitMetadataFailure: true,
		rangeA: "2.0.0",
		versions: ["2.0.0"],
	},
	{
		name: "reports native SSH authentication failure without HTTP fallback",
		gitDependency: "head",
		git: "sha",
		gitAuthFailure: true,
		rangeA: "2.0.0",
		versions: ["2.0.0"],
	},
	...(
		["package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"] as const
	).map((authorLock) => ({
		name: `preserves floating Git dependencies under tracked ${authorLock}`,
		authorLock,
		gitDependency: "head" as const,
		git: "sha" as const,
		versions: ["2.0.0"],
	})),
	...(["NPM_CONFIG_WORKSPACE_DIR", "npm_config_workspace_dir"] as const).flatMap((workspaceEnv) =>
		([undefined, "floating"] as const).map((git) => ({
			name: `skips external workspace environment ${workspaceEnv} for ${git ? "Git" : "managed npm"} roots`,
			workspaceEnv,
			git,
			initialA: "1.0.0",
			rangeA: "^1.0.0",
			versions: ["1.0.0", "1.1.0", "3.0.0"],
			latest: "1.1.0",
		})),
	),
	{ name: "preserves an unselected plugin's unrelated floating subtree", unrelated: true, updatedVersion: "2.1.0" },
	{ name: "skips native pnpm workspace settings at the managed root", workspace: "root" },
	{
		name: "skips ancestor native pnpm workspace settings through symlinked Git storage",
		workspace: "ancestor",
		git: "floating",
	},
	{ name: "cleans temporary pnpm metadata after an update failure", updateFailure: true, updatedVersion: "2.1.0" },
	{ name: "uses the managed root registry context for dependencies", rootRegistry: true, updatedVersion: "2.1.0" },
	{ name: "reports both npm package and dependency updates", ownUpdate: true, updatedVersion: "2.1.0" },
	{ name: "refreshes unchanged floating Git source dependencies", git: "floating", updatedVersion: "2.1.0" },
	{ name: "refreshes source-SHA-pinned Git dependencies", git: "sha", updatedVersion: "2.1.0" },
	{ name: "refreshes source-tag-pinned Git dependencies", git: "tag", updatedVersion: "2.1.0" },
	{ name: "preserves tracked Git author locks", git: "tracked-lock" },
	{ name: "preserves tracked npm Git shrinkwrap", git: "tracked-shrinkwrap" },
	{ name: "reports both Git source and dependency updates", git: "both", updatedVersion: "2.1.0" },
	{
		name: "protects every same-name instance in a Git package",
		git: "floating",
		initialA: "1.0.0",
		initialB: "2.1.0",
		rangeA: "^1.0.0",
		rangeB: "^2.0.0",
		versions: ["1.0.0", "1.1.0", "2.0.0", "2.1.0"],
		latest: "2.0.0",
	},
	{ name: "refreshes compatible indirect runtime dependencies", updatedVersion: "2.1.0" },
	{
		name: "does not advertise published versions beyond a lagging latest tag",
		initialA: "1.1.0",
		rangeA: "^1.0.0",
		versions: ["1.0.0", "1.1.0", "1.2.0"],
		latest: "1.0.0",
	},
	{
		name: "uses a forward latest tag instead of a higher published release",
		initialA: "1.0.0",
		rangeA: "^1.0.0",
		versions: ["1.0.0", "1.1.0", "1.2.0"],
		latest: "1.1.0",
		updatedVersion: "1.1.0",
	},
	{
		name: "does not downgrade an unselected plugin's separate instance",
		initialA: "1.0.0",
		initialB: "2.1.0",
		rangeA: "^1.0.0",
		rangeB: "^2.0.0",
		versions: ["1.0.0", "1.1.0", "2.0.0", "2.1.0"],
		latest: "2.0.0",
	},
	{
		name: "preserves required dependencies when the selected release rejects this OS",
		rejected: { os: ["not-an-os"] },
	},
	{
		name: "preserves optional dependencies when the selected release rejects this OS",
		optional: true,
		rejected: { os: ["not-an-os"] },
	},
	{
		name: "preserves optional dependencies when the selected release rejects this CPU",
		optional: true,
		rejected: { cpu: ["not-a-cpu"] },
	},
	{ name: "does not offer a release rejected by engine-strict", rejected: { engines: { node: "<1.0.0" } } },
	{
		name: "checks eligibility of every name-wide affected instance, not only the selected plugin",
		initialA: "1.0.0",
		initialB: "2.1.0",
		rangeA: "^1.0.0",
		rangeB: "^2.0.0",
		versions: ["1.0.0", "1.1.0", "2.1.0", "2.2.0"],
		latest: "2.2.0",
		rejectedVersion: "2.2.0",
		rejected: { os: ["not-an-os"] },
	},
];

// Exercise real solvers through Pi's public package API, not mocked command arguments.
const managers = (process.env.PI_TEST_PACKAGE_MANAGERS ?? "npm").split(",");
for (const configuredCommand of managers) {
	const manager = basename(configuredCommand).replace(/\.(cmd|exe)$/i, "");
	const command =
		manager === "pnpm"
			? fileURLToPath(new URL("../../../node_modules/.bin/pnpm", import.meta.url))
			: configuredCommand;
	const lockName = manager === "bun" ? "bun.lock" : manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
	for (const layout of manager === "bun" ? ["hoisted", "isolated"] : manager === "pnpm" ? ["isolated"] : ["hoisted"]) {
		for (const scenario of scenarios) {
			if (scenario.gitOptionName && manager !== "bun") continue;
			if (
				(scenario.rootRegistry ||
					scenario.workspace ||
					scenario.workspaceEnv ||
					scenario.updateFailure ||
					scenario.unrelated) &&
				manager !== "pnpm"
			)
				continue;
			if (scenario.gitDependency && manager === "pnpm" && (!scenario.git || scenario.gitIndirect)) continue;
			if ((scenario.gitExoticTarget || scenario.gitPeerTarget) && manager !== "pnpm") continue;
			if (
				(scenario.authorLock ||
					scenario.gitAuthFailure ||
					scenario.gitAlias ||
					scenario.gitUnknownInstance ||
					scenario.gitEscapedInstance ||
					scenario.gitDependency === "semver") &&
				manager !== "npm"
			)
				continue;
			if ((scenario.gitRepositoryEnv || scenario.gitTemplate) && manager !== "npm") continue;
			if (scenario.git === "tracked-shrinkwrap" && manager !== "npm") continue;
			it(`${manager} (${layout}): ${scenario.name}`, async () => {
				const root = mkdtempSync(join(tmpdir(), "pi-dependency-update-"));
				const agentDir = join(root, "agent");
				const work = join(root, "work");
				if (scenario.workspace === "ancestor") {
					mkdirSync(join(root, "physical", "agent"), { recursive: true });
					symlinkSync(join(root, "physical", "agent"), agentDir, "junction");
				} else mkdirSync(agentDir);
				mkdirSync(work);
				const names = {
					a: "pi-dependency-fixture-a",
					b: "pi-dependency-fixture-b",
					bridge: "pi-dependency-fixture-bridge",
					leaf: "pi-dependency-fixture-leaf",
					fixed: "pi-dependency-fixture-fixed",
					unrelated: "pi-dependency-fixture-unrelated",
				};
				const utilsName = scenario.gitOptionName ?? "pi-fixture-utils";
				const initialA = scenario.initialA ?? "2.0.0";
				const initialB = scenario.initialB ?? initialA;
				const rangeA = scenario.rangeA ?? "^2.0.0";
				const rangeB = scenario.rangeB ?? rangeA;
				const runtimeField = scenario.optional ? "optionalDependencies" : "dependencies";
				const gitFragment =
					scenario.gitDependency === "branch" ||
					scenario.gitDependency === "ambiguous" ||
					scenario.gitDependency === "mixed-ref"
						? "#moving"
						: scenario.gitDependency === "tag"
							? "#v1"
							: scenario.gitDependency === "semver"
								? "#semver:^1.0.0"
								: "";
				const gitRepository = scenario.gitAuthFailure
					? "ssh://git@fixture.invalid/utils"
					: pathToFileURL(join(root, "utils")).href;
				const floatingUtilsSpec = `git+${gitRepository}${gitFragment}`;
				const otherUtilsSpec = `git+${pathToFileURL(join(root, "other-utils")).href}`;
				const packages: FixturePackage[] = [
					{
						name: names.a,
						version: "1.0.0",
						dependencies: {
							[names.bridge]: "^1.0.0",
							[names.fixed]: "1.0.0",
							...(scenario.gitDependency && !scenario.gitIndirect ? { [utilsName]: floatingUtilsSpec } : {}),
						},
					},
					{
						name: names.a,
						version: scenario.gitOptionName ? "1.1.0" : "2.0.0",
						dependencies: {
							[names.bridge]: "^1.0.0",
							[names.fixed]: "1.0.0",
							...(scenario.gitOptionName ? { [utilsName]: floatingUtilsSpec } : {}),
						},
					},
					{
						name: names.b,
						version: "1.0.0",
						[runtimeField]: {
							[names.leaf]: rangeB,
							...(scenario.unrelated ? { [names.unrelated]: "^1.0.0" } : {}),
							...(scenario.gitUnselected ? { "pi-fixture-unselected-utils": otherUtilsSpec } : {}),
						},
					},
					{
						name: names.b,
						version: scenario.gitOptionName ? "1.1.0" : "2.0.0",
						[runtimeField]: {
							[names.leaf]: rangeB,
							...(scenario.unrelated ? { [names.unrelated]: "^1.0.0" } : {}),
							...(scenario.gitOptionName ? { "pi-fixture-unselected-utils": otherUtilsSpec } : {}),
						},
					},
					...(scenario.gitDependency === "mixed-registry"
						? [
								{ name: "pi-fixture-utils", version: "1.0.0" },
								{ name: "pi-fixture-utils", version: "1.1.0" },
							]
						: []),
					...(scenario.unrelated
						? [
								{ name: names.unrelated, version: "1.0.0" },
								{ name: names.unrelated, version: "1.1.0" },
							]
						: []),
					{
						name: names.bridge,
						version: "1.0.0",
						[runtimeField]: {
							[names.leaf]: scenario.git ? rangeB : rangeA,
							...(scenario.gitDependency && scenario.gitIndirect
								? { "pi-fixture-utils": floatingUtilsSpec }
								: {}),
						},
					},
					...(scenario.versions ?? ["2.0.0", "2.0.1", "2.1.0", "3.0.0"]).map((version) => ({
						name: names.leaf,
						version,
						...(version === (scenario.rejectedVersion ?? "2.1.0") ? scenario.rejected : {}),
					})),
					{ name: names.fixed, version: "1.0.0" },
					{ name: names.fixed, version: "1.1.0" },
				];
				const archives = new Map<string, Buffer>();
				for (const pkg of packages) {
					const directory = join(root, `${pkg.name}-${pkg.version}`);
					mkdirSync(join(directory, "package"), { recursive: true });
					writeFileSync(join(directory, "package", "package.json"), JSON.stringify(pkg));
					const archive = join(directory, "package.tgz");
					const result = spawnSync("tar", ["-czf", archive, "-C", directory, "package"], { encoding: "utf8" });
					expect(result.status, result.stderr).toBe(0);
					archives.set(`${pkg.name}/${pkg.version}`, readFileSync(archive));
				}
				let updated = false;
				let base = "";
				const registryQueries: string[] = [];
				const fallbackQueries: string[] = [];
				const server = createServer((request, response) => {
					const path = decodeURIComponent(request.url?.slice(1) ?? "");
					if (path.startsWith("fallback/")) {
						fallbackQueries.push(path);
						response.writeHead(404);
						response.end("{}");
						return;
					}
					if (!path.endsWith(".tgz")) registryQueries.push(path);
					const archive = archives.get(path.replace(/\.tgz$/, ""));
					if (archive) {
						response.end(archive);
						return;
					}
					const visible = packages.filter(
						(pkg) =>
							pkg.name === path &&
							(updated ||
								(pkg.name === names.leaf
									? [initialA, initialB].includes(pkg.version)
									: pkg.version === "1.0.0")),
					);
					if (visible.length === 0) {
						response.writeHead(404);
						response.end("{}");
						return;
					}
					const versions = Object.fromEntries(
						visible.map((pkg) => {
							const body = archives.get(`${pkg.name}/${pkg.version}`);
							if (!body) throw new Error("Missing fixture tarball");
							return [
								pkg.version,
								{
									...pkg,
									dist: {
										tarball: `${base}/${pkg.name}/${pkg.version}.tgz`,
										shasum: createHash("sha1").update(body).digest("hex"),
									},
								},
							];
						}),
					);
					response.setHeader("Content-Type", "application/json");
					response.end(
						JSON.stringify({
							name: path,
							"dist-tags": {
								latest:
									updated && path === names.leaf && scenario.latest
										? scenario.latest
										: visible.at(-1)?.version,
							},
							versions,
							time: Object.fromEntries(visible.map((pkg) => [pkg.version, "2020-01-01T00:00:00.000Z"])),
						}),
					);
				});
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, "127.0.0.1", resolve);
				});
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Missing fixture registry address");
				base = `http://127.0.0.1:${address.port}`;
				const userConfig = join(root, ".npmrc");
				const globalConfig = join(root, "global.npmrc");
				const nativeConfig = `ignore-scripts=true\nengine-strict=${scenario.rejected?.engines ? "true" : "false"}\n`;
				writeFileSync(userConfig, nativeConfig);
				writeFileSync(globalConfig, nativeConfig);
				vi.stubEnv("PI_OFFLINE", "");
				vi.stubEnv("HOME", root);
				vi.stubEnv("npm_config_userconfig", userConfig);
				vi.stubEnv("npm_config_globalconfig", globalConfig);
				vi.stubEnv("npm_config_registry", base);
				vi.stubEnv("npm_config_cache", join(root, "npm-cache"));
				vi.stubEnv("npm_config_fetch_retries", "0");
				vi.stubEnv("npm_config_ignore_scripts", "true");
				vi.stubEnv("npm_config_engine_strict", scenario.rejected?.engines ? "true" : "false");
				vi.stubEnv("pnpm_config_engine_strict", scenario.rejected?.engines ? "true" : "false");
				vi.stubEnv("pnpm_config_ignore_scripts", "true");
				vi.stubEnv("BUN_INSTALL_CACHE_DIR", join(root, "bun-cache"));
				vi.stubEnv("PNPM_HOME", join(root, "pnpm-home"));
				vi.stubEnv("XDG_DATA_HOME", join(root, "xdg-data"));
				vi.stubEnv("XDG_CACHE_HOME", join(root, "xdg-cache"));
				vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg-config"));
				if (manager === "pnpm") {
					vi.stubEnv("NPM_CONFIG_WORKSPACE_DIR", undefined);
					vi.stubEnv("npm_config_workspace_dir", undefined);
				}
				try {
					if (manager === "bun") {
						mkdirSync(join(agentDir, "npm"), { recursive: true });
						writeFileSync(join(agentDir, "npm", "bunfig.toml"), `[install]\nlinker = "${layout}"\n`);
					}
					const rootRegistry = scenario.git === "tag" || scenario.rootRegistry;
					const commandArgs = manager === "pnpm" && !rootRegistry ? [`--registry=${base}`] : [];
					if (scenario.rootRegistry) {
						mkdirSync(join(agentDir, "npm"), { recursive: true });
						writeFileSync(join(agentDir, "npm", ".npmrc"), `registry=${base}/\n`);
						writeFileSync(userConfig, `${nativeConfig}registry=${base}/fallback/\n`);
						writeFileSync(globalConfig, `${nativeConfig}registry=${base}/fallback/\n`);
						vi.stubEnv("npm_config_registry", undefined);
						vi.stubEnv("NPM_CONFIG_REGISTRY", undefined);
						vi.stubEnv("pnpm_config_registry", undefined);
						vi.stubEnv("PNPM_CONFIG_REGISTRY", undefined);
					}
					if (manager === "pnpm" && scenario.rejected?.engines) {
						expect(await runFixtureCommand(command, ["config", "get", "engine-strict"], work)).toBe("true");
					}
					const settings = SettingsManager.inMemory({ npmCommand: [command, ...commandArgs] });
					const pm = new DefaultPackageManager({ cwd: work, agentDir, settingsManager: settings });
					let source = `npm:${names.a}${scenario.ownUpdate ? "" : "@1.0.0"}`;
					let origin: string | undefined;
					let utils: string | undefined;
					let utilsDependency: string | undefined;
					let sourceHead: string | undefined;
					let utilsHeadBefore: string | undefined;
					let utilsHeadAfter: string | undefined;
					const gitConfig = join(root, "gitconfig");
					const createUtils = async (directory: string, name: string, payload: boolean): Promise<string> => {
						mkdirSync(directory);
						await runFixtureCommand("git", ["init", "--initial-branch=main"], directory);
						await runFixtureCommand("git", ["config", "user.name", "Fixture"], directory);
						await runFixtureCommand("git", ["config", "user.email", "fixture@example.invalid"], directory);
						writeFileSync(
							join(directory, "package.json"),
							JSON.stringify({
								name,
								version: "1.0.0",
								dependencies: { [names.fixed]: "1.0.0" },
								...(payload ? { main: "index.cjs" } : {}),
							}),
						);
						if (payload) writeFileSync(join(directory, "index.cjs"), 'module.exports = "marker1";\n');
						await runFixtureCommand("git", ["add", "package.json", ...(payload ? ["index.cjs"] : [])], directory);
						await runFixtureCommand("git", ["commit", "-m", "Git dependency fixture"], directory);
						return runFixtureCommand("git", ["rev-parse", "HEAD"], directory);
					};
					let otherUtils: string | undefined;
					if (scenario.git || scenario.gitDependency) {
						writeFileSync(gitConfig, "");
						vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);
						vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
						await runFixtureCommand(
							"git",
							["config", "--file", gitConfig, "protocol.file.allow", "always"],
							work,
						);
						if (scenario.git === "sha" || scenario.gitDependency) {
							utils = join(root, "utils");
							utilsHeadBefore = await createUtils(
								utils,
								scenario.gitAlias ? "pi-fixture-utils-actual" : utilsName,
								Boolean(scenario.gitDependency),
							);
							if (
								scenario.gitDependency === "branch" ||
								scenario.gitDependency === "ambiguous" ||
								scenario.gitDependency === "mixed-ref"
							)
								await runFixtureCommand("git", ["branch", "moving"], utils);
							if (scenario.gitDependency)
								await runFixtureCommand(
									"git",
									["tag", "--annotate", "v1", "-m", "Pinned annotated tag"],
									utils,
								);
							if (scenario.gitDependency === "semver")
								await runFixtureCommand(
									"git",
									["tag", "--annotate", "v1.0.0", "-m", "Unsupported semver selector fixture"],
									utils,
								);
							if (scenario.gitDependency === "ambiguous")
								await runFixtureCommand(
									"git",
									["tag", "--annotate", "moving", "-m", "Ambiguous annotated tag"],
									utils,
								);
							utilsDependency =
								scenario.gitDependency && scenario.gitDependency !== "sha"
									? floatingUtilsSpec
									: `git+${pathToFileURL(utils).href}#${utilsHeadBefore}`;
							if (scenario.gitAuthFailure)
								await runFixtureCommand(
									"git",
									["config", "--file", gitConfig, `url.${pathToFileURL(utils).href}.insteadOf`, gitRepository],
									work,
								);
						}
						if (scenario.gitUnselected || scenario.gitDependency === "mixed-repo") {
							otherUtils = join(root, "other-utils");
							await createUtils(
								otherUtils,
								scenario.gitUnselected ? "pi-fixture-unselected-utils" : "pi-fixture-utils",
								true,
							);
						}
					}
					if (scenario.git) {
						origin = join(root, "origin");
						mkdirSync(origin);

						const url = "https://fixture.invalid/team/plugin";
						await runFixtureCommand(
							"git",
							["config", "--file", gitConfig, `url.${pathToFileURL(origin).href}.insteadOf`, url],
							work,
						);
						await runFixtureCommand(
							"git",
							["config", "--file", gitConfig, "protocol.file.allow", "always"],
							work,
						);
						await runFixtureCommand("git", ["init", "--initial-branch=main"], origin);
						await runFixtureCommand("git", ["config", "user.name", "Fixture"], origin);
						await runFixtureCommand("git", ["config", "user.email", "fixture@example.invalid"], origin);
						writeFileSync(
							join(origin, "package.json"),
							JSON.stringify({
								name: names.a,
								version: "1.0.0",
								dependencies: {
									[names.bridge]: scenario.gitAuthFailure || scenario.gitMetadataFailure ? "1.0.0" : "^1.0.0",
									[names.fixed]: "1.0.0",
									[names.leaf]: rangeA,
									...(utilsDependency && (!scenario.gitIndirect || scenario.gitDependency?.startsWith("mixed"))
										? {
												"pi-fixture-utils":
													scenario.gitDependency === "mixed-registry"
														? "^1.0.0"
														: scenario.gitDependency === "mixed-ref"
															? `git+${pathToFileURL(utils!).href}`
															: scenario.gitDependency === "mixed-repo"
																? otherUtilsSpec
																: utilsDependency,
											}
										: {}),
								},
								pi: { extensions: ["index.ts"] },
							}),
						);
						writeFileSync(join(origin, "index.ts"), "export default function() {}\n");
						writeFileSync(join(origin, ".gitignore"), "node_modules/\n");
						const tracked = ["package.json", "index.ts", ".gitignore"];
						if (scenario.git === "tag") {
							// Project registry must win over isolated user/global configuration, without ENV overrides.
							writeFileSync(userConfig, `${nativeConfig}registry=${base}/fallback/\n`);
							writeFileSync(globalConfig, `${nativeConfig}registry=${base}/fallback/\n`);
							vi.stubEnv("npm_config_registry", undefined);
							vi.stubEnv("NPM_CONFIG_REGISTRY", undefined);
							vi.stubEnv("pnpm_config_registry", undefined);
							vi.stubEnv("PNPM_CONFIG_REGISTRY", undefined);
							writeFileSync(join(origin, ".npmrc"), `registry=${base}/\n`);
							tracked.push(".npmrc");
						}
						if (manager === "bun") {
							writeFileSync(join(origin, "bunfig.toml"), `[install]\nlinker = "${layout}"\n`);
							tracked.push("bunfig.toml");
						}
						if (
							scenario.authorLock &&
							!["package-lock.json", "npm-shrinkwrap.json"].includes(scenario.authorLock)
						) {
							writeFileSync(join(origin, scenario.authorLock), "");
							tracked.push(scenario.authorLock);
						}
						if (
							scenario.git === "tracked-lock" ||
							scenario.git === "tracked-shrinkwrap" ||
							scenario.authorLock === "package-lock.json" ||
							scenario.authorLock === "npm-shrinkwrap.json"
						) {
							const lockManager = scenario.git === "tracked-shrinkwrap" || scenario.authorLock ? "npm" : manager;
							await runFixtureCommand(
								lockManager === "pnpm" ? command : lockManager,
								lockManager === "bun"
									? ["install", "--omit=dev", "--omit=peer"]
									: lockManager === "pnpm"
										? [
												...commandArgs,
												"install",
												"--prod",
												"--config.auto-install-peers=false",
												"--config.strict-peer-dependencies=false",
												"--config.strict-dep-builds=false",
											]
										: ["install", "--omit=dev", "--legacy-peer-deps"],
								origin,
							);
							if (scenario.git === "tracked-shrinkwrap" || scenario.authorLock === "npm-shrinkwrap.json")
								await runFixtureCommand("npm", ["shrinkwrap", "--ignore-scripts"], origin);
							tracked.push(
								scenario.authorLock ??
									(scenario.git === "tracked-shrinkwrap" ? "npm-shrinkwrap.json" : lockName),
							);
						}
						await runFixtureCommand("git", ["add", ...tracked], origin);
						await runFixtureCommand("git", ["commit", "-m", "Fixture source"], origin);
						sourceHead = await runFixtureCommand("git", ["rev-parse", "HEAD"], origin);
						await runFixtureCommand("git", ["tag", "v1"], origin);
						source = `git:${url}${scenario.git === "sha" ? `@${sourceHead}` : scenario.git === "tag" ? "@v1" : ""}`;
					}
					await pm.installAndPersist(source, scenario.untrusted ? { local: true } : undefined);
					if (!scenario.git) await pm.installAndPersist(`npm:${names.b}@1.0.0`);
					const installRoot = scenario.git
						? pm.getInstalledPath(source, scenario.untrusted ? "project" : "user")!
						: join(agentDir, "npm");
					const modules = join(installRoot, "node_modules");
					const firstChain = scenario.git ? [names.leaf] : [names.a, names.bridge, names.leaf];
					const secondChain = scenario.git ? [names.bridge, names.leaf] : [names.b, names.leaf];
					const sentinel = join(installRoot, "untracked-marker");
					if (scenario.git) writeFileSync(sentinel, "preserve me");
					const versionScript = join(root, "version.cjs");
					writeFileSync(
						versionScript,
						`
const { createRequire } = require("node:module");
const { readFileSync, realpathSync } = require("node:fs");
let manifest = process.argv[2];
for (const name of process.argv.slice(3)) {
	manifest = createRequire(realpathSync(manifest)).resolve(name + "/package.json");
}
console.log(process.env.PI_TEST_GIT_PAYLOAD === "1" ? createRequire(realpathSync(manifest))("./index.cjs") : JSON.parse(readFileSync(manifest, "utf8")).version);
`,
					);
					// Fresh Node processes avoid cached realpaths after isolated dependency links change.
					const installedAt = (directory: string, chain: string[], payload = false) => {
						const result = spawnSync(
							process.execPath,
							[versionScript, join(directory, "package.json"), ...chain],
							{
								encoding: "utf8",
								timeout: 10000,
								env: { ...process.env, PI_TEST_GIT_PAYLOAD: payload ? "1" : "" },
							},
						);
						expect(result.status, result.stderr).toBe(0);
						return result.stdout.trim();
					};
					const versionAt = (directory: string, ...chain: string[]) => installedAt(directory, chain);
					const payloadAt = (directory: string, ...chain: string[]) => installedAt(directory, chain, true);
					const utilsChain = [
						...(scenario.git ? [] : [names.a]),
						...(scenario.gitIndirect ? [names.bridge] : []),
						utilsName,
					];
					let temporaryRoot: string | undefined;
					if (scenario.git === "floating") {
						temporaryRoot = (await pm.resolveExtensionSources([source], { temporary: true })).extensions[0]
							?.metadata.packageRoot;
						expect(temporaryRoot).toBeDefined();
						expect(versionAt(temporaryRoot!, ...firstChain)).toBe(initialA);
					}
					if (manager === "bun" && layout === "isolated") expect(existsSync(join(modules, ".bun"))).toBe(true);
					if (manager === "pnpm") expect(existsSync(join(modules, ".pnpm"))).toBe(true);
					expect(versionAt(installRoot, ...firstChain)).toBe(initialA);
					expect(versionAt(installRoot, ...secondChain)).toBe(initialB);
					if (scenario.git === "both") {
						writeFileSync(join(origin!, "index.ts"), "export default function() { return 1; }\n");
						await runFixtureCommand("git", ["add", "index.ts"], origin!);
						await runFixtureCommand("git", ["commit", "-m", "New source"], origin!);
						sourceHead = await runFixtureCommand("git", ["rev-parse", "HEAD"], origin!);
					}
					if (utils) {
						expect(versionAt(installRoot, ...utilsChain)).toBe("1.0.0");
						if (scenario.gitDependency) {
							if (scenario.gitDependency !== "mixed-registry")
								expect(payloadAt(installRoot, ...utilsChain)).toBe("marker1");
							writeFileSync(join(utils, "index.cjs"), 'module.exports = "marker2";\n');
							const files = ["index.cjs"];
							if (
								scenario.rejected ||
								scenario.gitLifecycle ||
								scenario.gitExoticTarget ||
								scenario.gitPeerTarget ||
								scenario.gitTargetVersion
							) {
								const target = JSON.parse(
									readFileSync(join(utils, "package.json"), "utf8"),
								) as FixturePackage & { scripts?: Record<string, string> };
								Object.assign(target, scenario.rejected);
								if (scenario.gitTargetVersion) target.version = scenario.gitTargetVersion;
								if (scenario.gitLifecycle) {
									target.scripts = { prepare: "node prepare.cjs" };
									writeFileSync(
										join(utils, "prepare.cjs"),
										`require("node:fs").writeFileSync(${JSON.stringify(join(root, "prepare-ran"))}, "ran");\n`,
									);
									files.push("prepare.cjs");
								}
								if (scenario.gitExoticTarget)
									target.dependencies = { ...target.dependencies, "pi-fixture-utils": floatingUtilsSpec };
								if (scenario.gitPeerTarget)
									Object.assign(target, { peerDependencies: { [names.leaf]: "^2.0.0" } });
								writeFileSync(join(utils, "package.json"), JSON.stringify(target));
								files.push("package.json");
							}
							await runFixtureCommand("git", ["add", ...files], utils);
							if (scenario.gitMetadataFailure) await runFixtureCommand("git", ["rm", "package.json"], utils);
						} else {
							writeFileSync(
								join(utils, "package.json"),
								JSON.stringify({
									name: "pi-fixture-utils",
									version: "2.0.0",
									dependencies: { [names.fixed]: "1.0.0" },
								}),
							);
							await runFixtureCommand("git", ["add", "package.json"], utils);
						}
						await runFixtureCommand("git", ["commit", "-m", "New unpinned Git dependency HEAD"], utils);
						utilsHeadAfter = await runFixtureCommand("git", ["rev-parse", "HEAD"], utils);
						if (scenario.gitDependency === "branch" || scenario.gitDependency === "ambiguous")
							await runFixtureCommand("git", ["branch", "--force", "moving", utilsHeadAfter], utils);
					}
					if (otherUtils) {
						writeFileSync(join(otherUtils, "index.cjs"), 'module.exports = "marker2";\n');
						await runFixtureCommand("git", ["add", "index.cjs"], otherUtils);
						await runFixtureCommand("git", ["commit", "-m", "Unselected Git payload, same version"], otherUtils);
					}
					updated = true;
					if (temporaryRoot) {
						await pm.resolveExtensionSources([source], { temporary: true });
						expect(versionAt(temporaryRoot, ...firstChain)).toBe(initialA);
					}
					const manifestPath = join(installRoot, "package.json");
					const lockPath = join(
						installRoot,
						scenario.git === "tracked-shrinkwrap" || scenario.authorLock === "npm-shrinkwrap.json"
							? "npm-shrinkwrap.json"
							: lockName,
					);
					if (scenario.gitUnknownInstance) {
						const path = join(modules, "pi-fixture-utils", "package.json");
						const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
						delete pkg.version;
						writeFileSync(path, JSON.stringify(pkg));
					}
					if (scenario.gitEscapedInstance) {
						const path = join(modules, "pi-fixture-utils");
						const outside = join(root, "escaped-utils");
						renameSync(path, outside);
						symlinkSync(outside, path, "junction");
					}
					const manifestBefore = readFileSync(manifestPath, "utf8");
					const lockBefore = readFileSync(lockPath, "utf8");
					const lockedGitCommit = () => {
						const raw = readFileSync(lockPath, "utf8");
						const lock = JSON.parse(
							manager === "bun" ? stripJsonComments(raw) : manager === "pnpm" ? "{}" : raw,
						) as { packages: Record<string, unknown> };
						if (manager === "pnpm") {
							const native = parseYaml(raw) as {
								importers: Record<string, { dependencies: Record<string, { version: string }> }>;
								packages: Record<string, { resolution: { commit: string } }>;
							};
							return native.packages[
								`pi-fixture-utils@${native.importers["."].dependencies["pi-fixture-utils"].version}`
							].resolution.commit;
						}
						const entry = lock.packages[manager === "bun" ? "pi-fixture-utils" : "node_modules/pi-fixture-utils"];
						if (Array.isArray(entry)) return entry[2] as unknown;
						const resolved = (entry as { resolved?: unknown } | undefined)?.resolved;
						return typeof resolved === "string" ? resolved.slice(resolved.lastIndexOf("#") + 1) : undefined;
					};
					if (scenario.gitUpdate) expect(lockedGitCommit()).toBe(utilsHeadBefore);
					const rootConfig = join(installRoot, ".npmrc");
					const configBefore = existsSync(rootConfig) ? readFileSync(rootConfig, "utf8") : undefined;
					if (scenario.workspace) {
						if (scenario.workspace === "ancestor") {
							writeFileSync(
								join(root, "physical", "package.json"),
								JSON.stringify({ name: "fixture-workspace", private: true }),
							);
						}
						writeFileSync(
							join(scenario.workspace === "root" ? installRoot : join(root, "physical"), "pnpm-workspace.yaml"),
							"packages: []\n",
						);
					}
					const externalWorkspace = join(root, "external-workspace");
					const externalLockPath = join(externalWorkspace, "pnpm-lock.yaml");
					const externalConfig = `packages: []\noverrides:\n  ${names.leaf}: 3.0.0\n`;
					const readExternalLock = () =>
						existsSync(externalLockPath)
							? {
									bytes: readFileSync(externalLockPath, "utf8"),
									mtime: statSync(externalLockPath, { bigint: true }).mtimeNs,
								}
							: undefined;
					if (scenario.workspaceEnv) {
						mkdirSync(externalWorkspace);
						writeFileSync(
							join(externalWorkspace, "package.json"),
							JSON.stringify({ name: "external-workspace", private: true }),
						);
						writeFileSync(join(externalWorkspace, "pnpm-workspace.yaml"), externalConfig);
						if (scenario.workspaceEnv === "npm_config_workspace_dir") {
							await runFixtureCommand(
								command,
								[
									...commandArgs,
									"install",
									"--lockfile-only",
									"--prod",
									"--config.auto-install-peers=false",
									"--config.strict-peer-dependencies=false",
									"--config.strict-dep-builds=false",
								],
								externalWorkspace,
							);
						}
						vi.stubEnv(scenario.workspaceEnv, externalWorkspace);
					}
					const externalLockBefore = readExternalLock();
					const expectMetadataClean = () => {
						const directory = join(agentDir, "tmp", "extensions");
						expect(
							existsSync(directory)
								? readdirSync(directory).filter(
										(name) => name.startsWith("git-dependency-") || name.startsWith("pnpm-update-"),
									)
								: [],
						).toEqual([]);
					};
					if (scenario.gitRepositoryEnv) vi.stubEnv("GIT_OBJECT_DIRECTORY", join(installRoot, ".git", "objects"));
					if (scenario.gitTemplate) {
						const template = join(root, "git-template");
						mkdirSync(template);
						writeFileSync(join(template, "commondir"), `${join(installRoot, ".git")}\n`);
						await runFixtureCommand("git", ["config", "--file", gitConfig, "init.templateDir", template], work);
					}
					const expectedGitUpdate = Boolean(scenario.gitUpdate);
					const installedSnapshot = () => {
						const snapshot: Record<string, string> = {};
						const visit = (path: string) => {
							const stat = lstatSync(path, { bigint: true });
							snapshot[path] =
								`${stat.mtimeNs}:${stat.mode}:${stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "directory"}`;
							if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
						};
						visit(installRoot);
						return snapshot;
					};
					if (scenario.offline) vi.stubEnv("PI_OFFLINE", "1");
					const stateBeforeCheck = scenario.gitDependency ? installedSnapshot() : undefined;
					if (scenario.untrusted) {
						settings.setProjectTrusted(false);
						expect(await pm.checkForAvailableUpdates()).toEqual([]);
						await expect(pm.install(source, { local: true })).rejects.toThrow("Project is not trusted");
						await expect(pm.update(source)).rejects.toThrow("No matching package");
						expect(installedSnapshot()).toEqual(stateBeforeCheck);
						return;
					}
					if (scenario.gitMetadataFailure) {
						await expect(pm.checkForAvailableUpdates()).rejects.toThrow("Native Git metadata lookup failed");
						expect(installedSnapshot()).toEqual(stateBeforeCheck);
						expectMetadataClean();
						await expect(pm.update(source)).rejects.toThrow("Native Git metadata lookup failed");
						expectMetadataClean();
						expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
						expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
						return;
					}
					if (scenario.gitAuthFailure) {
						const ssh = join(root, "deny-ssh.cjs");
						const trace = join(root, "git-trace");
						writeFileSync(ssh, 'process.stderr.write("Permission denied (publickey)\\n"); process.exit(1);\n');
						chmodSync(ssh, 0o700);
						await runFixtureCommand(
							"git",
							["config", "--file", gitConfig, "--unset-all", `url.${pathToFileURL(utils!).href}.insteadOf`],
							work,
						);
						await runFixtureCommand(
							"git",
							["config", "--file", gitConfig, "core.sshCommand", `${process.execPath} ${JSON.stringify(ssh)}`],
							work,
						);
						vi.stubEnv("GIT_TRACE", trace);
						await expect(pm.checkForAvailableUpdates()).rejects.toThrow(
							"Native Git authentication lookup failed",
						);
						expect(installedSnapshot()).toEqual(stateBeforeCheck);
						await expect(pm.update(source)).rejects.toThrow("Native Git authentication lookup failed");
						expect(readFileSync(trace, "utf8")).not.toContain("git-remote-http");
						expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
						expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
						return;
					}
					if (scenario.gitOptionName) {
						const dependencies = getNpmRuntimeDependencies(installRoot).get(names.a) ?? [];
						expect(dependencies).toContainEqual(
							expect.objectContaining({ name: utilsName, specs: [floatingUtilsSpec] }),
						);
						expect(dependencies).toContainEqual(
							expect.objectContaining({ name: names.fixed, specs: ["1.0.0"], ranges: ["1.0.0"], blocked: true }),
						);
						const commands = vi.spyOn(
							pm as unknown as { runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void> },
							"runNpmCommand",
						);
						const metadata = vi.spyOn(
							pm as unknown as {
								runCommandCapture(command: string, args: string[], options?: { cwd?: string }): Promise<string>;
							},
							"runCommandCapture",
						);
						try {
							const pending = [
								expect.objectContaining({ source: `npm:${names.b}@1.0.0`, reason: "dependencies" }),
							];
							const notices = await pm.checkForAvailableUpdates();
							expect(installedSnapshot()).toEqual(stateBeforeCheck);
							expect.soft(notices).toEqual(pending);
							await pm.update(source);
							const after = {
								versions: [versionAt(installRoot, names.a), versionAt(installRoot, names.b)],
								payloads: [
									payloadAt(installRoot, ...utilsChain),
									payloadAt(installRoot, names.b, "pi-fixture-unselected-utils"),
								],
								manifest: readFileSync(manifestPath, "utf8"),
								lock: readFileSync(lockPath, "utf8"),
								notices: await pm.checkForAvailableUpdates(),
							};
							const unsafeMetadata = metadata.mock.calls.filter(
								([command, args]) => command === "git" && args.includes(gitRepository),
							);
							process.stdout.write(
								`OPTION_TARGET_RECEIPT ${JSON.stringify({ layout, target: utilsName, before: { versions: ["1.0.0", "1.0.0"], payloads: ["marker1", "marker1"], manifest: manifestBefore, lock: createHash("sha256").update(lockBefore).digest("hex") }, after: { ...after, lock: createHash("sha256").update(after.lock).digest("hex") }, notices, nativeArguments: commands.mock.calls.map(([args]) => args), unsafeMetadataCalls: unsafeMetadata.length })}\n`,
							);
							expect.soft(commands).not.toHaveBeenCalled();
							expect.soft(unsafeMetadata).toEqual([]);
							expect.soft(after.versions).toEqual(["1.0.0", "1.0.0"]);
							expect.soft(after.payloads).toEqual(["marker1", "marker1"]);
							expect.soft(after.manifest).toBe(manifestBefore);
							expect.soft(after.lock).toBe(lockBefore);
							expect.soft(after.notices).toEqual(pending);
							expectMetadataClean();
						} finally {
							commands.mockRestore();
							metadata.mockRestore();
						}
						return;
					}
					const queriesBeforeCheck = registryQueries.length;
					const updates = await pm.checkForAvailableUpdates();
					if (scenario.gitDependency) {
						expect(installedSnapshot()).toEqual(stateBeforeCheck);
						expectMetadataClean();
						expect(existsSync(join(root, "prepare-ran"))).toBe(false);
					}
					if (scenario.workspaceEnv) {
						expect.soft(updates).toEqual([]);
						expect.soft(registryQueries.length).toBe(queriesBeforeCheck);
						expect.soft(readExternalLock()).toEqual(externalLockBefore);
						expect(process.env[scenario.workspaceEnv]).toBe(externalWorkspace);
						expect(readFileSync(join(externalWorkspace, "pnpm-workspace.yaml"), "utf8")).toBe(externalConfig);
					}
					if (scenario.workspace) expect(registryQueries.length).toBe(queriesBeforeCheck);
					if (rootRegistry) {
						expect(fallbackQueries).toEqual([]);
						expect(registryQueries.length).toBeGreaterThan(queriesBeforeCheck);
						expect(readFileSync(rootConfig, "utf8")).toBe(configBefore);
					}
					expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
					expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
					expect(versionAt(installRoot, ...firstChain)).toBe(initialA);
					expect(versionAt(installRoot, ...secondChain)).toBe(initialB);
					if (scenario.ownUpdate) {
						expect(updates).toEqual(
							expect.arrayContaining([expect.objectContaining({ source, reason: "both" })]),
						);
						return; // Own-source execution remains covered by the existing source-update regressions.
					}
					if (scenario.gitRepositoryEnv)
						expect(process.env.GIT_OBJECT_DIRECTORY).toBe(join(installRoot, ".git", "objects"));
					if (scenario.gitTemplate) {
						expect(updates).toContainEqual(expect.objectContaining({ source, reason: "dependencies" }));
						expect(
							await runFixtureCommand("git", ["config", "--file", gitConfig, "--get", "init.templateDir"], work),
						).toBe(join(root, "git-template"));
						return;
					}
					if (scenario.updatedVersion || expectedGitUpdate) {
						expect(updates).toEqual(
							expect.arrayContaining([
								expect.objectContaining({ source, reason: scenario.git === "both" ? "both" : "dependencies" }),
							]),
						);
					}
					const queriesBeforeUpdate = registryQueries.length;
					const failure = scenario.updateFailure ? new Error("Native dependency update failed") : undefined;
					const updateCommand = failure
						? vi
								.spyOn(
									pm as unknown as {
										runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void>;
									},
									"runNpmCommand",
								)
								.mockRejectedValueOnce(failure)
						: undefined;
					try {
						if (failure) await expect(pm.update(source)).rejects.toBe(failure);
						else await pm.update(source);
					} finally {
						updateCommand?.mockRestore();
					}
					if (scenario.workspaceEnv) {
						expect.soft(registryQueries.length).toBe(queriesBeforeUpdate);
						expect.soft(readExternalLock()).toEqual(externalLockBefore);
						expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
						expect(process.env[scenario.workspaceEnv]).toBe(externalWorkspace);
						expect(readFileSync(join(externalWorkspace, "pnpm-workspace.yaml"), "utf8")).toBe(externalConfig);
					}
					if (scenario.workspace) expect(registryQueries.length).toBe(queriesBeforeUpdate);
					if (manager === "pnpm" || scenario.gitDependency) expectMetadataClean();
					if (scenario.gitRepositoryEnv)
						expect(process.env.GIT_OBJECT_DIRECTORY).toBe(join(installRoot, ".git", "objects"));
					if (failure) {
						expect(versionAt(installRoot, ...firstChain)).toBe(initialA);
						expect(versionAt(installRoot, ...secondChain)).toBe(initialB);
						expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
						expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
						return;
					}
					if (rootRegistry) {
						expect(fallbackQueries).toEqual([]);
						expect(registryQueries.length).toBeGreaterThan(queriesBeforeUpdate);
					}
					expect(versionAt(installRoot, ...secondChain)).toBe(scenario.updatedVersion ?? initialB);
					expect(versionAt(installRoot, ...firstChain)).toBe(scenario.updatedVersion ?? initialA);
					if (!scenario.updatedVersion && !expectedGitUpdate) expect(updates).toEqual([]);
					expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
					if (scenario.git) {
						expect(await runFixtureCommand("git", ["rev-parse", "HEAD"], installRoot)).toBe(sourceHead);
						if (scenario.git !== "both") expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
						if (scenario.updatedVersion) {
							expect(readFileSync(lockPath, "utf8")).not.toBe(lockBefore);
							if (manager === "bun") {
								rmSync(modules, { recursive: true, force: true });
								await runFixtureCommand(
									"bun",
									["install", "--frozen-lockfile", "--omit=dev", "--omit=peer"],
									installRoot,
								);
								expect(versionAt(installRoot, ...firstChain)).toBe(scenario.updatedVersion);
								await runFixtureCommand("bun", ["install", "--omit=dev", "--omit=peer"], installRoot);
								await runFixtureCommand(
									"bun",
									["install", "--frozen-lockfile", "--omit=dev", "--omit=peer"],
									installRoot,
								);
								expect(versionAt(installRoot, ...firstChain)).toBe(scenario.updatedVersion);
								expect(versionAt(installRoot, ...secondChain)).toBe(scenario.updatedVersion);
								expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
								if (scenario.git !== "both") expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
							}
						} else if (!scenario.gitDependency) expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
					} else {
						expect(versionAt(installRoot, names.a)).toBe("1.0.0");
						expect(versionAt(installRoot, names.b)).toBe("1.0.0");
					}
					if (manager === "pnpm" && scenario.updatedVersion) {
						expect(readFileSync(lockPath, "utf8")).not.toBe(lockBefore);
						rmSync(modules, { recursive: true, force: true });
						await runFixtureCommand(
							command,
							[
								...commandArgs,
								"install",
								"--frozen-lockfile",
								"--prod",
								"--config.auto-install-peers=false",
								"--config.strict-peer-dependencies=false",
								"--config.strict-dep-builds=false",
							],
							installRoot,
						);
						expect(versionAt(installRoot, ...firstChain)).toBe(scenario.updatedVersion);
						expect(versionAt(installRoot, ...secondChain)).toBe(scenario.updatedVersion);
						expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
						if (scenario.git && scenario.git !== "both")
							expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
					}
					if (scenario.gitDependency) {
						if (scenario.gitDependency !== "mixed-registry")
							expect(payloadAt(installRoot, ...utilsChain)).toBe(expectedGitUpdate ? "marker2" : "marker1");
						if (expectedGitUpdate) {
							expect(lockedGitCommit()).toBe(utilsHeadAfter);
							expect(readFileSync(lockPath, "utf8")).not.toBe(lockBefore);
							rmSync(modules, { recursive: true, force: true });
							await runFixtureCommand(
								command,
								manager === "bun"
									? ["install", "--frozen-lockfile", "--omit=dev", "--omit=peer"]
									: manager === "pnpm"
										? [
												...commandArgs,
												"install",
												"--frozen-lockfile",
												"--prod",
												"--config.auto-install-peers=false",
												"--config.strict-peer-dependencies=false",
												"--config.strict-dep-builds=false",
											]
										: ["ci", "--omit=dev", "--legacy-peer-deps"],
								installRoot,
							);
							expect(payloadAt(installRoot, ...utilsChain)).toBe("marker2");
							expect(lockedGitCommit()).toBe(utilsHeadAfter);
						} else expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
						expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
						if (scenario.git) expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
					}
					expect(versionAt(installRoot, ...(scenario.git ? [] : [names.a]), names.fixed)).toBe("1.0.0");
					if (utils) expect(versionAt(installRoot, ...utilsChain)).toBe("1.0.0");
					if (configBefore !== undefined) expect(readFileSync(rootConfig, "utf8")).toBe(configBefore);
					if (scenario.gitUnselected) {
						expect(payloadAt(installRoot, names.b, "pi-fixture-unselected-utils")).toBe("marker1");
						expect(await pm.checkForAvailableUpdates()).toEqual([
							expect.objectContaining({ source: `npm:${names.b}@1.0.0`, reason: "dependencies" }),
						]);
						await pm.update(`npm:${names.b}@1.0.0`);
						expect(payloadAt(installRoot, names.b, "pi-fixture-unselected-utils")).toBe("marker2");
						expect(versionAt(installRoot, names.a)).toBe("1.0.0");
						expect(versionAt(installRoot, names.b)).toBe("1.0.0");
						expect(await pm.checkForAvailableUpdates()).toEqual([]);
					} else if (scenario.unrelated) {
						expect(versionAt(installRoot, names.b, names.unrelated)).toBe("1.0.0");
						expect(await pm.checkForAvailableUpdates()).toEqual([
							expect.objectContaining({ source: `npm:${names.b}@1.0.0`, reason: "dependencies" }),
						]);
					} else expect(await pm.checkForAvailableUpdates()).toEqual([]);
					expect(fallbackQueries).toEqual([]);
				} finally {
					vi.unstubAllEnvs();
					server.closeAllConnections();
					await new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					);
					rmSync(root, { recursive: true, force: true });
				}
			}, 60000);
		}
	}
}

it.each(["npm", "bun", "pnpm"])(
	"rejects option-shaped targets before %s apply or temporary cache allocation",
	async (manager) => {
		const root = mkdtempSync(join(tmpdir(), "floating-git-option-boundary-"));
		try {
			const agentDir = join(root, "agent");
			const settings = SettingsManager.inMemory({ npmCommand: [manager] });
			const pm = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings }) as unknown as {
				refreshRuntimeDependencies(names: string[], installRoot: string): Promise<void>;
				runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void>;
			};
			const command = vi.spyOn(pm, "runNpmCommand").mockResolvedValue(undefined);
			try {
				for (const name of ["--latest", "--force"]) {
					await expect(pm.refreshRuntimeDependencies(["normal-dependency", name], root)).rejects.toThrow(
						"Unsafe dependency update target",
					);
				}
				expect(command).not.toHaveBeenCalled();
				expect(existsSync(join(agentDir, "tmp", "extensions"))).toBe(false);
			} finally {
				command.mockRestore();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it.each([
	"ext::sh",
	"git+ssh://-oProxyCommand=bad/repository",
	"git+ssh://-user@host.invalid/repository",
	"git@-host.invalid:repository",
	"git@host.invalid:-repository",
	"git+https://host.invalid/repository#semver:^1.0.0",
])("rejects unsafe or unsupported Git metadata spec %s before invoking Git", async (spec) => {
	const root = mkdtempSync(join(tmpdir(), "floating-git-unit-"));
	try {
		writeFileSync(
			join(root, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"node_modules/dependency": { version: "1.0.0", resolved: `${spec.split("#")[0]}#${"1".repeat(40)}` },
				},
			}),
		);
		const instance: NpmRuntimeDependency = {
			name: "dependency",
			version: "1.0.0",
			specs: [spec],
			ranges: [],
			directory: join(root, "node_modules", "dependency"),
			blocked: false,
			depth: 0,
		};
		const run = vi.fn(async (_args: string[]) => "");
		expect(await getGitDependencyTarget("dependency", [instance], root, "npm", () => root, run)).toBeUndefined();
		expect(run).not.toHaveBeenCalled();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it.each([
	["npm", 2],
	["bun", 1],
	["bun", "binary"],
] as const)("skips unproved %s Git lock format %s without querying Git", async (manager, format) => {
	const root = mkdtempSync(join(tmpdir(), "floating-git-unit-"));
	try {
		const spec = "git+file:///unqueried/repository";
		const commit = "1".repeat(40);
		const lock =
			manager === "npm"
				? {
						lockfileVersion: format,
						packages: { "node_modules/dependency": { version: "1.0.0", resolved: `${spec}#${commit}` } },
					}
				: { lockfileVersion: format, packages: { dependency: [`dependency@${spec}#${commit}`, {}, commit] } };
		writeFileSync(
			join(root, manager === "npm" ? "package-lock.json" : format === "binary" ? "bun.lockb" : "bun.lock"),
			JSON.stringify(lock),
		);
		const instance: NpmRuntimeDependency = {
			name: "dependency",
			version: "1.0.0",
			specs: [spec],
			ranges: [],
			directory: join(root, "node_modules", "dependency"),
			blocked: false,
			depth: 0,
		};
		const run = vi.fn(async (_args: string[]) => "");
		expect(await getGitDependencyTarget("dependency", [instance], root, manager, () => root, run)).toBeUndefined();
		expect(run).not.toHaveBeenCalled();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
