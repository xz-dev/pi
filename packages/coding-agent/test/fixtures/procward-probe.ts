import { appendFileSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { ownCliProcesses } from "../../src/utils/procward.ts";
import { hasLostCliProcessOwner, onCliProcessOwnerLoss } from "../../src/utils/procward-contract.ts";

if (process.env.PROCWARD_PROBE_TRACE) appendFileSync(process.env.PROCWARD_PROBE_TRACE, `${process.pid}\n`);
const lifecyclePipe = process.env.PROCWARD_LIFECYCLE_FD
	? readlinkSync(`/proc/self/fd/${process.env.PROCWARD_LIFECYCLE_FD}`)
	: undefined;
ownCliProcesses();
ownCliProcesses();
const endpoints = readdirSync("/proc/self/fd").flatMap((fd) => {
	try {
		const link = readlinkSync(`/proc/self/fd/${fd}`);
		const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
		return link === lifecyclePipe && Number(fd) > 2
			? [{ fd: Number(fd), link, flags: info.match(/flags:\s+(\d+)/)?.[1] }]
			: [];
	} catch {
		return [];
	}
});
console.log(
	JSON.stringify({
		taskOwner: process.env.PI_PROCESS_OWNER_BINARY,
		pid: process.pid,
		ppid: process.ppid,
		contract: Object.keys(process.env).filter((key) => key.startsWith("PROCWARD_")),
		endpoints,
	}),
);
if (process.env.PROCWARD_PROBE_BLOCK) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
	process.exit(0);
}
if (process.env.PROCWARD_PROBE_WAIT) {
	onCliProcessOwnerLoss(() => {
		console.log(JSON.stringify({ loss: hasLostCliProcessOwner() }));
		process.exit(0);
	});
	setInterval(() => {}, 1000);
} else process.exit(0);
