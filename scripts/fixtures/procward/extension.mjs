import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi) {
	const directory = process.env.PI_PROCWARD_CONTRACT_DIRECTORY;
	const write = (name, data) => appendFileSync(join(directory, name), `${JSON.stringify(data)}\n`);
	if (process.env.PI_PROCWARD_CONTRACT_PROBE === "1") {
		const nest = process.env.PI_PROCWARD_CONTRACT_NEST;
		if (nest) {
			const child = spawnSync(process.execPath, [...process.argv.slice(2), ...(nest === "flag" ? ["--no-process-ownership"] : [])], {
				env: { ...process.env, PI_PROCWARD_CONTRACT_NEST: "", PI_NO_PROCESS_OWNERSHIP: nest === "env" ? "1" : "" },
				stdio: "inherit", timeout: 30000,
			});
			if (child.error) throw child.error;
			process.exit(child.status ?? 125);
		}
		const topology = JSON.parse(execFileSync(process.env.PI_PROCWARD_CONTRACT_RUNTIME, [process.env.PI_PROCWARD_CONTRACT_TOPOLOGY, String(process.pid)], { encoding: "utf8", timeout: 10000 }));
		write("probe.json", { pid: process.pid, parent: process.ppid, topology, taskOwner: process.env.PI_PROCESS_OWNER_BINARY, metadata: Object.keys(process.env).filter((key) => key.startsWith("PROCWARD_") || key === "PI_PROCWARD_BOOTSTRAP_NONCE") });
		process.exit(0);
	}
	pi.on("session_start", async () => { write("ready.json", { pid: process.pid, parent: process.ppid }); });
	pi.on("session_shutdown", async () => {
		write("hook.json", { shutdown: true });
		if (process.env.PI_PROCWARD_CONTRACT_BLOCKED === "1") await new Promise(() => {});
	});
}
