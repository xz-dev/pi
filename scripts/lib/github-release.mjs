#!/usr/bin/env node
/**
 * Shared GitHub Release artifact helpers for prepare/verify tooling.
 *
 * Plain ESM (.mjs) so future install.ts (erasable TS, Node 22.19+/Bun) can import
 * these named exports with static top-level imports — no dynamic import(), no
 * non-erasable TypeScript, no publish-time build step for this module.
 *
 * Hybrid packaging contract:
 * - one canonical entry tarball for npm/Node and Bun
 * - bundle internal Pi packages + portable JS production dependencies
 * - exclude host-selected platform-specific optional native packages
 * - preserve root optionalDependencies so the target machine resolves natives
 * - scan bundled package.json lifecycle scripts against an explicit allowlist
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { globSync } from "glob";
import { DEFAULT_ALLOWED_INSTALL_SCRIPT_PACKAGES } from "./install-lifecycle-policy.mjs";

export { DEFAULT_ALLOWED_INSTALL_SCRIPT_PACKAGES } from "./install-lifecycle-policy.mjs";

export const SOURCE_SCOPE = "@earendil-works/";
export const INTERNAL_PACKAGE_PREFIX = `${SOURCE_SCOPE}pi-`;
export const ENTRY_PACKAGE = "@earendil-works/pi-coding-agent";
export const DISTRIBUTION = "xz-dev";
export const REPOSITORY = "xz-dev/pi";
export const MANIFEST_SCHEMA_VERSION = 1;
export const ATTESTATION_SIGNER_WORKFLOW = ".github/workflows/publish-github-release.yml";
export const ATTESTATION_SIGNER_REF = "refs/heads/main";
export const ATTESTATION_SUBJECTS_FILENAME = "attestation-subjects.txt";
export const DEFAULT_MINIMUM_NODE_VERSION = "22.19.0";
export const PACKAGING_HYBRID = "hybrid";
export const NETWORK_POLICY_EXTERNAL_OPTIONAL_ONLY = "external-optional-only";

/** Platforms that must verify the hybrid package in CI. */
export const REQUIRED_VERIFY_PLATFORMS = Object.freeze(["linux", "darwin", "win32"]);
/** Package managers/runtimes that must verify the hybrid package in CI. */
export const REQUIRED_VERIFY_RUNTIMES = Object.freeze(["npm", "bun"]);

/** Install-time lifecycle scripts that require review when present on bundled packages. */
export const INSTALL_LIFECYCLE_SCRIPT_NAMES = Object.freeze([
	"preinstall",
	"install",
	"postinstall",
]);


export function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env ?? process.env,
		input: options.input,
		maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
		stdio: options.capture
			? ["pipe", "pipe", options.mergeStderr ? "pipe" : "inherit"]
			: options.stdio ?? "inherit",
	});
	if (result.status !== 0) {
		const detail = options.capture
			? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
			: "";
		throw new Error(
			`Command failed: ${[command, ...args].join(" ")}${detail ? `\n${detail}` : ""}`,
		);
	}
	return result.stdout ?? "";
}

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

export function sha512Integrity(path) {
	const digest = createHash("sha512").update(readFileSync(path)).digest("base64");
	return `sha512-${digest}`;
}

export function packageDependencies(packageJson) {
	return [
		...Object.keys(packageJson.dependencies ?? {}),
		...Object.keys(packageJson.peerDependencies ?? {}),
		...Object.keys(packageJson.optionalDependencies ?? {}),
	].sort();
}

export function discoverWorkspacePackages(repoRoot, workspacePatterns) {
	const packageJsonPaths = globSync(
		workspacePatterns.map((pattern) => `${pattern}/package.json`),
		{ absolute: true, cwd: repoRoot, nodir: true },
	).sort();
	const discovered = new Map();
	for (const packageJsonPath of packageJsonPaths) {
		const packageJson = readJson(packageJsonPath);
		if (typeof packageJson.name !== "string") continue;
		if (discovered.has(packageJson.name)) {
			throw new Error(`Duplicate workspace package ${packageJson.name}`);
		}
		discovered.set(packageJson.name, {
			directory: relative(repoRoot, dirname(packageJsonPath)),
			packageJson,
		});
	}
	return discovered;
}

