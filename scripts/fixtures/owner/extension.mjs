// Deliberately starts work in the factory: tests the CLI owner before any model or session is needed.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export default async function (api) {
	if (process.env.PI_OWNER_CASE === "pty") {
		const work = process.env.PI_OWNER_PTY_WORK;
		const publish = (name, record) => {
			writeFileSync(join(work, `${name}.tmp`), JSON.stringify(record));
			renameSync(join(work, `${name}.tmp`), join(work, name));
		};
		api.on("session_shutdown", () => {
			publish("shutdown-hook-entered", { pid: process.pid });
			if (!existsSync(join(work, "shutdown-arm"))) return;
			const waitMs = 12000;
			publish("shutdown-entered", { pid: process.pid, waitMs });
			// Deliberately block main JS; only the product's independent deadline may end Pi.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
			publish("shutdown-returned", { pid: process.pid });
		});
		api.on("session_start", () => {
			// Public owned exec seam; return so interactive startup and raw TTY setup finish.
			void api.exec(process.env.PI_OWNER_PTY_HARNESS, ["--payload", work]).catch(() => {});
			spawn(process.env.PI_OWNER_PTY_HARNESS, ["--extension-child", work], { stdio: "ignore" });
			const spawner = spawn(process.env.PI_OWNER_PTY_HARNESS, ["--adoption-spawner", work], { stdio: "ignore" });
			spawner.once("exit", (code, signal) => {
				const identity = JSON.parse(readFileSync(join(work, "spawner"), "utf8"));
				publish("spawner-exit", { pid: spawner.pid, birth: identity.birth, code, signal });
			});
			writeFileSync(`${process.env.PI_OWNER_READY}.tmp`, JSON.stringify({ pid: process.pid, parent: process.ppid, uid: process.getuid(), bun: process.versions.bun ?? null, owner: process.env.PI_PROCESS_OWNER_BINARY ?? null }));
			renameSync(`${process.env.PI_OWNER_READY}.tmp`, process.env.PI_OWNER_READY);
		});
		return;
	}
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
