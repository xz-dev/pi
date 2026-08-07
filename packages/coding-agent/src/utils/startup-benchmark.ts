import { writeSync } from "node:fs";

export const STARTUP_BENCHMARK_COMPLETE_MARKER = "__PI_STARTUP_BENCHMARK_COMPLETE__";

export type StartupBenchmarkStage =
	| "main-entered"
	| "session-manager-ready"
	| "runtime-ready"
	| "input-ready"
	| "interactive-created"
	| "init-entered"
	| "tools-ready"
	| "tui-started"
	| "theme-applied"
	| "session-rebound"
	| "providers-counted";

export function isStartupBenchmarkEnabled(): boolean {
	const value = process.env.PI_STARTUP_BENCHMARK?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

export function markStartupBenchmarkStage(stage: StartupBenchmarkStage): void {
	if (isStartupBenchmarkEnabled()) writeSync(process.stdout.fd, `__PI_STARTUP_BENCHMARK_STAGE__:${stage}\n`);
}

export function completeStartupBenchmark(): never {
	writeSync(process.stdout.fd, `${STARTUP_BENCHMARK_COMPLETE_MARKER}\n`);
	process.exit(0);
}