export function resolveInternalClosure(repoRoot, workspacePatterns, entryPackage = ENTRY_PACKAGE) {
	const discovered = discoverWorkspacePackages(repoRoot, workspacePatterns);
	const resolved = [];
	const resolving = new Set();
	const resolvedNames = new Set();

	const visit = (sourceName) => {
		if (resolvedNames.has(sourceName)) return;
		if (resolving.has(sourceName)) {
			throw new Error(`Circular internal package dependency involving ${sourceName}`);
		}
		const discoveredPackage = discovered.get(sourceName);
		if (!discoveredPackage || discoveredPackage.packageJson.private) {
			throw new Error(`${sourceName} is required but is not a publishable workspace package`);
		}

		resolving.add(sourceName);
		for (const dependencyName of packageDependencies(discoveredPackage.packageJson)) {
			if (discovered.has(dependencyName)) {
				visit(dependencyName);
			} else if (dependencyName.startsWith(INTERNAL_PACKAGE_PREFIX)) {
				throw new Error(`${sourceName} depends on unresolved internal package ${dependencyName}`);
			}
		}
		resolving.delete(sourceName);
		resolvedNames.add(sourceName);
		resolved.push({
			directory: discoveredPackage.directory,
			sourceName,
			packageJson: discoveredPackage.packageJson,
		});
	};

	visit(entryPackage);
	return resolved;
}

export function forkDistributionVersion(baseVersion, env = process.env) {
	const runNumber = env.GITHUB_RUN_NUMBER ?? "0";
	const runAttempt = env.GITHUB_RUN_ATTEMPT ?? "1";
	if (!/^\d+$/.test(runNumber) || !/^\d+$/.test(runAttempt)) {
		throw new Error("GITHUB_RUN_NUMBER and GITHUB_RUN_ATTEMPT must be decimal integers");
	}
	let sha = env.GITHUB_SHA;
	if (!sha) {
		sha = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
	}
	if (!/^[0-9a-f]{8,40}$/i.test(sha)) {
		throw new Error("GITHUB_SHA or checked-out HEAD must be a hexadecimal commit SHA");
	}
	return `${baseVersion}-xz.${runNumber}.${runAttempt}.g${sha.slice(0, 8).toLowerCase()}`;
}

export function resolveFullCommit(env = process.env) {
	if (env.GITHUB_SHA && /^[0-9a-f]{40}$/i.test(env.GITHUB_SHA)) {
		const expected = env.GITHUB_SHA.toLowerCase();
		if (env.GITHUB_ACTIONS || env.CI) {
			const head = run("git", ["rev-parse", "HEAD"], { capture: true }).trim().toLowerCase();
			if (head !== expected) {
				throw new Error(`GITHUB_SHA ${expected} does not match checked-out HEAD ${head}`);
			}
		}
		return expected;
	}
	if (env.GITHUB_SHA && env.GITHUB_SHA.length >= 7) {
		// Prefer full SHA from git when env only has a partial or any value.
		try {
			return run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
		} catch {
			return env.GITHUB_SHA;
		}
	}
	return run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
}

export function minimumNodeVersionFromEngines(engines) {
	const raw = engines?.node;
	if (typeof raw !== "string") return DEFAULT_MINIMUM_NODE_VERSION;
	const match = raw.match(/(\d+\.\d+\.\d+)/);
	return match?.[1] ?? DEFAULT_MINIMUM_NODE_VERSION;
}

export function tarballBasename(packageName, version) {
	return `${packageName.slice(1).replaceAll("/", "-")}-${version}.tgz`;
}

export function localInternalDependencyPath(packageName) {
	return `file:./node_modules/${packageName}`;
}

export function listTopLevelNodeModulesPackages(nodeModulesDir) {
	if (!existsSync(nodeModulesDir)) return [];
	const names = [];
	for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (entry.name.startsWith(".")) continue;
		if (entry.name.startsWith("@")) {
			const scopeDir = join(nodeModulesDir, entry.name);
			for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
				if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
				names.push(`${entry.name}/${scoped.name}`);
			}
			continue;
		}
		names.push(entry.name);
	}
	return names.sort((a, b) => a.localeCompare(b));
}

export function rewriteDependencyMap(dependencies, rewrite) {
	if (!dependencies) return dependencies;
	const rewritten = { ...dependencies };
	for (const [name, value] of Object.entries(rewritten)) {
		const next = rewrite(name, value);
		if (next !== undefined) {
			rewritten[name] = next;
		}
	}
	return rewritten;
}

export function commandExists(command, env = process.env) {
	return resolveExecutable(command, env) !== undefined;
}

/**
 * Resolve an executable from PATH, with a Bun-specific fallback to ~/.bun/bin.
 * Does not download or system-install anything.
 */
