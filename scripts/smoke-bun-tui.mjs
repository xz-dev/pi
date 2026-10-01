#!/usr/bin/env bun

import { dirname } from "node:path";

const [executable] = process.argv.slice(2);
if (!executable) throw new Error("Usage: smoke-bun-tui.mjs <executable>");

const started = performance.now();
// Emulated targets pass a scaled budget; the interrupt/exit delays scale with it (1000/500 ms at 7000).
const timeoutMs = Number(process.env.PI_XZ_TUI_TIMEOUT_MS ?? 7000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`Invalid PI_XZ_TUI_TIMEOUT_MS: ${process.env.PI_XZ_TUI_TIMEOUT_MS}`);
const startupBenchmark = ["1", "true", "yes"].includes((process.env.PI_STARTUP_BENCHMARK ?? "").toLowerCase());
// PI_XZ_TUI_PASTE_PROBE sends ctrl+v after output settles so the session issues
// a real clipboard read before exit (resource materialization evidence).
const pasteProbe = ["1", "true", "yes"].includes((process.env.PI_XZ_TUI_PASTE_PROBE ?? "").toLowerCase());
const startupBenchmarkCompleteMarker = "__PI_STARTUP_BENCHMARK_COMPLETE__";
const startupBenchmarkStagePattern = /__PI_STARTUP_BENCHMARK_STAGE__:(main-entered|session-manager-ready|runtime-ready|input-ready|interactive-created|init-entered|tools-ready|tui-started|theme-applied|session-rebound|providers-counted)/g;
const markerTailLength = Math.max(startupBenchmarkCompleteMarker.length, "__PI_STARTUP_BENCHMARK_STAGE__:session-manager-ready".length) - 1;
// JSON.stringify can expand one UTF-16 code unit to six ASCII characters (for example, ESC -> "\\u001b").
// Keep the serialized tail below 3.1 KB so the complete diagnostic remains below 5 KB.
const diagnosticTailLength = 512;
const decoder = new TextDecoder();
let outputBytes = 0;
let markerTail = "";
let diagnosticTail = "";
let lastBenchmarkStage = null;
let benchmarkCompleted = startupBenchmark ? false : null;
const terminalClosure = Promise.withResolvers();
let observedOutput = false;
let exitSent = false;
let interruptTimer;
let exitTimer;
let timeoutTimer;

const child = Bun.spawn([executable], {
	cwd: dirname(executable),
	env: process.env,
	terminal: {
		cols: 120,
		rows: 40,
		data(terminal, data) {
			outputBytes += data.byteLength;
			const decodedChunk = decoder.decode(data, { stream: true });
			diagnosticTail = (diagnosticTail + decodedChunk).slice(-diagnosticTailLength);
			if (startupBenchmark && !benchmarkCompleted) {
				const decoded = markerTail + decodedChunk;
				benchmarkCompleted = decoded.includes(startupBenchmarkCompleteMarker);
				for (const match of decoded.matchAll(startupBenchmarkStagePattern)) lastBenchmarkStage = match[1];
				markerTail = decoded.slice(-markerTailLength);
			}
			if (observedOutput) return;
			observedOutput = true;
			if (pasteProbe) terminal.write("\x16");
			if (!startupBenchmark) {
				interruptTimer = setTimeout(() => {
					terminal.write("\x03");
					exitTimer = setTimeout(() => {
						exitSent = true;
						terminal.write("\x04");
					}, timeoutMs / 14);
				}, timeoutMs / 7);
			}
		},
		exit(_terminal, exitCode) {
			terminalClosure.resolve(exitCode);
		},
	},
});

const timedOut = Promise.withResolvers();
timeoutTimer = setTimeout(
	() =>
		timedOut.reject(
			new Error(
				`TUI PTY timeout: exit=${child.exitCode} output=${outputBytes} observedOutput=${observedOutput} lastStage=${lastBenchmarkStage} tail=${JSON.stringify(diagnosticTail)}`,
			),
		),
	timeoutMs,
);
try {
	const [exitCode, terminalExitCode] = await Promise.race([Promise.all([child.exited, terminalClosure.promise]), timedOut.promise]);
	if (!observedOutput || (startupBenchmark && !benchmarkCompleted) || exitSent === startupBenchmark || exitCode !== 0) throw new Error(`TUI PTY acceptance failed: exit=${exitCode} terminalExit=${terminalExitCode} output=${outputBytes} exitSent=${exitSent} benchmark=${startupBenchmark} benchmarkCompleted=${benchmarkCompleted}`);
	console.log(JSON.stringify({
		harness: process.platform === "win32" ? "Bun.Terminal ConPTY" : "Bun.Terminal PTY",
		elapsedMs: Math.round(performance.now() - started),
		outputBytes,
		input: startupBenchmark ? "startup-benchmark" : pasteProbe ? "ctrl-v,ctrl-c,ctrl-d" : "ctrl-c,ctrl-d",
		childExitCode: exitCode,
		terminalClosed: true,
		terminalExitCode,
		observedOutput,
		benchmarkCompleted,
		lastBenchmarkStage,
		exitSent,
		cleanExit: true,
	}));
} catch (error) {
	// Bun's GitHub annotations duplicate uncaught errors; print the bounded diagnostic once.
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	clearTimeout(interruptTimer);
	clearTimeout(exitTimer);
	clearTimeout(timeoutTimer);
	if (child.exitCode === null) child.kill();
	child.terminal?.close();
}
