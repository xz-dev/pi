import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv[2];
if (mode === "retained-leaf") {
	const directory = process.argv[3];
	writeFileSync(join(directory, "leaf.pid"), String(process.pid));
	writeFileSync(join(directory, "ready"), "ready");
	let observed;
	while (!existsSync(join(directory, "release"))) {
		if (existsSync(join(directory, "probe"))) {
			const nonce = readFileSync(join(directory, "probe"), "utf8");
			if (nonce !== observed) {
				writeFileSync(join(directory, "ack"), nonce);
				observed = nonce;
			}
		}
		await delay(2);
	}
	writeFileSync(join(directory, "finished"), "natural exit");
} else if (mode === "retained-primary") {
	const directory = process.argv[3];
	const leaf = spawn(process.execPath, [process.argv[1], "retained-leaf", directory], {
		detached: true,
		stdio: "ignore",
	});
	leaf.on("error", (error) => {
		throw error;
	});
	leaf.unref();
	const deadline = Date.now() + 10000;
	while (!existsSync(join(directory, "ready"))) {
		if (Date.now() >= deadline) throw new Error("retained worker did not become ready");
		await delay(2);
	}
	process.exit(23);
} else if (mode === "timeout-primary") {
	// A primary that never returns; its detached leaf must die with the timed-out owned scope.
	const directory = process.argv[3];
	const leaf = spawn(process.execPath, [process.argv[1], "retained-leaf", directory], {
		detached: true,
		stdio: "ignore",
	});
	leaf.on("error", (error) => {
		throw error;
	});
	leaf.unref();
	setTimeout(() => process.exit(98), 600_000);
} else if (mode === "leaf") {
	writeFileSync(process.env.PI_OWNER_PID_FILE, String(process.pid));
	setTimeout(() => process.exit(99), 600_000);
} else if (mode === "bridge") {
	const middle = spawn(process.execPath, [process.argv[1], "middle"], {
		detached: process.env.PI_OWNER_CASE !== "double-fork",
		stdio: "ignore",
	});
	await new Promise((resolve, reject) => {
		middle.once("error", reject);
		middle.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`owner fixture middle: ${code}`))));
	});
} else if (mode === "middle") {
	const leaf =
		process.platform === "win32"
			? spawn(process.execPath, [process.argv[1], "leaf"], { detached: true, stdio: "ignore" })
			: spawn("/bin/sh", ["-c", 'printf "%s\\n" "$$" > "$PI_OWNER_PID_FILE"; exec sleep 600'], { stdio: "ignore" });
	leaf.on("error", (error) => {
		throw error;
	});
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
