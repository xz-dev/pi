// Controlled lifecycle/exec peer fixture. Never starts procward or sends owner-loss signals.
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { consumeAndObserveManagedContract, observeOwnerLoss } from "../../src/utils/managed-child.ts";
import { ownCliProcess } from "../../src/utils/procward.ts";

if (process.env.PI_RUNTIME_EXEC_PEER) {
	console.log(JSON.stringify({ pid: process.pid, execArgv: process.execArgv, entry: process.argv[1] }));
	ownCliProcess(process.argv.slice(2), {
		resolveBinary: () => process.env.PI_RUNTIME_EXEC_PEER,
		standalone: process.env.PI_RUNTIME_STANDALONE === "1",
	});
	throw new Error("exec unexpectedly returned");
}

const mode = process.argv[2];
const start = performance.now();
const fd = process.env.PI_RUNTIME_NONBLOCK === "1" ? openSync("/proc/self/fd/3", constants.O_RDONLY | constants.O_NONBLOCK) : 3;
if (fd !== 3) closeSync(3);
const endpoint = readlinkSync(`/proc/self/fd/${fd}`);
const flags = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").match(/flags:\s+(\S+)/)[1];
const descriptors = () => readdirSync("/proc/self/fd").filter((entry) => {
	try { return readlinkSync(`/proc/self/fd/${entry}`) === endpoint; }
	catch { return false; }
});
const loss = (reason) => { console.error(`UNEXPECTED_LOSS ${reason}`); process.exit(2); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const contract = { ownerPid: process.ppid, launchId: "a".repeat(32), lifecycleFd: fd };

if (mode === "stop") {
	const observer = observeOwnerLoss(contract, loss);
	await pause(250);
	const active = descriptors().length;
	observer.stop();
	await pause(200);
	const remaining = descriptors().length;
	const reused = openSync("/dev/null", "r");
	observer.stop();
	await pause(100);
	fstatSync(reused);
	closeSync(reused);
	console.log(JSON.stringify({ mode, flags, active, remaining, repeatedStopPreservedFd: true }));
} else {
	if (mode === "closed" || mode === "invalid") closeSync(fd);
	let caught;
	let readyMs;
	try {
		consumeAndObserveManagedContract({
			protocol: "1", ownerPid: String(process.ppid), contractId: contract.launchId,
			lifecycleFd: String(mode === "invalid" ? 999999 : fd),
		}, process.pid, process.ppid, loss);
		readyMs = Math.round(performance.now() - start);
		await pause(400);
	} catch (error) { caught = { message: error.message, code: error.code }; }
	const elapsedMs = Math.round(performance.now() - start);
	// Allow the worker's existing asynchronous termination/exit handler to finish.
	await pause(200);
	console.log(JSON.stringify({ mode, flags, caught, readyMs, elapsedMs, remaining: descriptors().length }));
}
