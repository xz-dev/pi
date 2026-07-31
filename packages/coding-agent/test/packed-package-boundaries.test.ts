import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPackedPackageCommand } from "./helpers/packed-package-command.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const packages = ["ai", "tui", "agent", "protocol", "client", "coding-agent"] as const;
const describePackedPackage =
	process.platform !== "win32" && process.env.PI_PACKED_PACKAGE_TEST === "1" ? describe : describe.skip;

async function pack(directory: string, packageName: string, tarballDir: string): Promise<string> {
	const output = await runPackedPackageCommand(
		"npm",
		["pack", "--json", "--ignore-scripts", "--pack-destination", tarballDir],
		directory,
		30_000,
	);
	const packed = JSON.parse(output) as Array<{ filename?: string }> | Record<string, { filename?: string }>;
	const filename = Array.isArray(packed) ? packed[0]?.filename : packed[packageName]?.filename;
	if (!filename) {
		throw new Error(`npm pack returned no filename for ${packageName}`);
	}
	return filename;
}

describePackedPackage("packed package boundaries", () => {
	let tempDir: string;
	let installDir: string;

	beforeAll(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-packed-boundaries-"));
		installDir = join(tempDir, "install");
		const tarballDir = join(tempDir, "tarballs");
		mkdirSync(installDir, { recursive: true });
		mkdirSync(tarballDir);

		const dependencies: Record<string, string> = {};
		for (const packagePath of packages) {
			const directory = join(repoRoot, "packages", packagePath);
			const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
				name: string;
			};
			const filename = await pack(directory, packageJson.name, tarballDir);
			dependencies[packageJson.name] = `file:${join(tarballDir, filename).replaceAll("\\", "/")}`;
		}

		writeFileSync(
			join(installDir, "package.json"),
			`${JSON.stringify({ private: true, type: "module", dependencies, overrides: dependencies }, undefined, "\t")}\n`,
		);
		mkdirSync(join(installDir, "pi-config"));
		await runPackedPackageCommand("npm", ["install", "--ignore-scripts", "--omit=dev"], installDir, 90_000);
	}, 240_000);

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("starts the coding-agent CLI without monorepo source imports", async () => {
		await expect(
			runPackedPackageCommand(
				"node",
				[join(installDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), "--help"],
				installDir,
				15_000,
				undefined,
				{ PI_CODING_AGENT_DIR: join(installDir, "pi-config") },
			),
		).resolves.toContain("Usage:");
	}, 30_000);
});
