import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}

const scenarios: Scenario[] = [
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
					{ name: names.b, version: "1.0.0", [runtimeField]: { [names.leaf]: rangeB } },
					{ name: names.b, version: "2.0.0", [runtimeField]: { [names.leaf]: rangeB } },
					{ name: names.bridge, version: "1.0.0", [runtimeField]: { [names.leaf]: rangeA } },
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
				const server = createServer((request, response) => {
					const path = decodeURIComponent(request.url?.slice(1) ?? "");
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
				writeFileSync(userConfig, "");
				vi.stubEnv("PI_OFFLINE", "");
				vi.stubEnv("HOME", root);
				vi.stubEnv("npm_config_userconfig", userConfig);
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
					const source = `npm:${names.a}@1.0.0`;
					await pm.installAndPersist(source);
					await pm.installAndPersist(`npm:${names.b}@1.0.0`);
					const modules = join(agentDir, "npm", "node_modules");
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
					const version = (...chain: string[]) => {
						const result = spawnSync(
							process.execPath,
							[versionScript, join(agentDir, "npm", "package.json"), ...chain],
							{
								encoding: "utf8",
								timeout: 10000,
							},
						);
						expect(result.status, result.stderr).toBe(0);
						return result.stdout.trim();
					};
					if (layout === "isolated") expect(existsSync(join(modules, ".bun"))).toBe(true);
					expect(version(names.a, names.bridge, names.leaf)).toBe(initialA);
					expect(version(names.b, names.leaf)).toBe(initialB);
					updated = true;
					const manifestPath = join(agentDir, "npm", "package.json");
					const lockPath = join(agentDir, "npm", manager === "bun" ? "bun.lock" : "package-lock.json");
					const manifestBefore = readFileSync(manifestPath, "utf8");
					const lockBefore = readFileSync(lockPath, "utf8");
					const updates = await pm.checkForAvailableUpdates();
					expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
					expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
					expect(version(names.a, names.bridge, names.leaf)).toBe(initialA);
					expect(version(names.b, names.leaf)).toBe(initialB);
					await pm.update(source);
					expect(version(names.b, names.leaf)).toBe(scenario.updatedVersion ?? initialB);
					expect(version(names.a, names.bridge, names.leaf)).toBe(scenario.updatedVersion ?? initialA);
					expect(updates).toEqual(
						scenario.updatedVersion ? expect.arrayContaining([expect.objectContaining({ source })]) : [],
					);
					expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
					expect(version(names.a)).toBe("1.0.0");
					expect(version(names.b)).toBe("1.0.0");
					expect(version(names.a, names.fixed)).toBe("1.0.0");
					expect(await pm.checkForAvailableUpdates()).toEqual([]);
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
