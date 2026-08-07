#!/usr/bin/env bun

const [executable] = process.argv.slice(2);
if (!executable) throw new Error("Usage: smoke-bun-tui.mjs <executable>");

const started = performance.now();
const startupBenchmark = ["1", "true", "yes"].includes((process.env.PI_STARTUP_BENCHMARK ?? "").toLowerCase());
const startupBenchmarkCompleteMarker = "__PI_STARTUP_BENCHMARK_COMPLETE__";
const startupBenchmarkStagePattern = /__PI_STARTUP_BENCHMARK_STAGE__:(init-entered|tools-ready|tui-started|theme-applied|session-rebound|providers-counted)/g;
const outputTailLength = Math.max(startupBenchmarkCompleteMarker.length, "__PI_STARTUP_BENCHMARK_STAGE__:providers-counted".length) - 1;
const decoder = new TextDecoder();
let outputBytes = 0;
let outputTail = "";
let lastBenchmarkStage = null;
let benchmarkCompleted = startupBenchmark ? false : null;
const terminalClosure = Promise.withResolvers();
let observedOutput = false;
let exitSent = false;
let interruptTimer;
let exitTimer;
let timeoutTimer;

const child = Bun.spawn([executable], {
	env: process.env,
	terminal: {
		cols: 120,
		rows: 40,
		data(terminal, data) {
			outputBytes += data.byteLength;
			if (startupBenchmark && !benchmarkCompleted) {
				const decoded = outputTail + decoder.decode(data, { stream: true });
				benchmarkCompleted = decoded.includes(startupBenchmarkCompleteMarker);
				for (const match of decoded.matchAll(startupBenchmarkStagePattern)) lastBenchmarkStage = match[1];
				outputTail = decoded.slice(-outputTailLength);
			}
			if (observedOutput) return;
			observedOutput = true;
			if (!startupBenchmark) {
				interruptTimer = setTimeout(() => {
					terminal.write("\x03");
					exitTimer = setTimeout(() => {
						exitSent = true;
						terminal.write("\x04");
					}, 500);
				}, 1000);
			}
		},
		exit(_terminal, exitCode) {
			terminalClosure.resolve(exitCode);
		},
	},
});

const timedOut = Promise.withResolvers();
timeoutTimer = setTimeout(() => timedOut.reject(new Error(`TUI PTY timeout: exit=${child.exitCode} output=${outputBytes} observedOutput=${observedOutput} lastStage=${lastBenchmarkStage}`)), 7000);
try {
	const [exitCode, terminalExitCode] = await Promise.race([Promise.all([child.exited, terminalClosure.promise]), timedOut.promise]);
	if (!observedOutput || (startupBenchmark && !benchmarkCompleted) || exitSent === startupBenchmark || exitCode !== 0) throw new Error(`TUI PTY acceptance failed: exit=${exitCode} terminalExit=${terminalExitCode} output=${outputBytes} exitSent=${exitSent} benchmark=${startupBenchmark} benchmarkCompleted=${benchmarkCompleted}`);
	console.log(JSON.stringify({
		harness: process.platform === "win32" ? "Bun.Terminal ConPTY" : "Bun.Terminal PTY",
		elapsedMs: Math.round(performance.now() - started),
		outputBytes,
		input: startupBenchmark ? "startup-benchmark" : "ctrl-c,ctrl-d",
		childExitCode: exitCode,
		terminalClosed: true,
		terminalExitCode,
		observedOutput,
		benchmarkCompleted,
		lastBenchmarkStage,
		exitSent,
		cleanExit: true,
	}));
} finally {
	clearTimeout(interruptTimer);
	clearTimeout(exitTimer);
	clearTimeout(timeoutTimer);
	if (child.exitCode === null) child.kill();
	child.terminal?.close();
}
