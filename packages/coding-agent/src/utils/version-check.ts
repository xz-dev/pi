import { compare, valid } from "semver";
import { spawnProcess } from "./child-process.ts";
import { killProcessTree } from "./shell.ts";

export const PACKAGE_SCOPE = "@xz-dev";
export const PACKAGE_NAME = `${PACKAGE_SCOPE}/pi-coding-agent`;
export const PACKAGE_REGISTRY = "https://npm.pkg.github.com";
export const PACKAGE_PAGE_URL = "https://github.com/xz-dev/pi/pkgs/npm/pi-coding-agent";

const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

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

function readLatestPackageVersion(timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawnProcess("npm", ["view", PACKAGE_NAME, "version", `--registry=${PACKAGE_REGISTRY}`], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			callback();
		};
		const timeout = setTimeout(() => {
			if (child.pid) killProcessTree(child.pid);
			child.stdout.destroy();
			child.stderr.destroy();
			finish(() => reject(new Error(`npm view timed out after ${timeoutMs}ms`)));
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => {
			finish(() => {
				if (code === 0) {
					resolve(Buffer.concat(stdout).toString("utf8").trim());
					return;
				}
				const reason = Buffer.concat(stderr).toString("utf8").trim() || `exit code ${code ?? "unknown"}`;
				reject(new Error(reason));
			});
		});
	});
}

export async function getLatestPiRelease(
	_currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	let version: string;
	try {
		version = await readLatestPackageVersion(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Could not read ${PACKAGE_NAME} latest version from ${PACKAGE_PAGE_URL}: ${reason}. ` +
				`Run npm login --scope=${PACKAGE_SCOPE} --auth-type=legacy --registry=${PACKAGE_REGISTRY}.`,
			{ cause: error },
		);
	}
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
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
	} catch {
		// Silently ignore version check errors
	}
	return undefined;
}
