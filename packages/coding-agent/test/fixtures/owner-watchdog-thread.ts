// Manual Unix watchdog fixture: real bootstrap, then block the main JS thread.
import { writeFileSync } from "node:fs";
import { ownCliProcesses } from "../../src/utils/process-owner.ts";

ownCliProcesses();
writeFileSync(`${process.env.REVIEW_ROOT}/thread-ready`, JSON.stringify({ pid: process.pid, ppid: process.ppid }));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
process.exit(0);
