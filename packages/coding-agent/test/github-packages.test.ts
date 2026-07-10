import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("GitHub Packages preparation", () => {
	test("publishes fork package versions while preserving the upstream changelog baseline", () => {
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
		const preparedPackageJsonPath = join(tempDir, "work", "packages", "coding-agent", "package.json");
		expect(existsSync(preparedPackageJsonPath)).toBe(true);

		const preparedPackageJson = JSON.parse(readFileSync(preparedPackageJsonPath, "utf8")) as {
			name: string;
			version: string;
			piConfig?: { changelogVersion?: string };
		};
		expect(preparedPackageJson.name).toBe("@xz-dev/pi-coding-agent");
		expect(preparedPackageJson.version).toBe(`${basePackageJson.version}-xz.29.1.g4dea8cc9`);
		expect(preparedPackageJson.piConfig?.changelogVersion).toBe(basePackageJson.version);
		expect(existsSync(join(tempDir, "work", "packages", "coding-agent", "CHANGELOG.md"))).toBe(true);
	});
});
