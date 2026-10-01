import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { createRequire } from "module";
import { homedir, tmpdir, userInfo } from "os";
import { basename, dirname, join, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { spawnProcessSync } from "./utils/child-process.ts";
import { normalizePath } from "./utils/paths.ts";
import { stripBom } from "./utils/text.ts";

// =============================================================================
// Embedded Assets and Materialized Resources (single-executable builds)
// =============================================================================

/**
 * `bun build --compile --asset=<path>` embeds package resources under
 * `/$bunfs/root/<basename>` (the argument's basename, directory trees kept).
 * `readFileSync`/`readdirSync`/`statSync` read them, but APIs that need a real
 * fd (`fs.open`, `require` of a `.node` addon, `realpath`, `cpSync`) fail on
 * `/$bunfs`. Resources consumed by external programs (README/docs/examples,
 * exposed to `rg` and editors via the system prompt) and native addons must
 * therefore live on the real filesystem.
 *
 * Materialization target: `os.tmpdir()/<pi-resources-uid>/<release target>/<version>`.
 * Missing or empty directory means populate; nonempty means reuse as-is — no
 * per-file integrity checks, no repair of user-modified files, no locks.
 * Population writes a private sibling directory then renames it into place so
 * a partial tree is never published; a lost rename race reuses the winner.
 */
const EMBEDDED_ASSETS_ROOT = "/$bunfs/root";
const RESOURCE_ROOT_PREFIX = "pi-resources";

/** Embedded asset root inside the compiled executable. */
export function getEmbeddedAssetsRoot(): string {
	return EMBEDDED_ASSETS_ROOT;
}

/** Embedded asset path by basename (`--asset` preserves only the basename). */
export function getEmbeddedAssetPath(name: string): string {
	return `${EMBEDDED_ASSETS_ROOT}/${name}`;
}

/** Whether a path points into the embedded `/$bunfs` tree. */
export function isEmbeddedAssetPath(path: string): boolean {
	return path.startsWith(`${EMBEDDED_ASSETS_ROOT}/`);
}

/** True when a directory exists and holds at least one entry. */
export function isNonEmptyDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory() && readdirSync(path).length > 0;
	} catch {
		return false;
	}
}

/**
 * Copy a directory tree with `readdirSync`/`readFileSync`/`writeFileSync`.
 * `fs.cpSync`/`copyFileSync` cannot read `/$bunfs` files.
 */
export function copyResourceTree(sourceDir: string, targetDir: string): void {
	mkdirSync(targetDir, { recursive: true });
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		const source = join(sourceDir, entry.name);
		const target = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			copyResourceTree(source, target);
		} else if (entry.isFile()) {
			writeFileSync(target, readFileSync(source));
		}
	}
}

/**
 * Resolve the materialization cache root for this build. Includes the user id
 * so a shared `os.tmpdir()` never collides across users.
 */
export function getResourceCacheRoot(): string {
	let userKey: string;
	try {
		userKey = String(userInfo().uid);
	} catch {
		userKey = process.env.USER || process.env.USERNAME || "unknown";
	}
	return join(tmpdir(), `${RESOURCE_ROOT_PREFIX}-${userKey}`, RELEASE_TARGET ?? "unknown-target", VERSION);
}

export interface MaterializeOptions {
	/** Embedded or on-disk tree to copy. */
	sourceDir: string;
	/** Package-relative path of the tree (`"docs"`, `"native/linux/prebuilds/linux-x64"`). */
	relativePath: string;
	/** Override the computed cache root (tests, custom tmpdir). */
	cacheRoot?: string;
}

/**
 * Materialize a resource tree onto disk and return its directory.
 * A nonempty target directory is reused without touching its contents.
 */
