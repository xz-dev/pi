import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const SOURCE_SCOPE = "@earendil-works/";
const INTERNAL_PACKAGE_PREFIX = `${SOURCE_SCOPE}pi-`;
const PUBLISH_SCOPE = "@xz-dev/";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function findPreparedPackageJsons(directory: string): Array<Record<string, unknown>> {
	const packageJsonPath = join(directory, "package.json");
	if (existsSync(packageJsonPath)) {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
		return typeof packageJson.name === "string" && packageJson.name.startsWith(PUBLISH_SCOPE) ? [packageJson] : [];
	}
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? findPreparedPackageJsons(join(directory, entry.name)) : [],
	);
}

function tarballName(packageName: string, version: string): string {
	return `${packageName.slice(1).replaceAll("/", "-")}-${version}.tgz`;
}

function writePackage(directory: string, packageJson: Record<string, unknown>): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(packageJson)}\n`);
}

describe("GitHub Packages preparation", () => {
	test("publishes the complete coding-agent dependency closure under the fork scope", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-github-packages-"));

		const result = spawnSync("node", ["scripts/prepare-github-packages.mjs", "--out", tempDir], {
			cwd: join(import.meta.dirname, "..", "..", ".."),
			encoding: "utf8",
			env: {
				...process.env,
				GITHUB_RUN_NUMBER: "29",
				GITHUB_RUN_ATTEMPT: "1",
				GITHUB_SHA: "4dea8cc9046547a59e2dd1e05688eed91290c67e",
			},
		});

		expect(result.status, result.stderr).toBe(0);

		const basePackageJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
			version: string;
		};
		const version = `${basePackageJson.version}-xz.29.1.g4dea8cc9`;
		const preparedPackageJsons = findPreparedPackageJsons(join(tempDir, "work", "packages"));
		const preparedByName = new Map(
			preparedPackageJsons.map((packageJson) => [packageJson.name as string, packageJson]),
		);
		const publishOrder = readFileSync(join(tempDir, "publish-order.txt"), "utf8")
			.trim()
			.split("\n")
			.map((path) => basename(path));
		const orderedNames = publishOrder.map((filename) => {
			const match = preparedPackageJsons.find(
				(packageJson) => tarballName(packageJson.name as string, version) === filename,
			);
			expect(match, `No prepared package matches ${filename}`).toBeDefined();
			return match?.name as string;
		});

		expect(new Set(orderedNames)).toEqual(new Set(preparedByName.keys()));
		expect(orderedNames.at(-1)).toBe("@xz-dev/pi-coding-agent");
		expect(basename(readFileSync(join(tempDir, "entry-tarball"), "utf8").trim())).toBe(
			tarballName("@xz-dev/pi-coding-agent", version),
		);

		for (const [packageName, packageJson] of preparedByName) {
			expect(packageJson.version).toBe(version);
			for (const section of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
				const dependencies = packageJson[section] as Record<string, string> | undefined;
				for (const [sourceName, dependencyVersion] of Object.entries(dependencies ?? {})) {
					if (!sourceName.startsWith(INTERNAL_PACKAGE_PREFIX)) continue;
					const publishedName = `${PUBLISH_SCOPE}${sourceName.slice(SOURCE_SCOPE.length)}`;
					expect(dependencyVersion).toBe(`npm:${publishedName}@${version}`);
					expect(preparedByName.has(publishedName)).toBe(true);
					expect(orderedNames.indexOf(publishedName)).toBeLessThan(orderedNames.indexOf(packageName));
				}
			}
		}

		const releaseManifest = JSON.parse(readFileSync(join(tempDir, "release-manifest.json"), "utf8")) as {
			version: string;
			packages: Array<{ publishName: string; integrity: string; entry: boolean }>;
		};
		expect(releaseManifest.version).toBe(version);
		expect(releaseManifest.packages.map((pkg) => pkg.publishName)).toEqual(orderedNames);
		expect(releaseManifest.packages.filter((pkg) => pkg.entry).map((pkg) => pkg.publishName)).toEqual([
			"@xz-dev/pi-coding-agent",
		]);
		expect(releaseManifest.packages.every((pkg) => pkg.integrity.startsWith("sha512-"))).toBe(true);

		const codingAgent = preparedByName.get("@xz-dev/pi-coding-agent") as {
			piConfig?: { changelogVersion?: string };
		};
		expect(codingAgent.piConfig?.changelogVersion).toBe(basePackageJson.version);
		expect(existsSync(join(tempDir, "work", "packages", "coding-agent", "CHANGELOG.md"))).toBe(true);
	});

	test("publishes newly introduced client and protocol workspaces and rejects missing internal packages", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-github-packages-fixture-"));
		const repository = join(tempDir, "repository");
		mkdirSync(repository, { recursive: true });
		const packageRoot = join(import.meta.dirname, "..", "..", "..");
		const prepareScript = join(packageRoot, "scripts", "prepare-github-packages.mjs");
		writeFileSync(
			join(repository, "package.json"),
			`${JSON.stringify({ name: "pi-monorepo", private: true, workspaces: ["packages/*"] })}\n`,
		);
		writePackage(join(repository, "packages", "coding-agent"), {
			name: "@earendil-works/pi-coding-agent",
			version: "1.0.0",
			dependencies: {
				"@earendil-works/pi-client": "^1.0.0",
				"@earendil-works/pi-protocol": "^1.0.0",
			},
		});
		writePackage(join(repository, "packages", "client"), {
			name: "@earendil-works/pi-client",
			version: "1.0.0",
			files: ["index.js"],
			dependencies: { "@earendil-works/pi-protocol": "^1.0.0" },
		});
		writeFileSync(join(repository, "packages", "client", "index.js"), "export {};\n");
		writePackage(join(repository, "packages", "protocol"), {
			name: "@earendil-works/pi-protocol",
			version: "1.0.0",
			files: ["index.js"],
		});
		writeFileSync(join(repository, "packages", "protocol", "index.js"), "export {};\n");

		const output = join(tempDir, "output");
		const result = spawnSync("node", [prepareScript, "--out", output], {
			cwd: repository,
			encoding: "utf8",
			env: { ...process.env, GITHUB_RUN_NUMBER: "29", GITHUB_SHA: "4dea8cc9046547a59e2dd1e05688eed91290c67e" },
		});
		expect(result.status, result.stderr).toBe(0);
		const codingAgent = JSON.parse(
			readFileSync(join(output, "work", "packages", "coding-agent", "package.json"), "utf8"),
		) as { dependencies: Record<string, string> };
		expect(codingAgent.dependencies).toMatchObject({
			"@earendil-works/pi-client": "npm:@xz-dev/pi-client@1.0.0-xz.29.1.g4dea8cc9",
			"@earendil-works/pi-protocol": "npm:@xz-dev/pi-protocol@1.0.0-xz.29.1.g4dea8cc9",
		});
		expect(
			readFileSync(join(output, "publish-order.txt"), "utf8")
				.trim()
				.split("\n")
				.map((path) => basename(path)),
		).toEqual([
			"xz-dev-pi-protocol-1.0.0-xz.29.1.g4dea8cc9.tgz",
			"xz-dev-pi-client-1.0.0-xz.29.1.g4dea8cc9.tgz",
			"xz-dev-pi-coding-agent-1.0.0-xz.29.1.g4dea8cc9.tgz",
		]);

		writePackage(join(repository, "packages", "coding-agent"), {
			name: "@earendil-works/pi-coding-agent",
			version: "1.0.0",
			dependencies: { "@earendil-works/pi-missing": "^1.0.0" },
		});
		const missing = spawnSync("node", [prepareScript, "--out", output], {
			cwd: repository,
			encoding: "utf8",
			env: { ...process.env, GITHUB_RUN_NUMBER: "29", GITHUB_SHA: "4dea8cc9046547a59e2dd1e05688eed91290c67e" },
		});
		expect(missing.status).not.toBe(0);
		expect(missing.stderr).toContain(
			"@earendil-works/pi-coding-agent depends on unresolved internal package @earendil-works/pi-missing",
		);
	});
});
