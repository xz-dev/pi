import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv[2];
if (mode === "leaf") {
	writeFileSync(process.env.PI_OWNER_PID_FILE, String(process.pid));
	setTimeout(() => process.exit(99), 600_000);
} else if (mode === "bridge") {
	const middle = spawn(process.execPath, [process.argv[1], "middle"], {
		detached: process.env.PI_OWNER_CASE !== "double-fork",
		stdio: "ignore",
	});
	await new Promise((resolve, reject) => {
		middle.once("error", reject);
		middle.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`owner fixture middle: ${code}`)));
	});
} else if (mode === "middle") {
	const leaf = process.platform === "win32"
		? spawn(process.execPath, [process.argv[1], "leaf"], { detached: true, stdio: "ignore" })
		: spawn("/bin/sh", ["-c", 'printf "%s\\n" "$$" > "$PI_OWNER_PID_FILE"; exec sleep 600'], { stdio: "ignore" });
	leaf.on("error", (error) => { throw error; });
	leaf.unref();
	const deadline = Date.now() + 10_000;
	while (!existsSync(process.env.PI_OWNER_PID_FILE)) {
		if (Date.now() >= deadline) throw new Error("owner fixture leaf did not start");
		await delay(5);
	}
	// Darwin samples every 25 ms; keep both parents observable before reparenting.
	if (process.env.PI_OWNER_CASE !== "fast-escape") await delay(500);
} else {
	throw new Error(`unknown owner fixture mode: ${mode}`);
}