export function materializeResourceTree(options: MaterializeOptions): string {
	// Non-bun runtimes read assets in place unless a test pins a cache root.
	if (!isBunBinary && !options.cacheRoot) return options.sourceDir;

	const cacheRoot = options.cacheRoot ?? getResourceCacheRoot();
	const targetDir = join(cacheRoot, ...options.relativePath.split("/"));

	if (isNonEmptyDirectory(targetDir)) return targetDir;

	mkdirSync(dirname(targetDir), { recursive: true });
	const stagingDir = mkdtempSync(join(dirname(targetDir), `.staging-${basename(targetDir)}-`));
	try {
		copyResourceTree(options.sourceDir, stagingDir);
		renameSync(stagingDir, targetDir);
	} catch (error) {
		rmSync(stagingDir, { recursive: true, force: true });
		// A concurrent process won the rename; its nonempty tree is authoritative.
		if (!isNonEmptyDirectory(targetDir)) throw error;
	}
	return targetDir;
}

export interface MaterializedDocs {
	docsDir: string;
	readmePath: string;
	examplesDir: string;
}

let materializedDocs: MaterializedDocs | undefined;

/**
 * Lazily materialize the document/example trees that external programs read
 * (the system prompt hands these paths to `rg` and editors). In a Bun binary
 * the first call populates the cache; later calls reuse it. Outside Bun
 * binaries this returns the package's own docs/examples paths. Do NOT call
 * this from a path where the physical tree is not actually needed — the
 * `/$bunfs` fallback keeps `--version`/`--help` from paying for a copy they
 * never read.
 */
export function ensureMaterializedDocs(): MaterializedDocs {
	if (!isBunBinary) {
		const packageDir = getPackageDir();
		return {
			docsDir: resolve(join(packageDir, "docs")),
			readmePath: resolve(join(packageDir, "README.md")),
			examplesDir: resolve(join(packageDir, "examples")),
		};
	}
	return materializePhysicalResources();
}

/**
 * Materialize the document/example trees that external programs read
 * (the system prompt hands these paths to `rg` and editors). Idempotent.
 */
export function materializePhysicalResources(cacheRoot?: string): MaterializedDocs {
	if (materializedDocs && !cacheRoot) return materializedDocs;
	const root = EMBEDDED_ASSETS_ROOT;
	const docsDir = materializeResourceTree({ sourceDir: `${root}/docs`, relativePath: "docs", cacheRoot });
	const examplesDir = materializeResourceTree({
		sourceDir: `${root}/examples`,
		relativePath: "examples",
		cacheRoot,
	});
	const readmePath = join(dirname(docsDir), "README.md");
	if (!existsSync(readmePath)) {
		try {
			writeFileSync(readmePath, readFileSync(`${root}/README.md`));
		} catch {
			// The readme is informational; a failed copy must not abort startup.
		}
	}
	const result = { docsDir, readmePath, examplesDir };
	if (!cacheRoot) materializedDocs = result;
	return result;
}

/** Materialized document paths, or undefined until registered. */
export function getMaterializedDocs(): MaterializedDocs | undefined {
	return materializedDocs;
}

export function setMaterializedDocs(docs: MaterializedDocs | undefined): void {
	materializedDocs = docs;
}

/**
 * Materialize the embedded native addon tree and return the directory that
 * contains the `.node` files. `require` of an embedded `.node` makes Bun
 * unpack it to an unpredictable global temp name, so addons must be loaded
 * from this explicit on-disk path instead.
 */
export function materializeNativeAddons(cacheRoot?: string): string {
	return materializeResourceTree({
		sourceDir: `${EMBEDDED_ASSETS_ROOT}/native`,
		relativePath: "native",
		cacheRoot,
	});
}

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

/** Detect the esbuild-bundled Node.js distribution. */
declare const PI_BUNDLED_NODE: boolean;
export const isBundledNode = typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

interface SelfUpdateCommandStep {
	command: string;
	args: string[];
	display: string;
}

export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	steps?: SelfUpdateCommandStep[];
}

export type SelfUpdatePackageTarget = string | { packageName: string; installSpec?: string };

function normalizeSelfUpdatePackageTarget(target: SelfUpdatePackageTarget): {
	packageName: string;
	installSpec: string;
} {
	if (typeof target === "string") {
		return { packageName: target, installSpec: target };
	}
	return { packageName: target.packageName, installSpec: target.installSpec ?? target.packageName };
}

