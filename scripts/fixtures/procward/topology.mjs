import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";

let pid = Number(process.argv[2] ?? process.pid);
if (process.platform !== "linux") {
	const python = process.platform === "win32" ? "python" : "python3.11";
	// macOS supplies python3, FreeBSD supplies the explicitly installed python3.11.
	const command = process.platform === "darwin" ? "python3" : python;
	process.stdout.write(execFileSync(command, [join(import.meta.dirname, "topology.py"), String(pid)], { encoding: "utf8", timeout: 10000 }));
} else {
	const stop = Number(process.env.PI_PROCWARD_CONTRACT_HARNESS_PID);
	const seen = new Set();
	const chain = [];
	while (pid !== stop) {
		if (!Number.isSafeInteger(pid) || pid <= 1 || seen.has(pid)) throw new Error("harness is not a live ancestor");
		seen.add(pid);
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		const name = basename(readlinkSync(`/proc/${pid}/exe`));
		chain.push({ pid, parent, name });
		pid = parent;
	}
	console.log(JSON.stringify({ chain, ownerLayers: chain.filter(({ name }) => name === "procward").length }));
}
