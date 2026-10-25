import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import hostedGitInfo from "hosted-git-info";
import { validRange } from "semver";
import { parse as parseYaml } from "yaml";
import { stripJsonComments } from "../utils/json.ts";
import type { NpmRuntimeDependency } from "./npm-dependency-updates.ts";

interface GitDependencySource {
	repository?: string;
	identity: string;
	reference?: string;
	qualified: boolean;
	fixed: boolean;
}

interface GitResolution {
	repository: string;
	commit: string;
}

export interface GitDependencyTarget {
	manifest: unknown;
	changed: NpmRuntimeDependency[];
}

type RunGit = (args: string[]) => Promise<string>;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseSource(spec: string): GitDependencySource | undefined {
	if (!spec || /[\s\x00-\x1f\x7f]/.test(spec)) return undefined;
	const hash = spec.indexOf("#");
	const rawRepository = hash < 0 ? spec : spec.slice(0, hash);
	let reference: string | undefined;
	try {
		reference = hash < 0 ? undefined : decodeURIComponent(spec.slice(hash + 1)) || undefined;
	} catch {
		return undefined;
	}
	if (reference?.startsWith("semver:") || reference?.startsWith("-") || reference?.includes("\0")) return undefined;
	const qualified = reference?.startsWith("refs/heads/") ?? false;
	const fixed = Boolean(reference && (/^[0-9a-f]{7,40}$/i.test(reference) || reference.startsWith("refs/tags/")));
	if (qualified) reference = reference?.slice("refs/heads/".length);
	if (reference === "HEAD") reference = undefined;
	const repository = rawRepository.replace(/^git\+/, "");
	let hosted: ReturnType<typeof hostedGitInfo.fromUrl>;
	try {
		hosted = hostedGitInfo.fromUrl(rawRepository);
	} catch {
		return undefined;
	}
	const identity = hosted ? `${hosted.domain}/${hosted.user}/${hosted.project}` : undefined;
	if (/^(?:github|gitlab|bitbucket|gist):/.test(repository) || /^[^:@/]+\/[^/]+$/.test(repository)) {
		return identity ? { identity, reference, qualified, fixed } : undefined;
	}
	const scp = /^([^\s/:@]+)@([^\s/:]+):(.+)$/.exec(repository);
	if (scp) {
		if (scp[1]?.startsWith("-") || scp[2]?.startsWith("-") || scp[3]?.startsWith("-")) return undefined;
		return { repository, identity: identity ?? repository, reference, qualified, fixed };
	}
	try {
		const url = new URL(repository);
		if (!["https:", "http:", "ssh:", "git:", "file:"].includes(url.protocol) || url.search || url.hash)
			return undefined;
		if (url.protocol !== "file:" && !url.hostname) return undefined;
		if (url.hostname.startsWith("-") || decodeURIComponent(url.username).startsWith("-")) return undefined;
		return { repository, identity: identity ?? url.toString(), reference, qualified, fixed };
	} catch {
		return undefined;
	}
}

function resolvedSource(value: unknown, source: GitDependencySource): GitResolution | undefined {
	if (typeof value !== "string") return undefined;
	const hash = value.lastIndexOf("#");
	const commit = value.slice(hash + 1);
	if (hash < 0 || !/^[0-9a-f]{40}$/i.test(commit)) return undefined;
	const resolved = parseSource(value);
	if (!resolved?.repository || resolved.identity !== source.identity) return undefined;
	return { repository: source.repository ?? resolved.repository, commit: commit.toLowerCase() };
}

