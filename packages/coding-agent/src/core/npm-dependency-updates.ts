import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { valid, validRange } from "semver";
import { stripBom } from "../utils/text.ts";

interface NpmManifest {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	bundleDependencies?: string[] | boolean;
	bundledDependencies?: string[] | boolean;
	overrides?: unknown;
	resolutions?: unknown;
	pnpm?: { overrides?: unknown };
}

export interface NpmRuntimeDependency {
	name: string;
	version: string;
	ranges: string[];
}

interface DependencyNode extends NpmRuntimeDependency {
	children: Set<DependencyNode>;
}

function readManifest(directory: string): NpmManifest | undefined {
	try {
		const manifest: unknown = JSON.parse(stripBom(readFileSync(join(directory, "package.json"), "utf8")));
		return manifest && typeof manifest === "object" && !Array.isArray(manifest)
			? (manifest as NpmManifest)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Inspect only installed runtime edges; the package manager remains responsible for solving updates. */
export function getNpmRuntimeDependencies(installRoot: string): Map<string, NpmRuntimeDependency[]> {
	const result = new Map<string, NpmRuntimeDependency[]>();
	const manifest = readManifest(installRoot);
	// shortcut: overrides and resolutions need manager-specific planning; skip until that is supported.
	if (!manifest || manifest.overrides || manifest.resolutions || manifest.pnpm?.overrides) return result;
	if (!existsSync(installRoot) || existsSync(join(installRoot, "npm-shrinkwrap.json"))) return result;
	const root = realpathSync(installRoot);
	const nodes = new Map<string, DependencyNode>();
	const visited = new Set<string>();
	const blockedNames = new Set<string>();
	const roots = new Map<string, DependencyNode>();

	const resolveDependency = (directory: string, name: string): string | undefined => {
		if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name === "." || name === "..") return undefined;
		let current = directory;
		while (current === root || current.startsWith(`${root}${sep}`)) {
			const candidate = join(current, "node_modules", name);
			if (basename(current) !== "node_modules" && existsSync(join(candidate, "package.json"))) {
				const path = realpathSync(candidate);
				return path.startsWith(`${root}${sep}`) ? path : undefined;
			}
			current = dirname(current);
		}
		return undefined;
	};

	const visit = (directory: string, locked: boolean): DependencyNode | undefined => {
		const pkg = readManifest(directory);
		if (typeof pkg?.name !== "string" || typeof pkg.version !== "string" || !valid(pkg.version)) return undefined;
		let node = nodes.get(directory);
		if (!node) {
			node = { name: pkg.name, version: pkg.version, ranges: [], children: new Set() };
			nodes.set(directory, node);
		}
		// Published shrinkwraps constrain descendants, unlike Pi's generated installation lock.
		locked ||= existsSync(join(directory, "npm-shrinkwrap.json"));
		if (locked) blockedNames.add(node.name);
		const key = `${directory}\0${locked}`;
		if (visited.has(key)) return node;
		visited.add(key);
		for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
			const path = resolveDependency(directory, name);
			if (!path) continue;
			const range = typeof spec === "string" ? validRange(spec) : null;
			const bundles = pkg.bundleDependencies ?? pkg.bundledDependencies;
			const bundled = bundles === true || (Array.isArray(bundles) && bundles.includes(name));
			const child = visit(path, locked || !range || bundled);
			if (!child) continue;
			if (child.name !== name) blockedNames.add(child.name);
			if (range && !child.ranges.includes(range)) child.ranges.push(range);
			node.children.add(child);
		}
		return node;
	};

	for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
		const path = resolveDependency(root, name);
		if (!path) continue;
		const node = visit(path, false);
		if (node) {
			roots.set(name, node);
			blockedNames.add(node.name);
		}
	}
	for (const [name, node] of roots) {
		const reachable = new Set<DependencyNode>();
		const pending = [...node.children];
		for (const child of pending) {
			if (reachable.has(child)) continue;
			reachable.add(child);
			pending.push(...child.children);
		}
		// Retain fixed and invalid instances too: name-wide command safety needs every incoming constraint.
		result.set(
			name,
			[...reachable].filter((child) => !blockedNames.has(child.name) && child.ranges.length > 0),
		);
	}
	return result;
}
