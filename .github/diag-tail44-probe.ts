// Diagnostic probe (diag/env-tail44 only): the large-output program of process.test.ts behind a client that spends
// DELAY_MS per output chunk once AFTER bytes arrived. Prints byte counts and timing only; fails on any missing byte.
// Usage (copied into packages/env/test): node test/tail44-probe.ts DELAY_MS RUNS AFTER
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection } from "../src/connection.ts";
import { openProcess } from "../src/process.ts";
import { daemon } from "./daemon.ts";

const delay = Number(process.argv[2] ?? "0");
const runs = Number(process.argv[3] ?? "3");
// The per-chunk delay applies only once this many bytes arrived (the backlog when the program exits).
const after = Number(process.argv[4] ?? "0");
const busy = (ms: number) => {
	const end = performance.now() + ms;
	while (performance.now() < end) {}
};
for (let run = 0; run < runs; run++) {
	const cwd = mkdtempSync(join(tmpdir(), "tail44-"));
	const connection = new Connection({ command: [daemon] });
	let received = 0;
	let chunks = 0;
	const started = performance.now();
	const program = await openProcess(connection, {
		cwd,
		argv: [process.execPath, "-e", "process.stdout.write(Buffer.alloc(12 * 1024 * 1024, 120))"],
		onStdout: (bytes) => {
			received += bytes.length;
			chunks++;
			if (received >= after) busy(delay);
		},
	});
	const code = await program.exited;
	console.log(
		JSON.stringify({ delayMs: delay, after, run, code, received, missing: 12 * 1024 * 1024 - received, chunks, ms: Math.round(performance.now() - started) }),
	);
	connection.close();
	rmSync(cwd, { recursive: true, force: true });
	if (received !== 12 * 1024 * 1024) process.exitCode = 1;
}
