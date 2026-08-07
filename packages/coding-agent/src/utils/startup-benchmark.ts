import { writeSync } from "node:fs";

export const STARTUP_BENCHMARK_COMPLETE_MARKER = "__PI_STARTUP_BENCHMARK_COMPLETE__";

export function completeStartupBenchmark(): never {
	writeSync(process.stdout.fd, `${STARTUP_BENCHMARK_COMPLETE_MARKER}\n`);
	process.exit(0);
}
