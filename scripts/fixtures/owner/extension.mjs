// Deliberately starts work in the factory: tests the CLI owner before any model or session is needed.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export default async function () {
	const child = spawn(process.env.PI_OWNER_RUNTIME, [join(process.env.PI_OWNER_FIXTURES, "descendant.mjs"), "bridge"], { stdio: "ignore" });
	await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`owner fixture bridge: ${code}`)));
	});
	writeFileSync(process.env.PI_OWNER_READY, JSON.stringify({ pid: process.pid, uid: process.getuid?.() ?? null, owner: process.env.PI_PROCESS_OWNER_BINARY ?? null }));
	while (!existsSync(process.env.PI_OWNER_RELEASE)) await delay(10);
	process.exit(0);
}
