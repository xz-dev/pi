import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STARTUP_BENCHMARK_COMPLETE_MARKER } from "../src/utils/startup-benchmark.ts";

const helperPath = fileURLToPath(new URL("../src/utils/startup-benchmark.ts", import.meta.url));

describe("startup benchmark completion", () => {
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
