import { compare, valid } from "semver";
import { spawnProcessSync } from "./child-process.ts";

export const PACKAGE_SCOPE = "@xz-dev";
export const PACKAGE_NAME = `${PACKAGE_SCOPE}/pi-coding-agent`;
export const PACKAGE_REGISTRY = "https://npm.pkg.github.com";
export const PACKAGE_PAGE_URL = "https://github.com/xz-dev/pi/pkgs/npm/pi-coding-agent";

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(
	_currentVersion: string,
	_options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

	const result = spawnProcessSync("npm", ["view", PACKAGE_NAME, "version", `--registry=${PACKAGE_REGISTRY}`], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(
			`Could not read ${PACKAGE_NAME} latest version from ${PACKAGE_PAGE_URL}: ${reason}. ` +
				`Run npm login --scope=${PACKAGE_SCOPE} --auth-type=legacy --registry=${PACKAGE_REGISTRY}.`,
		);
	}

	const version = result.stdout.trim();
	if (!version) return undefined;
	return {
		version,
		packageName: PACKAGE_NAME,
	};
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
