import { readFileSync } from "node:fs";
import {
	cliProcessOwnerExitCode,
	completeCliProcessOwnerStartup,
	consumeProcwardContract,
	hasLostCliProcessOwner,
	onCliProcessOwnerLoss,
} from "../../src/utils/managed-child.ts";

const endpoint = process.env.PROCWARD_LIFECYCLE_FD;
consumeProcwardContract();
consumeProcwardContract();
console.log(
	JSON.stringify({
		ready: true,
		pid: process.pid,
		metadata: Object.keys(process.env).filter((key) => key.startsWith("PROCWARD_")),
		flags:
			process.platform === "linux" && endpoint
				? readFileSync(`/proc/self/fdinfo/${endpoint}`, "utf8").match(/flags:\s+(\d+)/)?.[1]
				: undefined,
	}),
);
if (!["startup-term", "print-notice", "rpc-notice"].includes(process.env.PI_CONTRACT_MODE ?? "")) {
	onCliProcessOwnerLoss(() => {
		console.log(JSON.stringify({ loss: hasLostCliProcessOwner(), code: cliProcessOwnerExitCode() }));
		process.exit(cliProcessOwnerExitCode());
	});
}
if (["print-notice", "rpc-notice"].includes(process.env.PI_CONTRACT_MODE ?? "")) completeCliProcessOwnerStartup();
if (process.env.PI_CONTRACT_BLOCK === "1") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
setInterval(() => {}, 1000);