function installedResolution(
	installRoot: string,
	manager: string,
	instance: NpmRuntimeDependency,
	source: GitDependencySource,
): GitResolution | undefined {
	try {
		if (manager === "npm") {
			const path = join(
				installRoot,
				existsSync(join(installRoot, "npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : "package-lock.json",
			);
			const lock = record(JSON.parse(readFileSync(path, "utf8")) as unknown);
			if (lock?.lockfileVersion !== 3) return undefined;
			const packages = record(lock.packages);
			const key = relative(realpathSync(installRoot), instance.directory).split(sep).join("/");
			const entry = record(packages?.[key]);
			return entry?.version === instance.version ? resolvedSource(entry.resolved, source) : undefined;
		}
		if (manager === "pnpm") {
			if (
				instance.depth !== 0 ||
				instance.specs.length !== 1 ||
				realpathSync(join(installRoot, "node_modules", instance.name)) !== instance.directory
			)
				return undefined;
			const modules = record(
				parseYaml(readFileSync(join(installRoot, "node_modules", ".modules.yaml"), "utf8")) as unknown,
			);
			if (modules?.nodeLinker !== "isolated" || modules.virtualStoreDir !== ".pnpm" || modules.layoutVersion !== 5)
				return undefined;
			const current = record(
				parseYaml(
					readFileSync(join(installRoot, "node_modules", modules.virtualStoreDir, "lock.yaml"), "utf8"),
				) as unknown,
			);
			const wanted = record(parseYaml(readFileSync(join(installRoot, "pnpm-lock.yaml"), "utf8")) as unknown);
			if (current?.lockfileVersion !== "9.0" || wanted?.lockfileVersion !== "9.0") return undefined;
			const edge = record(record(record(current.importers)?.["."])?.dependencies)?.[instance.name];
			const wantedEdge = record(record(record(wanted.importers)?.["."])?.dependencies)?.[instance.name];
			const dependency = record(edge);
			if (
				!isDeepStrictEqual(edge, wantedEdge) ||
				dependency?.specifier !== instance.specs[0] ||
				typeof dependency.version !== "string" ||
				/[()]/.test(dependency.version)
			)
				return undefined;
			const key = `${instance.name}@${dependency.version}`;
			const pkg = record(record(current.packages)?.[key]);
			if (
				!pkg ||
				pkg.version !== instance.version ||
				pkg.peerDependencies !== undefined ||
				pkg.peerDependenciesMeta !== undefined ||
				!isDeepStrictEqual(pkg, record(wanted.packages)?.[key]) ||
				!record(record(current.snapshots)?.[key]) ||
				!isDeepStrictEqual(record(current.snapshots)?.[key], record(wanted.snapshots)?.[key])
			)
				return undefined;
			const resolution = record(pkg.resolution);
			if (resolution?.type !== "git" || typeof resolution.repo !== "string" || typeof resolution.commit !== "string")
				return undefined;
			return resolvedSource(`${resolution.repo}#${resolution.commit}`, source);
		}
		if (manager === "bun") {
			const lock = record(
				JSON.parse(stripJsonComments(readFileSync(join(installRoot, "bun.lock"), "utf8"))) as unknown,
			);
			if (lock?.lockfileVersion !== 2 || lock.configVersion !== 1) return undefined;
			const entries = Object.entries(record(lock.packages) ?? {}).filter(
				([key]) => key === instance.name || key.endsWith(`/${instance.name}`),
			);
			if (entries.length === 0) return undefined;
			const resolutions: GitResolution[] = [];
			for (const [, entry] of entries) {
				if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[0].startsWith(`${instance.name}@`))
					return undefined;
				const resolved = resolvedSource(entry[0].slice(instance.name.length + 1), source);
				if (!resolved || entry[2] !== resolved.commit) return undefined;
				resolutions.push(resolved);
			}
			// shortcut: ambiguous isolated instances require an exact native locator; never guess their commit.
			return new Set(resolutions.map((entry) => `${entry.repository}#${entry.commit}`)).size === 1
				? resolutions[0]
				: undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Compare authored Git constraints and native locked commits, without changing installed repositories. */
export async function getGitDependencyTarget(
	name: string,
	instances: NpmRuntimeDependency[],
	installRoot: string,
	manager: string,
	temporaryRoot: () => string,
	runGit: RunGit,
): Promise<GitDependencyTarget | undefined> {
	// Native pnpm's default exotic-subdependency policy forbids indirect Git; aliases/peer locators are unproved.
	if (manager === "pnpm" && instances.some((instance) => instance.depth !== 0 || instance.specs.length !== 1))
		return undefined;
	const sources = instances.flatMap((instance) => instance.specs.map(parseSource));
	const source = sources[0];
	if (
		!source ||
		source.fixed ||
		sources.some(
			(entry) =>
				!entry ||
				entry.fixed ||
				entry.identity !== source.identity ||
				entry.repository !== source.repository ||
				entry.reference !== source.reference,
		)
	)
		return undefined;
	const installed = instances.map((instance) => installedResolution(installRoot, manager, instance, source));
	if (installed.some((entry) => !entry)) return undefined;
	const repository = installed[0]?.repository;
	if (!repository || installed.some((entry) => entry?.repository !== repository)) return undefined;
	const branch = source.reference ? `refs/heads/${source.reference}` : undefined;
	if (branch) {
		try {
			await runGit(["check-ref-format", branch]);
		} catch {
			return undefined;
		}
	}
	try {
		const tag = source.reference ? `refs/tags/${source.reference}` : undefined;
		const refs = await runGit([
			"ls-remote",
			"--",
			repository,
			branch ?? "HEAD",
			...(tag && sources.some((entry) => !entry?.qualified) ? [tag] : []),
		]);
		const advertised = new Map(
			refs.split(/\r?\n/).map((line) => {
				const [commit, ref] = line.split(/\s+/);
				return [ref, commit];
			}),
		);
		if (tag && advertised.has(tag)) return undefined;
		const commit = advertised.get(branch ?? "HEAD");
		if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) return undefined;
		const changed = instances.filter((_instance, index) => installed[index]?.commit !== commit.toLowerCase());
		if (changed.length === 0) return undefined;
		const temporary = mkdtempSync(join(temporaryRoot(), "git-dependency-"));
		try {
			const hooks = join(temporary, "empty-hooks");
			mkdirSync(hooks);
			const prefix = ["-c", `core.hooksPath=${hooks}`, "--git-dir", temporary];
			await runGit([...prefix, "init", "--bare", "--template="]);
			await runGit([...prefix, "fetch", "--no-tags", "--depth=1", "--", repository, commit]);
			const manifest: unknown = JSON.parse(await runGit([...prefix, "show", `${commit}:package.json`]));
			if (manager === "pnpm") {
				const pkg = record(manifest);
				if (
					!pkg ||
					pkg.workspaces ||
					pkg.overrides ||
					pkg.resolutions ||
					pkg.peerDependencies !== undefined ||
					pkg.peerDependenciesMeta !== undefined ||
					record(pkg.pnpm)?.overrides
				)
					return undefined;
				// Do not offer a direct Git target that would introduce forbidden exotic subdependencies.
				for (const field of ["dependencies", "optionalDependencies"]) {
					if (pkg[field] === undefined) continue;
					const dependencies = record(pkg[field]);
					if (
						!dependencies ||
						Object.values(dependencies).some((spec) => typeof spec !== "string" || !validRange(spec))
					)
						return undefined;
				}
			}
			return { manifest, changed };
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	} catch (error) {
		const authentication =
			error instanceof Error &&
			/Permission denied|Authentication failed|could not read Username|access denied/i.test(error.message);
		// Native errors can contain credential-bearing URLs; report the failure without echoing those arguments.
		throw new Error(
			`Native Git ${authentication ? "authentication" : "metadata"} lookup failed for dependency ${name}`,
		);
	}
}