function makeSelfUpdateCommand(
	installStep: SelfUpdateCommandStep,
	uninstallStep?: SelfUpdateCommandStep,
): SelfUpdateCommand {
	if (!uninstallStep) return installStep;
	return {
		...installStep,
		display: `${uninstallStep.display} && ${installStep.display}`,
		steps: [uninstallStep, installStep],
	};
}

function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	return {
		command,
		args,
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
	const packageDir = getInstallDir();
	const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
	const parent = path.dirname(packageDir);
	let root: string | undefined;
	if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
		root = path.dirname(parent);
	} else if (path.basename(parent) === "node_modules") {
		root = parent;
	}
	if (!root) return undefined;
	const rootParent = path.dirname(root);
	if (path.basename(rootParent) === "lib") return { root, prefix: path.dirname(rootParent) };
	// Windows global npm prefixes use `<prefix>\\node_modules`, which is
	// indistinguishable from local project installs by path shape alone. Do not
	// infer unsupported Windows custom prefixes without `npm root -g` evidence.
	return undefined;
}

function getSelfUpdateCommandForMethod(
	method: InstallMethod,
	installedPackageName: string,
	updatePackageTarget: SelfUpdatePackageTarget = installedPackageName,
	npmCommand?: string[],
): SelfUpdateCommand | undefined {
	const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
	switch (method) {
		case "bun-binary":
			return undefined;
		case "pnpm": {
			const match = readCommandOutput("pnpm", ["root", "-g"])
				? undefined
				: /^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getInstallDir());
			const binDirArgs = match
				? [`--config.global-bin-dir=${process.env.PNPM_HOME || dirname(dirname(match[1]))}`]
				: [];
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("pnpm", [
					"install",
					"-g",
					"--ignore-scripts",
					"--config.minimumReleaseAge=0",
					...binDirArgs,
					target.installSpec,
				]),
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("pnpm", ["remove", "-g", ...binDirArgs, installedPackageName]),
			);
		}
		case "yarn":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("yarn", ["global", "add", "--ignore-scripts", target.installSpec]),
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
			);
		case "bun":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("bun", [
					"install",
					"-g",
					"--ignore-scripts",
					"--minimum-release-age=0",
					target.installSpec,
				]),
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
			);
		case "npm": {
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
			const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
			// pi.dev advertises releases immediately, so a configured npm age gate would
			// block the update. npm has no per-package age gate, so this also lets new
			// transitive dependency releases through. Managed installs avoid this.
			const installStep = makeSelfUpdateCommandStep(command, [
				...prefixArgs,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				target.installSpec,
			]);
			const uninstallStep =
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
			return makeSelfUpdateCommand(installStep, uninstallStep);
		}
		case "unknown":
			return undefined;
	}
}

function readCommandOutput(
	command: string,
	args: string[],
	options: { requireSuccess?: boolean } = {},
): string | undefined {
	const result = spawnProcessSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status === 0) return result.stdout.trim() || undefined;
	if (options.requireSuccess) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
	}
	return undefined;
}

function getGlobalPackageRoots(method: InstallMethod, _packageName: string, npmCommand?: string[]): string[] {
	switch (method) {
		case "npm": {
			const configured = !!npmCommand?.length;
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			if (configured && command === "bun") {
				const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
					requireSuccess: true,
				});
				const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
				if (bunBin) {
					roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
				}
				return roots;
			}
			const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
				requireSuccess: configured,
			});
			const inferred = configured ? undefined : getInferredNpmInstall();
			return [root, inferred?.root].filter((x): x is string => !!x);
		}
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			if (root) return [root, dirname(root)];
			const match = /^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getInstallDir());
			return match ? [match[1]] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "unknown":
			return [];
	}
}

