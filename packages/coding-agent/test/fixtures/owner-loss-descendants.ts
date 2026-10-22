import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";

// Raw extension descendants deliberately bypass per-tool ownership wrappers.
export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		const root = process.env.REVIEW_ROOT;
		if (!root) throw new Error("REVIEW_ROOT required by ownership fixture");
		const fixture = fileURLToPath(new URL("./owner-loss-orphan.py", import.meta.url));
		const direct = spawn("python3", [fixture, root, "direct"], { detached: true, stdio: "ignore" });
		if (!direct.pid) throw new Error("direct fixture child did not start");
		direct.unref();
		writeFileSync(`${root}/direct-pid`, String(direct.pid));
		const spawner = spawn("python3", [fixture, root, "orphan"], { stdio: "ignore" });
		writeFileSync(`${root}/orphan-spawner`, String(spawner.pid));
		await new Promise<void>((resolve, reject) => {
			spawner.once("error", reject);
			spawner.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("orphan spawner failed"))));
		});
		while (!existsSync(`${root}/adopted-pid`) || !existsSync(`${root}/direct-tick`)) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		writeFileSync(`${root}/descendants-ready`, "ready");
	});
}
