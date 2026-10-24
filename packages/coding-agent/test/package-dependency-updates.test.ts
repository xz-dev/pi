import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

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
for (const manager of managers) {
	for (const layout of manager === "bun" ? ["hoisted", "isolated"] : ["hoisted"]) {
		for (const scenario of scenarios) {
			if (scenario.git === "tracked-shrinkwrap" && manager !== "npm") continue;
			it(`${manager} (${layout}): ${scenario.name}`, async () => {
				const root = mkdtempSync(join(tmpdir(), "pi-dependency-update-"));
				const agentDir = join(root, "agent");
				const work = join(root, "work");
				mkdirSync(agentDir);
				mkdirSync(work);
				const names = {
					a: "pi-dependency-fixture-a",
					b: "pi-dependency-fixture-b",
					bridge: "pi-dependency-fixture-bridge",
					leaf: "pi-dependency-fixture-leaf",
					fixed: "pi-dependency-fixture-fixed",
				};
				const initialA = scenario.initialA ?? "2.0.0";
				const initialB = scenario.initialB ?? initialA;
				const rangeA = scenario.rangeA ?? "^2.0.0";
				const rangeB = scenario.rangeB ?? rangeA;
				const runtimeField = scenario.optional ? "optionalDependencies" : "dependencies";
				const packages: FixturePackage[] = [
					{ name: names.a, version: "1.0.0", dependencies: { [names.bridge]: "^1.0.0", [names.fixed]: "1.0.0" } },
					{ name: names.a, version: "2.0.0", dependencies: { [names.bridge]: "^1.0.0", [names.fixed]: "1.0.0" } },
					{ name: names.b, version: "1.0.0", [runtimeField]: { [names.leaf]: rangeB } },
					{ name: names.b, version: "2.0.0", [runtimeField]: { [names.leaf]: rangeB } },
					{
						name: names.bridge,
						version: "1.0.0",
						[runtimeField]: { [names.leaf]: scenario.git ? rangeB : rangeA },
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
				writeFileSync(userConfig, "");
				writeFileSync(globalConfig, "");
				vi.stubEnv("PI_OFFLINE", "");
				vi.stubEnv("HOME", root);
				vi.stubEnv("npm_config_userconfig", userConfig);
				vi.stubEnv("npm_config_globalconfig", globalConfig);
				vi.stubEnv("npm_config_registry", base);
				vi.stubEnv("npm_config_cache", join(root, "npm-cache"));
				vi.stubEnv("npm_config_fetch_retries", "0");
				vi.stubEnv("npm_config_ignore_scripts", "true");
				vi.stubEnv("npm_config_engine_strict", scenario.rejected?.engines ? "true" : "false");
				vi.stubEnv("BUN_INSTALL_CACHE_DIR", join(root, "bun-cache"));
				try {
					if (manager === "bun") {
						mkdirSync(join(agentDir, "npm"), { recursive: true });
						writeFileSync(join(agentDir, "npm", "bunfig.toml"), `[install]\nlinker = "${layout}"\n`);
					}
					const settings = SettingsManager.inMemory({ npmCommand: [manager] });
					const pm = new DefaultPackageManager({ cwd: work, agentDir, settingsManager: settings });
					let source = `npm:${names.a}${scenario.ownUpdate ? "" : "@1.0.0"}`;
					let origin: string | undefined;
					let utils: string | undefined;
					let utilsDependency: string | undefined;
					let sourceHead: string | undefined;
					if (scenario.git) {
						origin = join(root, "origin");
						mkdirSync(origin);
						const gitConfig = join(root, "gitconfig");
						writeFileSync(gitConfig, "");
						vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);
						vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
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
						if (scenario.git === "sha") {
							utils = join(root, "utils");
							mkdirSync(utils);
							await runFixtureCommand("git", ["init", "--initial-branch=main"], utils);
							await runFixtureCommand("git", ["config", "user.name", "Fixture"], utils);
							await runFixtureCommand("git", ["config", "user.email", "fixture@example.invalid"], utils);
							writeFileSync(
								join(utils, "package.json"),
								JSON.stringify({
									name: "pi-fixture-utils",
									version: "1.0.0",
									dependencies: { [names.fixed]: "1.0.0" },
								}),
							);
							await runFixtureCommand("git", ["add", "package.json"], utils);
							await runFixtureCommand("git", ["commit", "-m", "Fixed Git dependency"], utils);
							const hash = await runFixtureCommand("git", ["rev-parse", "HEAD"], utils);
							utilsDependency = `git+${pathToFileURL(utils).href}#${hash}`;
						}
						writeFileSync(
							join(origin, "package.json"),
							JSON.stringify({
								name: names.a,
								version: "1.0.0",
								dependencies: {
									[names.bridge]: "^1.0.0",
									[names.fixed]: "1.0.0",
									[names.leaf]: rangeA,
									...(utilsDependency ? { "pi-fixture-utils": utilsDependency } : {}),
								},
								pi: { extensions: ["index.ts"] },
							}),
						);
						writeFileSync(join(origin, "index.ts"), "export default function() {}\n");
						writeFileSync(join(origin, ".gitignore"), "node_modules/\n");
						const tracked = ["package.json", "index.ts", ".gitignore"];
						if (scenario.git === "tag") {
							// Project registry must win over isolated user/global configuration, without ENV overrides.
							writeFileSync(userConfig, `registry=${base}/fallback/\n`);
							writeFileSync(globalConfig, `registry=${base}/fallback/\n`);
							vi.stubEnv("npm_config_registry", undefined);
							vi.stubEnv("NPM_CONFIG_REGISTRY", undefined);
							writeFileSync(join(origin, ".npmrc"), `registry=${base}/\n`);
							tracked.push(".npmrc");
						}
						if (manager === "bun") {
							writeFileSync(join(origin, "bunfig.toml"), `[install]\nlinker = "${layout}"\n`);
							tracked.push("bunfig.toml");
						}
						if (scenario.git === "tracked-lock" || scenario.git === "tracked-shrinkwrap") {
							const lockManager = scenario.git === "tracked-shrinkwrap" ? "npm" : manager;
							await runFixtureCommand(
								lockManager,
								lockManager === "bun"
									? ["install", "--omit=dev", "--omit=peer"]
									: ["install", "--omit=dev", "--legacy-peer-deps"],
								origin,
							);
							if (scenario.git === "tracked-shrinkwrap")
								await runFixtureCommand("npm", ["shrinkwrap", "--ignore-scripts"], origin);
							tracked.push(
								scenario.git === "tracked-shrinkwrap"
									? "npm-shrinkwrap.json"
									: manager === "bun"
										? "bun.lock"
										: "package-lock.json",
							);
						}
						await runFixtureCommand("git", ["add", ...tracked], origin);
						await runFixtureCommand("git", ["commit", "-m", "Fixture source"], origin);
						sourceHead = await runFixtureCommand("git", ["rev-parse", "HEAD"], origin);
						await runFixtureCommand("git", ["tag", "v1"], origin);
						source = `git:${url}${scenario.git === "sha" ? `@${sourceHead}` : scenario.git === "tag" ? "@v1" : ""}`;
					}
					await pm.installAndPersist(source);
					if (!scenario.git) await pm.installAndPersist(`npm:${names.b}@1.0.0`);
					const installRoot = scenario.git ? pm.getInstalledPath(source, "user")! : join(agentDir, "npm");
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
console.log(JSON.parse(readFileSync(manifest, "utf8")).version);
`,
					);
					// Fresh Node processes avoid cached realpaths after isolated dependency links change.
					const versionAt = (directory: string, ...chain: string[]) => {
						const result = spawnSync(
							process.execPath,
							[versionScript, join(directory, "package.json"), ...chain],
							{
								encoding: "utf8",
								timeout: 10000,
							},
						);
						expect(result.status, result.stderr).toBe(0);
						return result.stdout.trim();
					};
					let temporaryRoot: string | undefined;
					if (scenario.git === "floating") {
						temporaryRoot = (await pm.resolveExtensionSources([source], { temporary: true })).extensions[0]
							?.metadata.packageRoot;
						expect(temporaryRoot).toBeDefined();
						expect(versionAt(temporaryRoot!, ...firstChain)).toBe(initialA);
					}
					if (layout === "isolated") expect(existsSync(join(modules, ".bun"))).toBe(true);
					expect(versionAt(installRoot, ...firstChain)).toBe(initialA);
					expect(versionAt(installRoot, ...secondChain)).toBe(initialB);
					if (scenario.git === "both") {
						writeFileSync(join(origin!, "index.ts"), "export default function() { return 1; }\n");
						await runFixtureCommand("git", ["add", "index.ts"], origin!);
						await runFixtureCommand("git", ["commit", "-m", "New source"], origin!);
						sourceHead = await runFixtureCommand("git", ["rev-parse", "HEAD"], origin!);
					}
					if (utils) {
						expect(versionAt(installRoot, "pi-fixture-utils")).toBe("1.0.0");
						writeFileSync(
							join(utils, "package.json"),
							JSON.stringify({
								name: "pi-fixture-utils",
								version: "2.0.0",
								dependencies: { [names.fixed]: "1.0.0" },
							}),
						);
						await runFixtureCommand("git", ["add", "package.json"], utils);
						await runFixtureCommand("git", ["commit", "-m", "New unpinned Git dependency HEAD"], utils);
					}
					updated = true;
					if (temporaryRoot) {
						await pm.resolveExtensionSources([source], { temporary: true });
						expect(versionAt(temporaryRoot, ...firstChain)).toBe(initialA);
					}
					const manifestPath = join(installRoot, "package.json");
					const lockPath = join(
						installRoot,
						scenario.git === "tracked-shrinkwrap"
							? "npm-shrinkwrap.json"
							: manager === "bun"
								? "bun.lock"
								: "package-lock.json",
					);
					const manifestBefore = readFileSync(manifestPath, "utf8");
					const lockBefore = readFileSync(lockPath, "utf8");
					const rootConfig = join(installRoot, ".npmrc");
					const configBefore = existsSync(rootConfig) ? readFileSync(rootConfig, "utf8") : undefined;
					const queriesBeforeCheck = registryQueries.length;
					const updates = await pm.checkForAvailableUpdates();
					if (scenario.git === "tag") {
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
					const queriesBeforeUpdate = registryQueries.length;
					await pm.update(source);
					if (scenario.git === "tag") {
						expect(fallbackQueries).toEqual([]);
						expect(registryQueries.length).toBeGreaterThan(queriesBeforeUpdate);
					}
					expect(versionAt(installRoot, ...secondChain)).toBe(scenario.updatedVersion ?? initialB);
					expect(versionAt(installRoot, ...firstChain)).toBe(scenario.updatedVersion ?? initialA);
					expect(updates).toEqual(
						scenario.updatedVersion
							? expect.arrayContaining([
									expect.objectContaining({
										source,
										reason: scenario.git === "both" ? "both" : "dependencies",
									}),
								])
							: [],
					);
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
						} else expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
					} else {
						expect(versionAt(installRoot, names.a)).toBe("1.0.0");
						expect(versionAt(installRoot, names.b)).toBe("1.0.0");
					}
					expect(versionAt(installRoot, ...(scenario.git ? [] : [names.a]), names.fixed)).toBe("1.0.0");
					if (utils) expect(versionAt(installRoot, "pi-fixture-utils")).toBe("1.0.0");
					if (configBefore !== undefined) expect(readFileSync(rootConfig, "utf8")).toBe(configBefore);
					expect(await pm.checkForAvailableUpdates()).toEqual([]);
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
