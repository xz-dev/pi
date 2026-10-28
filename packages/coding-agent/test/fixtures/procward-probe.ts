import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import { hasLostCliProcessOwner, onCliProcessOwnerLoss } from "../../src/utils/managed-child.ts";
import { ownCliProcesses } from "../../src/utils/procward.ts";

if (process.env.PROCWARD_PROBE_TRACE) appendFileSync(process.env.PROCWARD_PROBE_TRACE, `${process.pid}\n`);
let lifecyclePipe: string | undefined;
try {
	if (process.env.PROCWARD_LIFECYCLE_FD)
		lifecyclePipe = readlinkSync(`/proc/self/fd/${process.env.PROCWARD_LIFECYCLE_FD}`);
} catch {}
ownCliProcesses();
ownCliProcesses();
if (process.env.PI_PROCWARD_PROBE_NEST === "1") {
	const optOut = process.env.PI_PROCWARD_PROBE_CHILD_OPT_OUT;
	const child = spawnSync(
		process.execPath,
		[...process.execArgv, ...process.argv.slice(1), ...(optOut === "flag" ? ["--no-process-ownership"] : [])],
		{
			env: {
				...process.env,
				PI_PROCWARD_PROBE_NEST: "",
				PI_NO_PROCESS_OWNERSHIP: optOut === "environment" ? "1" : "",
			},
			encoding: "utf8",
			timeout: 10000,
		},
	);
	process.stdout.write(child.stdout);
	process.stderr.write(child.stderr);
	process.exit(child.status ?? 125);
}
let layers = 0;
for (let pid = process.pid; pid > 1; ) {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	if (basename(readlinkSync(`/proc/${pid}/exe`)) === "procward") layers++;
	pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}
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
		layers,
		bootstrapNonce: process.env.PI_PROCWARD_BOOTSTRAP_NONCE,
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
