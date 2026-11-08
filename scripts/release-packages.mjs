import { readFileSync } from "node:fs";
import { join, matchesGlob, relative, resolve } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

export function getPublicWorkspacePackages(root = "packages") {
	const repoRoot = resolve(root, "..");
	const { workspaces } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	return findPackageDirectories(root)
		.filter((directory) => workspaces.some((pattern) => matchesGlob(relative(repoRoot, resolve(directory)), pattern)))
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true)
		.map(({ directory, name, version }) => ({ directory, name, version }));
}
