#!/usr/bin/env bun

const [executable] = process.argv.slice(2);
if (!executable) throw new Error("Usage: smoke-bun-tui.mjs <executable>");

const started = performance.now();
let outputBytes = 0;
let observedOutput = false;
let exitSent = false;
let interruptTimer;
let exitTimer;
let timeoutTimer;

const processExited = Promise.withResolvers();
const child = Bun.spawn([executable], {
	env: process.env,
	terminal: {
		cols: 120,
		rows: 40,
		data(terminal, data) {
			outputBytes += data.byteLength;
			if (observedOutput) return;
			observedOutput = true;
			interruptTimer = setTimeout(() => {
				terminal.write("\x03");
				exitTimer = setTimeout(() => {
					exitSent = true;
					terminal.write("\x04");
				}, 500);
			}, 1000);
		},
	},
	onExit(_subprocess, exitCode) {
		processExited.resolve(exitCode);
	},
});

timeoutTimer = setTimeout(() => processExited.reject(new Error("TUI PTY timeout")), 7000);
try {
	const exitCode = await processExited.promise;
	if (!observedOutput || !exitSent || exitCode !== 0) throw new Error(`TUI PTY acceptance failed: exit=${exitCode} output=${outputBytes} exitSent=${exitSent}`);
	console.log(JSON.stringify({
		harness: "Bun.Terminal PTY",
		elapsedMs: Math.round(performance.now() - started),
		outputBytes,
		input: "ctrl-c,ctrl-d",
		childExitCode: exitCode,
		observedOutput,
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