function normalizeExistingPathForComparison(path: string, resolveSymlinks: boolean): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath = resolvedPath;
	if (resolveSymlinks) {
		try {
			normalizedPath = realpathSync(resolvedPath);
		} catch {
			return undefined;
		}
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

function getPathComparisonCandidates(path: string): string[] {
	return Array.from(
		new Set(
			[normalizeExistingPathForComparison(path, false), normalizeExistingPathForComparison(path, true)].filter(
				(candidate): candidate is string => !!candidate,
			),
		),
	);
}

function getEntrypointPackageDir(): string | undefined {
	const entrypoint = process.argv[1];
	if (!entrypoint) return undefined;
	let dir = dirname(entrypoint);
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return undefined;
}

function isSelfUpdatePathWritable(): boolean {
	const packageDir = getInstallDir();
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function isManagedByGlobalPackageManager(method: InstallMethod, packageName: string, npmCommand?: string[]): boolean {
	const packageDirs = [getInstallDir(), getEntrypointPackageDir()].filter((dir): dir is string => !!dir);
	const packageDirCandidates = packageDirs.flatMap((dir) => getPathComparisonCandidates(dir));
	return getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
		return getPathComparisonCandidates(root).some((normalizedRoot) => {
			const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
			return packageDirCandidates.some((packageDir) => packageDir.startsWith(rootPrefix));
		});
	});
}

export function getSelfUpdateCommand(
	packageName: string,
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = packageName,
): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageTarget, npmCommand);
	if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
		return undefined;
	}
	return command;
}

