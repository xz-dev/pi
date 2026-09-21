import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Build a process-unique native fixture from the current C source.
 *
 * Each Vitest worker gets its own output path, so parallel files cannot race
 * and a stale ignored .node can never hide source changes. Build uses the
 * production script and target, binding tests to the submitted builder.
 */
export function buildUsageClaimFixture(): string {
	const repoRoot = join(import.meta.dirname, "..", "..", "..");
	const source = join(repoRoot, "native", "pi-usage-claim-posix.c");
	const script = join(repoRoot, "scripts", "build-pi-usage-claim.sh");
	const artifact = join(import.meta.dirname, "fixtures", `pi-usage-claim-${process.pid}.node`);
	if (!existsSync(source)) throw new Error(`usage-claim source missing: ${source}`);
	if (!existsSync(script)) throw new Error(`usage-claim build script missing: ${script}`);
	const result = spawnSync(script, ["linux-x64-gnu-modern", artifact], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`cannot build usage-claim fixture: ${result.stderr}\n${result.stdout}`);
	}
	process.once("exit", () => rmSync(artifact, { force: true }));
	return artifact;
}