export function resolveExecutable(command, env = process.env) {
	const pathEnv = env.PATH ?? env.Path ?? "";
	const delimiter = process.platform === "win32" ? ";" : ":";
	const candidates = [];
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		candidates.push(join(dir, command));
		if (process.platform === "win32") {
			candidates.push(join(dir, `${command}.exe`));
			candidates.push(join(dir, `${command}.cmd`));
		}
	}
	if (command === "bun") {
		candidates.push(join(homedir(), ".bun", "bin", "bun"));
		if (process.platform === "win32") {
			candidates.push(join(homedir(), ".bun", "bin", "bun.exe"));
		}
	}
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const probe = spawnSync(candidate, ["--version"], {
			encoding: "utf8",
			stdio: "ignore",
			env,
		});
		if (probe.status === 0) return candidate;
	}
	// Final PATH lookup for commands that are shell builtins/aliases is not needed.
	const direct = spawnSync(command, ["--version"], {
		encoding: "utf8",
		stdio: "ignore",
		env,
	});
	if (direct.status === 0) return command;
	return undefined;
}

export function isCiEnvironment(env = process.env) {
	const truthy = new Set(["1", "true", "TRUE", "yes", "YES", "on", "ON"]);
	return (
		truthy.has(String(env.CI ?? "")) ||
		truthy.has(String(env.GITHUB_ACTIONS ?? "")) ||
		truthy.has(String(env.GITLAB_CI ?? "")) ||
		truthy.has(String(env.CIRCLECI ?? ""))
	);
}

export function packageJsonHasPlatformConstraints(packageJson) {
	const constrained = (value) => {
		if (Array.isArray(value)) return value.length > 0;
		return typeof value === "string" && value.length > 0;
	};
	return (
		constrained(packageJson?.os) ||
		constrained(packageJson?.cpu) ||
		constrained(packageJson?.libc)
	);
}

/**
 * Walk package.json files under a directory. Skips binary-ish files and deep
 * non-package trees by only following directories.
 */
export function findPackageJsonPaths(rootDir) {
	const found = [];
	const stack = [rootDir];
	while (stack.length > 0) {
		const current = stack.pop();
		let stat;
		try {
			stat = statSync(current);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			const base = current.split(/[\\/]/).pop();
			if (base === ".git") continue;
			let entries;
			try {
				entries = readdirSync(current);
			} catch {
				continue;
			}
			for (const entry of entries) {
				stack.push(join(current, entry));
			}
			continue;
		}
		if (!stat.isFile()) continue;
		if (current.endsWith(`${join.sep ?? "/"}package.json`) || /(?:^|[/\\])package\.json$/.test(current)) {
			found.push(current);
		}
	}
	return found.sort((a, b) => a.localeCompare(b));
}

/**
 * Find platform-specific packages anywhere under node_modules (nested optional
 * natives included). Returns package directory paths.
 */
