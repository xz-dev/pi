import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STARTUP_BENCHMARK_COMPLETE_MARKER } from "../src/utils/startup-benchmark.ts";

const helperPath = fileURLToPath(new URL("../src/utils/startup-benchmark.ts", import.meta.url));

describe("startup benchmark completion", () => {
	it("writes stage markers only while benchmarking", () => {
		const stages = [
			"main-entered",
			"session-manager-ready",
			"runtime-ready",
			"input-ready",
			"interactive-created",
			"init-entered",
			"tools-ready",
			"tui-started",
			"theme-applied",
			"session-rebound",
			"providers-counted",
		];
		const script = `import { markStartupBenchmarkStage } from ${JSON.stringify(helperPath)}; for (const stage of ${JSON.stringify(stages)}) markStartupBenchmarkStage(stage);`;
		const expected = stages.map((stage) => `__PI_STARTUP_BENCHMARK_STAGE__:${stage}\n`).join("");
		expect(
			execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
				encoding: "utf8",
				env: { ...process.env, PI_STARTUP_BENCHMARK: "1" },
			}),
		).toBe(expected);
		for (const value of ["", "0", "false", "no", "random"]) {
			expect(
				execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
					encoding: "utf8",
					env: { ...process.env, PI_STARTUP_BENCHMARK: value },
				}),
			).toBe("");
		}
	});

	it("writes the completion marker and exits successfully", () => {
		const output = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"--eval",
				`import { completeStartupBenchmark } from ${JSON.stringify(helperPath)}; completeStartupBenchmark();`,
			],
			{ encoding: "utf8" },
		);

		expect(output).toBe(`${STARTUP_BENCHMARK_COMPLETE_MARKER}\n`);
	});
});
