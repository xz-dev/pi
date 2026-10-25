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
	workspaces?: unknown;
}

export interface NpmRuntimeDependency {
	name: string;
	version: string;
	ranges: string[];
	specs: string[];
	directory: string;
	blocked: boolean;
	depth: number;
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
export function getNpmRuntimeDependencies(
	installRoot: string,
	packageRoot = false,
): Map<string, NpmRuntimeDependency[]> {
	const result = new Map<string, NpmRuntimeDependency[]>();
	const manifest = readManifest(installRoot);
	// shortcut: overrides and resolutions need manager-specific planning; skip until that is supported.
	if (!manifest || manifest.overrides || manifest.resolutions || manifest.pnpm?.overrides) return result;
	// shortcut: Git workspaces can contain unenumerated affected instances; skip until their graph is supported.
	if (packageRoot && manifest.workspaces !== undefined) return result;
	if (!existsSync(installRoot) || (!packageRoot && existsSync(join(installRoot, "npm-shrinkwrap.json"))))
		return result;
	const root = realpathSync(installRoot);
	const nodes = new Map<string, DependencyNode>();
	const visited = new Set<string>();
	const protectedNames = new Set<string>();
	const roots = new Map<string, DependencyNode>();
	let outsideRoot = false;

	const resolveDependency = (directory: string, name: string): string | undefined => {
		if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name === "." || name === "..") return undefined;
		let current = directory;
		while (current === root || current.startsWith(`${root}${sep}`)) {
			const candidate = join(current, "node_modules", name);
			if (basename(current) !== "node_modules" && existsSync(join(candidate, "package.json"))) {
				const path = realpathSync(candidate);
				if (path.startsWith(`${root}${sep}`)) return path;
				outsideRoot = true;
				return undefined;
			}
			current = dirname(current);
		}
		return undefined;
	};

	const visit = (directory: string, locked: boolean, opaque: boolean, depth: number): DependencyNode | undefined => {
		const pkg = readManifest(directory);
		if (typeof pkg?.name !== "string") return undefined;
		// Unversioned Git instances must still block unsafe name-wide native updates.
		const version = typeof pkg.version === "string" && valid(pkg.version) ? pkg.version : "";
		let node = nodes.get(directory);
		if (!node) {
			node = {
				name: pkg.name,
				version,
				ranges: [],
				specs: [],
				directory,
				blocked: false,
				depth,
				children: new Set(),
			};
			nodes.set(directory, node);
		}
		const shrinkwrapped = existsSync(join(directory, "npm-shrinkwrap.json"));
		node.blocked ||= locked || shrinkwrapped || !version;
		node.depth = Math.max(node.depth, depth);
		// A Git package may move, but its locked descendants are not independent update targets.
		const lockChildren = node.blocked || opaque;
		const key = `${directory}\0${lockChildren}`;
		if (visited.has(key)) return node;
		visited.add(key);
		for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
			const path = resolveDependency(directory, name);
			if (!path) continue;
			const range = typeof spec === "string" ? validRange(spec) : null;
			const bundles = pkg.bundleDependencies ?? pkg.bundledDependencies;
			const bundled = bundles === true || (Array.isArray(bundles) && bundles.includes(name));
			const child = visit(path, lockChildren || bundled, !range, depth + 1);
			if (!child) continue;
			if (child.name !== name || typeof spec !== "string") child.blocked = true;
			if (typeof spec === "string" && !child.specs.includes(spec)) child.specs.push(spec);
			if (range && !child.ranges.includes(range)) child.ranges.push(range);
			node.children.add(child);
		}
		return node;
	};

	for (const [name, spec] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
		const path = resolveDependency(root, name);
		if (!path) continue;
		const range = typeof spec === "string" ? validRange(spec) : null;
		const bundles = manifest.bundleDependencies ?? manifest.bundledDependencies;
		const bundled = bundles === true || (Array.isArray(bundles) && bundles.includes(name));
		const node = visit(path, packageRoot && bundled, packageRoot && !range, 0);
		if (node) {
			roots.set(name, node);
			if (packageRoot) {
				if (typeof spec === "string" && !node.specs.includes(spec)) node.specs.push(spec);
				if (range && !node.ranges.includes(range)) node.ranges.push(range);
				if (node.name !== name || typeof spec !== "string") node.blocked = true;
			} else {
				protectedNames.add(node.name);
			}
		}
	}
	// An escaped subtree can contain additional instances and constraints that cannot be enumerated safely.
	if (outsideRoot) return result;
	for (const node of nodes.values()) node.blocked ||= protectedNames.has(node.name);
	for (const [name, node] of roots) {
		const reachable = new Set<DependencyNode>();
		const pending = packageRoot ? [node] : [...node.children];
		for (const child of pending) {
			if (reachable.has(child)) continue;
			reachable.add(child);
			pending.push(...child.children);
		}
		// Keep every instance and authored constraint, including pins and blocked/shared subtrees.
		result.set(name, [...reachable]);
	}
	return result;
}