export function findPlatformSpecificPackageDirs(nodeModulesDir) {
	if (!existsSync(nodeModulesDir)) return [];
	const dirs = [];
	for (const packageJsonPath of findPackageJsonPaths(nodeModulesDir)) {
		let packageJson;
		try {
			packageJson = readJson(packageJsonPath);
		} catch {
			continue;
		}
		if (!packageJsonHasPlatformConstraints(packageJson)) continue;
		dirs.push(dirname(packageJsonPath));
	}
	// Remove deepest paths first so parent removals do not race.
	return dirs.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Remove host-selected platform-specific optional native packages from a staged
 * node_modules tree. Portable JS parents (e.g. @mariozechner/clipboard) remain.
 */
export function removePlatformSpecificNodeModules(nodeModulesDir) {
	const removed = [];
	for (const packageDir of findPlatformSpecificPackageDirs(nodeModulesDir)) {
		if (!existsSync(packageDir)) continue;
		let name = packageDir;
		try {
			const packageJson = readJson(join(packageDir, "package.json"));
			if (typeof packageJson.name === "string") name = packageJson.name;
		} catch {
			// keep path as name
		}
		rmSync(packageDir, { force: true, recursive: true });
		removed.push({ name, directory: packageDir });
	}
	return removed;
}

function packageDirectory(nodeModulesDir, packageName) {
	return join(nodeModulesDir, ...packageName.split("/"));
}

/**
 * External optional parents must be target-resolved along with their optional
 * native children, so remove the parent directory (and its whole subtree).
 */
export function removeExternalOptionalNodeModules(nodeModulesDir, packageNames) {
	const removed = [];
	for (const name of [...packageNames].sort()) {
		const directory = packageDirectory(nodeModulesDir, name);
		if (!existsSync(directory)) continue;
		rmSync(directory, { force: true, recursive: true });
		removed.push({ name, directory });
	}
	return removed;
}

export function assertExternalOptionalNodeModulesAbsent(nodeModulesDir, packageNames) {
	const bundled = [...packageNames]
		.filter((name) => existsSync(packageDirectory(nodeModulesDir, name)))
		.sort();
	if (bundled.length > 0) {
		throw new Error(
			`External optional package parent is still bundled: ${bundled.join(", ")}`,
		);
	}
}

export function assertNoPlatformSpecificNodeModules(nodeModulesDir) {
	const remaining = findPlatformSpecificPackageDirs(nodeModulesDir);
	if (remaining.length > 0) {
		const names = remaining
			.map((directory) => {
				try {
					return readJson(join(directory, "package.json")).name ?? directory;
				} catch {
					return directory;
				}
			})
			.join(", ");
		throw new Error(
			`Hybrid bundle still contains platform-specific packages: ${names}`,
		);
	}
}

/**
 * Collect install-time lifecycle scripts from every package.json under rootDir.
 * Scans the actual scripts field (not only lockfile hasInstallScript).
 */
export function collectInstallLifecycleScripts(rootDir) {
	const findings = [];
	for (const packageJsonPath of findPackageJsonPaths(rootDir)) {
		let packageJson;
		try {
			packageJson = readJson(packageJsonPath);
		} catch {
			continue;
		}
		const scripts = packageJson.scripts;
		if (!scripts || typeof scripts !== "object") continue;
		const present = {};
		for (const scriptName of INSTALL_LIFECYCLE_SCRIPT_NAMES) {
			if (typeof scripts[scriptName] === "string" && scripts[scriptName].length > 0) {
				present[scriptName] = scripts[scriptName];
			}
		}
		if (Object.keys(present).length === 0) continue;
		const name = typeof packageJson.name === "string" ? packageJson.name : "(unnamed)";
		const version = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
		findings.push({
			name,
			version,
			packageId: `${name}@${version}`,
			path: relative(rootDir, packageJsonPath),
			scripts: present,
		});
	}
	return findings.sort((a, b) => a.packageId.localeCompare(b.packageId));
}

/**
 * Reject non-allowlisted install lifecycle scripts. Reviewers must add an
 * allowlist entry deliberately; silent --ignore-scripts is not a substitute.
 */
export function assertInstallLifecycleScriptsAllowed(
	findings,
	allowlist = DEFAULT_ALLOWED_INSTALL_SCRIPT_PACKAGES,
) {
	const errors = [];
	const seenAllowed = new Set();
	for (const finding of findings) {
		const expectedDigest = allowlist.get(finding.packageId);
		const scriptRecord = Object.entries(finding.scripts)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, body]) => `${name}\0${body}\0`)
			.join("");
		const actualDigest = createHash("sha256").update(scriptRecord).digest("hex");
		if (expectedDigest === actualDigest) {
			seenAllowed.add(finding.packageId);
			continue;
		}
		if (expectedDigest) {
			errors.push(`${finding.path} has changed reviewed install lifecycle script content (${finding.packageId}: expected ${expectedDigest}, actual ${actualDigest}).`);
			continue;
		}
		const scriptList = Object.keys(finding.scripts).join(", ");
		errors.push(
			`${finding.path} has install lifecycle scripts (${finding.packageId}: ${scriptList}). Review and add it to DEFAULT_ALLOWED_INSTALL_SCRIPT_PACKAGES if intentional.`,
		);
	}
	// Allowlist entries that are simply absent from this bundle are fine; the
	// shrinkwrap generator owns presence checks for the published lock graph.
	if (errors.length > 0) {
		throw new Error(
			`Hybrid bundle has non-allowlisted install lifecycle scripts:\n${errors
				.map((error) => `  - ${error}`)
				.join("\n")}`,
		);
	}
	return [...seenAllowed].sort();
}

/**
 * Root optionalDependencies that are not internal Pi packages must remain
 * registry version specs so the target platform can fetch the correct native.
 */
export function listExternalOptionalDependencies(packageJson, internalNames = new Set()) {
	const external = {};
	for (const [name, spec] of Object.entries(packageJson.optionalDependencies ?? {})) {
		if (internalNames.has(name) || name.startsWith(INTERNAL_PACKAGE_PREFIX)) continue;
		external[name] = spec;
	}
	return Object.fromEntries(Object.entries(external).sort(([a], [b]) => a.localeCompare(b)));
}

