import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
	PACKAGE_NAME,
	PACKAGE_REGISTRY,
} from "../src/utils/version-check.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalOffline = process.env.PI_OFFLINE;
const originalPath = process.env.PATH;
const tempDirs: string[] = [];

function prependFakeNpmView(version: string): string {
	const fakeBinDir = mkdtempSync(join(tmpdir(), "pi-version-check-"));
	tempDirs.push(fakeBinDir);
	const recordPath = join(fakeBinDir, "npm-view-args.json");
	const fakeNpmPath = join(fakeBinDir, process.platform === "win32" ? "npm.cmd" : "npm");
	const script =
		process.platform === "win32"
			? `@echo off\r\necho %* > ${recordPath}\r\nif "%1"=="view" if "%2"=="${PACKAGE_NAME}" if "%3"=="version" (echo ${version} & exit /b 0)\r\nexit /b 23\r\n`
			: `#!/bin/sh\nprintf '%s\\n' "$*" > '${recordPath.replaceAll("'", "'\\''")}'\nif [ "$1" = "view" ] && [ "$2" = "${PACKAGE_NAME}" ] && [ "$3" = "version" ]; then\n\tprintf '%s\\n' '${version.replaceAll("'", "'\\''")}'\n\texit 0\nfi\nexit 23\n`;
	writeFileSync(fakeNpmPath, script);
	chmodSync(fakeNpmPath, 0o755);
	process.env.PATH = `${fakeBinDir}${originalPath ? `${delimiter}${originalPath}` : ""}`;
	return recordPath;
}

afterEach(() => {
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.PI_OFFLINE;
	} else {
		process.env.PI_OFFLINE = originalOffline;
	}
	process.env.PATH = originalPath;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		prependFakeNpmView("1.2.3");

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({
			packageName: PACKAGE_NAME,
			version: "1.2.3",
		});
	});

	it("reads the GitHub Packages npm version", async () => {
		const recordPath = prependFakeNpmView("1.2.4");

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		const recordedArgs = readFileSync(recordPath, "utf-8");
		expect(recordedArgs).toContain(`view ${PACKAGE_NAME} version`);
		expect(recordedArgs).toContain(`--registry=${PACKAGE_REGISTRY}`);
	});

	it("returns fork package metadata from the GitHub Packages npm version", async () => {
		prependFakeNpmView("1.2.4");

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: PACKAGE_NAME,
			version: "1.2.4",
		});
	});

	it("skips npm calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
	});
});
