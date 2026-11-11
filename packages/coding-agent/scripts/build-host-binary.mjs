#!/usr/bin/env node
// Keep the direct host Bun build using the same stamped helper as the npm build.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertProcwardBundleBuild } from "./build-procward.mjs";

export function buildHostBinary(directory = resolve(dirname(fileURLToPath(import.meta.url)), ".."), env = process.env) {
	const included = assertProcwardBundleBuild(directory, env);
	const staging = mkdtempSync(join(tmpdir(), "pi-host-binary-"));
	try {
		const assets = [];
		if (included) {
			const owner = join(staging, "process-owner");
			cpSync(join(directory, "native/procward", env.CARGO_BUILD_TARGET || "host"), owner, { recursive: true });
			assets.push(`--asset=${owner}`);
		}
		const result = spawnSync("bun", [
			"build", "--compile", "--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv",
			// Resolve extension dependencies through package.json main/exports (upstream #12012).
			"--compile-autoload-package-json",
			`--define=PI_PROCWARD_INCLUDED=${included}`, ...assets,
			"./dist/bun/cli-portable.js", "./src/utils/image-resize-worker.ts", "./src/extensions/codemode/worker.ts",
			"--outfile", "dist/pi",
		], { cwd: directory, env, stdio: "inherit" });
		if (result.error) throw result.error;
		return result.status ?? (result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : 1);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = buildHostBinary();
}