export function assertExternalOptionalSpecsAreRegistry(
	packageJson,
	internalNames = new Set(),
) {
	for (const [name, spec] of Object.entries(
		listExternalOptionalDependencies(packageJson, internalNames),
	)) {
		if (typeof spec !== "string" || spec.length === 0) {
			throw new Error(`External optional dependency ${name} must be a non-empty version spec`);
		}
		if (
			spec.startsWith("file:") ||
			spec.startsWith("link:") ||
			spec.startsWith("workspace:") ||
			spec.startsWith("git+") ||
			spec.startsWith("github:") ||
			spec.includes("npm.pkg.github.com") ||
			spec.includes("@xz-dev/")
		) {
			throw new Error(
				`External optional dependency ${name} must remain a registry version for target resolution, got ${spec}`,
			);
		}
	}
}

export function buildExternalOptionalPolicy(packageJson, internalNames = new Set()) {
	const packages = listExternalOptionalDependencies(packageJson, internalNames);
	const allowedNetworkPackages = Object.keys(packages);
	return {
		policy: NETWORK_POLICY_EXTERNAL_OPTIONAL_ONLY,
		packages,
		// Native package families are target-selected children of the declared
		// portable optional parent. No unrelated package may hit the registry.
		allowedNetworkPackages,
		allowedNetworkPackagePrefixes: allowedNetworkPackages.map((name) => `${name}-`),
	};
}

function decodeRegistryPackagePath(pathname) {
	let decoded;
	try {
		decoded = decodeURIComponent(pathname).replace(/^\/+/, "");
	} catch {
		return undefined;
	}
	if (!decoded) return undefined;
	if (decoded.startsWith("@")) {
		const parts = decoded.split("/");
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
	}
	return decoded.split("/")[0] || undefined;
}