export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = packageName,
): string {
	const method = detectInstallMethod();
	const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
	if (method === "bun-binary") {
		return DISTRIBUTION === "xz-dev"
			? `Download from: https://github.com/xz-dev/pi/releases/latest`
			: `Download from: https://github.com/earendil-works/pi/releases/latest`;
	}
	const command = getSelfUpdateCommandForMethod(method, packageName, target, npmCommand);
	if (command) {
		if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
			return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
		}
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${target.installSpec} using the package manager, wrapper, or source checkout that provides this installation.`;
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (command) {
		return `Run: ${command.display}`;
	}
	return getSelfUpdateUnavailableInstruction(packageName);
}

export function getXzDevSourceUpdateGuidance(): string {
	return [
		"This xz-dev installation is a source checkout and is user-managed.",
		"Run the following to update it (Pi does not run these for you):",
		"",
		"git -C <xz-dev-pi-checkout> pull --ff-only",
		"cd <xz-dev-pi-checkout>",
		"npm ci --ignore-scripts",
		"npm run build",
	].join("\n");
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js: returns the package root containing package.json
 * - Ignores Bun binary metadata copied into dist/ when the package root is available
 */
export function findNodePackageDir(startDir: string): string {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			const parent = dirname(dir);
			// build:binary places Bun's metadata inside dist/. Node still needs the
			// package root so its dist-relative asset paths do not become dist/dist/.
			if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) {
				return parent;
			}
			return dir;
		}
		dir = dirname(dir);
	}
	return startDir;
}

export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary) {
		// Single-executable builds embed package resources under `/$bunfs/root`.
		// Install-location and channel detection must use the real executable
		// directory instead (see getInstallDir).
		return getEmbeddedAssetPath(".").slice(0, -2);
	}
	return findNodePackageDir(__dirname);
}

/**
 * Physical directory containing the executable/installation. Used for
 * `*.managed.lock` channel markers, managed-install detection, and Windows
 * self-update quarantine — anything that inspects files on disk next to the
 * binary. Never returns an embedded `/$bunfs` path.
 */
export function getInstallDir(): string {
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}
	if (isBunBinary) {
		return dirname(process.execPath);
	}
	return findNodePackageDir(__dirname);
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For source (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return getEmbeddedAssetPath("theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For source (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return getEmbeddedAssetPath("export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json (embedded under `/$bunfs` in Bun binaries) */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	if (isBunBinary) {
		return materializedDocs?.readmePath ?? getEmbeddedAssetPath("README.md");
	}
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	if (isBunBinary) {
		return materializedDocs?.docsDir ?? getEmbeddedAssetPath("docs");
	}
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	if (isBunBinary) {
		return materializedDocs?.examplesDir ?? getEmbeddedAssetPath("examples");
	}
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	if (isBunBinary) {
		return getEmbeddedAssetPath("CHANGELOG.md");
	}
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For source (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return getEmbeddedAssetPath("assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

let quickJSWasmPath: string | undefined;

/** Called by the Bun entry with the path of the QuickJS wasm file embedded in the compiled executable. */
export function setEmbeddedQuickJSWasmPath(path: string): void {
	quickJSWasmPath = path;
}

/**
 * Get path to `quickjs-wasi/quickjs.wasm`, the VM that runs codemode scripts. Resolved once so the
 * compiled module cached per path keeps working after an update removes this install (#10439).
 */
export function getQuickJSWasmPath(): string {
	quickJSWasmPath ??= createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
	return quickJSWasmPath;
}

/** Resolve the codemode worker entry for a release runtime. */
export function resolveCodemodeWorkerSpecifier(
	runtime: "bun-binary" | "bundled-node" | "unbundled",
	moduleUrl: string,
): string | URL | undefined {
	// Bun embeds explicit source entrypoints, but on Windows Bun 1.3 cannot map an absolute
	// B:\~BUN URL back to one. A relative string with the original source extension works on
	// every Bun platform.
	if (runtime === "bun-binary") return "./src/extensions/codemode/worker.ts";
	if (runtime === "bundled-node") return new URL("./codemode-worker.js", moduleUrl);
	return undefined;
}

let codemodeWorkerDataUrl: URL | undefined;

/**
 * Get the codemode worker entry, or undefined to use the worker that ships next to pi-codemode.
 * The Bun and Node release builds both pass the worker as an extra entrypoint.
 */
export function getCodemodeWorkerSpecifier(): string | URL | undefined {
	const runtime = isBunBinary ? "bun-binary" : isBundledNode ? "bundled-node" : "unbundled";
	const specifier = resolveCodemodeWorkerSpecifier(runtime, import.meta.url);
	if (runtime !== "bundled-node" || !(specifier instanceof URL)) return specifier;
	// Spawn workers from an in-memory copy. An update replaces or deletes the file while this
	// process keeps running (#10439). The bundle build keeps the worker free of relative imports
	// and import.meta, so it runs from a data: URL.
	codemodeWorkerDataUrl ??= new URL(`data:text/javascript;base64,${readFileSync(specifier).toString("base64")}`);
	return codemodeWorkerDataUrl;
}

export type InstallChange = { kind: "updated"; version: string } | { kind: "removed" };

/**
 * Detect that the package this process runs from changed on disk, for example after `pi update`
 * in another terminal. Code loaded on demand can then be missing or from another version.
 *
 * Checks the package.json read at startup. Resolving it again would walk up past a deleted install
 * and could find an unrelated package.json, such as one in the home directory.
 */
export function detectInstallChange(packageJsonPath = startupPackageJsonPath): InstallChange | undefined {
	// The Bun binary embeds its code, so replacing the executable does not affect this process.
	if (isBunBinary || !packageJsonPath) return undefined;
	let installed: PackageJson;
	try {
		installed = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "removed" } : undefined;
	}
	return installed.version && installed.version !== VERSION
		? { kind: "updated", version: installed.version }
		: undefined;
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
		distribution?: string;
		releaseTarget?: string;
		changelogVersion?: string;
	};
}

let pkg: PackageJson = {};
/** The package.json this process started from, if one existed. */
let startupPackageJsonPath: string | undefined;
try {
	const packageJsonPath = getPackageJsonPath();
	pkg = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
	startupPackageJsonPath = packageJsonPath;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

const piConfigName: string | undefined = pkg.piConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
export const DISTRIBUTION: string | undefined = pkg.piConfig?.distribution;
export const RELEASE_TARGET: string | undefined = pkg.piConfig?.releaseTarget;
export const VERSION: string = pkg.version || "0.0.0";
export const CHANGELOG_VERSION: string = pkg.piConfig?.changelogVersion || VERSION;

// e.g., PI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** Get the share viewer URL for a gist ID. */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.pi/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.pi/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
