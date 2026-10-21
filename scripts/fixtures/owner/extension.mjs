// Deliberately starts work in the factory: tests the CLI owner before any model or session is needed.
import { spawn } from "node:child_process";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export default async function () {
	if (process.env.PI_OWNER_CASE !== "ownership-disabled") {
		const child = spawn(process.env.PI_OWNER_RUNTIME, [join(process.env.PI_OWNER_FIXTURES, "descendant.mjs"), "bridge"], { stdio: "ignore" });
		await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`owner fixture bridge: ${code}`)));
		});
	}
	// Atomic publish: the smoke polls existsSync(ready), so a plain write can be observed empty.
	writeFileSync(`${process.env.PI_OWNER_READY}.tmp`, JSON.stringify({ pid: process.pid, parent: process.ppid, uid: process.getuid?.() ?? null, bun: process.versions.bun ?? null, owner: process.env.PI_PROCESS_OWNER_BINARY ?? null }));
	renameSync(`${process.env.PI_OWNER_READY}.tmp`, process.env.PI_OWNER_READY);
	while (!existsSync(process.env.PI_OWNER_RELEASE)) {
		if (process.env.PI_OWNER_CASE === "suspend-resume" && existsSync(process.env.PI_OWNER_PAUSE)) {
			unlinkSync(process.env.PI_OWNER_PAUSE);
			process.kill(process.pid, "SIGSTOP");
		}
		await delay(10);
	}
	process.exit(0);
}