/** Collect package names from npm/Bun registry URLs in installer output. */
export function collectRegistryPackageRequests(logText) {
	const packages = new Set();
	for (const match of String(logText ?? "").matchAll(/https?:\/\/registry\.npmjs\.org\/([^\s"']+)/gi)) {
		const name = decodeRegistryPackagePath(match[1]);
		if (name) packages.add(name);
	}
	return [...packages].sort();
}

export function assertNetworkPackageRequestsAllowed(
	requestedPackages,
	policy,
	{ requireDeclared = true } = {},
) {
	const exact = new Set(policy.allowedNetworkPackages ?? []);
	const prefixes = policy.allowedNetworkPackagePrefixes ?? [];
	const forbidden = [...new Set(requestedPackages)]
		.filter((name) => !exact.has(name) && !prefixes.some((prefix) => name.startsWith(prefix)))
		.sort();
	if (forbidden.length > 0) {
		throw new Error(`Installer requested non-allowlisted network package(s): ${forbidden.join(", ")}`);
	}
	if (!requireDeclared) return;
	for (const name of exact) {
		if (!requestedPackages.includes(name)) {
			throw new Error(`Installer did not request declared external optional package ${name}`);
		}
	}
}

function isMuslRuntime() {
	if (process.platform !== "linux") return false;
	if (process.report?.getReport?.().header?.glibcVersionRuntime) return false;
	try {
		return readFileSync("/usr/bin/ldd", "utf8").includes("musl");
	} catch {
		return false;
	}
}

export function expectedClipboardNativePackageName() {
	if (process.platform === "darwin") {
		return "@mariozechner/clipboard-darwin-universal";
	}
	if (process.platform === "win32") {
		if (process.arch === "x64" || process.arch === "arm64") {
			return `@mariozechner/clipboard-win32-${process.arch}-msvc`;
		}
	}
	if (process.platform === "linux") {
		if (process.arch === "x64" || process.arch === "arm64") {
			return `@mariozechner/clipboard-linux-${process.arch}-${isMuslRuntime() ? "musl" : "gnu"}`;
		}
		if (process.arch === "riscv64") {
			return "@mariozechner/clipboard-linux-riscv64-gnu";
		}
	}
	throw new Error(`Unsupported clipboard target ${process.platform}/${process.arch}`);
}

/** Verify the target-resolved portable clipboard and native binding can load. */
export function verifyExternalOptionalRuntime(packageDir, policy) {
	if (!("@mariozechner/clipboard" in (policy.externalOptionalDependencies ?? {}))) return;
	const requireFromPackage = createRequire(join(packageDir, "package.json"));
	const nativeName = expectedClipboardNativePackageName();
	try {
		requireFromPackage.resolve(`${nativeName}/package.json`);
	} catch {
		throw new Error(`Expected native package ${nativeName} is missing from target install`);
	}
	let clipboard;
	try {
		clipboard = requireFromPackage("@mariozechner/clipboard");
	} catch (error) {
		throw new Error(
			`Portable clipboard failed to load target native package ${nativeName}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof clipboard.hasText !== "function") {
		throw new Error("Portable clipboard loaded without the non-destructive hasText capability");
	}
	clipboard.hasText();
}

/**
 * Scan npm/Bun installer output for forbidden internal registry resolution.
 */
export function assertNoInternalRegistryResolution(logText) {
	const text = String(logText ?? "");
	const patterns = [
		/https?:\/\/[^ \n]*@earendil-works\/pi-[^ \n]*/i,
		/npm\.pkg\.github\.com[^ \n]*@earendil-works\/pi-/i,
		/registry\.npmjs\.org\/@earendil-works\/pi-/i,
		/GET\s+https?:\/\/[^ \n]*\/@earendil-works%2fpi-/i,
		/http fetch\s+GET\s+https?:\/\/[^ \n]*@earendil-works\/pi-/i,
	];
	for (const pattern of patterns) {
		if (pattern.test(text)) {
			throw new Error(
				`Installer log shows internal package registry resolution (must stay local/bundled): ${pattern}`,
			);
		}
	}
	if (text.includes("@xz-dev/") || text.includes("npm.pkg.github.com")) {
		throw new Error("Installer log contains forbidden @xz-dev/ or GitHub Packages markers");
	}
}

const FORBIDDEN_PATTERNS = [
	{ id: "@xz-dev", regex: /@xz-dev\// },
	{ id: "npm.pkg.github.com", regex: /npm\.pkg\.github\.com/ },
	{ id: "absolute-unix-path", regex: /(?:^|["'\s=])\/(?:home|Users|tmp|var\/folders|private\/var)\/[^\s"']+/ },
	{ id: "file-absolute", regex: /file:\/[^.]/ },
	{ id: "file-windows-absolute", regex: /file:[A-Za-z]:\\/ },
];

export function scanTextForLeaks(text, { allowPatterns = [] } = {}) {
	const findings = [];
	for (const pattern of FORBIDDEN_PATTERNS) {
		if (allowPatterns.includes(pattern.id)) continue;
		if (pattern.regex.test(text)) {
			findings.push(pattern.id);
		}
	}
	return findings;
}

export function scanTreeForLeaks(rootDir, { ignoreDirNames = new Set() } = {}) {
	const findings = [];
	const stack = [rootDir];
	while (stack.length > 0) {
		const current = stack.pop();
		const stat = statSync(current);
		if (stat.isDirectory()) {
			const base = current.split(/[\\/]/).pop();
			if (ignoreDirNames.has(base)) continue;
			for (const entry of readdirSync(current)) {
				if (entry === ".git") continue;
				stack.push(join(current, entry));
			}
			continue;
		}
		if (!stat.isFile()) continue;
		// Skip large binary-ish files by extension.
		if (/\.(node|wasm|png|jpg|jpeg|gif|webp|ico|gz|tgz|zip|woff2?)$/i.test(current)) continue;
		if (stat.size > 2_000_000) continue;
		let text;
		try {
			text = readFileSync(current, "utf8");
		} catch {
			continue;
		}
		if (text.includes("\u0000")) continue;
		const hits = scanTextForLeaks(text);
		if (hits.length > 0) {
			findings.push({ path: relative(rootDir, current), hits });
		}
	}
	return findings;
}

export function formatSha256Sums(entries) {
	// Deterministic GNU-style "HASH  filename" lines, sorted by filename.
	return `${entries
		.slice()
		.sort((a, b) => a.file.localeCompare(b.file))
		.map((entry) => `${entry.sha256}  ${entry.file}`)
		.join("\n")}\n`;
}

export function parseSha256Sums(text) {
	const entries = new Map();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = line.match(/^([0-9a-f]{64})  (.+)$/);
		if (!match) {
			throw new Error(`Invalid SHA256SUMS line: ${line}`);
		}
		if (entries.has(match[2])) {
			throw new Error(`Duplicate SHA256SUMS entry: ${match[2]}`);
		}
		entries.set(match[2], match[1]);
	}
	return entries;
}

export function stableStringify(value) {
	return `${JSON.stringify(value, undefined, "\t")}\n`;
}
